import { describe, it, expect } from 'vitest'
import { env } from 'cloudflare:test'
import { KEYS, MASJID_BODY, api, createMasjid, getMasjid, spot, type MasjidJson } from './helpers'

interface Err { error: string; code: string; details?: Record<string, any> }
interface Candidate { id: number; name: string; score: number; distance_m: number; external_ids: unknown[]; type_id: string; lat: number; lng: number; address: string | null }

async function changesOf(masjidId: number) {
  const r = await env.DB.prepare('SELECT * FROM changes WHERE masjid_id = ? ORDER BY seq').bind(masjidId).all<Record<string, any>>()
  return r.results
}

const body = (n: number, extra: Record<string, unknown> = {}) => ({ ...MASJID_BODY, ...spot(n), ...extra })

describe('GET /masjids/match', () => {
  it('scores a variant spelling 20 m away at >= 0.9 and returns the summary shape', async () => {
    const p = spot(1)
    const m = await createMasjid({ ...p, name: 'MASJID AL-HIDAYAH' })
    const q = spot(1, 20)
    const res = await api('GET', `/masjids/match?lat=${q.lat}&lng=${q.lng}&name=${encodeURIComponent('Masjid Al Hidayah')}`)
    expect(res.status).toBe(200)
    const { candidates } = await res.json() as { candidates: Candidate[] }
    expect(candidates[0]).toMatchObject({ id: m.id, name: 'MASJID AL-HIDAYAH', type_id: 'masjid', external_ids: [] })
    expect(candidates[0].score).toBeGreaterThanOrEqual(0.9)
    expect(candidates[0].distance_m).toBeGreaterThanOrEqual(15)
    expect(candidates[0].distance_m).toBeLessThanOrEqual(25)
  })

  it('scores Surau Al-Ikhlas vs Surau An-Nur 30 m apart under 0.6', async () => {
    await createMasjid({ ...spot(2), name: 'Surau Al-Ikhlas', type_id: 'surau' })
    const q = spot(2, 30)
    const res = await api('GET', `/masjids/match?lat=${q.lat}&lng=${q.lng}&name=${encodeURIComponent('Surau An-Nur')}`)
    const { candidates } = await res.json() as { candidates: Candidate[] }
    expect(candidates).toHaveLength(1)
    expect(candidates[0].score).toBeLessThan(0.6)
  })

  it('only looks within 1 km, only active masjids, and returns the top 5', async () => {
    const far = await createMasjid({ ...spot(3, 2000), name: 'Masjid Jauh' })
    const gone = await createMasjid({ ...spot(3, 10), name: 'Masjid Padam' })
    for (let i = 0; i < 6; i++) await createMasjid({ ...spot(3, 100 + i * 50), name: `Masjid Taman ${i}` })
    const del = await api('DELETE', `/masjids/${gone.id}`, { ifMatch: gone.version })
    expect(del.status).toBe(200)

    const q = spot(3)
    const res = await api('GET', `/masjids/match?lat=${q.lat}&lng=${q.lng}&name=Masjid%20Taman%200`)
    const { candidates } = await res.json() as { candidates: Candidate[] }
    expect(candidates).toHaveLength(5)
    expect(candidates.map(c => c.id)).not.toContain(far.id)
    expect(candidates.map(c => c.id)).not.toContain(gone.id)
    expect(candidates[0].name).toBe('Masjid Taman 0')
    for (let i = 1; i < candidates.length; i++) expect(candidates[i - 1].score).toBeGreaterThanOrEqual(candidates[i].score)
  })

  it('needs lat, lng and name', async () => {
    for (const q of ['lat=1&lng=2', 'lat=1&name=x', 'lng=2&name=x', 'lat=x&lng=2&name=x']) {
      const res = await api('GET', `/masjids/match?${q}`)
      expect(res.status).toBe(422)
      expect(((await res.json()) as Err).code).toBe('validation_failed')
    }
  })

  it('needs the read scope and an API key', async () => {
    const { SELF } = await import('cloudflare:test')
    expect((await SELF.fetch('http://example.com/masjids/match?lat=1&lng=1&name=x')).status).toBe(401)
  })
})

describe('duplicate gate on POST /masjids', () => {
  it('409 possible_duplicate with candidates for a >= 0.9 match within 50 m; writes nothing', async () => {
    const existing = await createMasjid({ ...spot(4), name: 'Masjid Al-Hidayah' })
    const before = await env.DB.prepare('SELECT COUNT(*) AS n FROM masjids').first<{ n: number }>()
    const res = await api('POST', '/masjids', { body: body(4, { ...spot(4, 20), name: 'MASJID AL HIDAYAH' }) })
    expect(res.status).toBe(409)
    const err = await res.json() as Err
    expect(err.code).toBe('possible_duplicate')
    expect(err.details!.candidates[0]).toMatchObject({ id: existing.id })
    expect(err.details!.candidates[0].score).toBeGreaterThanOrEqual(0.9)
    const after = await env.DB.prepare('SELECT COUNT(*) AS n FROM masjids').first<{ n: number }>()
    expect(after!.n).toBe(before!.n)
  })

  it('?force=true creates it and records "forced": true in the change only', async () => {
    const res = await api('POST', '/masjids?force=true', { body: body(4, { ...spot(4, 20), name: 'Masjid Al-Hidayah' }) })
    expect(res.status).toBe(201)
    const created = await res.json() as MasjidJson
    expect(created).not.toHaveProperty('forced')
    const [row] = await changesOf(created.id)
    expect(JSON.parse(row.after_json).forced).toBe(true)
  })

  it('a similar name beyond 50 m, or a different name within 50 m, is not a duplicate', async () => {
    await createMasjid({ ...spot(5), name: 'Masjid Taman Desa' })
    const far = await api('POST', '/masjids', { body: body(5, { ...spot(5, 120), name: 'Masjid Taman Desa' }) })
    expect(far.status).toBe(201)
    const other = await api('POST', '/masjids', { body: body(5, { ...spot(5, 10), name: 'Masjid Bukit Indah' }) })
    expect(other.status).toBe(201)
  })

  it('an unforced create has no "forced" key in its change', async () => {
    const res = await api('POST', '/masjids', { body: body(6) })
    const created = await res.json() as MasjidJson
    const [row] = await changesOf(created.id)
    expect(JSON.parse(row.after_json)).not.toHaveProperty('forced')
  })
})

describe('external ids', () => {
  it('POST with external_id links it in the same write; by-external finds it', async () => {
    const res = await api('POST', '/masjids', { token: KEYS.qiyam.token, body: body(7, { external_id: 'q_1' }) })
    expect(res.status).toBe(201)
    const m = await res.json() as MasjidJson
    expect(m.external_ids).toEqual([{ app_id: 'qiyam', external_id: 'q_1' }])
    const [row] = await changesOf(m.id)
    expect(row.changed_fields).toContain('external_ids')

    const found = await api('GET', '/masjids/by-external/qiyam/q_1')
    expect(found.status).toBe(200)
    expect(((await found.json()) as MasjidJson).id).toBe(m.id)
    expect((await api('GET', '/masjids/by-external/qiyam/nope')).status).toBe(404)
    expect((await api('GET', '/masjids/by-external/jejak_masjid/q_1')).status).toBe(404)
  })

  it('POST with an existing (app_id, external_id) is 409 already_linked with details.masjid_id', async () => {
    const first = await createMasjid({ ...spot(8), external_id: 'q_dup' }, KEYS.qiyam.token)
    const res = await api('POST', '/masjids', { token: KEYS.qiyam.token, body: body(9, { external_id: 'q_dup' }) })
    expect(res.status).toBe(409)
    const err = await res.json() as Err
    expect(err.code).toBe('already_linked')
    expect(err.details!.masjid_id).toBe(first.id)
    // Another app may use the same string for its own id.
    const jm = await api('POST', '/masjids', { token: KEYS.jm.token, body: body(9, { external_id: 'q_dup' }) })
    expect(jm.status).toBe(201)
  })

  it('two concurrent POSTs with the same external_id: one 201, one 409 already_linked, one masjid', async () => {
    const [a, b] = await Promise.all([
      api('POST', '/masjids', { token: KEYS.qiyam.token, body: body(9, { ...spot(9, 3000), name: 'Race A', external_id: 'q_race' }) }),
      api('POST', '/masjids', { token: KEYS.qiyam.token, body: body(9, { ...spot(9, 6000), name: 'Race B', external_id: 'q_race' }) }),
    ])
    expect([a.status, b.status].sort()).toEqual([201, 409])
    const loser = a.status === 409 ? a : b
    expect(((await loser.json()) as Err).code).toBe('already_linked')
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM masjid_external_ids WHERE external_id = 'q_race'").first<{ n: number }>()
    expect(n!.n).toBe(1)
    const orphans = await env.DB.prepare("SELECT COUNT(*) AS n FROM masjids WHERE name IN ('Race A','Race B')").first<{ n: number }>()
    expect(orphans!.n).toBe(1)
  })

  it('PUT links my own app id; another app id is 403; works without an Idempotency-Key', async () => {
    const m = await createMasjid({ ...spot(10) })
    const wrong = await api('PUT', `/masjids/${m.id}/external-ids/qiyam`, { body: { external_id: 'x' } })
    expect(wrong.status).toBe(403)

    const res = await api('PUT', `/masjids/${m.id}/external-ids/jejak_masjid`, { body: { external_id: 'jm_55' }, noIdem: true })
    expect(res.status).toBe(200)
    const linked = await res.json() as MasjidJson
    expect(linked.version).toBe(m.version + 1)
    expect(linked.external_ids).toEqual([{ app_id: 'jejak_masjid', external_id: 'jm_55' }])
    const rows = await changesOf(m.id)
    const last = rows[rows.length - 1]
    expect(last).toMatchObject({ op: 'update', version: linked.version })
    expect(JSON.parse(last.changed_fields)).toEqual(['external_ids'])
  })

  it('PUT is idempotent: the same id again is a 200 no-op (no version bump, no change)', async () => {
    const m = await createMasjid({ ...spot(10, 3000) })
    await api('PUT', `/masjids/${m.id}/external-ids/jejak_masjid`, { body: { external_id: 'jm_same' } })
    const n = (await changesOf(m.id)).length
    const again = await api('PUT', `/masjids/${m.id}/external-ids/jejak_masjid`, { body: { external_id: 'jm_same' } })
    expect(again.status).toBe(200)
    expect(((await again.json()) as MasjidJson).version).toBe(m.version + 1)
    expect((await changesOf(m.id)).length).toBe(n)
  })

  it('PUT is one-to-one: a second id for the same app, or an id owned by another masjid, is 409 already_linked', async () => {
    const a = await createMasjid({ ...spot(11) })
    const b = await createMasjid({ ...spot(11, 2000) })
    await api('PUT', `/masjids/${a.id}/external-ids/qiyam`, { token: KEYS.qiyam.token, body: { external_id: 'q_a' } })

    const second = await api('PUT', `/masjids/${a.id}/external-ids/qiyam`, { token: KEYS.qiyam.token, body: { external_id: 'q_other' } })
    expect(second.status).toBe(409)
    expect(((await second.json()) as Err).code).toBe('already_linked')

    const taken = await api('PUT', `/masjids/${b.id}/external-ids/qiyam`, { token: KEYS.qiyam.token, body: { external_id: 'q_a' } })
    expect(taken.status).toBe(409)
    const err = await taken.json() as Err
    expect(err.code).toBe('already_linked')
    expect(err.details!.masjid_id).toBe(a.id)
  })

  it('PUT validates the body and the masjid', async () => {
    const m = await createMasjid({ ...spot(12) })
    expect((await api('PUT', `/masjids/${m.id}/external-ids/jejak_masjid`, { body: {} })).status).toBe(422)
    expect((await api('PUT', `/masjids/999999/external-ids/jejak_masjid`, { body: { external_id: 'x' } })).status).toBe(404)
  })

  it('PUT with the same Idempotency-Key replays; a different body is 409 idempotency_mismatch', async () => {
    const m = await createMasjid({ ...spot(12, 3000) })
    const opts = { idemKey: 'put-key-1', body: { external_id: 'jm_idem' } }
    const r1 = await api('PUT', `/masjids/${m.id}/external-ids/jejak_masjid`, opts)
    const r2 = await api('PUT', `/masjids/${m.id}/external-ids/jejak_masjid`, opts)
    expect(await r2.text()).toBe(await r1.text())
    const r3 = await api('PUT', `/masjids/${m.id}/external-ids/jejak_masjid`, { idemKey: 'put-key-1', body: { external_id: 'other' } })
    expect(r3.status).toBe(409)
    expect(((await r3.json()) as Err).code).toBe('idempotency_mismatch')
  })
})

describe('PATCH partial contacts and facilities', () => {
  it('contacts change only the listed types; value null deletes', async () => {
    const m = await createMasjid({ ...spot(13), contacts: [{ type: 'facebook', value: 'https://fb.example/a' }] })
    expect(m.contacts).toEqual([{ type: 'facebook', value: 'https://fb.example/a' }])

    const r1 = await api('PATCH', `/masjids/${m.id}`, { ifMatch: m.version, body: { contacts: [{ type: 'instagram', value: 'https://ig.example/a' }] } })
    expect(r1.status).toBe(200)
    const v2 = await r1.json() as MasjidJson
    expect(v2.contacts).toEqual([
      { type: 'facebook', value: 'https://fb.example/a' },
      { type: 'instagram', value: 'https://ig.example/a' },
    ])

    const r2 = await api('PATCH', `/masjids/${m.id}`, { ifMatch: v2.version, body: { contacts: [{ type: 'facebook', value: 'https://fb.example/b' }, { type: 'instagram', value: null }] } })
    const v3 = await r2.json() as MasjidJson
    expect(v3.contacts).toEqual([{ type: 'facebook', value: 'https://fb.example/b' }])
    expect(await getMasjid(m.id)).toEqual(v3)

    const rows = await changesOf(m.id)
    expect(JSON.parse(rows[rows.length - 1].changed_fields)).toEqual(['contacts'])
  })

  it('facilities change only the listed codes; available null clears one', async () => {
    const m = await createMasjid({ ...spot(13, 3000), facilities: [{ code: 'WIFI', available: true }] })
    const r1 = await api('PATCH', `/masjids/${m.id}`, { ifMatch: m.version, body: { facilities: [{ code: 'TOILET_FEMALE', available: true }, { code: 'KOLAH', available: false }] } })
    const v2 = await r1.json() as MasjidJson
    expect(v2.facilities).toEqual([
      { code: 'KOLAH', available: false },
      { code: 'TOILET_FEMALE', available: true },
      { code: 'WIFI', available: true },
    ])
    const r2 = await api('PATCH', `/masjids/${m.id}`, { ifMatch: v2.version, body: { facilities: [{ code: 'KOLAH', available: null }, { code: 'WIFI', available: false }] } })
    const v3 = await r2.json() as MasjidJson
    expect(v3.facilities).toEqual([{ code: 'TOILET_FEMALE', available: true }, { code: 'WIFI', available: false }])
    const rows = await changesOf(m.id)
    expect(JSON.parse(rows[rows.length - 1].changed_fields)).toEqual(['facilities'])
    expect(JSON.parse(rows[rows.length - 1].before_json).facilities).toHaveLength(3)
  })

  it('unknown or retired facility codes, bad contact types and duplicates are 422 and write nothing', async () => {
    const m = await createMasjid({ ...spot(14) })
    const cases = [
      { facilities: [{ code: 'NOPE', available: true }] },
      { facilities: [{ code: 'OKU_FRIENDLY', available: true }] }, // retired: inactive
      { facilities: [{ code: 'WIFI', available: 'yes' }] },
      { facilities: [{ code: 'WIFI', available: true }, { code: 'WIFI', available: false }] },
      { contacts: [{ type: 'myspace', value: 'x' }] },
      { contacts: [{ type: 'website', value: '' }] },
      { contacts: [{ type: 'website', value: 'a' }, { type: 'website', value: 'b' }] },
      { contacts: 'x' },
    ]
    for (const c of cases) {
      const res = await api('PATCH', `/masjids/${m.id}`, { ifMatch: m.version, body: c })
      expect(res.status, JSON.stringify(c)).toBe(422)
    }
    expect((await getMasjid(m.id)).version).toBe(m.version)
    expect(await changesOf(m.id)).toHaveLength(1)
  })

  it('a retired code can still be cleared, and unknown codes on POST are 422', async () => {
    const m = await createMasjid({ ...spot(14, 3000) })
    await env.DB.prepare("INSERT INTO masjid_facilities (masjid_id, code, available) VALUES (?, 'OKU_FRIENDLY', 1)").bind(m.id).run()
    const cleared = await api('PATCH', `/masjids/${m.id}`, { ifMatch: m.version, body: { facilities: [{ code: 'OKU_FRIENDLY', available: null }] } })
    expect(cleared.status).toBe(200)
    expect(((await cleared.json()) as MasjidJson).facilities).toEqual([])
    const bad = await api('POST', '/masjids', { body: body(15, { facilities: [{ code: 'NOPE', available: true }] }) })
    expect(bad.status).toBe(422)
  })

  it('PATCH also edits scalars together with children, and lat/lng recompute the geohash', async () => {
    const m = await createMasjid({ ...spot(15, 3000) })
    const res = await api('PATCH', `/masjids/${m.id}`, { ifMatch: m.version, body: { telephone: '+60312345678', lat: 1.5, lng: 103.9, contacts: [{ type: 'website', value: 'https://w.example' }] } })
    const v2 = await res.json() as MasjidJson
    expect(v2).toMatchObject({ telephone: '+60312345678', lat: 1.5, lng: 103.9 })
    expect(v2.geohash).not.toBe(m.geohash)
    const rows = await changesOf(m.id)
    expect(JSON.parse(rows[rows.length - 1].changed_fields)).toEqual(['contacts', 'geohash', 'lat', 'lng', 'telephone'].filter(f => f !== 'geohash'))
  })
})

describe('DELETE /masjids/:id', () => {
  it('needs If-Match (422) and an Idempotency-Key (422)', async () => {
    const m = await createMasjid({ ...spot(16) })
    const noMatch = await api('DELETE', `/masjids/${m.id}`)
    expect(noMatch.status).toBe(422)
    expect(((await noMatch.json()) as Err).details).toMatchObject({ header: 'If-Match' })
    const noKey = await api('DELETE', `/masjids/${m.id}`, { ifMatch: m.version, noIdem: true })
    expect(noKey.status).toBe(422)
  })

  it('soft deletes: op delete, tombstone, hidden from list/search/nearby, GET still 200', async () => {
    const m = await createMasjid({ ...spot(17), name: 'Masjid Akan Padam' })
    const res = await api('DELETE', `/masjids/${m.id}`, { ifMatch: m.version })
    expect(res.status).toBe(200)
    const tomb = await res.json() as MasjidJson
    expect(tomb).toMatchObject({ status: 'deleted', version: m.version + 1 })

    const rows = await changesOf(m.id)
    expect(rows[rows.length - 1]).toMatchObject({ op: 'delete', version: tomb.version })
    expect(JSON.parse(rows[rows.length - 1].after_json).status).toBe('deleted')

    expect((await getMasjid(m.id)).status).toBe('deleted')
    const list = await (await api('GET', '/masjids?name=Akan%20Padam')).json() as { data: unknown[] }
    expect(list.data).toHaveLength(0)
    const p = spot(17)
    const near = await (await api('GET', `/masjids/nearby?lat=${p.lat}&lng=${p.lng}&radius=500`)).json() as { data: unknown[] }
    expect(near.data).toHaveLength(0)

    expect((await api('DELETE', `/masjids/${m.id}`, { ifMatch: tomb.version })).status).toBe(404)
  })

  it('a stale If-Match is 409 version_conflict with details.current', async () => {
    const m = await createMasjid({ ...spot(17, 3000) })
    await api('PATCH', `/masjids/${m.id}`, { ifMatch: m.version, body: { telephone: '1' } })
    const res = await api('DELETE', `/masjids/${m.id}`, { ifMatch: m.version })
    expect(res.status).toBe(409)
    const err = await res.json() as Err
    expect(err.code).toBe('version_conflict')
    expect(err.details!.current).toMatchObject({ id: m.id, version: m.version + 1, status: 'active' })
  })

  it('replays with the same Idempotency-Key', async () => {
    const m = await createMasjid({ ...spot(18) })
    const opts = { ifMatch: m.version, idemKey: 'del-1' }
    const r1 = await api('DELETE', `/masjids/${m.id}`, opts)
    const r2 = await api('DELETE', `/masjids/${m.id}`, opts)
    expect(r2.status).toBe(200)
    expect(await r2.text()).toBe(await r1.text())
    expect((await changesOf(m.id)).filter(r => r.op === 'delete')).toHaveLength(1)
  })

  it('a read-only key cannot delete (403)', async () => {
    const m = await createMasjid({ ...spot(18, 3000) })
    const res = await api('DELETE', `/masjids/${m.id}`, { ifMatch: m.version, token: KEYS.read.token })
    expect(res.status).toBe(403)
  })
})

describe('GET /masjids (list)', () => {
  it('returns contract entities, boolean jumaat_available and cursor pagination', async () => {
    const ids: number[] = []
    for (let i = 0; i < 3; i++) ids.push((await createMasjid({ ...spot(19, i * 10), name: `Masjid Senarai ${i}`, jumaat_available: i === 0, contacts: [{ type: 'website', value: 'https://w.example' }] })).id)

    const p1 = await (await api('GET', '/masjids?name=Senarai&limit=2')).json() as { data: MasjidJson[]; next_cursor: string | null }
    expect(p1.data.map(m => m.id)).toEqual(ids.slice(0, 2))
    expect(p1.next_cursor).toEqual(expect.any(String))
    expect(p1.data[0]).toMatchObject({ jumaat_available: true, status: 'active', contacts: [{ type: 'website' }], external_ids: [], facilities: [], images: [] })
    expect(p1.data[1].jumaat_available).toBe(false)

    const p2 = await (await api('GET', `/masjids?name=Senarai&limit=2&cursor=${p1.next_cursor}`)).json() as { data: MasjidJson[]; next_cursor: string | null }
    expect(p2.data.map(m => m.id)).toEqual(ids.slice(2))
    expect(p2.next_cursor).toBeNull()
    // The list item equals GET /masjids/:id.
    expect(p2.data[0]).toEqual(await getMasjid(ids[2]))
  })

  it('filters: jumaat, type, state, updated_since; limit above 100 or a bad cursor is 422', async () => {
    const jumaat = await (await api('GET', '/masjids?name=Senarai&jumaat=true')).json() as { data: MasjidJson[] }
    expect(jumaat.data.every(m => m.jumaat_available === true)).toBe(true)
    expect(jumaat.data).toHaveLength(1)

    const future = await (await api('GET', '/masjids?updated_since=2999-01-01T00:00:00Z')).json() as { data: unknown[] }
    expect(future.data).toHaveLength(0)
    const past = await (await api('GET', '/masjids?updated_since=2000-01-01T00:00:00Z&limit=100')).json() as { data: unknown[] }
    expect(past.data.length).toBeGreaterThan(0)
    expect((await api('GET', '/masjids?updated_since=yesterday')).status).toBe(422)

    expect((await api('GET', '/masjids?limit=101')).status).toBe(422)
    expect((await api('GET', '/masjids?limit=0')).status).toBe(422)
    expect((await api('GET', '/masjids?cursor=!!!')).status).toBe(422)
    expect((await api('GET', '/masjids?type=surau&name=Senarai')).status).toBe(200)
  })

  it('does not return merged or deleted masjids and loads children without a query per masjid', async () => {
    const merged = await createMasjid({ ...spot(20), name: 'Masjid Gabung' })
    await env.DB.prepare("UPDATE masjids SET status = 'merged', merged_into = (SELECT MIN(id) FROM masjids WHERE id != ?) WHERE id = ?").bind(merged.id, merged.id).run()
    const list = await (await api('GET', '/masjids?name=Gabung')).json() as { data: unknown[] }
    expect(list.data).toHaveLength(0)
    const res = await api('GET', `/masjids/${merged.id}`)
    expect(res.status).toBe(200) // fetch follows the 301
    const { SELF } = await import('cloudflare:test')
    const raw = await SELF.fetch(`http://example.com/masjids/${merged.id}`, { headers: { Authorization: `Bearer ${KEYS.read.token}` }, redirect: 'manual' })
    expect(raw.status).toBe(301)
    expect(raw.headers.get('location')).toMatch(/^\/masjids\/\d+$/)
  })
})

describe('GET /masjids/nearby (radius in metres)', () => {
  it('uses metres, orders nearest first, adds distance_m', async () => {
    const near = await createMasjid({ ...spot(21, 100), name: 'Dekat' })
    const mid = await createMasjid({ ...spot(21, 300), name: 'Sederhana' })
    const far = await createMasjid({ ...spot(21, 3000), name: 'Jauh' })
    const q = spot(21)
    const r500 = await (await api('GET', `/masjids/nearby?lat=${q.lat}&lng=${q.lng}&radius=500`)).json() as { data: Array<MasjidJson & { distance_m: number }>; next_cursor: string | null }
    expect(r500.data.map(m => m.id)).toEqual([near.id, mid.id])
    expect(r500.data[0].distance_m).toBeGreaterThan(80)
    expect(r500.data[0].distance_m).toBeLessThan(120)
    expect(typeof r500.data[0].jumaat_available).toBe('boolean')

    const r200 = await (await api('GET', `/masjids/nearby?lat=${q.lat}&lng=${q.lng}&radius=200`)).json() as { data: MasjidJson[] }
    expect(r200.data.map(m => m.id)).toEqual([near.id])

    const r5k = await (await api('GET', `/masjids/nearby?lat=${q.lat}&lng=${q.lng}&radius=5000`)).json() as { data: MasjidJson[] }
    expect(r5k.data.map(m => m.id)).toEqual([near.id, mid.id, far.id])
  })

  it('paginates with limit and cursor', async () => {
    const q = spot(21)
    const p1 = await (await api('GET', `/masjids/nearby?lat=${q.lat}&lng=${q.lng}&radius=5000&limit=2`)).json() as { data: MasjidJson[]; next_cursor: string }
    expect(p1.data).toHaveLength(2)
    const p2 = await (await api('GET', `/masjids/nearby?lat=${q.lat}&lng=${q.lng}&radius=5000&limit=2&cursor=${p1.next_cursor}`)).json() as { data: MasjidJson[]; next_cursor: string | null }
    expect(p2.data).toHaveLength(1)
    expect(p2.next_cursor).toBeNull()
  })

  it('max radius is 20000 metres; 20 (the old km) is a 20 m radius', async () => {
    const q = spot(21)
    expect((await api('GET', `/masjids/nearby?lat=${q.lat}&lng=${q.lng}&radius=20001`)).status).toBe(422)
    expect((await api('GET', `/masjids/nearby?lat=${q.lat}&lng=${q.lng}&radius=20000`)).status).toBe(200)
    expect((await api('GET', `/masjids/nearby?lat=${q.lat}&lng=${q.lng}&radius=0`)).status).toBe(422)
    const tiny = await (await api('GET', `/masjids/nearby?lat=${q.lat}&lng=${q.lng}&radius=20`)).json() as { data: unknown[] }
    expect(tiny.data).toHaveLength(0)
  })

  it('a 20 km radius finds a masjid 19 km away', async () => {
    const m = await createMasjid({ ...spot(22, 19000), name: 'Masjid Sangat Jauh' })
    const q = spot(22)
    const res = await (await api('GET', `/masjids/nearby?lat=${q.lat}&lng=${q.lng}&radius=20000`)).json() as { data: MasjidJson[] }
    expect(res.data.map(x => x.id)).toContain(m.id)
  })
})

describe('GET /facilities', () => {
  it('returns the active catalogue with en/ms labels', async () => {
    const res = await api('GET', '/facilities')
    expect(res.status).toBe(200)
    const { data } = await res.json() as { data: Array<{ code: string; label_en: string; label_ms: string }> }
    expect(data.length).toBe(29)
    expect(data).toContainEqual(expect.objectContaining({ code: 'TOILET_FEMALE', label_en: "Women's toilet", label_ms: 'Tandas wanita' }))
    expect(data.map(d => d.code)).not.toContain('OKU_FRIENDLY')
  })

  it('needs a key', async () => {
    const { SELF } = await import('cloudflare:test')
    expect((await SELF.fetch('http://example.com/facilities')).status).toBe(401)
  })
})

describe('contract section 10 at the server level', () => {
  it('check 2: a masjid that exists is found by match, linked by PUT, and a re-run creates nothing', async () => {
    const base = await createMasjid({ ...spot(23), name: 'Masjid Al-Falah' }, KEYS.qiyam.token)
    const q = spot(23, 15)
    const run = async () => {
      const by = await api('GET', '/masjids/by-external/jejak_masjid/jm_local_9')
      if (by.status === 200) return ((await by.json()) as MasjidJson).id
      const m = await (await api('GET', `/masjids/match?lat=${q.lat}&lng=${q.lng}&name=${encodeURIComponent('Masjid Al Falah')}`)).json() as { candidates: Candidate[] }
      if (m.candidates[0].score >= 0.9 && m.candidates[0].distance_m <= 50) {
        const put = await api('PUT', `/masjids/${m.candidates[0].id}/external-ids/jejak_masjid`, { body: { external_id: 'jm_local_9' } })
        expect(put.status).toBe(200)
        return m.candidates[0].id
      }
      throw new Error('would have created a duplicate')
    }
    const before = await env.DB.prepare('SELECT COUNT(*) AS n FROM masjids').first<{ n: number }>()
    expect(await run()).toBe(base.id)
    expect(await run()).toBe(base.id)
    const after = await env.DB.prepare('SELECT COUNT(*) AS n FROM masjids').first<{ n: number }>()
    expect(after!.n).toBe(before!.n)
  })

  it('check 3: a facility edit shows in GET and appears in /changes with the new version', async () => {
    const m = await createMasjid({ ...spot(24) })
    const latest = (await (await api('GET', '/changes/latest')).json() as { latest_seq: number }).latest_seq
    const patched = await (await api('PATCH', `/masjids/${m.id}`, { ifMatch: m.version, body: { facilities: [{ code: 'WUDHU_FEMALE', available: true }] } })).json() as MasjidJson
    expect((await getMasjid(m.id)).facilities).toEqual([{ code: 'WUDHU_FEMALE', available: true }])
    const feed = await (await api('GET', `/changes?after=${latest}`)).json() as { changes: Array<{ entity: string; entity_id: number; version: number; origin_app: string; changed_fields: string[]; data: MasjidJson }> }
    const mine = feed.changes.find(c => c.entity_id === m.id)!
    expect(mine).toMatchObject({ entity: 'masjid', version: patched.version, origin_app: 'jejak_masjid', changed_fields: ['facilities'] })
    expect(mine.data).toEqual(patched)
  })

  it('check 8: two apps PATCH the same field from the same base: one wins, the other gets 409 and resolves', async () => {
    const m = await createMasjid({ ...spot(25) })
    const a = await api('PATCH', `/masjids/${m.id}`, { token: KEYS.jm.token, ifMatch: m.version, body: { telephone: '111' } })
    const b = await api('PATCH', `/masjids/${m.id}`, { token: KEYS.qiyam.token, ifMatch: m.version, body: { telephone: '222' } })
    expect(a.status).toBe(200)
    expect(b.status).toBe(409)
    const err = await b.json() as Err
    expect(err.details!.current).toMatchObject({ telephone: '111', version: m.version + 1 })
    // The remote value wins: the loser applies `current` and both end on the same value.
    expect((await getMasjid(m.id)).telephone).toBe('111')
  })

  it('check 9: the same Idempotency-Key twice on POST is one write with identical responses', async () => {
    const opts = { idemKey: 'check9', body: body(26) }
    const r1 = await api('POST', '/masjids', opts)
    const r2 = await api('POST', '/masjids', opts)
    expect(r1.status).toBe(201)
    expect(r2.status).toBe(201)
    expect(await r2.text()).toBe(await r1.text())
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM changes WHERE entity = 'masjid' AND op = 'create' AND masjid_id = ?").bind(((await (await api('POST', '/masjids', opts)).json()) as MasjidJson).id).first<{ n: number }>()
    expect(n!.n).toBe(1)
  })

  it('check 7: replaying a /changes page returns the same rows', async () => {
    const p1 = await (await api('GET', '/changes?after=0&limit=5')).text()
    const p2 = await (await api('GET', '/changes?after=0&limit=5')).text()
    expect(p2).toBe(p1)
  })
})
