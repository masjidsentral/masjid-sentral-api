// Admin routes. The admin scope is enforced globally in index.ts for every /admin path.
// S2: webhook registration. (Merge, revert and duplicates arrive in S4.)

import { Hono } from 'hono'
import { ApiError } from '../lib/errors'
import { newSecret } from '../lib/webhooks'
import { getActor, type AppEnv } from '../middleware/auth'

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
  const row = await c.env.DB
    .prepare('INSERT INTO webhook_subscriptions (api_key_id, url, secret) VALUES (?, ?, ?) RETURNING id, created_at')
    .bind(keyId, url, secret)
    .first<{ id: number; created_at: string }>()
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
