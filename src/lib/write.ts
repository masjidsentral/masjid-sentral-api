// Write pipeline (spec 3.2): every mutating handler goes through beginWrite() then commitWrite().
//
// Atomicity: one D1 batch() holds the entity write, the change-log row, the idempotency row,
// the child-row writes and the webhook enqueue. D1 runs a batch as a single SQLite transaction on one
// connection, statement by statement, with no interleaving writes. The guarded UPDATE
// (`WHERE id = ? AND version = ?`) is the only statement that can lose a race. Everything after it is
// chained to it:
//   1. changes row:      INSERT ... SELECT ... WHERE changes() = 1   (changes() = rows of the UPDATE)
//   2. idempotency row:  INSERT ... SELECT ... WHERE changes() = 1   (changes() = the changes row, 1)
//   3. child rows, webhook enqueue: guarded by EXISTS(the idempotency row of this request)
// A loser therefore writes nothing, and its idempotency row is never stored. We do not rely on
// changes() across statements that can legitimately affect 0 rows: step 3 uses the idempotency row.

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
   * Builds a statement that only takes effect when this write won. The template must end with `{{G}}`
   * (the guard expression, e.g. `INSERT INTO t (a) SELECT ? WHERE {{G}}` or `DELETE FROM t WHERE x = ? AND {{G}}`).
   * `{{ID}}` expands to the entity id (a literal on update, a sub-select on create). Binds cover only the
   * template's own `?` placeholders, in order, excluding the guard's.
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
  /** Override the change's origin_app (admin writes use "sentral_admin"). */
  originApp?: string
}

export type CommitResult =
  | { ok: true; seq: number; entity: { id: number; version: number }; status: number }
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
  opts: { requireIfMatch: boolean },
): Promise<{ replay: Response } | { ctx: WriteCtx }> {
  const idemKey = c.req.header('Idempotency-Key')?.trim() ?? ''
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

export function buildCommitStatements(ctx: WriteCtx, spec: WriteSpec, now: string): D1PreparedStatement[] {
  const { db } = ctx
  const isCreate = spec.op === 'create'
  const origin = spec.originApp ?? ctx.originApp
  const afterJson = JSON.stringify(spec.after)
  const beforeJson = spec.before === null ? null : JSON.stringify(spec.before)
  const fieldsJson = JSON.stringify(spec.changedFields)
  const status = spec.status

  // Entity id and masjid id as SQL: create takes them from the row just inserted.
  const entityIdSql = isCreate ? 'last_insert_rowid()' : String(spec.entityId)
  const masjidIdSql = spec.entity === 'masjid' ? entityIdSql : String(spec.masjidId)
  const version = spec.after.version
  const afterExpr = isCreate ? `json_set(?, '$.id', ${entityIdSql})` : '?'
  const respEntityId = isCreate ? LAST_CHANGE_ENTITY_ID : String(spec.entityId)
  const respExpr = isCreate ? `json_set(?, '$.id', ${respEntityId})` : '?'

  const stmts: D1PreparedStatement[] = [spec.entityStatement]

  const changeCols = 'entity, entity_id, masjid_id, op, version, origin_app, actor, changed_fields, before_json, after_json, occurred_at'
  if (isCreate) {
    stmts.push(
      db.prepare(
        `INSERT INTO changes (${changeCols}) VALUES (?, ${entityIdSql}, ${masjidIdSql}, ?, ?, ?, ?, ?, ?, ${afterExpr}, ?)`,
      ).bind(spec.entity, spec.op, version, origin, ctx.actor, fieldsJson, beforeJson, afterJson, now),
      db.prepare(
        `INSERT INTO idempotency_keys (api_key_id, key, request_hash, response_status, response_json, created_at)
         VALUES (?, ?, ?, ?, ${respExpr}, ?)`,
      ).bind(ctx.keyId, ctx.idemKey, ctx.requestHash, status, afterJson, now),
    )
  } else {
    stmts.push(
      db.prepare(
        `INSERT INTO changes (${changeCols})
         SELECT ?, ${entityIdSql}, ${masjidIdSql}, ?, ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1`,
      ).bind(spec.entity, spec.op, version, origin, ctx.actor, fieldsJson, beforeJson, afterJson, now),
      db.prepare(
        `INSERT INTO idempotency_keys (api_key_id, key, request_hash, response_status, response_json, created_at)
         SELECT ?, ?, ?, ?, ?, ? WHERE changes() = 1`,
      ).bind(ctx.keyId, ctx.idemKey, ctx.requestHash, status, afterJson, now),
    )
  }

  const guardSql = 'EXISTS (SELECT 1 FROM idempotency_keys WHERE api_key_id = ? AND key = ?)'
  const guardBinds = [ctx.keyId, ctx.idemKey]
  const builder: ChildBuilder = {
    stmt(template, binds = []) {
      if (!template.trimEnd().endsWith('{{G}}')) throw new Error('child statement template must end with {{G}}')
      const sql = template.replace('{{ID}}', isCreate ? LAST_CHANGE_ENTITY_ID : String(spec.entityId)).replace('{{G}}', guardSql)
      return db.prepare(sql).bind(...binds, ...guardBinds)
    },
  }
  if (spec.children) stmts.push(...spec.children(builder))

  // Coalesced webhook ping for every other app's active subscription (same transaction).
  stmts.push(
    db.prepare(
      `INSERT INTO webhook_deliveries (subscription_id, latest_seq, attempts, next_attempt_at, status, last_error, updated_at)
       SELECT s.id, ${LAST_CHANGE}, 0, ?, 'pending', NULL, ?
       FROM webhook_subscriptions s JOIN api_keys k ON k.id = s.api_key_id
       WHERE s.active = 1 AND COALESCE(k.app_id, '') != ? AND ${guardSql}
       ON CONFLICT(subscription_id) DO UPDATE SET
         latest_seq = MAX(webhook_deliveries.latest_seq, excluded.latest_seq),
         attempts = 0, next_attempt_at = excluded.next_attempt_at, status = 'pending',
         last_error = NULL, updated_at = excluded.updated_at`,
    ).bind(now, now, origin, ...guardBinds),
  )
  return stmts
}

/**
 * Runs the batch. Returns { ok: false } when the version guard lost (nothing was persisted).
 * Exported for tests that need to commit a stale spec without the handler's early version check.
 */
export async function runCommit(ctx: WriteCtx, spec: WriteSpec, now: string = isoNow()): Promise<CommitResult> {
  const results = await ctx.db.batch(buildCommitStatements(ctx, spec, now))
  const first = results[0]
  if (spec.op !== 'create' && (first.meta.changes ?? 0) !== 1) return { ok: false }

  const seqRow = await ctx.db
    .prepare('SELECT seq FROM changes WHERE entity = ? AND entity_id = ? AND version = ? ORDER BY seq DESC LIMIT 1')
    .bind(spec.entity, spec.op === 'create' ? first.meta.last_row_id : spec.entityId, spec.after.version)
    .first<{ seq: number }>()
  const entity = spec.op === 'create' ? { ...spec.after, id: first.meta.last_row_id } : spec.after
  return { ok: true, seq: seqRow?.seq ?? 0, entity, status: spec.status }
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
    const replay = await lookupIdempotent(ctx) // same key retried while the first attempt won
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
