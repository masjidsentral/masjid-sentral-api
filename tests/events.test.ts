import { describe, it, expect } from 'vitest'
import { env } from 'cloudflare:test'
import { KEYS, api, createMasjid, getMasjid, spot, type MasjidJson } from './helpers'

interface Err { error: string; code: string; details?: Record<string, any> }
interface Ev {
  id: number; version: number; masjid_id: number; title: string; status: string; category: string; timezone: string
  rrule: string | null; start_at: string; end_at: string | null; external_ids: Array<{ app_id: string; external_id: string }>
  source_app: string; updated_by_app: string; poster_url: string | null; [k: string]: unknown
}

const day = 24 * 3600 * 1000
const at = (offsetDays: number, hour = 12) => {
  const d = new Date(Date.now() + offsetDays * day)
  d.setUTCHours(hour, 0, 0, 0)
  return d.toISOString().replace('.000Z', 'Z')
}
const EVENT = (extra: Record<string, unknown> = {}) => ({ title: 'Kuliah Maghrib', start_at: at(3), ...extra })

async function mk(n: number, d = 0) { return createMasjid({ ...spot(30 + n, d), name: `Masjid Acara ${n}-${d}` }) }
async function post(masjidId: number, body: unknown, opts: Parameters<typeof api>[2] = {}) {
  return api('POST', `/masjids/${masjidId}/events`, { ...opts, body })
}
async function eventChanges(id: number) {
  return (await env.DB.prepare("SELECT * FROM changes WHERE entity = 'event' AND entity_id = ? ORDER BY seq").bind(id).all<Record<string, any>>()).results
}
async function list(path: string) {
  const res = await api('GET', path)
  return { res, body: await res.json() as { data: Ev[]; next_cursor: string | null } & Err }
}

describe('POST /masjids/:id/events', () => {
  it('creates a programme: 201, contract shape, defaults, source_app', async () => {
    const m = await mk(1)
    const res = await post(m.id, EVENT({ external_id: 'prog_1', speaker: 'Ustaz A', category: 'kuliah', rrule: 'FREQ=WEEKLY;BYDAY=TH', poster_url: 'https://cdn.example/p.jpg' }), { token: KEYS.qiyam.token })
    expect(res.status).toBe(201)
    const ev = await res.json() as Ev
    expect(ev).toMatchObject({
      version: 1, masjid_id: m.id, title: 'Kuliah Maghrib', category: 'kuliah', status: 'active', timezone: 'Asia/Kuala_Lumpur',
      rrule: 'FREQ=WEEKLY;BYDAY=TH', speaker: 'Ustaz A', source_app: 'qiyam', updated_by_app: 'qiyam', end_at: null,
      external_ids: [{ app_id: 'qiyam', external_id: 'prog_1' }],
    })
    expect((await (await api('GET', `/events/${ev.id}`)).json() as Ev)).toEqual(ev)
    const by = await api('GET', '/events/by-external/qiyam/prog_1')
    expect(((await by.json()) as Ev).id).toBe(ev.id)
    expect((await api('GET', '/events/by-external/qiyam/none')).status).toBe(404)
  })

  it('emits entity "event" with masjid_id and does not bump the masjid version', async () => {
    const m = await mk(2)
    const seqBefore = (await (await api('GET', '/changes/latest')).json() as { latest_seq: number }).latest_seq
    const ev = await (await post(m.id, EVENT())).json() as Ev
    const [row] = await eventChanges(ev.id)
    expect(row).toMatchObject({ entity: 'event', op: 'create', version: 1, masjid_id: m.id, entity_id: ev.id, origin_app: 'jejak_masjid' })
    expect(JSON.parse(row.after_json)).toEqual(ev)
    expect(row.seq).toBeGreaterThan(seqBefore)
    expect((await getMasjid(m.id)).version).toBe(m.version)
    const masjidChanges = await env.DB.prepare("SELECT COUNT(*) AS n FROM changes WHERE entity = 'masjid' AND entity_id = ?").bind(m.id).first<{ n: number }>()
    expect(masjidChanges!.n).toBe(1)
  })

  it('requires an active masjid (404 for missing, deleted or merged)', async () => {
    const gone = await mk(3)
    await api('DELETE', `/masjids/${gone.id}`, { ifMatch: gone.version })
    expect((await post(gone.id, EVENT())).status).toBe(404)
    expect((await post(999999, EVENT())).status).toBe(404)
    const merged = await mk(3, 2000)
    await env.DB.prepare("UPDATE masjids SET status = 'merged', merged_into = ? WHERE id = ?").bind(gone.id, merged.id).run()
    const res = await post(merged.id, EVENT())
    expect(res.status).toBe(404)
    expect(((await res.json()) as Err).details).toEqual({ merged_into: gone.id })
  })

  it('validates category, timezone, rrule, dates, URLs and required fields (422, nothing written)', async () => {
    const m = await mk(4)
    const before = await env.DB.prepare('SELECT COUNT(*) AS n FROM masjid_events').first<{ n: number }>()
    const bad: Array<Record<string, unknown>> = [
      EVENT({ category: 'party' }),
      EVENT({ timezone: 'Mars/Olympus' }),
      EVENT({ rrule: 'WEEKLY' }),
      EVENT({ rrule: 'RRULE:FREQ=WEEKLY' }),
      EVENT({ end_at: at(2) }), // before start
      EVENT({ start_at: '2026-11-20 10:00' }),
      EVENT({ start_at: '2026-02-30T10:00:00Z' }),
      EVENT({ start_at: '2026-11-20T10:00:00+25:00' }),
      EVENT({ start_at: '2026-11-20T10:00:00+08' }),
      EVENT({ poster_url: 'http://cdn.example/p.jpg' }),
      EVENT({ registration_url: 'ftp://x' }),
      EVENT({ status: 'deleted' }),
      EVENT({ external_id: '' }),
      { start_at: at(3) },
      { title: 'No start' },
    ]
    for (const b of bad) {
      const res = await post(m.id, b)
      expect(res.status, JSON.stringify(b)).toBe(422)
      expect(((await res.json()) as Err).code).toBe('validation_failed')
    }
    const after = await env.DB.prepare('SELECT COUNT(*) AS n FROM masjid_events').first<{ n: number }>()
    expect(after!.n).toBe(before!.n)
  })

  it('accepts every contract category and a valid IANA timezone', async () => {
    const m = await mk(5)
    for (const category of ['kuliah', 'ceramah', 'tazkirah', 'kelas', 'qiamullail', 'gotong_royong', 'sukan', 'majlis', 'program_belia', 'korban', 'iftar', 'jualan', 'lain']) {
      expect((await post(m.id, EVENT({ category, timezone: 'Asia/Singapore' }))).status, category).toBe(201)
    }
  })

  it('normalises start_at to second precision and accepts end_at == start_at', async () => {
    const m = await mk(5, 2000)
    const start = at(4)
    const ev = await (await post(m.id, EVENT({ start_at: start.replace('Z', '.456Z'), end_at: start }))).json() as Ev
    expect(ev.start_at).toBe(start)
    expect(ev.end_at).toBe(start)
  })

  it('POST with a linked external_id is 409 already_linked with details.event_id; another app can reuse the string', async () => {
    const m = await mk(6)
    const first = await (await post(m.id, EVENT({ external_id: 'e1' }), { token: KEYS.qiyam.token })).json() as Ev
    const dup = await post(m.id, EVENT({ external_id: 'e1' }), { token: KEYS.qiyam.token })
    expect(dup.status).toBe(409)
    const err = await dup.json() as Err
    expect(err.code).toBe('already_linked')
    expect(err.details!.event_id).toBe(first.id)
    expect((await post(m.id, EVENT({ external_id: 'e1' }), { token: KEYS.jm.token })).status).toBe(201)
  })

  it('replays with the same Idempotency-Key: one event, identical response', async () => {
    const m = await mk(7)
    const opts = { idemKey: 'ev-idem-1' }
    const r1 = await post(m.id, EVENT(), opts)
    const r2 = await post(m.id, EVENT(), opts)
    expect(r2.status).toBe(201)
    expect(await r2.text()).toBe(await r1.text())
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM masjid_events WHERE masjid_id = ?').bind(m.id).first<{ n: number }>()
    expect(n!.n).toBe(1)
    const bad = await post(m.id, EVENT({ title: 'Lain' }), opts)
    expect(bad.status).toBe(409)
    expect(((await bad.json()) as Err).code).toBe('idempotency_mismatch')
  })

  it('needs write scope and an Idempotency-Key', async () => {
    const m = await mk(7, 2000)
    expect((await post(m.id, EVENT(), { token: KEYS.read.token })).status).toBe(403)
    expect((await post(m.id, EVENT(), { noIdem: true })).status).toBe(422)
  })
})

describe('PATCH and DELETE /events/:id', () => {
  it('PATCH changes only the sent fields, bumps the version and records the change', async () => {
    const m = await mk(8)
    const ev = await (await post(m.id, EVENT({ description: 'asal' }))).json() as Ev
    const res = await api('PATCH', `/events/${ev.id}`, { ifMatch: ev.version, body: { status: 'cancelled', description: 'dibatalkan: hujan' } })
    expect(res.status).toBe(200)
    const v2 = await res.json() as Ev
    expect(v2).toMatchObject({ version: 2, status: 'cancelled', description: 'dibatalkan: hujan', title: ev.title, source_app: 'jejak_masjid' })
    const rows = await eventChanges(ev.id)
    expect(rows[1]).toMatchObject({ op: 'update', version: 2, masjid_id: m.id })
    expect(JSON.parse(rows[1].changed_fields)).toEqual(['description', 'status'])
    expect(JSON.parse(rows[1].before_json)).toEqual(ev)
    expect((await getMasjid(m.id)).version).toBe(m.version)
  })

  it('another app may edit a programme (source_app stays, updated_by_app changes)', async () => {
    const m = await mk(8, 2000)
    const ev = await (await post(m.id, EVENT(), { token: KEYS.qiyam.token })).json() as Ev
    const v2 = await (await api('PATCH', `/events/${ev.id}`, { token: KEYS.jm.token, ifMatch: ev.version, body: { status: 'cancelled' } })).json() as Ev
    expect(v2).toMatchObject({ source_app: 'qiyam', updated_by_app: 'jejak_masjid' })
  })

  it('a stale If-Match is 409 version_conflict with details.current (the event); a missing one is 422', async () => {
    const m = await mk(9)
    const ev = await (await post(m.id, EVENT())).json() as Ev
    await api('PATCH', `/events/${ev.id}`, { ifMatch: ev.version, body: { speaker: 'B' } })
    const stale = await api('PATCH', `/events/${ev.id}`, { ifMatch: ev.version, body: { speaker: 'C' } })
    expect(stale.status).toBe(409)
    const err = await stale.json() as Err
    expect(err.code).toBe('version_conflict')
    expect(err.details!.current).toMatchObject({ id: ev.id, version: 2, speaker: 'B', masjid_id: m.id })
    expect((await api('PATCH', `/events/${ev.id}`, { body: { speaker: 'C' } })).status).toBe(422)
    expect((await api('DELETE', `/events/${ev.id}`, { ifMatch: 1 })).status).toBe(409)
  })

  it('PATCH validates and checks end_at against the stored start_at', async () => {
    const m = await mk(9, 2000)
    const ev = await (await post(m.id, EVENT())).json() as Ev
    for (const b of [{ category: 'x' }, { timezone: 'No/Zone' }, { rrule: 'x' }, { end_at: at(1) }, { status: 'deleted' }, { poster_url: 'http://x' }, {}]) {
      expect((await api('PATCH', `/events/${ev.id}`, { ifMatch: 1, body: b })).status, JSON.stringify(b)).toBe(422)
    }
    expect((await api('PATCH', '/events/999999', { ifMatch: 1, body: { title: 'x' } })).status).toBe(404)
  })

  it('DELETE soft deletes with op delete; PATCH or DELETE on a deleted programme is 404; GET shows the tombstone', async () => {
    const m = await mk(10)
    const ev = await (await post(m.id, EVENT())).json() as Ev
    const res = await api('DELETE', `/events/${ev.id}`, { ifMatch: ev.version })
    expect(res.status).toBe(200)
    const tomb = await res.json() as Ev
    expect(tomb).toMatchObject({ status: 'deleted', version: 2 })
    const rows = await eventChanges(ev.id)
    expect(rows[1]).toMatchObject({ op: 'delete', version: 2, masjid_id: m.id })
    expect(((await (await api('GET', `/events/${ev.id}`)).json()) as Ev).status).toBe('deleted')
    expect((await api('DELETE', `/events/${ev.id}`, { ifMatch: 2 })).status).toBe(404)
    expect((await api('PATCH', `/events/${ev.id}`, { ifMatch: 2, body: { title: 'x' } })).status).toBe(404)
    const l = await list(`/masjids/${m.id}/events`)
    expect(l.body.data).toHaveLength(0)
  })

  it('DELETE needs If-Match, replays on the same key', async () => {
    const m = await mk(10, 2000)
    const ev = await (await post(m.id, EVENT())).json() as Ev
    expect((await api('DELETE', `/events/${ev.id}`)).status).toBe(422)
    const opts = { ifMatch: ev.version, idemKey: 'ev-del-1' }
    const r1 = await api('DELETE', `/events/${ev.id}`, opts)
    const r2 = await api('DELETE', `/events/${ev.id}`, opts)
    expect(await r2.text()).toBe(await r1.text())
    expect((await eventChanges(ev.id)).filter(r => r.op === 'delete')).toHaveLength(1)
  })

  it('two apps PATCH the same programme from the same base: one wins, one gets 409 with the current event', async () => {
    const m = await mk(11)
    const ev = await (await post(m.id, EVENT())).json() as Ev
    const [a, b] = await Promise.all([
      api('PATCH', `/events/${ev.id}`, { token: KEYS.jm.token, ifMatch: ev.version, body: { speaker: 'JM' } }),
      api('PATCH', `/events/${ev.id}`, { token: KEYS.qiyam.token, ifMatch: ev.version, body: { speaker: 'Qiyam' } }),
    ])
    expect([a.status, b.status].sort()).toEqual([200, 409])
    const loser = a.status === 409 ? a : b
    expect(((await loser.json()) as Err).details!.current).toMatchObject({ id: ev.id, version: 2 })
    expect((await eventChanges(ev.id)).filter(r => r.version === 2)).toHaveLength(1)
  })
})

describe('GET /masjids/:id/events', () => {
  it('applies the spec filter: status, rrule, end_at >= from, start_at < to', async () => {
    const m = await mk(12)
    const mkEv = async (title: string, extra: Record<string, unknown>) => (await (await post(m.id, { title, ...extra })).json()) as Ev
    const upcoming = await mkEv('upcoming', { start_at: at(5) })
    const ongoing = await mkEv('ongoing', { start_at: at(-1, 8), end_at: at(2, 8) })
    const finished = await mkEv('finished', { start_at: at(-5), end_at: at(-4) })
    const finishedNoEnd = await mkEv('finishedNoEnd', { start_at: at(-5) })
    const recurring = await mkEv('recurring', { start_at: at(-60), rrule: 'FREQ=WEEKLY' })
    const beyond = await mkEv('beyond', { start_at: at(100) })
    const cancelled = await mkEv('cancelled', { start_at: at(6), status: 'cancelled' })
    const completed = await mkEv('completed', { start_at: at(6), status: 'completed' })
    const removed = await mkEv('removed', { start_at: at(6) })
    await api('DELETE', `/events/${removed.id}`, { ifMatch: removed.version })

    const { body } = await list(`/masjids/${m.id}/events`)
    const ids = body.data.map(e => e.id)
    expect(ids).toEqual([recurring.id, ongoing.id, upcoming.id, cancelled.id]) // ordered by start_at
    for (const e of [finished, finishedNoEnd, beyond, completed, removed]) expect(ids).not.toContain(e.id)

    const wide = await list(`/masjids/${m.id}/events?from=${at(-10)}&to=${at(200)}`)
    expect(wide.body.data.map(e => e.id)).toEqual([recurring.id, finished.id, finishedNoEnd.id, ongoing.id, upcoming.id, cancelled.id, beyond.id])
    const narrow = await list(`/masjids/${m.id}/events?from=${at(4)}&to=${at(5, 23)}`)
    expect(narrow.body.data.map(e => e.id)).toEqual([recurring.id, upcoming.id])
  })

  it('paginates with limit and cursor', async () => {
    const m = await mk(13)
    for (let i = 0; i < 5; i++) await post(m.id, { title: `E${i}`, start_at: at(1 + i) })
    const p1 = await list(`/masjids/${m.id}/events?limit=2`)
    expect(p1.body.data.map(e => e.title)).toEqual(['E0', 'E1'])
    const p2 = await list(`/masjids/${m.id}/events?limit=2&cursor=${p1.body.next_cursor}`)
    expect(p2.body.data.map(e => e.title)).toEqual(['E2', 'E3'])
    const p3 = await list(`/masjids/${m.id}/events?limit=2&cursor=${p2.body.next_cursor}`)
    expect(p3.body.data.map(e => e.title)).toEqual(['E4'])
    expect(p3.body.next_cursor).toBeNull()
    expect((await api('GET', `/masjids/${m.id}/events?limit=101`)).status).toBe(422)
    expect((await api('GET', `/masjids/${m.id}/events?cursor=!!`)).status).toBe(422)
  })

  it('validates from/to and the masjid', async () => {
    const m = await mk(13, 2000)
    expect((await api('GET', `/masjids/${m.id}/events?from=tomorrow`)).status).toBe(422)
    expect((await api('GET', `/masjids/${m.id}/events?to=2026-01-01`)).status).toBe(422)
    expect((await api('GET', '/masjids/999999/events')).status).toBe(404)
    const gone = await mk(13, 4000)
    await api('DELETE', `/masjids/${gone.id}`, { ifMatch: gone.version })
    expect((await api('GET', `/masjids/${gone.id}/events`)).status).toBe(404)
  })

  it('a merged masjid redirects (301) to the survivor events', async () => {
    const a = await mk(14)
    const b = await mk(14, 2000)
    await env.DB.prepare("UPDATE masjids SET status = 'merged', merged_into = ? WHERE id = ?").bind(b.id, a.id).run()
    const { SELF } = await import('cloudflare:test')
    const raw = await SELF.fetch(`http://example.com/masjids/${a.id}/events`, { headers: { Authorization: `Bearer ${KEYS.read.token}` }, redirect: 'manual' })
    expect(raw.status).toBe(301)
    expect(raw.headers.get('location')).toBe(`/masjids/${b.id}/events`)
  })
})

describe('GET /events?masjid_ids=', () => {
  it('lists programmes across masjids, hides non-active masjids, caps at 100 ids', async () => {
    const a = await mk(15)
    const b = await mk(15, 2000)
    const c = await mk(15, 4000)
    const ea = await (await post(a.id, EVENT({ title: 'A' }))).json() as Ev
    const eb = await (await post(b.id, EVENT({ title: 'B', start_at: at(4) }))).json() as Ev
    await post(c.id, EVENT({ title: 'C' }))
    await api('DELETE', `/masjids/${c.id}`, { ifMatch: c.version })

    const { body } = await list(`/events?masjid_ids=${a.id},${b.id},${c.id}`)
    expect(body.data.map(e => e.id)).toEqual([ea.id, eb.id])

    const ids100 = Array.from({ length: 100 }, (_, i) => i + 1).join(',')
    expect((await api('GET', `/events?masjid_ids=${ids100}`)).status).toBe(200)
    const ids101 = Array.from({ length: 101 }, (_, i) => i + 1).join(',')
    const over = await api('GET', `/events?masjid_ids=${ids101}`)
    expect(over.status).toBe(422)
    expect(((await over.json()) as Err).code).toBe('validation_failed')
    for (const q of ['', '?masjid_ids=', '?masjid_ids=a,b', '?masjid_ids=1,,2']) {
      expect((await api('GET', `/events${q}`)).status, q).toBe(422)
    }
  })
})

describe('contract section 10 check 11 (server level)', () => {
  it('create, cancel, delete: the feed shows each step and the list hides it at the end', async () => {
    const m = await mk(16)
    const latest = (await (await api('GET', '/changes/latest')).json() as { latest_seq: number }).latest_seq
    const ev = await (await post(m.id, EVENT({ external_id: 'c11' }), { token: KEYS.qiyam.token })).json() as Ev
    const cancelled = await (await api('PATCH', `/events/${ev.id}`, { token: KEYS.qiyam.token, ifMatch: ev.version, body: { status: 'cancelled' } })).json() as Ev
    expect((await list(`/masjids/${m.id}/events`)).body.data[0].status).toBe('cancelled')
    await api('DELETE', `/events/${ev.id}`, { token: KEYS.qiyam.token, ifMatch: cancelled.version })

    const feed = await (await api('GET', `/changes?after=${latest}`)).json() as { changes: Array<{ entity: string; op: string; masjid_id: number; version: number; data: Ev }> }
    const mine = feed.changes.filter(c => c.entity === 'event')
    expect(mine.map(c => [c.op, c.version, c.data.status])).toEqual([['create', 1, 'active'], ['update', 2, 'cancelled'], ['delete', 3, 'deleted']])
    expect(mine.every(c => c.masjid_id === m.id)).toBe(true)
    expect((await list(`/masjids/${m.id}/events`)).body.data).toHaveLength(0)
  })
})
