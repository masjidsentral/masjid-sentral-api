import { describe, it, expect } from 'vitest'
import { SELF, env } from 'cloudflare:test'
import {
  BASE, KEYS, writeHeaders, readHeaders, createMasjid, patchMasjid, getMasjid, MASJID_BODY,
} from './helpers'
import { loadMasjid } from '../src/lib/entities'
import { runCommit, type WriteCtx, type WriteSpec } from '../src/lib/write'
import { isoNow } from '../src/lib/time'

// S2: write pipeline (idempotency, versions, atomic commit, change log).

async function changeRows(id: number) {
  const r = await env.DB
    .prepare('SELECT * FROM changes WHERE entity = ? AND entity_id = ? ORDER BY seq')
    .bind('masjid', id)
    .run<Record<string, unknown>>()
  return r.results
}

async function idemRow(keyId: number, key: string) {
  return env.DB.prepare('SELECT * FROM idempotency_keys WHERE api_key_id = ? AND key = ?').bind(keyId, key).first<Record<string, unknown>>()
}

async function keyId(name: keyof typeof KEYS): Promise<number> {
  const r = await env.DB.prepare('SELECT id FROM api_keys WHERE name = ?').bind(`test-${name}`).first<{ id: number }>()
  return r!.id
}

describe('create', () => {
  it('returns the full contract entity, version 1, and writes one create change with matching after_json', async () => {
    const m = await createMasjid({ images: [{ url: 'https://img.example/a.jpg', is_thumbnail: true }] })
    expect(m.version).toBe(1)
    expect(m.updated_by_app).toBe('jejak_masjid')
    expect(m.geohash).toHaveLength(9)
    expect(m.lat).toBe(MASJID_BODY.lat) // stored unrounded (contract R9)
    expect(m.status).toBe('active')
    expect(m.created_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/)

    const rows = await changeRows(m.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ op: 'create', version: 1, origin_app: 'jejak_masjid', actor: 'user-1', masjid_id: m.id, before_json: null })
    // after_json is exactly what GET returns.
    const got = await getMasjid(m.id)
    expect(JSON.parse(rows[0].after_json as string)).toEqual(got)
    expect(got.images).toEqual([{ url: 'https://img.example/a.jpg', is_thumbnail: true, sort_order: 0 }])
    expect(m).toEqual(got)
  })

  it('requires an Idempotency-Key (422) and writes nothing without it', async () => {
    const before = await env.DB.prepare('SELECT COUNT(*) AS n FROM changes').first<{ n: number }>()
    const { 'Idempotency-Key': _k, ...headers } = writeHeaders()
    const res = await SELF.fetch(`${BASE}/masjids`, { method: 'POST', headers, body: JSON.stringify(MASJID_BODY) })
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ code: 'validation_failed', details: { header: 'Idempotency-Key' } })
    const after = await env.DB.prepare('SELECT COUNT(*) AS n FROM changes').first<{ n: number }>()
    expect(after!.n).toBe(before!.n)
  })

  it('rejects unknown references with 422', async () => {
    const res = await SELF.fetch(`${BASE}/masjids`, {
      method: 'POST', headers: writeHeaders(), body: JSON.stringify({ ...MASJID_BODY, state_id: 'my-nope' }),
    })
    expect(res.status).toBe(422)
  })
})

describe('idempotency', () => {
  it('replays an identical body for the same key + same request', async () => {
    const key = `idem-create-${crypto.randomUUID()}`
    const send = () => SELF.fetch(`${BASE}/masjids`, {
      method: 'POST',
      headers: writeHeaders(KEYS.jm.token, 'user-1', { 'Idempotency-Key': key }),
      body: JSON.stringify({ ...MASJID_BODY, name: 'Idem Create' }),
    })
    const first = await send()
    const second = await send()
    expect(first.status).toBe(201)
    expect(second.status).toBe(201)
    expect(second.headers.get('Idempotent-Replay')).toBe('true')
    const a = await first.text()
    const b = await second.text()
    expect(b).toBe(a)
    const id = (JSON.parse(a) as { id: number }).id
    expect(await changeRows(id)).toHaveLength(1)
    const dup = await env.DB.prepare("SELECT COUNT(*) AS n FROM masjids WHERE name = 'Idem Create'").first<{ n: number }>()
    expect(dup!.n).toBe(1)
  })

  it('replays a PATCH even though If-Match is now stale, and writes one change', async () => {
    const m = await createMasjid()
    const key = `idem-patch-${crypto.randomUUID()}`
    const first = await patchMasjid(m.id, m.version, { name: 'Replay Name' }, { idemKey: key })
    const second = await patchMasjid(m.id, m.version, { name: 'Replay Name' }, { idemKey: key })
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(await second.text()).toBe(await first.text())
    expect((await getMasjid(m.id)).version).toBe(2)
    expect(await changeRows(m.id)).toHaveLength(2) // create + one update
  })

  it('409 idempotency_mismatch for the same key with a different body', async () => {
    const m = await createMasjid()
    const key = `idem-mismatch-${crypto.randomUUID()}`
    expect((await patchMasjid(m.id, m.version, { name: 'One' }, { idemKey: key })).status).toBe(200)
    const res = await patchMasjid(m.id, m.version + 1, { name: 'Two' }, { idemKey: key })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'idempotency_mismatch' })
    expect((await getMasjid(m.id)).name).toBe('One')
  })

  it('keys are scoped per API key', async () => {
    const key = `shared-${crypto.randomUUID()}`
    const mk = (token: string) => SELF.fetch(`${BASE}/masjids`, {
      method: 'POST',
      headers: writeHeaders(token, 'user-1', { 'Idempotency-Key': key }),
      body: JSON.stringify({ ...MASJID_BODY, name: `Scoped ${token === KEYS.jm.token ? 'jm' : 'qiyam'}` }),
    })
    const a = await mk(KEYS.jm.token)
    const b = await mk(KEYS.qiyam.token)
    expect(a.status).toBe(201)
    expect(b.status).toBe(201)
    expect((await a.json() as { id: number }).id).not.toBe((await b.json() as { id: number }).id)
  })

  it('an expired idempotency row (older than 24 h) frees the key', async () => {
    const m = await createMasjid()
    const key = `idem-old-${crypto.randomUUID()}`
    await env.DB.prepare(
      `INSERT INTO idempotency_keys (api_key_id, key, request_hash, response_status, response_json, created_at) VALUES (?, ?, 'x', 200, '{}', ?)`,
    ).bind(await keyId('jm'), key, isoNow(new Date(Date.now() - 25 * 3600 * 1000))).run()
    const res = await patchMasjid(m.id, m.version, { name: 'Fresh' }, { idemKey: key })
    expect(res.status).toBe(200)
  })
})

describe('version checks', () => {
  it('PATCH without If-Match is 422 and writes nothing', async () => {
    const m = await createMasjid()
    const res = await patchMasjid(m.id, null, { name: 'X' })
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ code: 'validation_failed', details: { header: 'If-Match' } })
    expect(await changeRows(m.id)).toHaveLength(1)
  })

  it('a stale If-Match is 409 version_conflict with details.current, and writes no change row', async () => {
    const m = await createMasjid()
    expect((await patchMasjid(m.id, m.version, { telephone: '+60312345678' })).status).toBe(200)
    const key = `stale-${crypto.randomUUID()}`
    const res = await patchMasjid(m.id, m.version, { name: 'Stale' }, { idemKey: key })
    expect(res.status).toBe(409)
    const body = await res.json() as { code: string; details: { current: MasjidJsonLike } }
    expect(body.code).toBe('version_conflict')
    expect(body.details.current.version).toBe(2)
    expect(body.details.current.telephone).toBe('+60312345678')
    expect(await changeRows(m.id)).toHaveLength(2)
    expect(await idemRow(await keyId('jm'), key)).toBeNull() // a conflict is never stored
    expect((await getMasjid(m.id)).name).toBe(MASJID_BODY.name)
  })

  it('accepts a quoted If-Match', async () => {
    const m = await createMasjid()
    expect((await patchMasjid(m.id, `"${m.version}"`, { name: 'Quoted' })).status).toBe(200)
  })

  it('records changed_fields, before_json and after_json on update', async () => {
    const m = await createMasjid()
    const res = await patchMasjid(m.id, m.version, { telephone: '+60311111111', name: MASJID_BODY.name })
    expect(res.status).toBe(200)
    const rows = await changeRows(m.id)
    const last = rows[rows.length - 1]
    expect(last).toMatchObject({ op: 'update', version: 2, origin_app: 'jejak_masjid', actor: 'user-1' })
    expect(JSON.parse(last.changed_fields as string)).toEqual(['telephone']) // name did not change
    expect(JSON.parse(last.before_json as string)).toEqual(m)
    expect(JSON.parse(last.after_json as string)).toEqual(await getMasjid(m.id))
  })

  it('PATCH of a missing masjid is 404', async () => {
    expect((await patchMasjid(999999, 1, { name: 'X' })).status).toBe(404)
  })
})

describe('atomic commit (race)', () => {
  it('two PATCHes from the same base: exactly one 200, one 409 with details.current, one change row', async () => {
    const m = await createMasjid({ images: [{ url: 'https://img.example/base.jpg' }] })
    const keyA = `race-a-${crypto.randomUUID()}`
    const keyB = `race-b-${crypto.randomUUID()}`
    const [ra, rb] = await Promise.all([
      patchMasjid(m.id, m.version, { name: 'Race A', images: [{ url: 'https://img.example/a.jpg' }] }, { idemKey: keyA }),
      patchMasjid(m.id, m.version, { name: 'Race B', images: [{ url: 'https://img.example/b.jpg' }] }, { idemKey: keyB }),
    ])
    const statuses = [ra.status, rb.status].sort()
    expect(statuses).toEqual([200, 409])
    const [winner, loser, winKey, loseKey, winName, winImg] = ra.status === 200
      ? [ra, rb, keyA, keyB, 'Race A', 'https://img.example/a.jpg']
      : [rb, ra, keyB, keyA, 'Race B', 'https://img.example/b.jpg']
    expect(((await winner.json()) as { version: number }).version).toBe(2)
    const lbody = await loser.json() as { code: string; details: { current: MasjidJsonLike } }
    expect(lbody.code).toBe('version_conflict')
    expect(lbody.details.current.version).toBe(2)
    expect(lbody.details.current.name).toBe(winName)

    const rows = await changeRows(m.id)
    expect(rows.filter(r => r.version === 2)).toHaveLength(1)
    expect(rows).toHaveLength(2)
    const jm = await keyId('jm')
    expect(await idemRow(jm, winKey)).not.toBeNull()
    expect(await idemRow(jm, loseKey)).toBeNull()
    const final = await getMasjid(m.id)
    expect(final.name).toBe(winName)
    expect(final.images.map(i => i.url)).toEqual([winImg]) // loser's children did not persist
  })

  // Bypasses the handler's early version check so the batch guard itself is what rejects the loser.
  it('the batch guard alone rejects a stale commit and persists nothing (changes, idempotency, children, webhooks)', async () => {
    const m = await createMasjid({ images: [{ url: 'https://img.example/base.jpg' }] })
    const db = env.DB
    const jm = await keyId('jm')
    const before = (await loadMasjid(db, m.id))!

    const makeCtx = (idemKey: string, name: string): { ctx: WriteCtx; spec: WriteSpec } => {
      const now = isoNow()
      const after = { ...before, name, version: before.version + 1, updated_at: now, images: [{ url: `https://img.example/${name}.jpg`, is_thumbnail: false, sort_order: 0 }] }
      const ctx: WriteCtx = {
        db, keyId: jm, originApp: 'jejak_masjid', actor: 'user-1', idemKey, requestHash: `h-${idemKey}`, bodyText: '', ifMatch: before.version,
      }
      const spec: WriteSpec = {
        entity: 'masjid', op: 'update', entityId: m.id, baseVersion: before.version, masjidId: null,
        changedFields: ['images', 'name'], before, after, status: 200,
        entityStatement: db
          .prepare('UPDATE masjids SET name = ?, version = version + 1, updated_by_app = ?, updated_at = ? WHERE id = ? AND version = ?')
          .bind(name, 'jejak_masjid', now, m.id, before.version),
        children: (b) => [
          b.stmt('DELETE FROM masjid_images WHERE masjid_id = {{ID}} AND {{G}}'),
          b.stmt('INSERT INTO masjid_images (masjid_id, url, is_thumbnail, sort_order, created_at) SELECT {{ID}}, ?, 0, 0, ? WHERE {{G}}', [after.images[0].url, now]),
        ],
      }
      return { ctx, spec }
    }

    // A subscription for another app, to prove the webhook enqueue is chained too.
    const sub = await db.prepare("INSERT INTO webhook_subscriptions (api_key_id, url, secret) VALUES (?, 'https://hooks.example/race', 's') RETURNING id")
      .bind(await keyId('webhook')).first<{ id: number }>()

    const a = makeCtx(`guard-a-${crypto.randomUUID()}`, 'GuardA')
    const b = makeCtx(`guard-b-${crypto.randomUUID()}`, 'GuardB')
    const first = await runCommit(a.ctx, a.spec)
    expect(first.ok).toBe(true)
    await db.prepare('DELETE FROM webhook_deliveries WHERE subscription_id = ?').bind(sub!.id).run()

    const second = await runCommit(b.ctx, b.spec)
    expect(second.ok).toBe(false)

    expect((await changeRows(m.id)).filter(r => r.version === 2)).toHaveLength(1)
    expect(await idemRow(jm, b.ctx.idemKey)).toBeNull()
    expect(await idemRow(jm, a.ctx.idemKey)).not.toBeNull()
    const final = await getMasjid(m.id)
    expect(final.name).toBe('GuardA')
    expect(final.version).toBe(2)
    expect(final.images.map(i => i.url)).toEqual(['https://img.example/GuardA.jpg'])
    const del = await db.prepare('SELECT * FROM webhook_deliveries WHERE subscription_id = ?').bind(sub!.id).first()
    expect(del).toBeNull() // the loser enqueued no ping
    await db.prepare('DELETE FROM webhook_subscriptions WHERE id = ?').bind(sub!.id).run()
  })

  it('changes() chaining behaves as documented inside a D1 batch (guards for the loser fire as 0)', async () => {
    const m = await createMasjid()
    const [upd, ins] = await env.DB.batch([
      env.DB.prepare('UPDATE masjids SET name = ? WHERE id = ? AND version = ?').bind('nope', m.id, 999),
      env.DB.prepare("INSERT INTO changes (entity, entity_id, op, version, origin_app, actor, after_json, occurred_at) SELECT 'masjid', ?, 'update', 999, 'x', 'x', '{}', 'x' WHERE changes() = 1").bind(m.id),
    ])
    expect(upd.meta.changes).toBe(0)
    expect(ins.meta.changes).toBe(0)
    expect((await changeRows(m.id)).filter(r => r.version === 999)).toHaveLength(0)
  })

  it('a batch that throws rolls everything back (same Idempotency-Key collision)', async () => {
    const m = await createMasjid()
    const jm = await keyId('jm')
    const key = `dup-${crypto.randomUUID()}`
    await env.DB.prepare(
      `INSERT INTO idempotency_keys (api_key_id, key, request_hash, response_status, response_json, created_at) VALUES (?, ?, 'other', 200, '{"x":1}', ?)`,
    ).bind(jm, key, isoNow()).run()
    const before = (await loadMasjid(env.DB, m.id))!
    const now = isoNow()
    const ctx: WriteCtx = { db: env.DB, keyId: jm, originApp: 'jejak_masjid', actor: 'u', idemKey: key, requestHash: 'h', bodyText: '', ifMatch: 1 }
    const spec: WriteSpec = {
      entity: 'masjid', op: 'update', entityId: m.id, baseVersion: 1, masjidId: null, changedFields: ['name'], before,
      after: { ...before, name: 'Rolled', version: 2 }, status: 200,
      entityStatement: env.DB.prepare('UPDATE masjids SET name = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?').bind('Rolled', now, m.id, 1),
    }
    await expect(runCommit(ctx, spec)).rejects.toThrow()
    expect((await getMasjid(m.id)).name).toBe(MASJID_BODY.name)
    expect(await changeRows(m.id)).toHaveLength(1)
  })
})

describe('v1.0 handlers on the new schema', () => {
  it('list and nearby return active rows with a version and no source column', async () => {
    const m = await createMasjid({ name: 'Listed Masjid' })
    const list = await (await SELF.fetch(`${BASE}/masjids?q=Listed`, { headers: readHeaders() })).json() as { data: Array<Record<string, unknown>> }
    const row = list.data.find(r => r.id === m.id)!
    expect(row.version).toBe(1)
    expect('source' in row).toBe(false)
    const near = await (await SELF.fetch(`${BASE}/masjids/nearby?lat=${m.lat}&lng=${m.lng}&radius=1`, { headers: readHeaders() })).json() as { data: Array<{ id: number }> }
    expect(near.data.some(r => r.id === m.id)).toBe(true)
  })

  it('a merged masjid is 301 to the survivor; a deleted one returns its tombstone', async () => {
    const survivor = await createMasjid({ name: 'Survivor' })
    const loser = await createMasjid({ name: 'Loser' })
    await env.DB.prepare("UPDATE masjids SET status = 'merged', merged_into = ? WHERE id = ?").bind(survivor.id, loser.id).run()
    const res = await SELF.fetch(`${BASE}/masjids/${loser.id}`, { headers: readHeaders(), redirect: 'manual' })
    expect(res.status).toBe(301)
    expect(res.headers.get('Location')).toBe(`/masjids/${survivor.id}`)
    const del = await createMasjid({ name: 'Gone' })
    await env.DB.prepare("UPDATE masjids SET status = 'deleted' WHERE id = ?").bind(del.id).run()
    const tomb = await SELF.fetch(`${BASE}/masjids/${del.id}`, { headers: readHeaders() })
    expect(tomb.status).toBe(200)
    expect(((await tomb.json()) as { status: string }).status).toBe('deleted')
    const list = await (await SELF.fetch(`${BASE}/masjids?q=Gone`, { headers: readHeaders() })).json() as { data: unknown[] }
    expect(list.data).toHaveLength(0)
  })
})

interface MasjidJsonLike { version: number; name: string; telephone: string | null }
