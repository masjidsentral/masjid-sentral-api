import { describe, it, expect, vi } from 'vitest'
import app from '../src/index'
import { SELF, env } from 'cloudflare:test'
import { Hono } from 'hono'
import { KEYS, tok, DEV_KEY_TOKEN, bearer, readHeaders, writeHeaders, sha256Hex } from './helpers'
import { authMiddleware, type AppEnv } from '../src/middleware/auth'
import { createRateLimit } from '../src/middleware/rate-limit'
import { errorBody } from '../src/lib/errors'
import { ApiError } from '../src/lib/errors'

const URL_ = 'http://example.com'
const BODY = JSON.stringify({
  name: 'Auth Test Masjid', type_id: 'masjid', state_id: 'my-kul', country_id: 'my',
  lat: 3.147, lng: 101.698, address: '1 Jalan Test', source: 'manual',
})

async function expectError(res: Response, status: number, code: string) {
  expect(res.status).toBe(status)
  const body = await res.json() as { error: string; code: string }
  expect(typeof body.error).toBe('string')
  expect(body.error.length).toBeGreaterThan(0)
  expect(body.code).toBe(code)
}

describe('authentication', () => {
  it('no key on a read -> 401 unauthorized (error shape)', async () => {
    await expectError(await SELF.fetch(`${URL_}/masjids`), 401, 'unauthorized')
  })

  it('no key on a write -> 401', async () => {
    await expectError(
      await SELF.fetch(`${URL_}/masjids`, { method: 'POST', body: BODY }), 401, 'unauthorized')
  })

  it('malformed / unknown key -> 401', async () => {
    await expectError(await SELF.fetch(`${URL_}/masjids`, { headers: { Authorization: 'Basic abc' } }), 401, 'unauthorized')
    await expectError(await SELF.fetch(`${URL_}/masjids`, { headers: bearer('nope') }), 401, 'unauthorized')
  })

  it('the dev key seeded by migration 002 is rejected (removed by 003)', async () => {
    await expectError(await SELF.fetch(`${URL_}/masjids`, { headers: bearer(DEV_KEY_TOKEN) }), 401, 'unauthorized')
    const row = await env.DB
      .prepare('SELECT id FROM api_keys WHERE key_hash = ?')
      .bind(await sha256Hex(DEV_KEY_TOKEN)).first()
    expect(row).toBeNull()
  })

  it('a revoked key -> 401', async () => {
    const token = tok('revoked')
    await env.DB
      .prepare(`INSERT INTO api_keys (key_hash, name, app_id, scopes, revoked_at) VALUES (?, 'revoked', 'qiyam', 'read,write', '2026-11-14T00:00:00Z')`)
      .bind(await sha256Hex(token)).run()
    await expectError(await SELF.fetch(`${URL_}/masjids`, { headers: bearer(token) }), 401, 'unauthorized')
  })

  it('an inactive key (is_active = 0) -> 401', async () => {
    const token = tok('inactive')
    await env.DB
      .prepare(`INSERT INTO api_keys (key_hash, name, app_id, scopes, is_active) VALUES (?, 'inactive', 'qiyam', 'read', 0)`)
      .bind(await sha256Hex(token)).run()
    await expectError(await SELF.fetch(`${URL_}/masjids`, { headers: bearer(token) }), 401, 'unauthorized')
  })

  it('GET / and GET /openapi.json need no key', async () => {
    expect((await SELF.fetch(`${URL_}/`)).status).toBe(200)
    expect((await SELF.fetch(`${URL_}/openapi.json`)).status).toBe(200)
  })

  it('a valid read key can read', async () => {
    expect((await SELF.fetch(`${URL_}/masjids`, { headers: readHeaders() })).status).toBe(200)
  })

  it('no CORS headers are emitted', async () => {
    const res = await SELF.fetch(`${URL_}/masjids`, { headers: { ...readHeaders(), Origin: 'https://evil.example' } })
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })
})

describe('write scope, app_id and actor', () => {
  it('read-only key on POST -> 403 forbidden', async () => {
    const res = await SELF.fetch(`${URL_}/masjids`, {
      method: 'POST', headers: { ...readHeaders(), 'X-Sentral-Actor': 'u1' }, body: BODY,
    })
    await expectError(res, 403, 'forbidden')
  })

  it('read-only key on PATCH -> 403', async () => {
    const res = await SELF.fetch(`${URL_}/masjids/1`, {
      method: 'PATCH', headers: { ...readHeaders(), 'X-Sentral-Actor': 'u1' }, body: '{}',
    })
    await expectError(res, 403, 'forbidden')
  })

  it('admin-only key cannot write outside /admin -> 403', async () => {
    await expectError(
      await SELF.fetch(`${URL_}/masjids`, { method: 'POST', headers: writeHeaders(KEYS.admin.token), body: BODY }),
      403, 'forbidden')
  })

  it('a write key without an app_id -> 403', async () => {
    const token = tok('noapp')
    await env.DB
      .prepare(`INSERT INTO api_keys (key_hash, name, app_id, scopes) VALUES (?, 'noapp', NULL, 'read,write')`)
      .bind(await sha256Hex(token)).run()
    await expectError(
      await SELF.fetch(`${URL_}/masjids`, { method: 'POST', headers: writeHeaders(token), body: BODY }),
      403, 'forbidden')
  })

  it('missing X-Sentral-Actor -> 422 validation_failed', async () => {
    const { 'X-Sentral-Actor': _omit, ...headers } = writeHeaders()
    await expectError(await SELF.fetch(`${URL_}/masjids`, { method: 'POST', headers, body: BODY }), 422, 'validation_failed')
  })

  it('empty or >128 char actor -> 422', async () => {
    await expectError(
      await SELF.fetch(`${URL_}/masjids`, { method: 'POST', headers: writeHeaders(KEYS.jm.token, ''), body: BODY }),
      422, 'validation_failed')
    await expectError(
      await SELF.fetch(`${URL_}/masjids`, { method: 'POST', headers: writeHeaders(KEYS.jm.token, 'a'.repeat(129)), body: BODY }),
      422, 'validation_failed')
  })

  it('a write key with an actor can write (128 chars is allowed)', async () => {
    const res = await SELF.fetch(`${URL_}/masjids`, {
      method: 'POST', headers: writeHeaders(KEYS.qiyam.token, 'a'.repeat(128)), body: BODY,
    })
    expect(res.status).toBe(201)
  })

  it('the actor is not needed on reads', async () => {
    expect((await SELF.fetch(`${URL_}/masjids`, { headers: bearer(KEYS.jm.token) })).status).toBe(200)
  })
})

describe('error shape', () => {
  it('404 for an unknown route', async () => {
    await expectError(await SELF.fetch(`${URL_}/nope`, { headers: readHeaders() }), 404, 'not_found')
  })

  it('404 for a missing masjid', async () => {
    await expectError(await SELF.fetch(`${URL_}/masjids/999999999`, { headers: readHeaders() }), 404, 'not_found')
  })

  it('422 for a bad request keeps { error, code }', async () => {
    await expectError(await SELF.fetch(`${URL_}/cities`, { headers: readHeaders() }), 422, 'validation_failed')
  })

  it('500 is { error, code: "internal" } and leaks no detail', async () => {
    const brokenDb = { prepare: () => { throw new Error('secret stack detail') } }
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await app.request('/masjids', { headers: readHeaders() }, { ...env, DB: brokenDb })
    spy.mockRestore()
    expect(res.status).toBe(500)
    const body = await res.json() as { error: string; code: string }
    expect(body.code).toBe('internal')
    expect(JSON.stringify(body)).not.toContain('secret')
  })
})

describe('rate limit', () => {
  function makeApp(success: boolean) {
    const calls: string[] = []
    const stub = { limit: async ({ key }: { key: string }) => { calls.push(key); return { success } } }
    const app = new Hono<AppEnv>()
    app.use('*', authMiddleware)
    app.use('*', createRateLimit(() => stub))
    app.onError((err, c) => {
      if (err instanceof ApiError) return c.json(errorBody(err.message, err.code), err.status as 429, err.headers)
      throw err
    })
    app.get('/ping', (c) => c.text('ok'))
    return { app, calls }
  }

  it('over the limit -> 429 rate_limited with Retry-After', async () => {
    const { app } = makeApp(false)
    const res = await app.request('/ping', { headers: readHeaders() }, env)
    await expectError(res, 429, 'rate_limited')
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0)
  })

  it('under the limit passes, keyed by key id', async () => {
    const { app, calls } = makeApp(true)
    const res = await app.request('/ping', { headers: readHeaders() }, env)
    expect(res.status).toBe(200)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatch(/^key:\d+$/)
  })

  it('rejected (unauthenticated) requests do not consume the limiter', async () => {
    const { app, calls } = makeApp(true)
    const res = await app.request('/ping', {}, env)
    expect(res.status).toBe(401)
    expect(calls).toHaveLength(0)
  })

  it('the real binding is configured and lets normal traffic through', async () => {
    expect(typeof (env as unknown as { RATE_LIMITER: { limit: unknown } }).RATE_LIMITER.limit).toBe('function')
    expect((await SELF.fetch(`${URL_}/masjids`, { headers: readHeaders() })).status).toBe(200)
  })
})
