import { describe, it, expect } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { BASE, KEYS, api, bearer, createMasjid, getMasjid, spot, type MasjidJson } from './helpers'
import { findCandidates } from '../src/lib/match'
import { searchWindow, windowWhere } from '../src/lib/geo'
import { loadEvent, loadMasjid } from '../src/lib/entities'
import { runCommit, type WriteCtx } from '../src/lib/write'
import { activeMasjidGuard, eventDeleteSpec, lostActiveMasjid } from '../src/lib/specs'
import { isoNow } from '../src/lib/time'

interface Err { error: string; code: string; details?: Record<string, any> }
interface Ev {
  id: number; version: number; masjid_id: number; title: string; status: string; timezone: string; start_at: string
  external_ids: Array<{ app_id: string; external_id: string }>; [k: string]: unknown
}
interface Candidate { id: number; name: string; type_id: string; score: number; distance_m: number; same_type: boolean | null }

const day = 24 * 3600 * 1000
const at = (offsetDays: number) => {
  const d = new Date(Date.now() + offsetDays * day)
  d.setUTCHours(12, 0, 0, 0)
  return d.toISOString().replace('.000Z', 'Z')
}
const EVENT = (extra: Record<string, unknown> = {}) => ({ title: 'Kuliah', start_at: at(3), ...extra })

async function mkEvent(masjidId: number, extra: Record<string, unknown> = {}, token: string = KEYS.jm.token): Promise<Ev> {
  const res = await api('POST', `/masjids/${masjidId}/events`, { token, body: EVENT(extra) })
  if (res.status !== 201) throw new Error(`mkEvent ${res.status} ${await res.text()}`)
  return res.json() as Promise<Ev>
}
async function changes(entity: string, id: number) {
  return (await env.DB.prepare('SELECT * FROM changes WHERE entity = ? AND entity_id = ? ORDER BY seq').bind(entity, id).all<Record<string, any>>()).results
}
async function keyId(name: keyof typeof KEYS): Promise<number> {
  const row = await env.DB.prepare('SELECT id FROM api_keys WHERE app_id IS ? AND scopes = ?')
    .bind(KEYS[name].app_id, KEYS[name].scopes).first<{ id: number }>()
  return row!.id
}
async function mkCtx(): Promise<WriteCtx> {
  return {
    db: env.DB, keyId: await keyId('jm'), originApp: 'jejak_masjid', actor: 'user-1',
    idemKey: `k-${crypto.randomUUID()}`, requestHash: 'h', bodyText: '', ifMatch: null,
  }
}
async function setStatus(id: number, status: string, mergedInto: number | null = null) {
  await env.DB.prepare('UPDATE masjids SET status = ?, merged_into = ? WHERE id = ?').bind(status, mergedInto, id).run()
}

// ─── 1. Search window ────────────────────────────────────────────────────────

describe('nearby / candidate search window', () => {
  it('reads only masjids inside the box: a crowd 2-4 km away (same 5-char ring) is not scanned', async () => {
    const centre = spot(70)
    const near = await createMasjid({ ...centre, name: 'Surau Pusat 70' })
    const near2 = await createMasjid({ ...spot(70, 300, 200), name: 'Surau Hampir 70' })
    for (let i = 0; i < 70; i++) {
      await createMasjid({ ...spot(70, 2000 + i * 30, i % 2 ? 400 : -400), name: `Masjid Jauh 70-${i}` })
    }
    const w = windowWhere(searchWindow(centre.lat, centre.lng, 1000))
    const r = await env.DB.prepare(`SELECT id FROM masjids INDEXED BY ${w.index} WHERE status = 'active' AND ${w.sql}`).bind(...w.binds).all<{ id: number }>()
    expect(r.results.map(x => x.id).sort()).toEqual([near.id, near2.id].sort())
    const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN SELECT id FROM masjids INDEXED BY ${w.index} WHERE status = 'active' AND ${w.sql}`).bind(...w.binds).all<{ detail: string }>()
    expect(plan.results.some(p => p.detail.includes('idx_masjids_geohash'))).toBe(true)
    const rowsRead = (r.meta as { rows_read?: number }).rows_read
    const total = (await env.DB.prepare('SELECT COUNT(*) AS n FROM masjids').first<{ n: number }>())!.n
    expect(total).toBeGreaterThan(30)
    if (typeof rowsRead === 'number') expect(rowsRead).toBeLessThan(total / 2) // a status-index scan reads every row

    const cands = await findCandidates(env.DB, centre.lat, centre.lng, 'Surau Pusat 70')
    expect(cands.map(c => c.id).sort()).toEqual([near.id, near2.id].sort())
  })

  it('nearby is unchanged for results inside the radius and still sorted nearest first', async () => {
    const centre = spot(71)
    const a = await createMasjid({ ...spot(71, 900), name: 'Nearby B 71' })
    const b = await createMasjid({ ...spot(71, 100), name: 'Nearby A 71' })
    await createMasjid({ ...spot(71, 3000), name: 'Nearby Far 71' })
    const res = await api('GET', `/masjids/nearby?lat=${centre.lat}&lng=${centre.lng}&radius=1000`)
    const { data } = await res.json() as { data: Array<MasjidJson & { distance_m: number }> }
    expect(data.map(m => m.id)).toEqual([b.id, a.id])
  })

  it('nearby paginates with a keyset cursor: no duplicates, none skipped, even when a masjid appears mid-way', async () => {
    const centre = spot(72)
    const ids: number[] = []
    for (let i = 0; i < 7; i++) ids.push((await createMasjid({ ...spot(72, 100 + i * 100), name: `Page 72-${i}` })).id)
    const seen: number[] = []
    let cursor: string | null = null
    for (let page = 0; page < 10; page++) {
      const res = await api('GET', `/masjids/nearby?lat=${centre.lat}&lng=${centre.lng}&radius=2000&limit=3${cursor ? `&cursor=${cursor}` : ''}`)
      const body = await res.json() as { data: Array<{ id: number }>; next_cursor: string | null }
      seen.push(...body.data.map(m => m.id))
      if (page === 0) await createMasjid({ ...spot(72, 50), name: 'Page 72 newcomer' }) // sorts before the cursor: must not shift pages
      cursor = body.next_cursor
      if (!cursor) break
    }
    expect(seen).toEqual(ids)
    expect(new Set(seen).size).toBe(seen.length)
    expect((await api('GET', `/masjids/nearby?lat=${centre.lat}&lng=${centre.lng}&cursor=bm9wZQ`)).status).toBe(422)
  })
})

// ─── 2. Pre-guards ───────────────────────────────────────────────────────────

describe('event writes on a non-active masjid', () => {
  it('POST / PATCH / DELETE / link on a deleted masjid are 404; a merged masjid adds details.merged_into', async () => {
    const m = await createMasjid({ ...spot(73), name: 'Guard 73' })
    const survivor = await createMasjid({ ...spot(73, 3000), name: 'Survivor 73' })
    const ev = await mkEvent(m.id)
    await setStatus(m.id, 'merged', survivor.id)

    const post = await api('POST', `/masjids/${m.id}/events`, { body: EVENT() })
    expect(post.status).toBe(404)
    expect(((await post.json()) as Err).details).toEqual({ merged_into: survivor.id })
    for (const res of [
      await api('PATCH', `/events/${ev.id}`, { ifMatch: ev.version, body: { title: 'x' } }),
      await api('DELETE', `/events/${ev.id}`, { ifMatch: ev.version }),
      await api('PUT', `/events/${ev.id}/external-ids/jejak_masjid`, { body: { external_id: 'e' } }),
    ]) {
      expect(res.status).toBe(404)
      expect(((await res.json()) as Err).details).toEqual({ merged_into: survivor.id })
    }
    await setStatus(m.id, 'deleted')
    expect((await api('PATCH', `/events/${ev.id}`, { ifMatch: ev.version, body: { title: 'x' } })).status).toBe(404)
    expect((await loadEvent(env.DB, ev.id))!.version).toBe(ev.version)
  })

  it('race: the masjid stops being active between the handler reads and the batch (pre-guard aborts, nothing persists)', async () => {
    const m = await createMasjid({ ...spot(73, 5000), name: 'Race 73' })
    const survivor = await createMasjid({ ...spot(73, 7000), name: 'Survivor 73b' })
    const ev = await mkEvent(m.id)
    const before = (await loadEvent(env.DB, ev.id))!
    const ctx = await mkCtx()

    const spec = { ...eventDeleteSpec(ctx, before, isoNow()), preGuards: [activeMasjidGuard(m.id)], onPreconditionLost: lostActiveMasjid(env.DB, m.id) }
    // Handler pre-reads passed, THEN the masjid is merged (committed status change).
    await setStatus(m.id, 'merged', survivor.id)
    const r = await runCommit(ctx, spec)
    expect(r).toEqual({ ok: false, reason: 'precondition' })
    expect((await loadEvent(env.DB, ev.id))!.status).toBe('active')
    expect(await changes('event', ev.id)).toHaveLength(1) // only the create
    const idem = await env.DB.prepare('SELECT 1 AS x FROM idempotency_keys WHERE key = ?').bind(ctx.idemKey).first()
    expect(idem).toBeNull()
    const err = await spec.onPreconditionLost()
    expect(err.status).toBe(404)
    expect(err.details).toEqual({ merged_into: survivor.id })
  })

  it('a lost version race is still reported as a version loss, not a precondition loss', async () => {
    const m = await createMasjid({ ...spot(73, 9000), name: 'Race 73c' })
    const ev = await mkEvent(m.id)
    const stale = (await loadEvent(env.DB, ev.id))!
    await api('PATCH', `/events/${ev.id}`, { ifMatch: ev.version, body: { title: 'winner' } })
    const ctx = await mkCtx()
    const r = await runCommit(ctx, { ...eventDeleteSpec(ctx, stale, isoNow()), preGuards: [activeMasjidGuard(m.id)] })
    expect(r).toEqual({ ok: false, reason: 'version' })
  })

  it('a pre-guard loss on create persists no programme', async () => {
    const m = await createMasjid({ ...spot(74), name: 'Race 74' })
    const n0 = (await env.DB.prepare('SELECT COUNT(*) AS n FROM masjid_events').first<{ n: number }>())!.n
    await setStatus(m.id, 'deleted')
    const ctx = await mkCtx()
    const r = await runCommit(ctx, {
      entity: 'event', op: 'create', entityId: null, baseVersion: null, masjidId: m.id, changedFields: ['title'], before: null,
      after: { id: 0, version: 1 }, status: 201, preGuards: [activeMasjidGuard(m.id)],
      entityStatement: env.DB.prepare(
        `INSERT INTO masjid_events (version, masjid_id, title, category, start_at, timezone, status, source_app, created_at, updated_at)
         VALUES (1, ?, 'ghost', 'lain', ?, 'Asia/Kuala_Lumpur', 'active', 'x', ?, ?)`,
      ).bind(m.id, at(2), isoNow(), isoNow()),
    })
    expect(r).toEqual({ ok: false, reason: 'precondition' })
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM masjid_events').first<{ n: number }>())!.n).toBe(n0)
  })
})

// ─── 3. Programme linking ────────────────────────────────────────────────────

describe('PUT /events/:id/external-ids/:app_id', () => {
  it('links my own app id, bumps the version, emits an event update with changed_fields ["external_ids"]', async () => {
    const m = await createMasjid({ ...spot(75), name: 'Link 75' })
    const ev = await mkEvent(m.id)
    expect((await api('PUT', `/events/${ev.id}/external-ids/qiyam`, { body: { external_id: 'x' } })).status).toBe(403)
    const res = await api('PUT', `/events/${ev.id}/external-ids/jejak_masjid`, { body: { external_id: 'jm_ev_1' }, noIdem: true })
    expect(res.status).toBe(200)
    const linked = await res.json() as Ev
    expect(linked.version).toBe(ev.version + 1)
    expect(linked.external_ids).toEqual([{ app_id: 'jejak_masjid', external_id: 'jm_ev_1' }])
    const rows = await changes('event', ev.id)
    expect(rows[rows.length - 1]).toMatchObject({ op: 'update', version: linked.version, masjid_id: m.id })
    expect(JSON.parse(rows[rows.length - 1].changed_fields)).toEqual(['external_ids'])
    expect(((await (await api('GET', '/events/by-external/jejak_masjid/jm_ev_1')).json()) as Ev).id).toBe(ev.id)

    // same id again: 200 no-op
    const again = await api('PUT', `/events/${ev.id}/external-ids/jejak_masjid`, { body: { external_id: 'jm_ev_1' } })
    expect(again.status).toBe(200)
    expect(((await again.json()) as Ev).version).toBe(linked.version)
    expect(await changes('event', ev.id)).toHaveLength(rows.length)
  })

  it('is one-to-one per app: another id, or an id held by an active programme, is 409 already_linked (details.event_id)', async () => {
    const m = await createMasjid({ ...spot(75, 3000), name: 'Link 75b' })
    const a = await mkEvent(m.id)
    const b = await mkEvent(m.id)
    await api('PUT', `/events/${a.id}/external-ids/qiyam`, { token: KEYS.qiyam.token, body: { external_id: 'q_a' } })
    const second = await api('PUT', `/events/${a.id}/external-ids/qiyam`, { token: KEYS.qiyam.token, body: { external_id: 'q_b' } })
    expect(second.status).toBe(409)
    const taken = await api('PUT', `/events/${b.id}/external-ids/qiyam`, { token: KEYS.qiyam.token, body: { external_id: 'q_a' } })
    expect(taken.status).toBe(409)
    const err = await taken.json() as Err
    expect(err.code).toBe('already_linked')
    expect(err.details!.event_id).toBe(a.id)
    expect((await api('PUT', `/events/${b.id}/external-ids/qiyam`, { token: KEYS.qiyam.token, body: {} })).status).toBe(422)
    expect((await api('PUT', '/events/999999/external-ids/qiyam', { token: KEYS.qiyam.token, body: { external_id: 'z' } })).status).toBe(404)
  })

  it('Idempotency-Key is optional but honoured (replay, mismatch)', async () => {
    const m = await createMasjid({ ...spot(75, 6000), name: 'Link 75c' })
    const ev = await mkEvent(m.id)
    const opts = { idemKey: 'ev-put-1', body: { external_id: 'jm_idem' } }
    const r1 = await api('PUT', `/events/${ev.id}/external-ids/jejak_masjid`, opts)
    const r2 = await api('PUT', `/events/${ev.id}/external-ids/jejak_masjid`, opts)
    expect(await r2.text()).toBe(await r1.text())
    expect(r2.headers.get('Idempotent-Replay')).toBe('true')
    const r3 = await api('PUT', `/events/${ev.id}/external-ids/jejak_masjid`, { idemKey: 'ev-put-1', body: { external_id: 'other' } })
    expect(((await r3.json()) as Err).code).toBe('idempotency_mismatch')
  })
})

// ─── 4. Cascade ──────────────────────────────────────────────────────────────

describe('DELETE /masjids/:id cascades to programmes', () => {
  it('deletes the masjid and every non-deleted programme in one batch, each with a version bump and a change row', async () => {
    const m = await createMasjid({ ...spot(76), name: 'Cascade 76' })
    const e1 = await mkEvent(m.id)
    const e2 = await mkEvent(m.id, { status: 'cancelled' })
    const e3 = await mkEvent(m.id)
    expect((await api('DELETE', `/events/${e3.id}`, { ifMatch: e3.version })).status).toBe(200) // already deleted: untouched
    const other = await createMasjid({ ...spot(76, 3000), name: 'Cascade 76 other' })
    const keep = await mkEvent(other.id)

    const res = await api('DELETE', `/masjids/${m.id}`, { ifMatch: m.version })
    expect(res.status).toBe(200)
    expect(((await res.json()) as MasjidJson).status).toBe('deleted')

    for (const e of [e1, e2]) {
      const now = (await loadEvent(env.DB, e.id))!
      expect(now.status).toBe('deleted')
      expect(now.version).toBe(e.version + 1)
      const rows = await changes('event', e.id)
      const last = rows[rows.length - 1]
      expect(last).toMatchObject({ op: 'delete', version: e.version + 1, masjid_id: m.id })
      expect(JSON.parse(last.after_json)).toEqual(now)
    }
    expect((await changes('event', e3.id)).filter(r => r.op === 'delete')).toHaveLength(1)
    expect((await loadEvent(env.DB, e3.id))!.version).toBe(e3.version + 1)
    expect((await loadEvent(env.DB, keep.id))!.status).toBe('active')
  })

  it('more than 200 programmes is 422 validation_failed / too_many_events and nothing is deleted', async () => {
    const m = await createMasjid({ ...spot(76, 6000), name: 'Cascade 76 big' })
    const now = isoNow()
    const rows = Array.from({ length: 201 }, (_, i) => ({ t: `bulk ${i}` }))
    await env.DB.batch(rows.map(r => env.DB.prepare(
      `INSERT INTO masjid_events (version, masjid_id, title, category, start_at, timezone, status, source_app, created_at, updated_at)
       VALUES (1, ?, ?, 'lain', ?, 'Asia/Kuala_Lumpur', 'active', 'x', ?, ?)`,
    ).bind(m.id, r.t, at(5), now, now)))
    const res = await api('DELETE', `/masjids/${m.id}`, { ifMatch: m.version })
    expect(res.status).toBe(422)
    const err = await res.json() as Err
    expect(err.code).toBe('validation_failed')
    expect(err.details!.reason).toBe('too_many_events')
    expect((await getMasjid(m.id)).status).toBe('active')
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM masjid_events WHERE masjid_id = ? AND status = 'active'").bind(m.id).first<{ n: number }>())!.n).toBe(201)
  })

  it('exactly 200 programmes cascade', async () => {
    const m = await createMasjid({ ...spot(76, 9000), name: 'Cascade 76 edge' })
    const now = isoNow()
    await env.DB.batch(Array.from({ length: 200 }, (_, i) => env.DB.prepare(
      `INSERT INTO masjid_events (version, masjid_id, title, category, start_at, timezone, status, source_app, created_at, updated_at)
       VALUES (1, ?, ?, 'lain', ?, 'Asia/Kuala_Lumpur', 'active', 'x', ?, ?)`,
    ).bind(m.id, `edge ${i}`, at(5), now, now)))
    expect((await api('DELETE', `/masjids/${m.id}`, { ifMatch: m.version })).status).toBe(200)
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM masjid_events WHERE masjid_id = ? AND status = 'deleted'").bind(m.id).first<{ n: number }>())!.n).toBe(200)
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM changes WHERE entity = 'event' AND masjid_id = ? AND op = 'delete'").bind(m.id).first<{ n: number }>())!.n).toBe(200)
  })

  it('a programme created after the handler listed them aborts the delete (pre-guard), nothing persists', async () => {
    const m = await createMasjid({ ...spot(77), name: 'Cascade 77' })
    const e1 = await mkEvent(m.id)
    const ctx = await mkCtx()
    const before = (await loadMasjid(env.DB, m.id))!
    const listed = [(await loadEvent(env.DB, e1.id))!]
    const late = await mkEvent(m.id) // created after the listing
    const now = isoNow()
    const r = await runCommit(ctx, {
      entity: 'masjid', op: 'delete', entityId: m.id, baseVersion: m.version, masjidId: null, changedFields: ['status'], before,
      after: { ...before, status: 'deleted', version: m.version + 1 }, status: 200,
      entityStatement: env.DB.prepare("UPDATE masjids SET status = 'deleted', version = version + 1 WHERE id = ? AND version = ?").bind(m.id, m.version),
      preGuards: [{
        condition: "NOT EXISTS (SELECT 1 FROM masjid_events WHERE masjid_id = ? AND status != 'deleted' AND id NOT IN (SELECT value FROM json_each(?)))",
        binds: [m.id, JSON.stringify(listed.map(e => e.id))],
      }],
    }, now)
    expect(r).toEqual({ ok: false, reason: 'precondition' })
    expect((await getMasjid(m.id)).status).toBe('active')
    expect((await loadEvent(env.DB, late.id))!.status).toBe('active')
  })
})

// ─── 5. Relink after delete ──────────────────────────────────────────────────

describe('relink after delete', () => {
  it('POST external_id held by a DELETED masjid moves the link: tombstone version bump + update change, new masjid holds it', async () => {
    const old = await createMasjid({ ...spot(78), name: 'Old 78', external_id: 'q_move' }, KEYS.qiyam.token)
    const del = await api('DELETE', `/masjids/${old.id}`, { ifMatch: old.version })
    const tomb = await del.json() as MasjidJson
    expect(tomb.external_ids).toEqual([{ app_id: 'qiyam', external_id: 'q_move' }]) // deleted masjids keep their ids

    const res = await api('POST', '/masjids?force=true', { token: KEYS.qiyam.token, body: { ...spot(78, 4000), name: 'New 78', type_id: 'masjid', state_id: 'my-kul', country_id: 'my', address: 'x', external_id: 'q_move' } })
    expect(res.status).toBe(201)
    const created = await res.json() as MasjidJson
    expect(created.external_ids).toEqual([{ app_id: 'qiyam', external_id: 'q_move' }])

    const now = (await loadMasjid(env.DB, old.id))!
    expect(now.status).toBe('deleted')
    expect(now.version).toBe(tomb.version + 1)
    expect(now.external_ids).toEqual([])
    const rows = await changes('masjid', old.id)
    const last = rows[rows.length - 1]
    expect(last).toMatchObject({ op: 'update', version: tomb.version + 1, origin_app: 'qiyam' })
    expect(JSON.parse(last.changed_fields)).toEqual(['external_ids'])
    expect(JSON.parse(last.after_json)).toEqual(now)

    const by = await api('GET', '/masjids/by-external/qiyam/q_move')
    expect(((await by.json()) as MasjidJson).id).toBe(created.id)
    // The create change comes after the tombstone change.
    const createRow = (await changes('masjid', created.id))[0]
    expect(createRow.seq).toBeGreaterThan(last.seq)
  })

  it('POST external_id held by an ACTIVE masjid is still 409 already_linked', async () => {
    const holder = await createMasjid({ ...spot(78, 8000), name: 'Holder 78', external_id: 'q_act' }, KEYS.qiyam.token)
    const res = await api('POST', '/masjids?force=true', { token: KEYS.qiyam.token, body: { ...spot(78, 12000), name: 'Other 78', type_id: 'masjid', state_id: 'my-kul', country_id: 'my', address: 'x', external_id: 'q_act' } })
    expect(res.status).toBe(409)
    expect(((await res.json()) as Err).details!.masjid_id).toBe(holder.id)
  })

  it('PUT link held by a deleted masjid moves it to the target in one batch; by-external returns the holder in any status', async () => {
    const old = await createMasjid({ ...spot(79), name: 'Old 79', external_id: 'jm_move' })
    const del = await (await api('DELETE', `/masjids/${old.id}`, { ifMatch: old.version })).json() as MasjidJson
    const by0 = await api('GET', '/masjids/by-external/jejak_masjid/jm_move')
    expect(by0.status).toBe(200)
    expect(((await by0.json()) as MasjidJson).status).toBe('deleted')

    const target = await createMasjid({ ...spot(79, 4000), name: 'Target 79' })
    const res = await api('PUT', `/masjids/${target.id}/external-ids/jejak_masjid`, { body: { external_id: 'jm_move' } })
    expect(res.status).toBe(200)
    const linked = await res.json() as MasjidJson
    expect(linked.external_ids).toEqual([{ app_id: 'jejak_masjid', external_id: 'jm_move' }])
    expect(linked.version).toBe(target.version + 1)
    expect((await loadMasjid(env.DB, old.id))!.version).toBe(del.version + 1)
    expect((await loadMasjid(env.DB, old.id))!.external_ids).toEqual([])
    const by = await api('GET', '/masjids/by-external/jejak_masjid/jm_move')
    expect(((await by.json()) as MasjidJson).id).toBe(target.id)

    // active holder: 409
    const third = await createMasjid({ ...spot(79, 8000), name: 'Third 79' })
    const clash = await api('PUT', `/masjids/${third.id}/external-ids/jejak_masjid`, { body: { external_id: 'jm_move' } })
    expect(clash.status).toBe(409)
    expect(((await clash.json()) as Err).details!.masjid_id).toBe(target.id)
  })

  it('by-external follows a merged holder to its survivor', async () => {
    const loser = await createMasjid({ ...spot(79, 12000), name: 'Loser 79', external_id: 'jm_merged' })
    const survivor = await createMasjid({ ...spot(79, 15000), name: 'Survivor 79' })
    await setStatus(loser.id, 'merged', survivor.id)
    const by = await api('GET', '/masjids/by-external/jejak_masjid/jm_merged')
    expect(by.status).toBe(200)
    expect(((await by.json()) as MasjidJson).id).toBe(survivor.id)
    // A merged holder still blocks a new POST with the same id.
    const res = await api('POST', '/masjids?force=true', { body: { ...spot(79, 18000), name: 'Again 79', type_id: 'masjid', state_id: 'my-kul', country_id: 'my', address: 'x', external_id: 'jm_merged' } })
    expect(res.status).toBe(409)
  })

  it('programmes: POST and PUT with an id held by a deleted programme move the link; an active holder is 409', async () => {
    const m = await createMasjid({ ...spot(80), name: 'Relink 80' })
    const old = await mkEvent(m.id, { external_id: 'ev_move' }, KEYS.qiyam.token)
    const tomb = await (await api('DELETE', `/events/${old.id}`, { ifMatch: old.version })).json() as Ev
    expect(tomb.external_ids).toEqual([{ app_id: 'qiyam', external_id: 'ev_move' }])
    expect(((await (await api('GET', '/events/by-external/qiyam/ev_move')).json()) as Ev).status).toBe('deleted')

    const created = await mkEvent(m.id, { external_id: 'ev_move' }, KEYS.qiyam.token)
    expect(created.external_ids).toEqual([{ app_id: 'qiyam', external_id: 'ev_move' }])
    const now = (await loadEvent(env.DB, old.id))!
    expect(now.version).toBe(tomb.version + 1)
    expect(now.external_ids).toEqual([])
    const rows = await changes('event', old.id)
    expect(JSON.parse(rows[rows.length - 1].changed_fields)).toEqual(['external_ids'])
    expect(rows[rows.length - 1].op).toBe('update')

    const dup = await api('POST', `/masjids/${m.id}/events`, { token: KEYS.qiyam.token, body: EVENT({ external_id: 'ev_move' }) })
    expect(dup.status).toBe(409)
    expect(((await dup.json()) as Err).details!.event_id).toBe(created.id)

    // PUT path
    const old2 = await mkEvent(m.id, { external_id: 'ev_put' }, KEYS.qiyam.token)
    await api('DELETE', `/events/${old2.id}`, { ifMatch: old2.version })
    const target = await mkEvent(m.id, {}, KEYS.qiyam.token)
    const put = await api('PUT', `/events/${target.id}/external-ids/qiyam`, { token: KEYS.qiyam.token, body: { external_id: 'ev_put' } })
    expect(put.status).toBe(200)
    expect(((await put.json()) as Ev).external_ids).toEqual([{ app_id: 'qiyam', external_id: 'ev_put' }])
    expect((await loadEvent(env.DB, old2.id))!.external_ids).toEqual([])
  })
})

// ─── 6. Matching and the duplicate gate ──────────────────────────────────────

describe('matching: type-aware duplicate gate', () => {
  const body = (extra: Record<string, unknown>) => ({ type_id: 'masjid', state_id: 'my-kul', country_id: 'my', address: 'x', ...extra })

  it('Surau Al-Ikhlas vs Masjid Al-Ikhlas 30 m apart: match lists it with same_type false; the gate does not fire', async () => {
    const existing = await createMasjid({ ...spot(81), name: 'Surau Al-Ikhlas', type_id: 'surau' })
    const q = spot(81, 30)
    const res = await api('GET', `/masjids/match?lat=${q.lat}&lng=${q.lng}&name=${encodeURIComponent('Masjid Al-Ikhlas')}&type_id=masjid`)
    const { candidates } = await res.json() as { candidates: Candidate[] }
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({ id: existing.id, type_id: 'surau', same_type: false })
    expect(candidates[0].score).toBeGreaterThanOrEqual(0.9)

    const post = await api('POST', '/masjids', { body: body({ ...q, name: 'Masjid Al-Ikhlas' }) })
    expect(post.status).toBe(201)
  })

  it('same type_id: the gate fires (409 possible_duplicate with same_type true); without type_id, same_type is null', async () => {
    const existing = await createMasjid({ ...spot(82), name: 'Masjid Al-Falah' })
    const q = spot(82, 20)
    const post = await api('POST', '/masjids', { body: body({ ...q, name: 'Masjid Al Falah' }) })
    expect(post.status).toBe(409)
    const err = await post.json() as Err
    expect(err.code).toBe('possible_duplicate')
    expect(err.details!.candidates[0]).toMatchObject({ id: existing.id, same_type: true })
    const res = await api('GET', `/masjids/match?lat=${q.lat}&lng=${q.lng}&name=Masjid%20Al%20Falah`)
    expect(((await res.json()) as { candidates: Candidate[] }).candidates[0].same_type).toBeNull()
    const same = await api('GET', `/masjids/match?lat=${q.lat}&lng=${q.lng}&name=Masjid%20Al%20Falah&type_id=masjid`)
    expect(((await same.json()) as { candidates: Candidate[] }).candidates[0].same_type).toBe(true)
  })

  it('conflicting block letters / phase numbers do not trip the gate; abbreviations do', async () => {
    await createMasjid({ ...spot(83), name: 'Surau Al-Hidayah Blok A', type_id: 'surau' })
    const b = await api('POST', '/masjids', { body: body({ ...spot(83, 40), name: 'Surau Al-Hidayah Blok B', type_id: 'surau' }) })
    expect(b.status).toBe(201)
    await createMasjid({ ...spot(83, 3000), name: 'Surau Taman Desa Fasa 1', type_id: 'surau' })
    const f = await api('POST', '/masjids', { body: body({ ...spot(83, 3040), name: 'Surau Taman Desa Fasa 2', type_id: 'surau' }) })
    expect(f.status).toBe(201)
    await createMasjid({ ...spot(83, 6000), name: 'Masjid Kampung Baru' })
    const kg = await api('POST', '/masjids', { body: body({ ...spot(83, 6040), name: 'Masjid Kg Baru' }) })
    expect(kg.status).toBe(409)
  })

  it('findCandidates reads the 1 km window only', async () => {
    const cands = await findCandidates(env.DB, spot(81).lat, spot(81).lng, 'Surau Al-Ikhlas', { typeId: 'surau' })
    expect(cands.every(c => c.distance_m <= 1000)).toBe(true)
    expect(cands[0].same_type).toBe(true)
  })
})

// ─── 9. Timestamps ───────────────────────────────────────────────────────────

describe('RFC 3339 offsets', () => {
  it('start_at / end_at with an offset are stored as UTC Z at second precision', async () => {
    const m = await createMasjid({ ...spot(84), name: 'Offsets 84' })
    const ev = await mkEvent(m.id, { start_at: '2026-12-01T20:30:15.789+08:00', end_at: '2026-12-01T22:00:00+08:00' })
    expect(ev.start_at).toBe('2026-12-01T12:30:15Z')
    expect(ev.end_at).toBe('2026-12-01T14:00:00Z')
    const patch = await api('PATCH', `/events/${ev.id}`, { ifMatch: ev.version, body: { start_at: '2026-12-01T10:00:00-03:30' } })
    expect(((await patch.json()) as Ev).start_at).toBe('2026-12-01T13:30:00Z')
  })

  it('invalid offsets and non-instants are 422', async () => {
    const m = await createMasjid({ ...spot(84, 3000), name: 'Offsets 84b' })
    for (const start_at of ['2026-12-01T20:30:00+24:00', '2026-12-01T20:30:00+08:60', '2026-12-01T25:00:00Z', '2026-12-01T20:30:00', '2026-13-01T10:00:00Z']) {
      expect((await api('POST', `/masjids/${m.id}/events`, { body: EVENT({ start_at }) })).status, start_at).toBe(422)
    }
  })

  it('query timestamps accept offsets (an unescaped + arrives as a space) and normalise to UTC', async () => {
    const m = await createMasjid({ ...spot(84, 6000), name: 'Offsets 84c' })
    const ev = await mkEvent(m.id, { start_at: '2026-12-10T12:00:00Z' })
    const inside = await api('GET', `/masjids/${m.id}/events?from=2026-12-10T19:00:00%2B08:00&to=2026-12-11T00:00:00%2B08:00`)
    expect(((await inside.json()) as { data: Ev[] }).data.map(e => e.id)).toEqual([ev.id])
    const bare = await api('GET', `/masjids/${m.id}/events?from=2026-12-10T19:00:00+08:00&to=2026-12-11T00:00:00+08:00`)
    expect(bare.status).toBe(200)
    expect(((await bare.json()) as { data: Ev[] }).data.map(e => e.id)).toEqual([ev.id])
    const since = await api('GET', '/masjids?updated_since=2020-01-01T08:00:00%2B08:00&limit=1')
    expect(since.status).toBe(200)
    expect((await api('GET', '/masjids?updated_since=nonsense')).status).toBe(422)
  })
})

// ─── 10. Low fixes ───────────────────────────────────────────────────────────

describe('low fixes', () => {
  it('HEAD needs the read scope like GET', async () => {
    const m = await createMasjid({ ...spot(85), name: 'Head 85' })
    const ev = await mkEvent(m.id)
    for (const path of [`/masjids/${m.id}`, '/masjids', `/events/${ev.id}`, `/masjids/${m.id}/events`]) {
      const ok = await SELF.fetch(`${BASE}${path}`, { method: 'HEAD', headers: bearer(KEYS.read.token) })
      expect(ok.status, path).toBe(200)
      const noRead = await SELF.fetch(`${BASE}${path}`, { method: 'HEAD', headers: bearer(KEYS.admin.token) })
      expect(noRead.status, path).toBe(403)
      const get = await SELF.fetch(`${BASE}${path}`, { headers: bearer(KEYS.admin.token) })
      expect(get.status, path).toBe(403)
    }
  })

  it('timezone is canonicalised', async () => {
    const m = await createMasjid({ ...spot(85, 3000), name: 'Tz 85' })
    const ev = await mkEvent(m.id, { timezone: 'asia/kuala_lumpur' })
    expect(ev.timezone).toBe('Asia/Kuala_Lumpur')
    const patch = await api('PATCH', `/events/${ev.id}`, { ifMatch: ev.version, body: { timezone: 'ASIA/SINGAPORE' } })
    expect(((await patch.json()) as Ev).timezone).toBe('Asia/Singapore')
    expect((await api('POST', `/masjids/${m.id}/events`, { body: EVENT({ timezone: 'Mars/Olympus' }) })).status).toBe(422)
  })

  it('PUT link on a merged masjid is 404 with details.merged_into (PATCH and DELETE too)', async () => {
    const loser = await createMasjid({ ...spot(85, 6000), name: 'Merged 85' })
    const survivor = await createMasjid({ ...spot(85, 9000), name: 'Survivor 85' })
    await setStatus(loser.id, 'merged', survivor.id)
    for (const res of [
      await api('PUT', `/masjids/${loser.id}/external-ids/jejak_masjid`, { body: { external_id: 'x' } }),
      await api('PATCH', `/masjids/${loser.id}`, { ifMatch: loser.version, body: { name: 'x' } }),
      await api('DELETE', `/masjids/${loser.id}`, { ifMatch: loser.version }),
    ]) {
      expect(res.status).toBe(404)
      expect(((await res.json()) as Err).details).toEqual({ merged_into: survivor.id })
    }
    const gone = await createMasjid({ ...spot(85, 12000), name: 'Gone 85' })
    await setStatus(gone.id, 'deleted')
    const res = await api('PUT', `/masjids/${gone.id}/external-ids/jejak_masjid`, { body: { external_id: 'x' } })
    expect(res.status).toBe(404)
    expect(((await res.json()) as Err).details).toBeUndefined()
  })

  it('PATCH lists geohash in changed_fields only when it actually changed', async () => {
    const m = await createMasjid({ ...spot(86), name: 'Geohash 86' })
    const moved = await api('PATCH', `/masjids/${m.id}`, { ifMatch: m.version, body: { lat: spot(86).lat + 0.01, lng: spot(86).lng } })
    const v2 = await moved.json() as MasjidJson
    const rows = await changes('masjid', m.id)
    expect(JSON.parse(rows[rows.length - 1].changed_fields)).toEqual(['geohash', 'lat'])
    const same = await api('PATCH', `/masjids/${m.id}`, { ifMatch: v2.version, body: { lat: v2.lat, lng: v2.lng } })
    expect(same.status).toBe(200)
    const rows2 = await changes('masjid', m.id)
    expect(JSON.parse(rows2[rows2.length - 1].changed_fields)).toEqual([])
  })

  it('events list hides programmes of non-active masjids (correlated EXISTS)', async () => {
    const live = await createMasjid({ ...spot(87), name: 'Live 87' })
    const dead = await createMasjid({ ...spot(87, 3000), name: 'Dead 87' })
    const e1 = await mkEvent(live.id)
    const e2 = await mkEvent(dead.id)
    await setStatus(dead.id, 'deleted')
    const res = await api('GET', `/events?masjid_ids=${live.id},${dead.id}`)
    expect(((await res.json()) as { data: Ev[] }).data.map(e => e.id)).toEqual([e1.id])
    expect(e2.id).not.toBe(e1.id)
  })
})
