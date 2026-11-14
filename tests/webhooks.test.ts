import { describe, it, expect, afterEach, vi } from 'vitest'
import { SELF, env } from 'cloudflare:test'
import { BASE, KEYS, bearer, writeHeaders, createMasjid, patchMasjid } from './helpers'
import {
  signPayload, verifySignature, backoffSeconds, BACKOFF_SECONDS, dispatchDue, purgeIdempotency,
} from '../src/lib/webhooks'
import worker from '../src/index'
import { isoNow } from '../src/lib/time'

async function keyId(name: keyof typeof KEYS): Promise<number> {
  const r = await env.DB.prepare('SELECT id FROM api_keys WHERE name = ?').bind(`test-${name}`).first<{ id: number }>()
  return r!.id
}

const adminJson = (method: string, path: string, body?: unknown, token: string = KEYS.admin.token) =>
  SELF.fetch(`${BASE}${path}`, {
    method,
    headers: writeHeaders(token, 'ops-1'),
    body: body === undefined ? undefined : JSON.stringify(body),
  })

async function addSub(keyName: keyof typeof KEYS, url = 'https://hooks.example.test/in', secret = 'whsec_test'): Promise<number> {
  const r = await env.DB
    .prepare('INSERT INTO webhook_subscriptions (api_key_id, url, secret) VALUES (?, ?, ?) RETURNING id')
    .bind(await keyId(keyName), url, secret)
    .first<{ id: number }>()
  return r!.id
}

async function delivery(subId: number) {
  return env.DB.prepare('SELECT * FROM webhook_deliveries WHERE subscription_id = ?').bind(subId).first<Record<string, unknown>>()
}

async function setDelivery(subId: number, f: { latest_seq?: number; attempts?: number; status?: string; next?: string }) {
  await env.DB.prepare('DELETE FROM webhook_deliveries WHERE subscription_id = ?').bind(subId).run()
  await env.DB.prepare(
    `INSERT INTO webhook_deliveries (subscription_id, latest_seq, attempts, next_attempt_at, status, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(subId, f.latest_seq ?? 10, f.attempts ?? 0, f.next ?? isoNow(new Date(Date.now() - 1000)), f.status ?? 'pending', isoNow()).run()
}

afterEach(async () => {
  // Keep other tests free of stray subscriptions (writes would try to dispatch them).
  await env.DB.exec('DELETE FROM webhook_deliveries; DELETE FROM webhook_subscriptions;')
})

describe('signature', () => {
  it('round-trips: signed header verifies with the secret, not with another', async () => {
    const body = JSON.stringify({ type: 'changes.available', latest_seq: 5 })
    const t = Math.floor(Date.now() / 1000)
    const header = await signPayload('whsec_abc', body, t)
    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/)
    expect(await verifySignature(header, 'whsec_abc', body)).toBe(true)
    expect(await verifySignature(header, 'whsec_other', body)).toBe(false)
    expect(await verifySignature(header, 'whsec_abc', body + ' ')).toBe(false)
  })

  it('rejects a timestamp outside 300 s and malformed headers', async () => {
    const body = '{}'
    const now = 1_800_000_000
    const old = await signPayload('s', body, now - 301)
    expect(await verifySignature(old, 's', body, now)).toBe(false)
    const ok = await signPayload('s', body, now - 299)
    expect(await verifySignature(ok, 's', body, now)).toBe(true)
    expect(await verifySignature(null, 's', body, now)).toBe(false)
    expect(await verifySignature('garbage', 's', body, now)).toBe(false)
  })

  it('matches the contract formula hex(HMAC_SHA256(secret, t + "." + body))', async () => {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('sek'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('1763116502.{"a":1}')))
    const hex = [...mac].map(b => b.toString(16).padStart(2, '0')).join('')
    expect(await signPayload('sek', '{"a":1}', 1763116502)).toBe(`t=1763116502,v1=${hex}`)
  })
})

describe('backoff schedule', () => {
  it('is 1 m, 5 m, 30 m, 2 h, 6 h, then dropped', () => {
    expect(BACKOFF_SECONDS).toEqual([60, 300, 1800, 7200, 21600])
    expect([1, 2, 3, 4, 5].map(backoffSeconds)).toEqual([60, 300, 1800, 7200, 21600])
    expect(backoffSeconds(6)).toBeNull()
    expect(backoffSeconds(0)).toBeNull()
  })
})

describe('dispatch', () => {
  it('POSTs the thin ping with a verifiable signature and marks the row delivered on 2xx', async () => {
    const sub = await addSub('webhook', 'https://hooks.example.test/ok', 'whsec_dispatch')
    await setDelivery(sub, { latest_seq: 42 })
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init! })
      return new Response(null, { status: 204 })
    }) as unknown as typeof fetch

    const summary = await dispatchDue(env.DB, { fetchFn })
    expect(summary).toMatchObject({ claimed: 1, delivered: 1 })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://hooks.example.test/ok')
    const headers = calls[0].init.headers as Record<string, string>
    const body = calls[0].init.body as string
    expect(JSON.parse(body)).toEqual({ type: 'changes.available', latest_seq: 42 })
    expect(headers['X-Sentral-Delivery']).toMatch(/^dlv_[0-9a-f]{32}$/)
    expect(await verifySignature(headers['X-Sentral-Signature'], 'whsec_dispatch', body)).toBe(true)
    expect((await delivery(sub))!.status).toBe('delivered')

    // Delivered rows are not sent again.
    expect((await dispatchDue(env.DB, { fetchFn })).claimed).toBe(0)
  })

  it('a non-2xx or network error counts an attempt and schedules the backoff', async () => {
    const sub = await addSub('webhook')
    await setDelivery(sub, {})
    const now = new Date('2026-11-14T10:00:00Z')
    await setDelivery(sub, { next: '2026-11-14T09:00:00Z' })
    const fail500 = (async () => new Response('no', { status: 500 })) as unknown as typeof fetch
    const failNet = (async () => { throw new Error('boom') }) as unknown as typeof fetch

    await dispatchDue(env.DB, { fetchFn: fail500, now })
    let row = (await delivery(sub))!
    expect(row).toMatchObject({ status: 'pending', attempts: 1, next_attempt_at: '2026-11-14T10:01:00Z', last_error: 'HTTP 500' })

    // Not due yet.
    expect((await dispatchDue(env.DB, { fetchFn: failNet, now })).claimed).toBe(0)

    // each failure is sent at the previous next_attempt_at: 10:01 + 5 m, +30 m, +2 h, +6 h
    const expected = ['2026-11-14T10:06:00Z', '2026-11-14T10:36:00Z', '2026-11-14T12:36:00Z', '2026-11-14T18:36:00Z']
    let t = new Date('2026-11-14T10:01:00Z')
    for (let i = 0; i < 4; i++) {
      await dispatchDue(env.DB, { fetchFn: failNet, now: t })
      row = (await delivery(sub))!
      expect(row.attempts).toBe(i + 2)
      expect(row.next_attempt_at).toBe(expected[i])
      expect(row.last_error).toBe('boom')
      t = new Date(String(row.next_attempt_at))
    }
    // Fifth failure after the 6 h wait: dropped.
    const summary = await dispatchDue(env.DB, { fetchFn: failNet, now: t })
    expect(summary.dropped).toBe(1)
    row = (await delivery(sub))!
    expect(row.status).toBe('dropped')
    expect(row.attempts).toBe(6)
    expect((await dispatchDue(env.DB, { fetchFn: failNet, now: new Date(t.getTime() + 1e9) })).claimed).toBe(0)
  })

  it('a newer change while a ping is in flight is not lost (result applies only to the same latest_seq)', async () => {
    const sub = await addSub('webhook')
    await setDelivery(sub, { latest_seq: 7 })
    const fetchFn = (async () => {
      // A write lands mid-send: the row is reset to pending with a higher latest_seq.
      await env.DB.prepare("UPDATE webhook_deliveries SET latest_seq = 8, status = 'pending', next_attempt_at = ? WHERE subscription_id = ?")
        .bind(isoNow(new Date(Date.now() - 1000)), sub).run()
      return new Response('ok', { status: 200 })
    }) as unknown as typeof fetch
    await dispatchDue(env.DB, { fetchFn })
    expect(await delivery(sub)).toMatchObject({ status: 'pending', latest_seq: 8 })
  })

  it('processes at most 40 due rows per run', async () => {
    const key = await keyId('webhook')
    for (let i = 0; i < 55; i++) {
      const s = await env.DB.prepare('INSERT INTO webhook_subscriptions (api_key_id, url, secret) VALUES (?, ?, ?) RETURNING id')
        .bind(key, `https://hooks.example.test/${i}`, 's').first<{ id: number }>()
      await setDelivery(s!.id, {})
    }
    const fetchFn = (async () => new Response('ok')) as unknown as typeof fetch
    expect((await dispatchDue(env.DB, { fetchFn })).delivered).toBe(40)
    expect((await dispatchDue(env.DB, { fetchFn })).delivered).toBe(15)
  })

  it('skips inactive subscriptions', async () => {
    const sub = await addSub('webhook')
    await env.DB.prepare('UPDATE webhook_subscriptions SET active = 0 WHERE id = ?').bind(sub).run()
    await setDelivery(sub, {})
    expect((await dispatchDue(env.DB, { fetchFn: (async () => new Response('ok')) as unknown as typeof fetch })).claimed).toBe(0)
  })
})

describe('enqueue on write', () => {
  const stub = () => vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('ok', { status: 500 }))

  it('queues a ping for another app, never for the writer\'s own app, and coalesces to the latest seq', async () => {
    const spy = stub()
    try {
      const subOther = await addSub('webhook') // app qiyam_hooks
      const subOwn = await addSub('jm')        // app jejak_masjid (the writer)
      const m = await createMasjid() // written by jejak_masjid
      const d1 = await delivery(subOther)
      expect(d1).toMatchObject({ status: expect.stringMatching(/pending|delivered/) })
      expect(await delivery(subOwn)).toBeNull()

      const res = await patchMasjid(m.id, m.version, { name: 'Ping 2' })
      const latest = (await res.json() as { version: number }).version
      expect(latest).toBe(2)
      const row = await env.DB.prepare('SELECT MAX(seq) AS s FROM changes').first<{ s: number }>()
      expect((await delivery(subOther))!.latest_seq).toBe(row!.s)
      expect(await delivery(subOwn)).toBeNull()
      const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM webhook_deliveries').first<{ n: number }>()
      expect(count!.n).toBe(1) // one row per subscription
    } finally {
      spy.mockRestore()
    }
  })

  it('a write by the webhook key\'s own app queues nothing for its subscription', async () => {
    const spy = stub()
    try {
      const sub = await addSub('webhook')
      await createMasjid({}, KEYS.webhook.token)
      expect(await delivery(sub)).toBeNull()
    } finally {
      spy.mockRestore()
    }
  })

  it('a failed write queues nothing', async () => {
    const spy = stub()
    try {
      const m = await createMasjid()
      const sub = await addSub('webhook')
      const res = await patchMasjid(m.id, 99, { name: 'Stale' })
      expect(res.status).toBe(409)
      expect(await delivery(sub)).toBeNull()
    } finally {
      spy.mockRestore()
    }
  })
})

describe('backoff under steady writes (M2) and revoked keys (L4)', () => {
  const failing = () => vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('down', { status: 500 }))

  it('a failing endpoint keeps backing off and drops while writes keep coming; a later write revives it', async () => {
    const spy = failing()
    try {
      const sub = await addSub('webhook')
      const m = await createMasjid()
      let version = m.version
      const farFuture = new Date(Date.now() + 3600_000)
      // Already one failed attempt, retry scheduled: new changes must not reset it.
      await setDelivery(sub, { attempts: 1, next: isoNow(farFuture), latest_seq: 1 })
      let next = String((await delivery(sub))!.next_attempt_at)

      for (let attempts = 1; attempts < 6; attempts++) {
        const res = await patchMasjid(m.id, version, { name: `Steady ${attempts}` })
        expect(res.status).toBe(200)
        version = ((await res.json()) as { version: number }).version
        const row = (await delivery(sub))!
        expect(row).toMatchObject({ status: 'pending', attempts, next_attempt_at: next }) // schedule kept
        const maxSeq = (await env.DB.prepare('SELECT MAX(seq) AS s FROM changes').first<{ s: number }>())!.s
        expect(row.latest_seq).toBe(maxSeq) // but latest_seq follows the writes

        // The retry fires at its scheduled time and fails while a newer change exists.
        await dispatchDue(env.DB, { now: new Date(next), fetchFn: (async () => new Response('x', { status: 500 })) as unknown as typeof fetch })
        const after = (await delivery(sub))!
        if (attempts < 5) {
          expect(after).toMatchObject({ status: 'pending', attempts: attempts + 1 })
          next = String(after.next_attempt_at)
          expect(Date.parse(next)).toBeGreaterThan(Date.parse(String(row.next_attempt_at)))
        } else {
          expect(after).toMatchObject({ status: 'dropped', attempts: 6 })
        }
      }

      // A dropped endpoint recovers on the next change.
      const res = await patchMasjid(m.id, version, { name: 'Revive' })
      expect(res.status).toBe(200)
      expect(await delivery(sub)).toMatchObject({ status: 'pending', last_error: null })
      expect((await delivery(sub))!.attempts).toBeLessThanOrEqual(1) // 0, or 1 if the background dispatch already tried
    } finally {
      spy.mockRestore()
    }
  })

  it('revoked or deactivated keys get no enqueue and no dispatch', async () => {
    const spy = failing()
    const kid = await keyId('webhook')
    try {
      const sub = await addSub('webhook')
      await env.DB.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ?').bind(isoNow(), kid).run()
      await createMasjid()
      expect(await delivery(sub)).toBeNull() // not enqueued

      await setDelivery(sub, {})
      expect((await dispatchDue(env.DB, { fetchFn: (async () => new Response('ok')) as unknown as typeof fetch })).claimed).toBe(0)
      await env.DB.prepare('UPDATE api_keys SET revoked_at = NULL, is_active = 0 WHERE id = ?').bind(kid).run()
      expect((await dispatchDue(env.DB, { fetchFn: (async () => new Response('ok')) as unknown as typeof fetch })).claimed).toBe(0)
    } finally {
      await env.DB.prepare('UPDATE api_keys SET revoked_at = NULL, is_active = 1 WHERE id = ?').bind(kid).run()
      spy.mockRestore()
    }
  })
})

describe('admin webhook registration', () => {
  it('creates a subscription, returns the whsec_ secret once, and never lists it', async () => {
    const res = await adminJson('POST', '/admin/webhooks', { api_key_id: await keyId('webhook'), url: 'https://qiyam.example/hook' })
    expect(res.status).toBe(201)
    const body = await res.json() as { id: number; secret: string; url: string; app_id: string }
    expect(body.secret).toMatch(/^whsec_[0-9a-f]{64}$/)
    expect(body).toMatchObject({ url: 'https://qiyam.example/hook', app_id: 'qiyam_hooks' })

    const list = await SELF.fetch(`${BASE}/admin/webhooks`, { headers: bearer(KEYS.admin.token) })
    const text = await list.text()
    expect(text).not.toContain(body.secret)
    expect(JSON.parse(text).webhooks).toHaveLength(1)

    const del = await adminJson('DELETE', `/admin/webhooks/${body.id}`)
    expect(del.status).toBe(204)
    expect((await adminJson('DELETE', `/admin/webhooks/${body.id}`)).status).toBe(404)
  })

  it('accepts only https URLs, and only keys that hold the webhook scope', async () => {
    const webhookKey = await keyId('webhook')
    expect((await adminJson('POST', '/admin/webhooks', { api_key_id: webhookKey, url: 'http://insecure.example/h' })).status).toBe(422)
    expect((await adminJson('POST', '/admin/webhooks', { api_key_id: webhookKey, url: 'ftp://x/h' })).status).toBe(422)
    expect((await adminJson('POST', '/admin/webhooks', { api_key_id: await keyId('jm'), url: 'https://x.example/h' })).status).toBe(422)
    expect((await adminJson('POST', '/admin/webhooks', { api_key_id: 999999, url: 'https://x.example/h' })).status).toBe(422)
    expect((await adminJson('POST', '/admin/webhooks', { url: 'https://x.example/h' })).status).toBe(422)
  })

  it('a duplicate (key, url) registration is 409 already_exists and does not touch the first', async () => {
    const body = { api_key_id: await keyId('webhook'), url: 'https://dup.example/hook' }
    const first = await adminJson('POST', '/admin/webhooks', body)
    expect(first.status).toBe(201)
    const second = await adminJson('POST', '/admin/webhooks', body)
    expect(second.status).toBe(409)
    const text = await second.text()
    expect(JSON.parse(text)).toMatchObject({ code: 'already_exists' })
    expect(text).not.toContain('whsec_')
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM webhook_subscriptions').first<{ n: number }>()
    expect(n!.n).toBe(1)
  })

  it('is admin-only', async () => {
    const body = { api_key_id: await keyId('webhook'), url: 'https://x.example/h' }
    expect((await adminJson('POST', '/admin/webhooks', body, KEYS.jm.token)).status).toBe(403)
    expect((await adminJson('POST', '/admin/webhooks', body, KEYS.webhook.token)).status).toBe(403)
    expect((await SELF.fetch(`${BASE}/admin/webhooks`, { headers: bearer(KEYS.jm.token) })).status).toBe(403)
  })
})

describe('cron', () => {
  it('exports scheduled next to fetch, and the sweep drops idempotency rows older than 24 h', async () => {
    expect(typeof worker.fetch).toBe('function')
    expect(typeof worker.scheduled).toBe('function')
    const jm = await keyId('jm')
    const ins = (k: string, at: string) => env.DB.prepare(
      `INSERT INTO idempotency_keys (api_key_id, key, request_hash, response_status, response_json, created_at) VALUES (?, ?, 'h', 200, '{}', ?)`,
    ).bind(jm, k, at).run()
    await ins('sweep-old', isoNow(new Date(Date.now() - 25 * 3600 * 1000)))
    await ins('sweep-new', isoNow(new Date(Date.now() - 23 * 3600 * 1000)))
    await purgeIdempotency(env.DB)
    const rows = await env.DB.prepare("SELECT key FROM idempotency_keys WHERE key LIKE 'sweep-%'").run<{ key: string }>()
    expect(rows.results.map(r => r.key)).toEqual(['sweep-new'])
  })

  it('scheduled() dispatches due pings', async () => {
    const sub = await addSub('webhook')
    await setDelivery(sub, { latest_seq: 3 })
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('ok', { status: 200 }))
    try {
      const pending: Promise<unknown>[] = []
      await worker.scheduled({} as ScheduledController, env, { waitUntil: (p: Promise<unknown>) => { pending.push(p) } } as unknown as ExecutionContext)
      await Promise.all(pending)
      expect(spy).toHaveBeenCalledTimes(1)
      expect((await delivery(sub))!.status).toBe('delivered')
    } finally {
      spy.mockRestore()
    }
  })
})
