import { describe, it, expect } from 'vitest'
import { SELF, env } from 'cloudflare:test'
import { BASE, readHeaders } from './helpers'

describe('004 schema', () => {
  it('seeds the provisional facility catalogue (29 active JM codes + retired OKU_FRIENDLY)', async () => {
    const all = await env.DB.prepare('SELECT COUNT(*) AS n FROM facility_catalogue').first<{ n: number }>()
    const active = await env.DB.prepare('SELECT COUNT(*) AS n FROM facility_catalogue WHERE active = 1').first<{ n: number }>()
    expect(all!.n).toBe(30)
    expect(active!.n).toBe(29)
    const codes = await env.DB.prepare("SELECT code FROM facility_catalogue WHERE code IN ('TOILET_FEMALE','OPEN_24H','WHEELCHAIR_ACCESS')").run()
    expect(codes.results).toHaveLength(3)
  })

  it('masjid_facilities rejects unknown codes and masjid_contacts is unique per type', async () => {
    const { createMasjid } = await import('./helpers')
    const m = await createMasjid()
    await expect(env.DB.prepare("INSERT INTO masjid_facilities (masjid_id, code, available) VALUES (?, 'NOPE', 1)").bind(m.id).run()).rejects.toThrow()
    await env.DB.prepare("INSERT INTO masjid_contacts (masjid_id, type, value) VALUES (?, 'facebook', 'https://fb.example/a')").bind(m.id).run()
    await expect(env.DB.prepare("INSERT INTO masjid_contacts (masjid_id, type, value) VALUES (?, 'facebook', 'x')").bind(m.id).run()).rejects.toThrow()
    await env.DB.prepare("INSERT INTO masjid_contacts (masjid_id, type, value) VALUES (?, 'tiktok', 'https://tiktok.example/a')").bind(m.id).run()
  })

  it('the entity shows facilities by code, contacts and external ids in contract shape', async () => {
    const { createMasjid, getMasjid } = await import('./helpers')
    const m = await createMasjid()
    await env.DB.batch([
      env.DB.prepare("INSERT INTO masjid_facilities (masjid_id, code, available) VALUES (?, 'TOILET_FEMALE', 1), (?, 'OPEN_24H', 0)").bind(m.id, m.id),
      env.DB.prepare("INSERT INTO masjid_contacts (masjid_id, type, value) VALUES (?, 'website', 'https://m.example')").bind(m.id),
      env.DB.prepare("INSERT INTO masjid_external_ids (app_id, external_id, masjid_id) VALUES ('qiyam', ?, ?)").bind(`q_${m.id}`, m.id),
    ])
    const got = await getMasjid(m.id)
    expect(got.facilities).toEqual([{ code: 'OPEN_24H', available: false }, { code: 'TOILET_FEMALE', available: true }])
    expect(got.contacts).toEqual([{ type: 'website', value: 'https://m.example' }])
    expect(got.external_ids).toEqual([{ app_id: 'qiyam', external_id: `q_${m.id}` }])
  })

  it('has no source column on masjids and the dev key is gone', async () => {
    const cols = await env.DB.prepare("SELECT name FROM pragma_table_info('masjids')").run<{ name: string }>()
    const names = cols.results.map(c => c.name)
    expect(names).not.toContain('source')
    expect(names).toEqual(expect.arrayContaining(['version', 'updated_by_app', 'merged_into']))
    const res = await SELF.fetch(`${BASE}/masjids`, { headers: readHeaders() })
    expect(res.status).toBe(200)
  })
})
