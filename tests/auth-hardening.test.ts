import { describe, it, expect } from 'vitest'
import { SELF, env } from 'cloudflare:test'
import app from '../src/index'
import { getActor } from '../src/middleware/auth'
import { KEYS, bearer, readHeaders, writeHeaders } from './helpers'
// @ts-expect-error plain .mjs script
import { issueKey, sha256Hex as scriptSha, parseScopes } from '../scripts/issue-key.mjs'

const U = 'http://example.com'
const BODY = JSON.stringify({
  name: 'Hardening Masjid', type_id: 'masjid', state_id: 'my-kul', country_id: 'my',
  lat: 3.147, lng: 101.698, address: '1 Jalan Test', source: 'manual',
})
const count = async () =>
  (await env.DB.prepare('SELECT COUNT(*) AS n FROM masjids').first<{ n: number }>())!.n

describe('no key anywhere -> 401', () => {
  const routes = ['/masjids', '/masjids/nearby?lat=3&lng=101', '/masjids/1', '/states', '/cities?state=my-kul', '/admin', '/admin/anything', '/nope']
  for (const path of routes) {
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'POST', 'PATCH', 'PUT', 'DELETE']) {
      it(`${method} ${path}`, async () => {
        const res = await SELF.fetch(U + path, { method, body: ['POST', 'PATCH', 'PUT'].includes(method) ? BODY : undefined })
        expect(res.status).toBe(401)
      })
    }
  }
})

describe('malformed token is rejected without a D1 query', () => {
  it('wrong format -> 401 even though the hash is never looked up', async () => {
    const brokenDb = { prepare: () => { throw new Error('D1 was queried') } }
    const res = await app.request('/masjids', { headers: bearer('test-api-key-dev') }, { ...env, DB: brokenDb })
    expect(res.status).toBe(401)
    const short = await app.request('/masjids', { headers: bearer('ms_live_short') }, { ...env, DB: brokenDb })
    expect(short.status).toBe(401)
  })
})

describe('/admin fails closed', () => {
  for (const path of ['/admin', '/admin/anything', '/admin/webhooks']) {
    for (const [name, token] of [['read', KEYS.read.token], ['write', KEYS.jm.token]] as const) {
      it(`GET ${path} with ${name} key -> 403`, async () => {
        const res = await SELF.fetch(U + path, { headers: bearer(token) })
        expect(res.status).toBe(403)
        expect((await res.json() as { code: string }).code).toBe('forbidden')
      })
      it(`POST ${path} with ${name} key -> 403`, async () => {
        const res = await SELF.fetch(U + path, { method: 'POST', headers: writeHeaders(token), body: '{}' })
        expect(res.status).toBe(403)
      })
    }
  }

  it('admin key passes the scope check (unbuilt route -> 404, not 403)', async () => {
    const res = await SELF.fetch(U + '/admin/anything', { headers: bearer(KEYS.admin.token) })
    expect(res.status).toBe(404)
  })

  it('admin writes still need a valid actor (422), but not write scope/app_id', async () => {
    const noActor = await SELF.fetch(U + '/admin/anything', { method: 'POST', headers: { ...bearer(KEYS.admin.token), 'Content-Type': 'application/json' }, body: '{}' })
    expect(noActor.status).toBe(422)
    const ok = await SELF.fetch(U + '/admin/anything', { method: 'POST', headers: writeHeaders(KEYS.admin.token), body: '{}' })
    expect(ok.status).toBe(404)
  })
})

describe('actor validation', () => {
  it('whitespace-only and control characters -> 422, no row written', async () => {
    const before = await count()
    for (const actor of ['   ', 'bad\u0000actor', 'tab\tactor', 'new\nline']) {
      const res = await SELF.fetch(U + '/masjids', {
        method: 'POST', headers: { ...writeHeaders(KEYS.jm.token), 'X-Sentral-Actor': actor }, body: BODY,
      }).catch(() => null)
      // Some runtimes refuse to send control chars at all; either way nothing is written.
      if (res) expect(res.status).toBe(422)
    }
    expect(await count()).toBe(before)
  })

  it('trims surrounding whitespace and accepts the write', async () => {
    const res = await SELF.fetch(U + '/masjids', {
      method: 'POST', headers: { ...writeHeaders(), 'X-Sentral-Actor': '  user-1  ' }, body: BODY,
    })
    expect(res.status).toBe(201)
  })

  it('403 / 422 write rejections leave the row count unchanged', async () => {
    const before = await count()
    const readOnly = await SELF.fetch(U + '/masjids', { method: 'POST', headers: { ...readHeaders(), 'X-Sentral-Actor': 'u' }, body: BODY })
    expect(readOnly.status).toBe(403)
    const { 'X-Sentral-Actor': _o, ...noActor } = writeHeaders()
    const missing = await SELF.fetch(U + '/masjids', { method: 'POST', headers: noActor, body: BODY })
    expect(missing.status).toBe(422)
    expect(await count()).toBe(before)
  })

  it('getActor throws without a validated actor', () => {
    expect(() => getActor({ get: () => undefined })).toThrow()
  })
})

describe('rate limit on the real app', () => {
  const denied = { limit: async () => ({ success: false }) }
  const e = () => ({ ...env, RATE_LIMITER: denied })

  it('429 on /masjids after auth', async () => {
    const res = await app.request('/masjids', { headers: readHeaders() }, e())
    expect(res.status).toBe(429)
    expect((await res.json() as { code: string }).code).toBe('rate_limited')
    expect(res.headers.get('Retry-After')).toBeTruthy()
  })

  it('no key is still 401 (limiter after auth)', async () => {
    expect((await app.request('/masjids', {}, e())).status).toBe(401)
  })

  it('429 beats writeGuard (a write with no actor is 429, not 422)', async () => {
    const res = await app.request('/masjids', { method: 'POST', headers: { ...bearer(KEYS.jm.token), 'Content-Type': 'application/json' }, body: BODY }, e())
    expect(res.status).toBe(429)
  })
})

describe('issue-key script', () => {
  it('prints a token whose SHA-256 matches the SQL, in the accepted format', async () => {
    const { token, hash, sql } = await issueKey('qiyam', 'read,write')
    expect(token).toMatch(/^ms_live_[A-Za-z0-9_-]{43}$/)
    expect(hash).toBe(await scriptSha(token))
    expect(sql).toContain(hash)
    expect(sql).toContain("'qiyam'")
    // the issued key actually authenticates once inserted
    await env.DB.prepare(sql).run()
    expect((await SELF.fetch(U + '/masjids', { headers: bearer(token) })).status).toBe(200)
  })

  it('rejects unknown scopes and bad app ids', async () => {
    expect(() => parseScopes('read,root')).toThrow()
    await expect(issueKey('Bad App', 'read')).rejects.toThrow()
  })

  it('tokens are unique', async () => {
    const a = await issueKey('qiyam', 'read'); const b = await issueKey('qiyam', 'read')
    expect(a.token).not.toBe(b.token)
  })
})
