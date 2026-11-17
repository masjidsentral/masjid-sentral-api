import { describe, it, expect } from 'vitest'
import { SELF, env } from 'cloudflare:test'
import { readHeaders } from './helpers'

// Counts recorded from scripts/regions/generate.mjs (migration 006). See PROGRESS_regions.md.
const EXPECTED = {
  my: { states: 16, cities: 632 },
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

  it('MY keeps the 16 states from 001 and at least the 612 prod cities', async () => {
    const c = await one<{ n: number }>("SELECT COUNT(*) AS n FROM cities WHERE state_id LIKE 'my-%'")
    expect(c.n).toBeGreaterThanOrEqual(612)
    const names = await one<{ n: number }>("SELECT COUNT(*) AS n FROM states WHERE id IN ('my-jhr','my-kul','my-lbn','my-pjy','my-sgr','my-swk')")
    expect(names.n).toBe(6)
  })

  it('Indonesia has 416 kabupaten and 98 kota', async () => {
    const kab = await one<{ n: number }>("SELECT COUNT(*) AS n FROM cities WHERE id LIKE 'id-%' AND name LIKE 'Kabupaten %'")
    const kota = await one<{ n: number }>("SELECT COUNT(*) AS n FROM cities WHERE id LIKE 'id-%' AND name LIKE 'Kota %'")
    expect(kab.n).toBe(416)
    expect(kota.n).toBe(98)
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

  it('ids are lowercase slugs and city ids start with their state id', async () => {
    const re = /^[a-z]{2}(-[a-z0-9]+)+$/
    const states = (await env.DB.prepare('SELECT id, country_id FROM states').all<{ id: string; country_id: string }>()).results
    for (const s of states) {
      expect(s.id, s.id).toMatch(re)
      expect(s.id.startsWith(s.country_id + '-'), s.id).toBe(true)
    }
    const cities = (await env.DB.prepare('SELECT id, state_id FROM cities').all<{ id: string; state_id: string }>()).results
    // 33 legacy prod ids (copied unchanged from the old D1) contain runs of hyphens, e.g. my-sbh-taw---tawau.
    const legacy = cities.filter((c) => !re.test(c.id))
    expect(legacy.length).toBe(33)
    for (const c of legacy) expect(c.id.startsWith('my-') && c.id.includes('--'), c.id).toBe(true)
    for (const c of cities) expect(c.id.startsWith(c.state_id + '-'), c.id).toBe(true)
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
