import { describe, it, expect } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { BASE, KEYS, api, bearer, createMasjid, getMasjid, patchMasjid, spot } from './helpers'
import { loadMasjid } from '../src/lib/entities'
import { buildMergeSpecs, buildRevertSpecs } from '../src/lib/admin'
import { runCommitMany, type WriteCtx } from '../src/lib/write'
import { isoNow } from '../src/lib/time'

interface Err { error: string; code: string; details?: Record<string, any> }
interface Ent { id: number; version: number; status: string; external_ids: Array<{ app_id: string; external_id: string }>; [k: string]: any }

const day = 24 * 3600 * 1000
const at = (offsetDays: number) => {
  const d = new Date(Date.now() + offsetDays * day)
  d.setUTCHours(12, 0, 0, 0)
  return d.toISOString().replace('.000Z', 'Z')
}
const admin = KEYS.admin.token

async function mkEvent(masjidId: number, extra: Record<string, unknown> = {}, token: string = KEYS.jm.token): Promise<Ent> {
  const res = await api('POST', `/masjids/${masjidId}/events`, { token, body: { title: 'Kuliah', start_at: at(3), ...extra } })
  if (res.status !== 201) throw new Error(`mkEvent ${res.status} ${await res.text()}`)
  return res.json() as Promise<Ent>
}
async function mkMasjid(n: number, extra: Record<string, unknown> = {}, token: string = KEYS.jm.token): Promise<Ent> {
  return createMasjid({ ...spot(n), name: `Masjid S4 ${n}`, ...extra }, token) as Promise<Ent>
}
async function changes(entity: string, id: number) {
  return (await env.DB.prepare('SELECT * FROM changes WHERE entity = ? AND entity_id = ? ORDER BY seq').bind(entity, id).all<Record<string, any>>()).results
}
async function lastSeq(entity: string, id: number): Promise<number> {
  const rows = await changes(entity, id)
  return rows[rows.length - 1].seq
}
const merge = (id: number, body: unknown, opts: { token?: string; idemKey?: string } = {}) =>
  api('POST', `/admin/masjids/${id}/merge`, { token: opts.token ?? admin, body, idemKey: opts.idemKey, actor: 'admin-1' })
const revert = (seq: number, opts: { token?: string } = {}) =>
  api('POST', `/admin/changes/${seq}/revert`, { token: opts.token ?? admin, body: {}, actor: 'admin-1' })
const putLink = (id: number, token: string, appId: string, externalId: string) =>
  api('PUT', `/masjids/${id}/external-ids/${appId}`, { token, body: { external_id: externalId } })
async function mkCtx(): Promise<WriteCtx> {
  const row = await env.DB.prepare('SELECT id FROM api_keys WHERE app_id = ?').bind('sentral_admin').first<{ id: number }>()
  return { db: env.DB, keyId: row!.id, originApp: 'sentral_admin', actor: 'admin-1', idemKey: `k-${crypto.randomUUID()}`, requestHash: 'h', bodyText: '', ifMatch: null }
}

// ─── Merge ───────────────────────────────────────────────────────────────────

describe('POST /admin/masjids/:id/merge', () => {
  it('moves links and programmes to the survivor and emits the contract changes (contract check 10)', async () => {
    const survivor = await mkMasjid(1, { external_id: 'jm-surv' })
    const loser = await mkMasjid(2, { external_id: 'jm-lose' }) // JM id on both: a survivor may hold two ids from one app
    expect((await putLink(loser.id, KEYS.qiyam.token, 'qiyam', 'q-lose')).status).toBe(200)
    const e1 = await mkEvent(loser.id, { title: 'Moves 1' })
    const e2 = await mkEvent(loser.id, { title: 'Cancelled one' })
    await api('PATCH', `/events/${e2.id}`, { ifMatch: e2.version, body: { status: 'cancelled' } })
    const gone = await mkEvent(loser.id, { title: 'Already deleted' })
    await api('DELETE', `/events/${gone.id}`, { ifMatch: gone.version })
    const loserBefore = await getMasjid(loser.id)
    const survivorBefore = await getMasjid(survivor.id)

    const res = await merge(loser.id, { into: survivor.id, reason: 'same place' })
    expect(res.status).toBe(200)
    const body = await res.json() as Ent
    expect(body).toMatchObject({ id: loser.id, status: 'merged', merged_into: survivor.id, version: loserBefore.version + 1, external_ids: [] })

    // Survivor: both JM ids and the Qiyam id, version +1, an `update` change listing external_ids.
    const s = await getMasjid(survivor.id) as Ent
    expect(s.version).toBe(survivorBefore.version + 1)
    expect(s.external_ids).toEqual([
      { app_id: 'jejak_masjid', external_id: 'jm-lose' },
      { app_id: 'jejak_masjid', external_id: 'jm-surv' },
      { app_id: 'qiyam', external_id: 'q-lose' },
    ])
    const sc = (await changes('masjid', survivor.id)).at(-1)!
    expect(sc).toMatchObject({ op: 'update', origin_app: 'sentral_admin', actor: 'admin-1', version: s.version })
    expect(JSON.parse(sc.changed_fields)).toEqual(['external_ids'])

    // Loser: a `merge` change whose after_json carries merged_into and moved_external_ids.
    const lc = (await changes('masjid', loser.id)).at(-1)!
    expect(lc).toMatchObject({ op: 'merge', origin_app: 'sentral_admin', version: body.version })
    const lafter = JSON.parse(lc.after_json)
    expect(lafter.merged_into).toBe(survivor.id)
    expect(lafter.moved_external_ids).toEqual([
      { app_id: 'jejak_masjid', external_id: 'jm-lose' },
      { app_id: 'qiyam', external_id: 'q-lose' },
    ])
    expect(lafter.status).toBe('merged')

    // by-external of either id returns the survivor; the loser id redirects.
    for (const [app, ext] of [['jejak_masjid', 'jm-lose'], ['jejak_masjid', 'jm-surv'], ['qiyam', 'q-lose']]) {
      const r = await SELF.fetch(`${BASE}/masjids/by-external/${app}/${ext}`, { headers: bearer(KEYS.read.token) })
      expect(r.status).toBe(200)
      expect((await r.json() as Ent).id).toBe(survivor.id)
    }
    const redirect = await SELF.fetch(`${BASE}/masjids/${loser.id}`, { headers: bearer(KEYS.read.token), redirect: 'manual' })
    expect(redirect.status).toBe(301)
    expect(redirect.headers.get('location')).toBe(`/masjids/${survivor.id}`)

    // Programmes: live ones moved (version +1, `event` update with the new masjid_id); the deleted one stayed.
    for (const e of [e1, e2]) {
      const row = await env.DB.prepare('SELECT masjid_id, version FROM masjid_events WHERE id = ?').bind(e.id).first<{ masjid_id: number; version: number }>()
      expect(row!.masjid_id).toBe(survivor.id)
      const ec = (await changes('event', e.id)).at(-1)!
      expect(ec).toMatchObject({ op: 'update', masjid_id: survivor.id, origin_app: 'sentral_admin', version: row!.version })
      expect(JSON.parse(ec.changed_fields)).toEqual(['masjid_id'])
      expect(JSON.parse(ec.after_json).masjid_id).toBe(survivor.id)
      expect(JSON.parse(ec.before_json).masjid_id).toBe(loser.id)
    }
    const still = await env.DB.prepare('SELECT masjid_id FROM masjid_events WHERE id = ?').bind(gone.id).first<{ masjid_id: number }>()
    expect(still!.masjid_id).toBe(loser.id)
    const list = await SELF.fetch(`${BASE}/masjids/${survivor.id}/events`, { headers: bearer(KEYS.read.token) })
    expect(((await list.json()) as { data: Ent[] }).data.map(e => e.id).sort()).toEqual([e1.id, e2.id].sort())

    // Change order in the feed: survivor, then loser, then events.
    const seqs = [sc.seq, lc.seq, (await changes('event', e1.id)).at(-1)!.seq]
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
  })

  it('replays the same Idempotency-Key and refuses a second merge', async () => {
    const survivor = await mkMasjid(3)
    const loser = await mkMasjid(4)
    const key = `merge-${crypto.randomUUID()}`
    const a = await merge(loser.id, { into: survivor.id }, { idemKey: key })
    const b = await merge(loser.id, { into: survivor.id }, { idemKey: key })
    expect(a.status).toBe(200)
    expect(b.headers.get('Idempotent-Replay')).toBe('true')
    expect(await b.json()).toEqual(await a.json())
    expect((await changes('masjid', loser.id)).filter(c => c.op === 'merge')).toHaveLength(1)
    const again = await merge(loser.id, { into: survivor.id })
    expect(again.status).toBe(422)
    expect(((await again.json()) as Err).details).toMatchObject({ reason: 'not_active', status: 'merged' })
  })

  it('refuses itself, a non-active target, a non-active loser, missing masjids and bad bodies', async () => {
    const a = await mkMasjid(5)
    const b = await mkMasjid(6)
    const dead = await mkMasjid(7)
    await api('DELETE', `/masjids/${dead.id}`, { ifMatch: dead.version })

    const self = await merge(a.id, { into: a.id })
    expect(self.status).toBe(422)
    expect(((await self.json()) as Err).details).toMatchObject({ reason: 'same_masjid' })

    const intoDead = await merge(a.id, { into: dead.id })
    expect(intoDead.status).toBe(422)
    expect(((await intoDead.json()) as Err).details).toMatchObject({ reason: 'not_active', masjid_id: dead.id })
    const fromDead = await merge(dead.id, { into: a.id })
    expect(fromDead.status).toBe(422)

    expect((await merge(a.id, { into: 99_999_999 })).status).toBe(404)
    expect((await merge(99_999_999, { into: a.id })).status).toBe(404)
    expect((await merge(a.id, {})).status).toBe(422)
    expect((await merge(a.id, { into: 'x' })).status).toBe(422)
    expect((await merge(a.id, { into: b.id, reason: 5 })).status).toBe(422)
    // nothing changed
    expect((await getMasjid(a.id)).version).toBe(a.version)
  })

  it('refuses a loser with more than 200 live programmes (too_many_events) and changes nothing', async () => {
    const survivor = await mkMasjid(8)
    const loser = await mkMasjid(9)
    const stmts = Array.from({ length: 201 }, (_, i) => env.DB
      .prepare("INSERT INTO masjid_events (masjid_id, title, category, start_at, source_app) VALUES (?, ?, 'lain', ?, 'jejak_masjid')")
      .bind(loser.id, `Bulk ${i}`, at(5)))
    await env.DB.batch(stmts)
    const res = await merge(loser.id, { into: survivor.id })
    expect(res.status).toBe(422)
    expect(((await res.json()) as Err).details).toMatchObject({ reason: 'too_many_events', max_events: 200 })
    expect((await getMasjid(loser.id)).status).toBe('active')
    expect((await getMasjid(survivor.id)).version).toBe(survivor.version)
  })

  it('is atomic: a masjid that stops being active between the read and the commit rolls everything back', async () => {
    const survivor = await mkMasjid(10, { external_id: 'atomic-s' })
    const loser = await mkMasjid(11, { external_id: 'atomic-l' })
    const ev = await mkEvent(loser.id)
    const ctx = await mkCtx()
    const specs = await buildMergeSpecs(ctx, loser.id, survivor.id, null, isoNow())
    await env.DB.prepare("UPDATE masjids SET status = 'deleted' WHERE id = ?").bind(survivor.id).run()
    const r = await runCommitMany(ctx, specs)
    expect(r).toEqual({ ok: false, reason: 'precondition' })
    expect((await loadMasjid(env.DB, loser.id))!.status).toBe('active')
    expect((await loadMasjid(env.DB, loser.id))!.external_ids).toEqual([{ app_id: 'jejak_masjid', external_id: 'atomic-l' }])
    const evRow = await env.DB.prepare('SELECT masjid_id, version FROM masjid_events WHERE id = ?').bind(ev.id).first<{ masjid_id: number; version: number }>()
    expect(evRow).toEqual({ masjid_id: loser.id, version: ev.version })
    expect((await changes('masjid', loser.id)).filter(c => c.op === 'merge')).toHaveLength(0)
  })

  it('is atomic against a stale loser version too (concurrent PATCH wins, nothing from the merge persists)', async () => {
    const survivor = await mkMasjid(12)
    const loser = await mkMasjid(13, { external_id: 'stale-l' })
    const ctx = await mkCtx()
    const specs = await buildMergeSpecs(ctx, loser.id, survivor.id, null, isoNow())
    expect((await patchMasjid(loser.id, loser.version, { name: 'Raced rename' })).status).toBe(200)
    const r = await runCommitMany(ctx, specs)
    expect(r).toEqual({ ok: false, reason: 'version' })
    const s = await loadMasjid(env.DB, survivor.id)
    expect(s!.version).toBe(survivor.version)
    expect(s!.external_ids).toEqual([])
  })

  it('an admin key is required', async () => {
    const a = await mkMasjid(14)
    const b = await mkMasjid(15)
    for (const token of [KEYS.jm.token, KEYS.read.token, KEYS.webhook.token]) {
      expect((await merge(a.id, { into: b.id }, { token })).status).toBe(403)
    }
    expect((await getMasjid(a.id)).status).toBe('active')
  })
})

// ─── Revert ──────────────────────────────────────────────────────────────────

describe('POST /admin/changes/:seq/revert', () => {
  it('restores an update fully: scalars, contacts, facilities and images; records revert:<seq> and a higher version', async () => {
    const m = await mkMasjid(20, {
      description: 'Original',
      telephone: '+60312345678',
      contacts: [{ type: 'facebook', value: 'https://facebook.com/orig' }, { type: 'website', value: 'https://orig.example' }],
      facilities: [{ code: 'TOILET_FEMALE', available: true }, { code: 'PARKING_COMPOUND', available: false }],
      images: [{ url: 'https://img.example/1.jpg', is_thumbnail: true }, { url: 'https://img.example/2.jpg' }],
    })
    const before = await getMasjid(m.id)
    const p = await patchMasjid(m.id, m.version, {
      name: 'Renamed',
      description: null,
      lat: before.lat as number + 0.0001,
      lng: before.lng as number,
      contacts: [{ type: 'facebook', value: null }, { type: 'instagram', value: 'https://instagram.com/new' }],
      facilities: [{ code: 'TOILET_FEMALE', available: null }, { code: 'TOILET_MALE', available: true }],
      images: [{ url: 'https://img.example/3.jpg' }],
    })
    expect(p.status).toBe(200)
    const edited = await p.json() as Ent
    const seq = await lastSeq('masjid', m.id)

    const res = await revert(seq)
    expect(res.status).toBe(200)
    const after = await res.json() as Ent
    expect(after.version).toBe(edited.version + 1)

    const now = await getMasjid(m.id)
    const strip = (e: Record<string, unknown>) => { const { version, updated_at, updated_by_app, ...rest } = e; return rest }
    expect(strip(now)).toEqual(strip(before))
    expect(now.version).toBe(edited.version + 1)
    expect(now.updated_by_app).toBe('sentral_admin')
    expect(now).toEqual(after)

    const c = (await changes('masjid', m.id)).at(-1)!
    expect(c).toMatchObject({ op: 'update', actor: `revert:${seq}`, origin_app: 'sentral_admin' })
    expect(JSON.parse(c.changed_fields)).toEqual(expect.arrayContaining(['name', 'description', 'lat', 'geohash', 'contacts', 'facilities', 'images']))
    expect(JSON.parse(c.after_json)).toEqual(now)
  })

  it('reverting a link change deletes the link row; reverting that revert re-adds it', async () => {
    const m = await mkMasjid(21, { external_id: 'jm-keep' })
    const linked = await (await putLink(m.id, KEYS.qiyam.token, 'qiyam', 'q-link')).json() as Ent
    const linkSeq = await lastSeq('masjid', m.id)
    expect(linked.external_ids).toHaveLength(2)

    const r1 = await revert(linkSeq)
    expect(r1.status).toBe(200)
    expect((await getMasjid(m.id)).external_ids).toEqual([{ app_id: 'jejak_masjid', external_id: 'jm-keep' }])
    const gone = await env.DB.prepare("SELECT COUNT(*) AS n FROM masjid_external_ids WHERE app_id = 'qiyam' AND external_id = 'q-link'").first<{ n: number }>()
    expect(gone!.n).toBe(0)
    // the id is free again: another masjid can take it
    const other = await mkMasjid(22)
    expect((await putLink(other.id, KEYS.qiyam.token, 'qiyam', 'q-link')).status).toBe(200)

    // Revert the revert while the id is held by another masjid: refused, nothing changes.
    const revertSeq = (await changes('masjid', m.id)).at(-1)!.seq
    const blocked = await revert(revertSeq)
    expect(blocked.status).toBe(409)
    expect(((await blocked.json()) as Err).code).toBe('already_linked')

    // Free it (delete `other` moves nothing; relink semantics keep it) - so instead restore on a clean masjid:
    const solo = await mkMasjid(23)
    await putLink(solo.id, KEYS.qiyam.token, 'qiyam', 'q-solo')
    const sSeq = await lastSeq('masjid', solo.id)
    await revert(sSeq)
    const rrSeq = await lastSeq('masjid', solo.id)
    const back = await revert(rrSeq)
    expect(back.status).toBe(200)
    expect((await getMasjid(solo.id)).external_ids).toEqual([{ app_id: 'qiyam', external_id: 'q-solo' }])
    const row = await env.DB.prepare("SELECT masjid_id FROM masjid_external_ids WHERE external_id = 'q-solo'").first<{ masjid_id: number }>()
    expect(row!.masjid_id).toBe(solo.id)
  })

  it('reverting a create soft-deletes the masjid and its programmes', async () => {
    const m = await mkMasjid(24)
    const ev = await mkEvent(m.id)
    const createSeq = (await changes('masjid', m.id))[0].seq
    const res = await revert(createSeq)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ id: m.id, status: 'deleted', version: m.version + 1 })
    const c = (await changes('masjid', m.id)).at(-1)!
    expect(c).toMatchObject({ op: 'delete', actor: `revert:${createSeq}` })
    const evc = (await changes('event', ev.id)).at(-1)!
    expect(evc).toMatchObject({ op: 'delete', actor: `revert:${createSeq}` })
    // already deleted: refused
    expect((await revert(createSeq)).status).toBe(422)
  })

  it('reverting a delete restores the masjid as active with its prior fields (programmes stay deleted)', async () => {
    const m = await mkMasjid(25, {
      description: 'Back soon',
      contacts: [{ type: 'website', value: 'https://back.example' }],
      facilities: [{ code: 'TOILET_MALE', available: true }],
      external_id: 'jm-back',
    })
    const ev = await mkEvent(m.id)
    const full = await getMasjid(m.id)
    expect((await api('DELETE', `/masjids/${m.id}`, { ifMatch: full.version })).status).toBe(200)
    const delSeq = await lastSeq('masjid', m.id)

    const res = await revert(delSeq)
    expect(res.status).toBe(200)
    const back = await getMasjid(m.id)
    const strip = (e: Record<string, unknown>) => { const { version, updated_at, updated_by_app, ...rest } = e; return rest }
    expect(strip(back)).toEqual(strip(full))
    expect(back.status).toBe('active')
    expect(back.version).toBe(full.version + 2)
    expect((await changes('masjid', m.id)).at(-1)).toMatchObject({ op: 'update', actor: `revert:${delSeq}` })
    const deletedAt = await env.DB.prepare('SELECT deleted_at FROM masjids WHERE id = ?').bind(m.id).first<{ deleted_at: string | null }>()
    expect(deletedAt!.deleted_at).toBeNull()
    const evRow = await env.DB.prepare('SELECT status FROM masjid_events WHERE id = ?').bind(ev.id).first<{ status: string }>()
    expect(evRow!.status).toBe('deleted')
    // reverting the delete again: not deleted any more
    const again = await revert(delSeq)
    expect(again.status).toBe(422)
    expect(((await again.json()) as Err).details).toMatchObject({ reason: 'not_deleted' })
  })

  it('refuses merge reverts, the changes a merge made, merged entities, and unknown changes', async () => {
    const survivor = await mkMasjid(26, { external_id: 'rv-s' })
    const loser = await mkMasjid(27, { external_id: 'rv-l' })
    const ev = await mkEvent(loser.id)
    await patchMasjid(loser.id, loser.version, { name: 'Edited before merge' })
    const loserUpdateSeq = await lastSeq('masjid', loser.id)
    expect((await merge(loser.id, { into: survivor.id })).status).toBe(200)

    const mergeSeq = await lastSeq('masjid', loser.id)
    const survivorSeq = await lastSeq('masjid', survivor.id)
    const eventSeq = await lastSeq('event', ev.id)
    for (const seq of [mergeSeq, survivorSeq, eventSeq]) {
      const res = await revert(seq)
      expect(res.status).toBe(422)
      expect(((await res.json()) as Err).details).toMatchObject({ reason: 'merge_not_revertable' })
    }
    const merged = await revert(loserUpdateSeq)
    expect(merged.status).toBe(422)
    expect(((await merged.json()) as Err).details).toMatchObject({ reason: 'entity_merged', merged_into: survivor.id })
    expect((await revert(2_000_000_000)).status).toBe(404)
    // survivor still holds the links
    expect((await getMasjid(survivor.id)).external_ids).toHaveLength(2)
  })

  it('refuses reverting an update of a deleted masjid', async () => {
    const m = await mkMasjid(28)
    const p = await (await patchMasjid(m.id, m.version, { name: 'Late edit' })).json() as Ent
    const seq = await lastSeq('masjid', m.id)
    await api('DELETE', `/masjids/${m.id}`, { ifMatch: p.version })
    const res = await revert(seq)
    expect(res.status).toBe(422)
    expect(((await res.json()) as Err).details).toMatchObject({ reason: 'entity_deleted' })
  })

  it('a concurrent write between the read and the commit is a 409-style conflict and persists nothing', async () => {
    const m = await mkMasjid(29)
    await patchMasjid(m.id, m.version, { name: 'Edit 1' })
    const seq = await lastSeq('masjid', m.id)
    const ctx = await mkCtx()
    const specs = await buildRevertSpecs(ctx, seq, isoNow())
    const cur = await getMasjid(m.id)
    expect((await patchMasjid(m.id, cur.version, { name: 'Edit 2' })).status).toBe(200)
    expect(await runCommitMany(ctx, specs)).toEqual({ ok: false, reason: 'version' })
    expect((await getMasjid(m.id)).name).toBe('Edit 2')
  })

  it('reverts programme updates, deletes and creates', async () => {
    const m = await mkMasjid(30)
    const ev = await mkEvent(m.id, { title: 'Original', external_id: 'p-1', category: 'kuliah' })
    const upd = await (await api('PATCH', `/events/${ev.id}`, { ifMatch: ev.version, body: { title: 'Changed', category: 'ceramah', status: 'cancelled' } })).json() as Ent
    const updSeq = await lastSeq('event', ev.id)

    const r = await revert(updSeq)
    expect(r.status).toBe(200)
    const restored = await (await SELF.fetch(`${BASE}/events/${ev.id}`, { headers: bearer(KEYS.read.token) })).json() as Ent
    expect(restored).toMatchObject({ title: 'Original', category: 'kuliah', status: 'active', version: upd.version + 1, updated_by_app: 'sentral_admin' })
    expect(restored.external_ids).toEqual([{ app_id: 'jejak_masjid', external_id: 'p-1' }])
    expect((await changes('event', ev.id)).at(-1)).toMatchObject({ op: 'update', actor: `revert:${updSeq}` })

    // delete then revert the delete
    expect((await api('DELETE', `/events/${ev.id}`, { ifMatch: restored.version })).status).toBe(200)
    const delSeq = await lastSeq('event', ev.id)
    expect((await revert(delSeq)).status).toBe(200)
    const back = await (await SELF.fetch(`${BASE}/events/${ev.id}`, { headers: bearer(KEYS.read.token) })).json() as Ent
    expect(back).toMatchObject({ title: 'Original', status: 'active' })

    // revert the create = soft delete
    const createSeq = (await changes('event', ev.id))[0].seq
    const del = await revert(createSeq)
    expect(del.status).toBe(200)
    expect(await del.json()).toMatchObject({ id: ev.id, status: 'deleted' })
    expect((await changes('event', ev.id)).at(-1)).toMatchObject({ op: 'delete', actor: `revert:${createSeq}` })
  })

  it('refuses a programme revert when its masjid is no longer active', async () => {
    const m = await mkMasjid(31)
    const ev = await mkEvent(m.id)
    await api('PATCH', `/events/${ev.id}`, { ifMatch: ev.version, body: { title: 'Edit' } })
    const seq = await lastSeq('event', ev.id)
    await env.DB.prepare("UPDATE masjids SET status = 'deleted' WHERE id = ?").bind(m.id).run()
    const res = await revert(seq)
    expect(res.status).toBe(422)
    expect(((await res.json()) as Err).details).toMatchObject({ reason: 'masjid_not_active', masjid_id: m.id })
  })

  it('needs the admin scope', async () => {
    const m = await mkMasjid(32)
    const seq = await lastSeq('masjid', m.id)
    for (const token of [KEYS.jm.token, KEYS.read.token]) {
      expect((await revert(seq, { token })).status).toBe(403)
    }
  })
})
