// Change feed (contract section 6). The feed is the source of truth; webhooks are pings.

import { Hono } from 'hono'
import { ApiError } from '../lib/errors'
import { requireScope, type AppEnv } from '../middleware/auth'

export const changesRouter = new Hono<AppEnv>()

changesRouter.use('*', requireScope('read'))

const DEFAULT_LIMIT = 200
const MAX_LIMIT = 500

function intParam(raw: string | undefined, name: string, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw === '') return fallback
  if (!/^\d{1,15}$/.test(raw)) throw new ApiError(422, 'validation_failed', `${name} must be an integer`, { field: name })
  const n = Number(raw)
  if (n < min || n > max) throw new ApiError(422, 'validation_failed', `${name} must be between ${min} and ${max}`, { field: name })
  return n
}

changesRouter.get('/latest', async (c) => {
  const row = await c.env.DB.prepare('SELECT COALESCE(MAX(seq), 0) AS latest_seq FROM changes').first<{ latest_seq: number }>()
  return c.json({ latest_seq: row?.latest_seq ?? 0 })
})

changesRouter.get('/', async (c) => {
  const after = intParam(c.req.query('after'), 'after', 0, 0, Number.MAX_SAFE_INTEGER)
  const limit = intParam(c.req.query('limit'), 'limit', DEFAULT_LIMIT, 1, MAX_LIMIT)

  // One extra row tells us whether there is another page.
  const rows = await c.env.DB
    .prepare(
      `SELECT seq, entity, entity_id, masjid_id, op, version, origin_app, changed_fields, occurred_at, after_json
       FROM changes WHERE seq > ? ORDER BY seq ASC LIMIT ?`,
    )
    .bind(after, limit + 1)
    .run<{
      seq: number; entity: string; entity_id: number; masjid_id: number | null; op: string; version: number
      origin_app: string; changed_fields: string; occurred_at: string; after_json: string
    }>()

  // after_json / changed_fields are stored as JSON text written by JSON.stringify: splice them into the body
  // as-is instead of parsing and re-serialising every row.
  const page = rows.results.slice(0, limit)
  const items = page.map(r =>
    `{"seq":${r.seq},"entity":${JSON.stringify(r.entity)},"entity_id":${r.entity_id},"masjid_id":${r.masjid_id === null ? 'null' : r.masjid_id},` +
    `"op":${JSON.stringify(r.op)},"version":${r.version},"origin_app":${JSON.stringify(r.origin_app)},` +
    `"changed_fields":${r.changed_fields},"occurred_at":${JSON.stringify(r.occurred_at)},"data":${r.after_json}}`,
  )
  const nextAfter = page.length ? page[page.length - 1].seq : after
  return new Response(
    `{"changes":[${items.join(',')}],"next_after":${nextAfter},"has_more":${rows.results.length > limit}}`,
    { headers: { 'content-type': 'application/json' } },
  )
})
