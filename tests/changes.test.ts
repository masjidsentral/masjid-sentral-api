import { describe, it, expect } from 'vitest'
import { SELF, env } from 'cloudflare:test'
import { BASE, KEYS, bearer, readHeaders, createMasjid, patchMasjid, getMasjid } from './helpers'

interface Feed {
  changes: Array<{
    seq: number; entity: string; entity_id: number; masjid_id: number; op: string; version: number
    origin_app: string; changed_fields: string[]; occurred_at: string; data: Record<string, unknown>
  }>
  next_after: number
  has_more: boolean
}

const feed = async (qs = '', headers: Record<string, string> = readHeaders()) =>
  SELF.fetch(`${BASE}/changes${qs}`, { headers })

describe('GET /changes', () => {
  it('returns changes in seq order with the contract shape, data = the entity as GET returns it', async () => {
    const start = (await (await feed('/latest' as string)).json() as { latest_seq: number }).latest_seq
    const m = await createMasjid({ name: 'Feed One' })
    expect((await patchMasjid(m.id, m.version, { telephone: '+60399999999' }, { token: KEYS.qiyam.token })).status).toBe(200)

    const body = await (await feed(`?after=${start}`)).json() as Feed
    expect(body.changes).toHaveLength(2)
    expect(body.has_more).toBe(false)
    const [c1, c2] = body.changes
    expect(c2.seq).toBeGreaterThan(c1.seq)
    expect(c1).toMatchObject({ entity: 'masjid', entity_id: m.id, masjid_id: m.id, op: 'create', version: 1, origin_app: 'jejak_masjid' })
    expect(c2).toMatchObject({ op: 'update', version: 2, origin_app: 'qiyam', changed_fields: ['telephone'] })
    expect(c2.occurred_at).toMatch(/Z$/)
    expect(c2.data).toEqual(await getMasjid(m.id))
    expect(body.next_after).toBe(c2.seq)
  })

  it('paginates with limit/has_more/next_after and a replay of a page returns the same rows', async () => {
    const start = (await (await feed('/latest')).json() as { latest_seq: number }).latest_seq
    for (let i = 0; i < 5; i++) await createMasjid({ name: `Page ${i}` })

    const p1 = await (await feed(`?after=${start}&limit=2`)).json() as Feed
    expect(p1.changes).toHaveLength(2)
    expect(p1.has_more).toBe(true)
    const p2 = await (await feed(`?after=${p1.next_after}&limit=2`)).json() as Feed
    expect(p2.has_more).toBe(true)
    const p3 = await (await feed(`?after=${p2.next_after}&limit=2`)).json() as Feed
    expect(p3.changes).toHaveLength(1)
    expect(p3.has_more).toBe(false)
    const seqs = [...p1.changes, ...p2.changes, ...p3.changes].map(c => c.seq)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    expect(new Set(seqs).size).toBe(5)

    const again = await (await feed(`?after=${start}&limit=2`)).json() as Feed
    expect(again).toEqual(p1)
  })

  it('an empty page keeps the cursor', async () => {
    const latest = (await (await feed('/latest')).json() as { latest_seq: number }).latest_seq
    const body = await (await feed(`?after=${latest}`)).json() as Feed
    expect(body).toEqual({ changes: [], next_after: latest, has_more: false })
  })

  it('GET /changes/latest returns the highest seq', async () => {
    const m = await createMasjid()
    const row = await env.DB.prepare('SELECT MAX(seq) AS s FROM changes').first<{ s: number }>()
    const latest = await (await feed('/latest')).json() as { latest_seq: number }
    expect(latest.latest_seq).toBe(row!.s)
    expect(m.id).toBeGreaterThan(0)
  })

  it('validates after and limit (422), caps limit at 500', async () => {
    expect((await feed('?after=abc')).status).toBe(422)
    expect((await feed('?limit=0')).status).toBe(422)
    expect((await feed('?limit=501')).status).toBe(422)
    expect((await feed('?limit=500')).status).toBe(200)
  })

  it('needs a key with the read scope (401 / 403)', async () => {
    expect((await SELF.fetch(`${BASE}/changes`)).status).toBe(401)
    expect((await feed('', bearer(KEYS.admin.token))).status).toBe(403)
  })

  it('stores no personal data: the log holds only the opaque actor and app ids', async () => {
    const m = await createMasjid()
    const row = await env.DB.prepare('SELECT * FROM changes WHERE entity_id = ? AND entity = ?').bind(m.id, 'masjid').first<Record<string, unknown>>()
    expect(Object.keys(row!).sort()).toEqual([
      'actor', 'after_json', 'before_json', 'changed_fields', 'entity', 'entity_id', 'masjid_id', 'occurred_at', 'op', 'origin_app', 'seq', 'version',
    ])
    expect(row!.actor).toBe('user-1')
  })
})
