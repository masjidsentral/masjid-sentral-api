// Admin routes. The admin scope is enforced globally in index.ts for every /admin path.
// S2: webhook registration. (Merge, revert and duplicates arrive in S4.)

import { Hono } from 'hono'
import { ApiError } from '../lib/errors'
import { newSecret } from '../lib/webhooks'
import { getActor, type AppEnv } from '../middleware/auth'
import { loadMasjidsByIds } from '../lib/entities'
import { adminCtx, buildMergeSpecs, buildRevertSpecs } from '../lib/admin'
import { decodeCursor, encodeCursor, intParam } from '../lib/page'
import { scanStatus } from '../lib/scan'
import { isoNow } from '../lib/time'
import { beginWrite, commitWrite, parseJsonObject, replayOnConflict, type WriteCtx } from '../lib/write'

export const adminRouter = new Hono<AppEnv>()

function fail(message: string, field: string): never {
  throw new ApiError(422, 'validation_failed', message, { field })
}

adminRouter.get('/webhooks', async (c) => {
  const rows = await c.env.DB
    .prepare(
      `SELECT s.id, s.api_key_id, k.app_id, s.url, s.active, s.created_at,
              d.status AS delivery_status, d.latest_seq, d.attempts, d.last_error
       FROM webhook_subscriptions s
       JOIN api_keys k ON k.id = s.api_key_id
       LEFT JOIN webhook_deliveries d ON d.subscription_id = s.id
       ORDER BY s.id`,
    )
    .run()
  // The secret is never listed.
  return c.json({ webhooks: rows.results })
})

adminRouter.post('/webhooks', async (c) => {
  let body: Record<string, unknown>
  try {
    const parsed = await c.req.json()
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object')
    body = parsed as Record<string, unknown>
  } catch {
    return fail('Invalid JSON body', 'body')
  }
  const keyId = body.api_key_id
  const url = body.url
  if (typeof keyId !== 'number' || !Number.isInteger(keyId)) fail('api_key_id must be an integer', 'api_key_id')
  if (typeof url !== 'string' || !/^https:\/\/[^\s/]+\S*$/.test(url) || url.length > 2000) fail('url must be an https:// URL', 'url')

  const key = await c.env.DB
    .prepare('SELECT id, app_id, scopes FROM api_keys WHERE id = ? AND is_active = 1 AND revoked_at IS NULL')
    .bind(keyId)
    .first<{ id: number; app_id: string | null; scopes: string }>()
  if (!key) fail('api_key_id does not match an active key', 'api_key_id')
  if (!key.app_id) fail('That key has no app_id', 'api_key_id')
  if (!key.scopes.split(',').map(s => s.trim()).includes('webhook')) {
    fail("That key lacks the 'webhook' scope", 'api_key_id')
  }

  getActor(c) // writeGuard already validated it; admin actions are attributable
  const secret = newSecret()
  let row: { id: number; created_at: string } | null
  try {
    row = await c.env.DB
      .prepare('INSERT INTO webhook_subscriptions (api_key_id, url, secret) VALUES (?, ?, ?) RETURNING id, created_at')
      .bind(keyId, url, secret)
      .first<{ id: number; created_at: string }>()
  } catch (err) {
    // UNIQUE (api_key_id, url): a duplicate registration is a 409 and never reveals the existing secret.
    if (String(err instanceof Error ? err.message : err).includes('UNIQUE')) {
      throw new ApiError(409, 'already_exists', 'That key already has a webhook for this URL; delete it first to rotate the secret')
    }
    throw err
  }
  // The secret is returned once.
  return c.json({ id: row!.id, api_key_id: keyId, app_id: key.app_id, url, secret, active: true, created_at: row!.created_at }, 201)
})

adminRouter.delete('/webhooks/:id', async (c) => {
  const raw = c.req.param('id')
  if (!/^\d{1,15}$/.test(raw)) fail('Invalid id', 'id')
  const id = Number(raw)
  const [, deleted] = await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM webhook_deliveries WHERE subscription_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM webhook_subscriptions WHERE id = ?').bind(id),
  ])
  if ((deleted.meta.changes ?? 0) === 0) throw new ApiError(404, 'not_found', 'Webhook not found')
  return c.body(null, 204)
})

// ─── Merge, revert, duplicate queue (S4) ─────────────────────────────────────

function parseIdParam(raw: string, name = 'id'): number {
  if (!/^\d{1,15}$/.test(raw)) fail(`Invalid ${name}`, name)
  const n = Number(raw)
  if (n < 1) fail(`Invalid ${name}`, name)
  return n
}

function parseInto(body: Record<string, unknown>): number {
  const into = body.into
  if (typeof into !== 'number' || !Number.isInteger(into) || into < 1) fail('into must be a positive integer masjid id', 'into')
  return into
}

function parseReason(body: Record<string, unknown>): string | null {
  const r = body.reason
  if (r === undefined || r === null) return null
  // eslint-disable-next-line no-control-regex
  if (typeof r !== 'string' || r.length > 500 || /[\u0000-\u001f\u007f-\u009f]/.test(r)) fail('reason must be text of at most 500 characters', 'reason')
  return r.trim() === '' ? null : r.trim()
}

// POST /admin/masjids/:id/merge { into, reason }: the masjid in the path is the duplicate that is removed.
adminRouter.post('/masjids/:id/merge', async (c) => {
  const loserId = parseIdParam(c.req.param('id'))
  const begin = await beginWrite(c, { requireIfMatch: false })
  if ('replay' in begin) return begin.replay
  const ctx: WriteCtx = begin.ctx
  return replayOnConflict(ctx, async () => {
    const body = parseJsonObject(ctx)
    const into = parseInto(body)
    const reason = parseReason(body)
    return commitWrite(c, adminCtx(ctx), await buildMergeSpecs(ctx, loserId, into, reason, isoNow()))
  })
})

// POST /admin/changes/:seq/revert: applies the change's before_json as a new write (actor "revert:<seq>").
adminRouter.post('/changes/:seq/revert', async (c) => {
  const seq = parseIdParam(c.req.param('seq'), 'seq')
  const forceRaw = c.req.query('force')
  if (forceRaw !== undefined && forceRaw !== 'true' && forceRaw !== 'false') fail('force must be true or false', 'force')
  const begin = await beginWrite(c, { requireIfMatch: false })
  if ('replay' in begin) return begin.replay
  const ctx: WriteCtx = begin.ctx
  return replayOnConflict(ctx, async () => {
    try {
      return await commitWrite(
        c,
        adminCtx(ctx, `revert:${seq}:${ctx.actor}`),
        await buildRevertSpecs(ctx, seq, isoNow(), { force: forceRaw === 'true' }),
      )
    } catch (err) {
      if (!(err instanceof ApiError) && String(err instanceof Error ? err.message : err).includes('UNIQUE')) {
        throw new ApiError(409, 'already_linked', 'An external id from the logged state now belongs to another entity')
      }
      throw err
    }
  })
})

interface DuplicateRow {
  id: number
  masjid_a: number
  masjid_b: number
  score: number
  distance_m: number
  status: string
  created_at: string
  resolved_at: string | null
}

const DUP_COLUMNS = 'id, masjid_a, masjid_b, score, distance_m, status, created_at, resolved_at'

async function duplicateView(db: D1Database, rows: DuplicateRow[]) {
  const masjids = await loadMasjidsByIds(db, [...new Set(rows.flatMap(r => [r.masjid_a, r.masjid_b]))])
  const byId = new Map(masjids.map(m => [m.id, m]))
  const summary = (id: number) => {
    const m = byId.get(id)
    return m
      ? { id: m.id, name: m.name, type_id: m.type_id, lat: m.lat, lng: m.lng, address: m.address, status: m.status, external_ids: m.external_ids }
      : { id, name: null, type_id: null, lat: null, lng: null, address: null, status: 'missing', external_ids: [] }
  }
  return rows.map(r => ({
    id: r.id,
    status: r.status,
    score: r.score,
    distance_m: r.distance_m,
    same_type: byId.get(r.masjid_a)?.type_id === byId.get(r.masjid_b)?.type_id,
    masjid_a: summary(r.masjid_a),
    masjid_b: summary(r.masjid_b),
    created_at: r.created_at,
    resolved_at: r.resolved_at,
  }))
}

// GET /admin/duplicates?status=pending|merged|dismissed|all&limit&cursor
adminRouter.get('/duplicates', async (c) => {
  const status = c.req.query('status') ?? 'pending'
  if (!['pending', 'merged', 'dismissed', 'all'].includes(status)) fail('status must be pending, merged, dismissed or all', 'status')
  const limit = intParam(c.req.query('limit'), 'limit', 20, 1, 100)
  const raw = decodeCursor(c.req.query('cursor'))
  const after = raw === null ? 0 : /^\d{1,15}$/.test(raw) ? Number(raw) : fail('cursor is not valid', 'cursor')

  const rows = await c.env.DB
    .prepare(
      `SELECT ${DUP_COLUMNS} FROM duplicate_candidates WHERE id > ? AND (? = 'all' OR status = ?) ORDER BY id LIMIT ?`,
    )
    .bind(after, status, status, limit + 1)
    .all<DuplicateRow>()
  const page = rows.results.slice(0, limit)
  return c.json({
    data: await duplicateView(c.env.DB, page),
    next_cursor: rows.results.length > limit ? encodeCursor(String(page[page.length - 1].id)) : null,
  })
})

async function loadDuplicate(db: D1Database, id: number): Promise<DuplicateRow> {
  const row = await db.prepare(`SELECT ${DUP_COLUMNS} FROM duplicate_candidates WHERE id = ?`).bind(id).first<DuplicateRow>()
  if (!row) throw new ApiError(404, 'not_found', 'Duplicate candidate not found')
  return row
}

// POST /admin/duplicates/:id/dismiss: "these are different places". Dismissing twice is a no-op.
adminRouter.post('/duplicates/:id/dismiss', async (c) => {
  const id = parseIdParam(c.req.param('id'))
  const begin = await beginWrite(c, { requireIfMatch: false })
  if ('replay' in begin) return begin.replay
  const ctx: WriteCtx = begin.ctx
  const now = isoNow()
  const res = await c.env.DB
    .prepare("UPDATE duplicate_candidates SET status = 'dismissed', resolved_at = ?, resolved_by = ? WHERE id = ? AND status = 'pending'")
    .bind(now, ctx.actor, id)
    .run()
  const row = await loadDuplicate(c.env.DB, id)
  if ((res.meta.changes ?? 0) === 0 && row.status !== 'dismissed') {
    throw new ApiError(422, 'validation_failed', `This pair is already ${row.status}`, { reason: 'not_pending', status: row.status })
  }
  const view = (await duplicateView(c.env.DB, [row]))[0]
  // Store the response so a double-sent dismiss replays instead of re-running (the action is idempotent anyway).
  await c.env.DB
    .prepare(
      `INSERT OR IGNORE INTO idempotency_keys (api_key_id, key, request_hash, response_status, response_json, created_at)
       VALUES (?, ?, ?, 200, ?, ?)`,
    )
    .bind(ctx.keyId, ctx.idemKey, ctx.requestHash, JSON.stringify(view), now)
    .run()
  return c.json(view)
})

adminRouter.post('/duplicates/:id/merge', async (c) => {
  const id = parseIdParam(c.req.param('id'))
  const begin = await beginWrite(c, { requireIfMatch: false })
  if ('replay' in begin) return begin.replay
  const ctx: WriteCtx = begin.ctx
  return replayOnConflict(ctx, async () => {
    const body = parseJsonObject(ctx)
    const into = parseInto(body)
    const row = await loadDuplicate(ctx.db, id)
    if (row.status !== 'pending') {
      throw new ApiError(422, 'validation_failed', `This pair is already ${row.status}`, { reason: 'not_pending', status: row.status })
    }
    if (into !== row.masjid_a && into !== row.masjid_b) {
      throw new ApiError(422, 'validation_failed', 'into must be one of the two masjids in the pair', {
        field: 'into', masjid_a: row.masjid_a, masjid_b: row.masjid_b,
      })
    }
    const loser = into === row.masjid_a ? row.masjid_b : row.masjid_a
    return commitWrite(c, adminCtx(ctx), await buildMergeSpecs(ctx, loser, into, parseReason(body), isoNow()))
  })
})

adminRouter.get('/scan', async (c) => c.json(await scanStatus(c.env.DB)))
