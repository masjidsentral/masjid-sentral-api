import { describe, it, expect, inject } from 'vitest'
import { SELF, env } from 'cloudflare:test'
import { readHeaders } from './helpers'
import { LEGACY_MY_CITIES } from './fixtures/legacy-my-cities'

// Counts recorded from scripts/regions/generate.mjs (migration 006). See PROGRESS_regions.md.
const EXPECTED = {
  my: { states: 16, cities: 442 },
  sg: { states: 1, cities: 55 },
  bn: { states: 4, cities: 40 },
  id: { states: 38, cities: 514 },
}

async function one<T>(sql: string, ...args: unknown[]): Promise<T> {
  return (await env.DB.prepare(sql).bind(...args).first<T>())!
}

describe('006 regions: counts', () => {
  for (const [country, exp] of Object.entries(EXPECTED)) {
    it(`${country} has ${exp.states} states and ${exp.cities} cities`, async () => {
      const s = await one<{ n: number }>('SELECT COUNT(*) AS n FROM states WHERE country_id = ?', country)
      const c = await one<{ n: number }>(
        'SELECT COUNT(*) AS n FROM cities WHERE state_id IN (SELECT id FROM states WHERE country_id = ?)', country)
      expect(s.n).toBe(exp.states)
      expect(c.n).toBe(exp.cities)
    })
  }

  it('MY keeps the 16 states from 001 and one city per Pos Malaysia post town', async () => {
    const c = await one<{ n: number }>("SELECT COUNT(*) AS n FROM cities WHERE state_id LIKE 'my-%'")
    expect(c.n).toBe(442)
    const names = await one<{ n: number }>("SELECT COUNT(*) AS n FROM states WHERE id IN ('my-jhr','my-kul','my-lbn','my-pjy','my-sgr','my-swk')")
    expect(names.n).toBe(6)
  })

  it('Indonesia has 416 kabupaten and 98 kota', async () => {
    const kab = await one<{ n: number }>("SELECT COUNT(*) AS n FROM cities WHERE id LIKE 'id-%' AND name LIKE 'Kabupaten %'")
    const kota = await one<{ n: number }>("SELECT COUNT(*) AS n FROM cities WHERE id LIKE 'id-%' AND name LIKE 'Kota %'")
    expect(kab.n).toBe(416)
    expect(kota.n).toBe(98)
  })

  it('Brunei per district: Brunei-Muara 18 mukims + Bandar Seri Begawan, Belait 8, Tutong 8, Temburong 5', async () => {
    const exp: Record<string, number> = { 'bn-brunei-muara': 19, 'bn-belait': 8, 'bn-tutong': 8, 'bn-temburong': 5 }
    for (const [st, n] of Object.entries(exp)) {
      expect((await one<{ n: number }>('SELECT COUNT(*) AS n FROM cities WHERE state_id = ?', st)).n, st).toBe(n)
    }
  })

  it('Papua provinces have the expected kabupaten and kota counts', async () => {
    const exp: Record<string, [number, number]> = {
      'id-papua': [8, 1], 'id-papua-barat': [7, 0], 'id-papua-barat-daya': [5, 1],
      'id-papua-selatan': [4, 0], 'id-papua-tengah': [8, 0], 'id-papua-pegunungan': [8, 0],
    }
    for (const [st, [kab, kota]] of Object.entries(exp)) {
      const k = await one<{ n: number }>("SELECT COUNT(*) AS n FROM cities WHERE state_id = ? AND name LIKE 'Kabupaten %'", st)
      const t = await one<{ n: number }>("SELECT COUNT(*) AS n FROM cities WHERE state_id = ? AND name LIKE 'Kota %'", st)
      expect([st, k.n, t.n]).toEqual([st, kab, kota])
    }
  })

  it('Brunei: 39 mukims plus Bandar Seri Begawan', async () => {
    const bsb = await one<{ n: number }>("SELECT COUNT(*) AS n FROM cities WHERE id = 'bn-brunei-muara-bandar-seri-begawan'")
    expect(bsb.n).toBe(1)
  })
})

describe('006 regions: integrity', () => {
  it('has no orphan city and no state without cities', async () => {
    const orphans = await one<{ n: number }>('SELECT COUNT(*) AS n FROM cities WHERE state_id NOT IN (SELECT id FROM states)')
    expect(orphans.n).toBe(0)
    const empty = await one<{ n: number }>('SELECT COUNT(*) AS n FROM states WHERE id NOT IN (SELECT state_id FROM cities)')
    expect(empty.n).toBe(0)
  })

  it('every state belongs to a known country', async () => {
    const bad = await one<{ n: number }>('SELECT COUNT(*) AS n FROM states WHERE country_id NOT IN (SELECT id FROM countries)')
    expect(bad.n).toBe(0)
  })

  it('every id is a strict lowercase slug and city ids start with their state id', async () => {
    const re = /^[a-z]{2}(-[a-z0-9]+)+$/
    const states = (await env.DB.prepare('SELECT id, country_id FROM states').all<{ id: string; country_id: string }>()).results
    for (const s of states) {
      expect(s.id, s.id).toMatch(re)
      expect(s.id.startsWith(s.country_id + '-'), s.id).toBe(true)
    }
    const cities = (await env.DB.prepare('SELECT id, state_id FROM cities').all<{ id: string; state_id: string }>()).results
    for (const c of cities) {
      expect(c.id, c.id).toMatch(re)
      expect(c.id.startsWith(c.state_id + '-'), c.id).toBe(true)
    }
  })

  it('has no ALL-CAPS names (acronyms KLIA, TLDM, USM only) and no duplicate name within a state', async () => {
    const rows = (await env.DB.prepare('SELECT id, name, state_id FROM cities').all<{ id: string; name: string; state_id: string }>()).results
    const acronyms = new Set(['KLIA', 'TLDM', 'USM'])
    const seen = new Set<string>()
    for (const r of rows) {
      for (const w0 of r.name.split(/[\s-]+/)) {
        const w = w0.replace(/[^A-Za-z]/g, '')
        if (w.length > 1 && w === w.toUpperCase()) expect(acronyms.has(w), `${r.id}: ${r.name}`).toBe(true)
      }
      expect(/[^\x20-\x7e]/.test(r.name), r.id).toBe(false)
      const key = r.state_id + '|' + r.name.toLowerCase()
      expect(seen.has(key), key).toBe(false)
      seen.add(key)
    }
  })

  it('the legacy junk MY ids do not exist, the clean towns do', async () => {
    const junk = ['my-sbh-taw---tawau', 'my-kul-zon-1', 'my-kul-kuala-kumpur', 'my-jhr-johor', 'my-pls---01000-kangar']
    const jm = junk.map(() => '?').join(',')
    expect((await one<{ n: number }>(`SELECT COUNT(*) AS n FROM cities WHERE id IN (${jm})`, ...junk)).n).toBe(0)
    const dropped = ['my-kdh-bandar-bahru', 'my-swk-pusat-mel-miri']
    expect((await one<{ n: number }>(`SELECT COUNT(*) AS n FROM cities WHERE id IN (?, ?)`, ...dropped)).n).toBe(0)
    const good = ['my-kdh-bandar-baharu', 'my-swk-miri', 'my-sgr-shah-alam', 'my-jhr-johor-bahru', 'my-kul-kuala-lumpur', 'my-sbh-tawau', 'my-pjy-putrajaya', 'my-lbn-labuan']
    const gm = good.map(() => '?').join(',')
    expect((await one<{ n: number }>(`SELECT COUNT(*) AS n FROM cities WHERE id IN (${gm})`, ...good)).n).toBe(good.length)
    expect((await one<{ name: string }>("SELECT name FROM cities WHERE id = 'my-sgr-shah-alam'")).name).toBe('Shah Alam')
  })

  it('has none of the old duplicate ids', async () => {
    const old = ['id-jakarta', 'id-jakarta-selatan', 'id-daerah-khusus-ibukota-jakarta', 'bn-brunei-muara-district', 'id-east-java', 'id-west-sumatra']
    const marks = old.map(() => '?').join(',')
    const s = await one<{ n: number }>(`SELECT COUNT(*) AS n FROM states WHERE id IN (${marks})`, ...old)
    const c = await one<{ n: number }>(`SELECT COUNT(*) AS n FROM cities WHERE id IN (${marks})`, ...old)
    expect(s.n).toBe(0)
    expect(c.n).toBe(0)
  })

  it('same-name kabupaten and kota never collide', async () => {
    const rows = (await env.DB.prepare("SELECT id FROM cities WHERE id IN ('id-jawa-barat-kab-bogor','id-jawa-barat-kota-bogor','id-dki-jakarta-kota-jakarta-selatan','id-dki-jakarta-kab-kepulauan-seribu')").all()).results
    expect(rows.length).toBe(4)
  })

  it('has the spec example ids', async () => {
    const ids = ['id-dki-jakarta', 'id-jawa-barat', 'id-di-yogyakarta', 'id-kepulauan-bangka-belitung', 'sg-singapore', 'bn-belait', 'bn-brunei-muara', 'bn-tutong', 'bn-temburong']
    const marks = ids.map(() => '?').join(',')
    const r = await one<{ n: number }>(`SELECT COUNT(*) AS n FROM states WHERE id IN (${marks})`, ...ids)
    expect(r.n).toBe(ids.length)
    const sg = await one<{ name: string }>("SELECT name FROM cities WHERE id = 'sg-singapore-ang-mo-kio'")
    expect(sg.name).toBe('Ang Mo Kio')
    const bn = await one<{ name: string }>("SELECT name FROM cities WHERE id = 'bn-belait-kuala-belait'")
    expect(bn.name).toBe('Kuala Belait')
  })
})

describe('006 regions: API', () => {
  it('GET /states?country=id returns the 38 provinces', async () => {
    const res = await SELF.fetch('http://example.com/states?country=id', { headers: readHeaders() })
    expect(res.status).toBe(200)
    const body = await res.json() as { data: Array<{ id: string; country_id: string }> }
    expect(body.data.length).toBe(38)
    expect(body.data.every((s) => s.country_id === 'id')).toBe(true)
    expect(body.data.some((s) => s.id === 'id-dki-jakarta')).toBe(true)
  })

  it('GET /cities?state=bn-belait returns the Belait mukims', async () => {
    const res = await SELF.fetch('http://example.com/cities?state=bn-belait', { headers: readHeaders() })
    expect(res.status).toBe(200)
    const body = await res.json() as { data: Array<{ id: string; state_id: string }> }
    expect(body.data.length).toBe(8)
    expect(body.data.every((c) => c.state_id === 'bn-belait')).toBe(true)
    expect(body.data.some((c) => c.id === 'bn-belait-kuala-belait')).toBe(true)
  })

  it('GET /cities?state=sg-singapore returns 55 planning areas', async () => {
    const res = await SELF.fetch('http://example.com/cities?state=sg-singapore', { headers: readHeaders() })
    const body = await res.json() as { data: unknown[] }
    expect(body.data.length).toBe(55)
  })
})

describe('006 regions: upgrade of a DB that holds the legacy MY rows', () => {
  it('replaces unreferenced legacy cities, fixes names, keeps referenced ones, and is idempotent', async () => {
    const mig = inject('D1_MIGRATIONS').find((m) => m.name.includes('006_regions'))!
    expect(mig).toBeDefined()
    const run = async () => { for (const q of mig.queries) await env.DB.prepare(q).run() }

    expect(LEGACY_MY_CITIES.length).toBe(612)
    const ins = LEGACY_MY_CITIES.map(([id, name, st]) =>
      env.DB.prepare('INSERT OR REPLACE INTO cities (id, name, state_id) VALUES (?, ?, ?)').bind(id, name, st))
    for (let i = 0; i < ins.length; i += 50) await env.DB.batch(ins.slice(i, i + 50))
    expect((await one<{ n: number }>("SELECT COUNT(*) AS n FROM cities WHERE state_id LIKE 'my-%'")).n).toBeGreaterThan(600)
    await env.DB.prepare(
      `INSERT INTO masjids (name, type_id, lat, lng, geohash, state_id, country_id, city_id)
       VALUES ('Upgrade Test', 'masjid', 3.1, 101.7, 'w283w', 'my-kul', 'my', 'my-kul-zon-2')`).run()

    await run()

    const ids = (await env.DB.prepare("SELECT id FROM cities WHERE id IN ('my-sbh-taw---tawau','my-kul-zon-1','my-kul-zon-2','my-kul-kuala-kumpur','my-jhr-johor','my-pls---01000-kangar','my-jhr-bahru')").all<{ id: string }>()).results.map((r) => r.id)
    expect(ids).toEqual(['my-kul-zon-2']) // only the one a masjid points at survives
    expect((await one<{ name: string }>("SELECT name FROM cities WHERE id = 'my-sgr-shah-alam'")).name).toBe('Shah Alam')
  })

  it('has none of the old duplicate ids', async () => {
    const old = ['id-jakarta', 'id-jakarta-selatan', 'id-daerah-khusus-ibukota-jakarta', 'bn-brunei-muara-district', 'id-east-java', 'id-west-sumatra']
    const marks = old.map(() => '?').join(',')
    const s = await one<{ n: number }>(`SELECT COUNT(*) AS n FROM states WHERE id IN (${marks})`, ...old)
    const c = await one<{ n: number }>(`SELECT COUNT(*) AS n FROM cities WHERE id IN (${marks})`, ...old)
    expect(s.n).toBe(0)
    expect(c.n).toBe(0)
  })

  it('same-name kabupaten and kota never collide', async () => {
    const rows = (await env.DB.prepare("SELECT id FROM cities WHERE id IN ('id-jawa-barat-kab-bogor','id-jawa-barat-kota-bogor','id-dki-jakarta-kota-jakarta-selatan','id-dki-jakarta-kab-kepulauan-seribu')").all()).results
    expect(rows.length).toBe(4)
  })

  it('has the spec example ids', async () => {
    const ids = ['id-dki-jakarta', 'id-jawa-barat', 'id-di-yogyakarta', 'id-kepulauan-bangka-belitung', 'sg-singapore', 'bn-belait', 'bn-brunei-muara', 'bn-tutong', 'bn-temburong']
    const marks = ids.map(() => '?').join(',')
    const r = await one<{ n: number }>(`SELECT COUNT(*) AS n FROM states WHERE id IN (${marks})`, ...ids)
    expect(r.n).toBe(ids.length)
    const sg = await one<{ name: string }>("SELECT name FROM cities WHERE id = 'sg-singapore-ang-mo-kio'")
    expect(sg.name).toBe('Ang Mo Kio')
    const bn = await one<{ name: string }>("SELECT name FROM cities WHERE id = 'bn-belait-kuala-belait'")
    expect(bn.name).toBe('Kuala Belait')
  })
})

describe('006 regions: API', () => {
  it('GET /states?country=id returns the 38 provinces', async () => {
    const res = await SELF.fetch('http://example.com/states?country=id', { headers: readHeaders() })
    expect(res.status).toBe(200)
    const body = await res.json() as { data: Array<{ id: string; country_id: string }> }
    expect(body.data.length).toBe(38)
    expect(body.data.every((s) => s.country_id === 'id')).toBe(true)
    expect(body.data.some((s) => s.id === 'id-dki-jakarta')).toBe(true)
  })

  it('GET /cities?state=bn-belait returns the Belait mukims', async () => {
    const res = await SELF.fetch('http://example.com/cities?state=bn-belait', { headers: readHeaders() })
    expect(res.status).toBe(200)
    const body = await res.json() as { data: Array<{ id: string; state_id: string }> }
    expect(body.data.length).toBe(8)
    expect(body.data.every((c) => c.state_id === 'bn-belait')).toBe(true)
    expect(body.data.some((c) => c.id === 'bn-belait-kuala-belait')).toBe(true)
  })

  it('GET /cities?state=sg-singapore returns 55 planning areas', async () => {
    const res = await SELF.fetch('http://example.com/cities?state=sg-singapore', { headers: readHeaders() })
    const body = await res.json() as { data: unknown[] }
    expect(body.data.length).toBe(55)
  })
})

describe('006 regions: upgrade of a DB that holds the legacy MY rows', () => {
  it('replaces unreferenced legacy cities, fixes names, keeps referenced ones, and is idempotent', async () => {
    const mig = inject('D1_MIGRATIONS').find((m) => m.name.includes('006_regions'))!
    expect(mig).toBeDefined()
    const run = async () => { for (const q of mig.queries) await env.DB.prepare(q).run() }

    expect(LEGACY_MY_CITIES.length).toBe(612)
    const ins = LEGACY_MY_CITIES.map(([id, name, st]) =>
      env.DB.prepare('INSERT OR REPLACE INTO cities (id, name, state_id) VALUES (?, ?, ?)').bind(id, name, st))
    for (let i = 0; i < ins.length; i += 50) await env.DB.batch(ins.slice(i, i + 50))
    expect((await one<{ n: number }>("SELECT COUNT(*) AS n FROM cities WHERE state_id LIKE 'my-%'")).n).toBeGreaterThan(600)
    await env.DB.prepare(
      `INSERT INTO masjids (name, type_id, lat, lng, geohash, state_id, country_id, city_id)
       VALUES ('Upgrade Test', 'masjid', 3.1, 101.7, 'w283w', 'my-kul', 'my', 'my-kul-zon-2')`).run()

    await run()

    const ids = (await env.DB.prepare("SELECT id FROM cities WHERE id IN ('my-sbh-taw---tawau','my-kul-zon-1','my-kul-zon-2','my-kul-kuala-kumpur','my-jhr-johor','my-pls---01000-kangar','my-jhr-bahru')").all<{ id: string }>()).results.map((r) => r.id)
    expect(ids).toEqual(['my-kul-zon-2']) // only the one a masjid points at survives
    expect((await one<{ name: string }>("SELECT name FROM cities WHERE id = 'my-sgr-shah-alam'")).name).toBe('Shah Alam')
    expect((await one<{ name: string }>("SELECT name FROM cities WHERE id = 'my-kul-kuala-lumpur'")).name).toBe('Kuala Lumpur')
    expect((await one<{ n: number }>("SELECT COUNT(*) AS n FROM cities WHERE state_id LIKE 'my-%'")).n).toBe(442 + 1)

    // after the masjid is repointed, a second run removes the last legacy row and the list is exactly the new one
    await env.DB.prepare("UPDATE masjids SET city_id = NULL WHERE name = 'Upgrade Test'").run()
    await run()
    expect((await one<{ n: number }>("SELECT COUNT(*) AS n FROM cities WHERE state_id LIKE 'my-%'")).n).toBe(442)
    await env.DB.prepare("DELETE FROM masjids WHERE name = 'Upgrade Test'").run()
  })
})
