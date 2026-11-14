// Write pipeline (spec 3.2): every mutating handler goes through beginWrite() then commitWrite().
//
// Atomicity: one D1 batch() holds the entity write(s), the change-log row(s), the idempotency row,
// the child-row writes and the webhook enqueue. D1 runs a batch as a single SQLite transaction on one
// connection, statement by statement, with no interleaving writes, and rolls the whole batch back when any
// statement fails. The guarded UPDATE (`WHERE id = ? AND version = ?`) is the only statement that can lose a
// race, so right after it comes an ABORT GUARD:
//   INSERT INTO batch_guard (ok) SELECT CASE WHEN changes() = 1 THEN 1 ELSE 0 END   (changes() = the UPDATE's rows)
// batch_guard has CHECK (ok = 1) (constraint name version_guard): a lost guard raises, the batch rolls back, and
// nothing (children, change rows, idempotency row, webhook ping) persists. Everything after the guard therefore
// needs no condition of its own. The guard row is deleted again right away.
// A raised guard maps to the 409 path (`isVersionGuardError`).

import type { Context } from 'hono'
import { ApiError } from './errors'
import { isoNow } from './time'
import type { AppEnv } from '../middleware/auth'
import { getActor } from '../middleware/auth'
import { dispatchDue } from './webhooks'

export type EntityKind = 'masjid' | 'event'
export type ChangeOp = 'create' | 'update' | 'delete' | 'merge'

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000
const LAST_CHANGE = `(SELECT seq FROM sqlite_sequence WHERE name = 'changes')`
const LAST_CHANGE_ENTITY_ID = `(SELECT entity_id FROM changes WHERE seq = ${LAST_CHANGE})`

export interface WriteCtx {
  db: D1Database
  keyId: number
  originApp: string
  actor: string
  idemKey: string
  requestHash: string
  bodyText: string
  /** The If-Match value for PATCH/DELETE, null otherwise. */
  ifMatch: number | null
}

export interface ChildBuilder {
  /**
   * Builds a child statement. It runs only if the entity's version guard won (a lost guard aborts the whole
   * batch before it). `{{ID}}` expands to the entity id (a literal on update, a sub-select on create). Binds
   * are the template's own `?` placeholders, in order.
   */
  stmt(template: string, binds?: unknown[]): D1PreparedStatement
}

export interface WriteSpec {
  entity: EntityKind
  op: ChangeOp
  /** null on create. */
  entityId: number | null
  /** null on create. */
  baseVersion: number | null
  /** The masjid the change belongs to (events); for masjid entities null (= the entity id). */
  masjidId: number | null
  changedFields: string[]
  /** null on create. */
  before: unknown | null
  /** Full entity after the write. On create, `id` must be present as a placeholder (0). */
  after: { id: number; version: number }
  /** create: the INSERT. update/delete: the guarded UPDATE (`... WHERE id = ? AND version = ?`). */
  entityStatement: D1PreparedStatement
  /** Loads the current full entity for a 409 version_conflict (`details.current`). */
  loadCurrent?: () => Promise<unknown>
  children?: (b: ChildBuilder) => D1PreparedStatement[]
  status: 200 | 201
  /** Extra top-level keys recorded in changes.after_json only (e.g. `forced: true`); never in the response. */
  changeExtra?: Record<string, unknown>
  /** Override the change's origin_app (admin writes use "sentral_admin"). */
  originApp?: string
}

export type CommitResult =
  | { ok: true; seq: number; entity: { id: number; version: number }; status: number }
  | { ok: false }

export type CommitManyResult =
  | { ok: true; results: Array<{ seq: number; entity: { id: number; version: number } }>; status: number }
  | { ok: false }

// ─── helpers ─────────────────────────────────────────────────────────────────

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/

function validationError(message: string, details: Record<string, unknown>): ApiError {
  return new ApiError(422, 'validation_failed', message, details)
}

export function versionConflict(current: unknown): ApiError {
  return new ApiError(409, 'version_conflict', 'The entity changed since the version you based this edit on', { current })
}

/** Parses an If-Match value: `7`, `"7"` or `W/"7"`. */
function parseIfMatch(raw: string | undefined): number {
  const m = raw === undefined ? null : /^\s*(?:W\/)?"?(\d{1,15})"?\s*$/.exec(raw)
  if (!m) {
    throw validationError('If-Match header is required: the version you based this edit on', { header: 'If-Match' })
  }
  return Number(m[1])
}

// ─── begin: headers, idempotency lookup ──────────────────────────────────────

export async function beginWrite(
  c: Context<AppEnv>,
  opts: { requireIfMatch: boolean; idempotencyOptional?: boolean },
): Promise<{ replay: Response } | { ctx: WriteCtx }> {
  let idemKey = c.req.header('Idempotency-Key')?.trim() ?? ''
  // PUT link: the contract does not require the header (R4 names POST/PATCH/DELETE). Without it the write gets a
  // private key, so nothing replays; the handler itself is idempotent.
  if (idemKey === '' && opts.idempotencyOptional) idemKey = `auto-${crypto.randomUUID()}`
  if (idemKey.length < 1 || idemKey.length > 255 || CONTROL_CHARS.test(idemKey)) {
    throw validationError(
      'Idempotency-Key header is required (1-255 characters, no control characters)',
      { header: 'Idempotency-Key' },
    )
  }
  const ifMatch = opts.requireIfMatch ? parseIfMatch(c.req.header('If-Match')) : null

  const bodyText = await c.req.text()
  const url = new URL(c.req.url)
  const requestHash = await sha256Hex(`${c.req.method} ${url.pathname}${url.search}\n${bodyText}`)

  const key = c.get('key')
  const db = c.env.DB
  const ctx: WriteCtx = {
    db,
    keyId: key.id,
    originApp: key.app_id ?? 'sentral_admin',
    actor: getActor(c),
    idemKey,
    requestHash,
    bodyText,
    ifMatch,
  }

  const replay = await lookupIdempotent(ctx)
  return replay ? { replay } : { ctx }
}

/** Replay response for a stored key, 409 on a different request, null when the key is free. */
export async function lookupIdempotent(ctx: Pick<WriteCtx, 'db' | 'keyId' | 'idemKey' | 'requestHash'>): Promise<Response | null> {
  const row = await ctx.db
    .prepare('SELECT request_hash, response_status, response_json, created_at FROM idempotency_keys WHERE api_key_id = ? AND key = ?')
    .bind(ctx.keyId, ctx.idemKey)
    .first<{ request_hash: string; response_status: number; response_json: string; created_at: string }>()
  if (!row) return null

  if (Date.parse(row.created_at) < Date.now() - IDEMPOTENCY_TTL_MS) {
    // Expired (the cron has not swept it yet): free the key.
    await ctx.db.prepare('DELETE FROM idempotency_keys WHERE api_key_id = ? AND key = ?').bind(ctx.keyId, ctx.idemKey).run()
    return null
  }
  if (row.request_hash !== ctx.requestHash) {
    throw new ApiError(409, 'idempotency_mismatch', 'This Idempotency-Key was already used for a different request')
  }
  return new Response(row.response_json, {
    status: row.response_status,
    headers: { 'content-type': 'application/json', 'Idempotent-Replay': 'true' },
  })
}

/** Parses the (already read) body as a JSON object. */
export function parseJsonObject(ctx: Pick<WriteCtx, 'bodyText'>): Record<string, unknown> {
  let body: unknown
  try {
    body = JSON.parse(ctx.bodyText)
  } catch {
    throw validationError('Invalid JSON body', { field: 'body' })
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw validationError('Body must be a JSON object', { field: 'body' })
  }
  return body as Record<string, unknown>
}

// ─── commit ──────────────────────────────────────────────────────────────────

/** True when a batch error is the abort guard firing (a lost version race). */
export function isVersionGuardError(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 4; depth++) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes('version_guard')) return true
    e = (e as { cause?: unknown }).cause
  }
  return false
}

/** Builds the batch for one or more entity writes (one idempotency row for the request, one enqueue). */
export function buildCommitStatements(ctx: WriteCtx, specs: WriteSpec[], now: string): { stmts: D1PreparedStatement[]; entityIdx: number[] } {
  const { db } = ctx
  const stmts: D1PreparedStatement[] = []
  const entityIdx: number[] = []
  const changeCols = 'entity, entity_id, masjid_id, op, version, origin_app, actor, changed_fields, before_json, after_json, occurred_at'

  specs.forEach((spec, index) => {
    const isCreate = spec.op === 'create'
    const origin = spec.originApp ?? ctx.originApp
    const afterJson = JSON.stringify(spec.after)
    const changeAfterJson = spec.changeExtra ? JSON.stringify({ ...spec.after, ...spec.changeExtra }) : afterJson
    const beforeJson = spec.before === null ? null : JSON.stringify(spec.before)
    const fieldsJson = JSON.stringify(spec.changedFields)

    // Entity id and masjid id as SQL: create takes them from the row just inserted.
    const entityIdSql = isCreate ? 'last_insert_rowid()' : String(spec.entityId)
    const masjidIdSql = spec.entity === 'masjid' ? entityIdSql : String(spec.masjidId)
    const version = spec.after.version
    const afterExpr = isCreate ? `json_set(?, '$.id', ${entityIdSql})` : '?'

    entityIdx.push(stmts.length)
    stmts.push(spec.entityStatement)
    if (!isCreate) {
      // Abort guard: raises (rolling the batch back) unless the UPDATE above matched exactly one row.
      stmts.push(
        db.prepare('INSERT INTO batch_guard (ok) SELECT CASE WHEN changes() = 1 THEN 1 ELSE 0 END'),
        db.prepare('DELETE FROM batch_guard'),
      )
    }
    stmts.push(
      db.prepare(
        `INSERT INTO changes (${changeCols}) VALUES (?, ${entityIdSql}, ${masjidIdSql}, ?, ?, ?, ?, ?, ?, ${afterExpr}, ?)`,
      ).bind(spec.entity, spec.op, version, origin, ctx.actor, fieldsJson, beforeJson, changeAfterJson, now),
    )
    if (index === 0) {
      // The stored response is the first entity (the primary one).
      const respExpr = isCreate ? `json_set(?, '$.id', ${LAST_CHANGE_ENTITY_ID})` : '?'
      stmts.push(
        db.prepare(
          `INSERT INTO idempotency_keys (api_key_id, key, request_hash, response_status, response_json, created_at)
           VALUES (?, ?, ?, ?, ${respExpr}, ?)`,
        ).bind(ctx.keyId, ctx.idemKey, ctx.requestHash, spec.status, afterJson, now),
      )
    }

    const builder: ChildBuilder = {
      stmt(template, binds = []) {
        const sql = template.replaceAll('{{ID}}', isCreate ? LAST_CHANGE_ENTITY_ID : String(spec.entityId))
        return db.prepare(sql).bind(...binds)
      },
    }
    if (spec.children) stmts.push(...spec.children(builder))
  })

  // Coalesced webhook ping for every other app's active subscription (same transaction).
  // M2: a row that is pending and already backing off (attempts > 0) keeps its attempts and schedule, so steady
  // writes cannot keep resetting a failing endpoint. Delivered, dropped or never-attempted rows restart.
  const origin = specs[0].originApp ?? ctx.originApp
  stmts.push(
    db.prepare(
      `INSERT INTO webhook_deliveries (subscription_id, latest_seq, attempts, next_attempt_at, status, last_error, updated_at)
       SELECT s.id, ${LAST_CHANGE}, 0, ?, 'pending', NULL, ?
       FROM webhook_subscriptions s JOIN api_keys k ON k.id = s.api_key_id
       WHERE s.active = 1 AND k.is_active = 1 AND k.revoked_at IS NULL AND COALESCE(k.app_id, '') != ?
       ON CONFLICT(subscription_id) DO UPDATE SET
         latest_seq = MAX(webhook_deliveries.latest_seq, excluded.latest_seq),
         attempts = CASE WHEN webhook_deliveries.status = 'pending' AND webhook_deliveries.attempts > 0
                         THEN webhook_deliveries.attempts ELSE 0 END,
         next_attempt_at = CASE WHEN webhook_deliveries.status = 'pending' AND webhook_deliveries.attempts > 0
                                THEN webhook_deliveries.next_attempt_at ELSE excluded.next_attempt_at END,
         last_error = CASE WHEN webhook_deliveries.status = 'pending' AND webhook_deliveries.attempts > 0
                           THEN webhook_deliveries.last_error ELSE NULL END,
         status = 'pending',
         updated_at = excluded.updated_at`,
    ).bind(now, now, origin),
  )
  return { stmts, entityIdx }
}

/**
 * Runs the batch for several entity writes (S4 merge). Returns { ok: false } when any version guard lost
 * (the abort guard rolled everything back: nothing was persisted). Other errors propagate.
 * Exported for tests that need to commit a stale spec without the handler's early version check.
 */
export async function runCommitMany(ctx: WriteCtx, specs: WriteSpec[], now: string = isoNow()): Promise<CommitManyResult> {
  if (specs.length === 0) throw new Error('runCommitMany needs at least one spec')
  const { stmts, entityIdx } = buildCommitStatements(ctx, specs, now)
  let results: D1Result[]
  try {
    results = await ctx.db.batch(stmts)
  } catch (err) {
    if (isVersionGuardError(err)) return { ok: false }
    throw err
  }

  const out: Array<{ seq: number; entity: { id: number; version: number } }> = []
  for (const [i, spec] of specs.entries()) {
    const first = results[entityIdx[i]]
    const entity = spec.op === 'create' ? { ...spec.after, id: first.meta.last_row_id } : spec.after
    const seqRow = await ctx.db
      .prepare('SELECT seq FROM changes WHERE entity = ? AND entity_id = ? AND version = ? ORDER BY seq DESC LIMIT 1')
      .bind(spec.entity, entity.id, spec.after.version)
      .first<{ seq: number }>()
    out.push({ seq: seqRow?.seq ?? 0, entity })
  }
  return { ok: true, results: out, status: specs[0].status }
}

/** Single-entity commit: the one-spec case of runCommitMany. */
export async function runCommit(ctx: WriteCtx, spec: WriteSpec, now: string = isoNow()): Promise<CommitResult> {
  const r = await runCommitMany(ctx, [spec], now)
  if (!r.ok) return { ok: false }
  return { ok: true, seq: r.results[0].seq, entity: r.results[0].entity, status: r.status }
}

/**
 * M1: runs a handler step and, when it ends in a 404 / version_conflict, re-checks idempotency first. A request
 * that raced its own retry (the first attempt committed in between) gets the stored response replayed instead
 * of a spurious 409/404. A key stored for a different request still answers 409 idempotency_mismatch.
 */
export async function replayOnConflict(
  ctx: Pick<WriteCtx, 'db' | 'keyId' | 'idemKey' | 'requestHash'>,
  fn: () => Promise<Response>,
): Promise<Response> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.code === 'version_conflict')) {
      const replay = await lookupIdempotent(ctx)
      if (replay) return replay
    }
    throw err
  }
}

export async function commitWrite(c: Context<AppEnv>, ctx: WriteCtx, spec: WriteSpec): Promise<Response> {
  let result: CommitResult
  try {
    result = await runCommit(ctx, spec)
  } catch (err) {
    // Two requests with the same Idempotency-Key racing: the loser's idempotency insert violates the PK
    // and the whole batch rolls back. Answer it from the winner's stored response.
    const replay = await lookupIdempotent(ctx)
    if (replay) return replay
    throw err
  }

  if (!result.ok) {
    // Guard lost: same key retried while the first attempt won -> replay (M1); otherwise a real conflict.
    const replay = await lookupIdempotent(ctx)
    if (replay) return replay
    throw versionConflict(spec.loadCurrent ? await spec.loadCurrent() : null)
  }

  try {
    c.executionCtx.waitUntil(dispatchDue(c.env.DB).catch(err => console.error('webhook dispatch failed', err)))
  } catch {
    // No execution context (unit tests): the cron picks the ping up.
  }
  return c.json(result.entity, spec.status)
}
