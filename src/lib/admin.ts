// Admin write builders (S4): merge a duplicate masjid into a survivor, and revert a logged change.
// Both return WriteSpec lists for runCommitMany / commitWrite, so they get the same atomicity as every other write
// (version guards, pre-guards, change log, idempotency, webhook enqueue in one D1 batch).

import { ApiError } from './errors'
import {
  loadEvent, loadMasjid, type EventEntity, type MasjidEntity,
} from './entities'
import {
  activeMasjidGuard, eventDeleteSpec, findHolder, loadLiveEvents, masjidDeleteSpecs,
} from './specs'
import { versionConflict, type WriteCtx, type WriteSpec } from './write'

export const ADMIN_APP = 'sentral_admin'

/** The admin identity every admin write is recorded under. */
export function adminCtx(ctx: WriteCtx, actor?: string): WriteCtx {
  return { ...ctx, originApp: ADMIN_APP, actor: actor ?? ctx.actor }
}

function fail(status: 404 | 409 | 422, code: 'not_found' | 'validation_failed' | 'already_linked' | 'stale_revert', message: string, details?: Record<string, unknown>): ApiError {
  return new ApiError(status, code, message, details)
}

function sortExternalIds<T extends { app_id: string; external_id: string }>(list: T[]): T[] {
  return [...list].sort((a, b) => (a.app_id + '\0' + a.external_id < b.app_id + '\0' + b.external_id ? -1 : 1))
}

// ─── Merge ───────────────────────────────────────────────────────────────────

/**
 * Merge `loserId` into `survivorId`. Specs, in order (the loser first, so the guards and the loser's version check
 * run before any other write; the feed shows the merge before the changes it caused):
 *   1. loser `merge` (status merged, merged_into set, external ids moved to the survivor, version +1); this is the
 *      idempotent response. Its children also: resolve the queue (the pair row becomes `merged`; the loser's other
 *      pending pairs are re-pointed to the survivor, then dismissed) and flatten chains (every tombstone that pointed
 *      at the loser now points at the survivor, so a 301 is one hop).
 *   2. one `event` `update` per non-deleted programme of the loser (masjid_id moves to the survivor).
 *   3. survivor `update` (changed_fields ["external_ids"], version +1).
 * Pre-guards (on spec 1): both masjids still active and different; no programme appeared on the loser since it was
 * listed. The admin's `reason` goes to changes.admin_note, never into the feed.
 */
export async function buildMergeSpecs(
  rawCtx: WriteCtx,
  loserId: number,
  survivorId: number,
  reason: string | null,
  now: string,
): Promise<WriteSpec[]> {
  const ctx = adminCtx(rawCtx)
  if (loserId === survivorId) {
    throw fail(422, 'validation_failed', 'A masjid cannot be merged into itself', { field: 'into', reason: 'same_masjid' })
  }
  const [loser, survivor] = await Promise.all([loadMasjid(ctx.db, loserId), loadMasjid(ctx.db, survivorId)])
  if (!loser) throw fail(404, 'not_found', 'Masjid not found', { masjid_id: loserId })
  if (!survivor) throw fail(404, 'not_found', 'Target masjid not found', { masjid_id: survivorId })
  for (const m of [loser, survivor]) {
    if (m.status !== 'active') {
      throw fail(422, 'validation_failed', `Masjid ${m.id} is ${m.status}; only active masjids can be merged`, {
        reason: 'not_active', masjid_id: m.id, status: m.status,
      })
    }
  }
  const events = await loadLiveEvents(ctx.db, loserId, 'merge')

  const movedExternalIds = loser.external_ids
  const survivorAfter: MasjidEntity = {
    ...survivor,
    external_ids: sortExternalIds([...survivor.external_ids, ...movedExternalIds]),
    version: survivor.version + 1,
    updated_by_app: ADMIN_APP,
    updated_at: now,
  }
  const loserAfter: MasjidEntity = {
    ...loser,
    status: 'merged',
    merged_into: survivorId,
    external_ids: [],
    version: loser.version + 1,
    updated_by_app: ADMIN_APP,
    updated_at: now,
  }

  const survivorSpec: WriteSpec = {
    entity: 'masjid',
    op: 'update',
    entityId: survivorId,
    baseVersion: survivor.version,
    masjidId: null,
    changedFields: ['external_ids'],
    before: survivor,
    after: survivorAfter,
    originApp: ADMIN_APP,
    changeExtra: { via_merge: loserId },
    entityStatement: ctx.db
      .prepare('UPDATE masjids SET version = version + 1, updated_by_app = ?, updated_at = ? WHERE id = ? AND version = ?')
      .bind(ADMIN_APP, now, survivorId, survivor.version),
    loadCurrent: () => loadMasjid(ctx.db, survivorId),
    status: 200,
  }

  const pairA = Math.min(loserId, survivorId)
  const pairB = Math.max(loserId, survivorId)
  const loserSpec: WriteSpec = {
    entity: 'masjid',
    op: 'merge',
    respond: true,
    entityId: loserId,
    baseVersion: loser.version,
    masjidId: null,
    changedFields: movedExternalIds.length > 0 ? ['status', 'merged_into', 'external_ids'] : ['status', 'merged_into'],
    before: loser,
    after: loserAfter,
    originApp: ADMIN_APP,
    changeExtra: { merged_into: survivorId, moved_external_ids: movedExternalIds },
    adminNote: reason,
    entityStatement: ctx.db
      .prepare(
        `UPDATE masjids SET status = 'merged', merged_into = ?, version = version + 1, updated_by_app = ?, updated_at = ?
         WHERE id = ? AND version = ?`,
      )
      .bind(survivorId, ADMIN_APP, now, loserId, loser.version),
    preGuards: [
      {
        condition: "(SELECT COUNT(*) FROM masjids WHERE id IN (?, ?) AND status = 'active') = 2 AND ? != ?",
        binds: [loserId, survivorId, loserId, survivorId],
      },
      {
        condition: `NOT EXISTS (SELECT 1 FROM masjid_events WHERE masjid_id = ? AND status != 'deleted'
                                AND id NOT IN (SELECT value FROM json_each(?)))`,
        binds: [loserId, JSON.stringify(events.map(e => e.id))],
      },
    ],
    onPreconditionLost: async () => {
      const [l, s] = await Promise.all([loadMasjid(ctx.db, loserId), loadMasjid(ctx.db, survivorId)])
      for (const m of [l, s]) {
        if (!m) return fail(404, 'not_found', 'Masjid not found')
        if (m.status !== 'active') {
          return fail(422, 'validation_failed', `Masjid ${m.id} is ${m.status}; only active masjids can be merged`, {
            reason: 'not_active', masjid_id: m.id, status: m.status,
          })
        }
      }
      return versionConflict(l) // a programme was added meanwhile: retry
    },
    loadCurrent: () => loadMasjid(ctx.db, loserId),
    children: (b) => [
      b.stmt('UPDATE masjid_external_ids SET masjid_id = ? WHERE masjid_id = {{ID}}', [survivorId]),
      b.stmt(
        `UPDATE duplicate_candidates SET status = 'merged', resolved_at = ?, resolved_by = ?
         WHERE status = 'pending' AND masjid_a = ? AND masjid_b = ?`,
        [now, ctx.actor, pairA, pairB],
      ),
      // The loser's other pending pairs move to the survivor (the pair is queued under the survivor unless it
      // already exists in any state), then the old rows are closed.
      b.stmt(
        `INSERT OR IGNORE INTO duplicate_candidates (masjid_a, masjid_b, score, distance_m)
         SELECT MIN(o, ?), MAX(o, ?), score, distance_m FROM (
           SELECT CASE WHEN masjid_a = {{ID}} THEN masjid_b ELSE masjid_a END AS o, score, distance_m
           FROM duplicate_candidates
           WHERE status = 'pending' AND (masjid_a = {{ID}} OR masjid_b = {{ID}})
         ) WHERE o != ?`,
        [survivorId, survivorId, survivorId],
      ),
      b.stmt(
        `UPDATE duplicate_candidates SET status = 'dismissed', resolved_at = ?, resolved_by = ?
         WHERE status = 'pending' AND (masjid_a = {{ID}} OR masjid_b = {{ID}})`,
        [now, ctx.actor],
      ),
      // Flatten merge chains: tombstones that pointed at the loser now point at the survivor (no version bump).
      b.stmt('UPDATE masjids SET merged_into = ? WHERE merged_into = {{ID}}', [survivorId]),
    ],
    status: 200,
  }

  const eventSpecs: WriteSpec[] = events.map(e => ({
    entity: 'event',
    op: 'update',
    entityId: e.id,
    baseVersion: e.version,
    masjidId: survivorId,
    changedFields: ['masjid_id'],
    before: e,
    after: { ...e, masjid_id: survivorId, version: e.version + 1, updated_by_app: ADMIN_APP, updated_at: now },
    originApp: ADMIN_APP,
    changeExtra: { via_merge: loserId },
    entityStatement: ctx.db
      .prepare('UPDATE masjid_events SET masjid_id = ?, version = version + 1, updated_by_app = ?, updated_at = ? WHERE id = ? AND version = ?')
      .bind(survivorId, ADMIN_APP, now, e.id, e.version),
    loadCurrent: () => loadEvent(ctx.db, e.id),
    status: 200,
  }))

  return [loserSpec, ...eventSpecs, survivorSpec]
}

interface ChangeRow {
  seq: number
  entity: string
  entity_id: number
  op: string
  changed_fields: string
  before_json: string | null
  after_json: string
}

const REVERT_IGNORED_KEYS = new Set(['version', 'updated_at', 'updated_by_app'])
const MASJID_SCALARS = [
  'name', 'type_id', 'lat', 'lng', 'geohash', 'city_id', 'state_id', 'country_id', 'address', 'description',
  'jumaat_available', 'telephone', 'email', 'google_url',
] as const
const MASJID_COLLECTIONS = ['contacts', 'facilities', 'images'] as const
const EVENT_SCALARS = [
  'title', 'description', 'category', 'speaker', 'start_at', 'end_at', 'timezone', 'rrule', 'status', 'poster_url', 'registration_url',
] as const

type Link = { app_id: string; external_id: string }

/** Fields whose value differs between two entities (the revert's `changed_fields`). */
function diffFields(current: object, target: object): string[] {
  const cur = current as Record<string, unknown>
  const tgt = target as Record<string, unknown>
  return Object.keys(tgt).filter(k => !REVERT_IGNORED_KEYS.has(k) && JSON.stringify(cur[k]) !== JSON.stringify(tgt[k]))
}

function linkDiff(current: Link[], target: Link[]) {
  const key = (e: Link) => `${e.app_id}\0${e.external_id}`
  const cur = new Set(current.map(key))
  const tgt = new Set(target.map(key))
  return {
    removed: current.filter(e => !tgt.has(key(e))),
    added: target.filter(e => !cur.has(key(e))),
  }
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** The target state must look like the entity it claims to be (a damaged before_json is refused, not applied). */
function sanity(target: unknown, entityId: number, required: string[]): Record<string, unknown> {
  const t = target as Record<string, unknown> | null
  if (!t || typeof t !== 'object' || t.id !== entityId || required.some(k => !(k in t))) {
    throw fail(422, 'validation_failed', 'The logged state cannot be restored', { reason: 'bad_before_json' })
  }
  return t
}

async function assertLinksFree(
  db: D1Database,
  kind: 'masjid' | 'event',
  entityId: number,
  added: Link[],
): Promise<void> {
  for (const link of added) {
    const holder = await findHolder(db, kind, link.app_id, link.external_id)
    if (holder && holder.id !== entityId) {
      throw fail(409, 'already_linked', 'An external id from the logged state now belongs to another entity', {
        [kind === 'masjid' ? 'masjid_id' : 'event_id']: holder.id,
        app_id: link.app_id,
        external_id: link.external_id,
      })
    }
  }
}

function parseList(json: string | undefined): string[] {
  try {
    const v = JSON.parse(json ?? '[]') as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/** Later changes to the same entity that touched any of `fields`: reverting would silently undo them. */
async function laterTouching(db: D1Database, change: ChangeRow, fields: string[]): Promise<number[]> {
  const rows = await db
    .prepare('SELECT seq, changed_fields FROM changes WHERE entity = ? AND entity_id = ? AND seq > ? ORDER BY seq')
    .bind(change.entity, change.entity_id, change.seq)
    .all<{ seq: number; changed_fields: string }>()
  const wanted = new Set(fields)
  return rows.results.filter(r => parseList(r.changed_fields).some(f => wanted.has(f))).map(r => r.seq)
}

export interface RevertOptions {
  /** Revert despite later changes to the same fields (recorded as `forced: true` in the change data). */
  force?: boolean
}

export async function buildRevertSpecs(rawCtx: WriteCtx, seq: number, now: string, opts: RevertOptions = {}): Promise<WriteSpec[]> {
  const ctx = adminCtx(rawCtx, `revert:${seq}:${rawCtx.actor}`)
  const change = await ctx.db
    .prepare('SELECT seq, entity, entity_id, op, changed_fields, before_json, after_json FROM changes WHERE seq = ?')
    .bind(seq)
    .first<ChangeRow>()
  if (!change) throw fail(404, 'not_found', 'Change not found', { seq })

  let after: Record<string, unknown>
  try {
    after = JSON.parse(change.after_json) as Record<string, unknown>
  } catch {
    after = {}
  }
  if (change.op === 'merge' || 'via_merge' in after) {
    throw fail(422, 'validation_failed', 'Merges, and the changes a merge made, cannot be reverted in v1.1', {
      reason: 'merge_not_revertable', seq,
    })
  }

  const target = change.before_json === null ? null : (JSON.parse(change.before_json) as unknown)
  if (change.entity === 'masjid') return revertMasjid(ctx, change, after, target, now, opts)
  if (change.entity === 'event') return revertEvent(ctx, change, after, target, now, opts)
  throw fail(422, 'validation_failed', 'Unknown entity in the change log', { reason: 'unknown_entity', entity: change.entity })
}

/**
 * Field-level revert of an `update` (or the full restore of a `delete`): only the fields the change listed are
 * restored, from its before_json. Returns the fields to restore, the external-id delta and the `forced` marker.
 */
async function planFieldRevert(
  ctx: WriteCtx,
  change: ChangeRow,
  after: Record<string, unknown>,
  t: Record<string, unknown>,
  scalars: readonly string[],
  collections: readonly string[],
  opts: RevertOptions,
): Promise<{ scalarFields: string[]; collectionFields: string[]; linksTouched: boolean; forced: boolean }> {
  const listed = parseList(change.changed_fields)
  const scalarFields = scalars.filter(f => listed.includes(f))
  const collectionFields = collections.filter(f => listed.includes(f))
  const linksTouched = listed.includes('external_ids')
  const touched = [...scalarFields, ...collectionFields, ...(linksTouched ? ['external_ids'] : [])]
  if (touched.length === 0) {
    throw fail(422, 'validation_failed', 'The change lists no field that can be restored', { reason: 'nothing_to_revert', seq: change.seq })
  }
  sanity(t, change.entity_id, touched)
  if (linksTouched && !Array.isArray((after as { external_ids?: unknown }).external_ids)) {
    throw fail(422, 'validation_failed', 'The logged state cannot be restored', { reason: 'bad_before_json' })
  }
  const later = await laterTouching(ctx.db, change, touched)
  if (later.length > 0 && !opts.force) {
    throw fail(422, 'stale_revert', 'Later changes touched the same fields; revert would undo them (retry with ?force=true to override)', {
      reason: 'stale_revert', seq: change.seq, fields: touched, later_seqs: later.slice(0, 50),
    })
  }
  return { scalarFields, collectionFields, linksTouched, forced: later.length > 0 }
}

/** The ids this change added (to delete now) and removed (to re-add now), against the entity's current ids. */
function linkRevertPlan(current: Link[], before: Link[], afterIds: Link[]) {
  const change = linkDiff(before, afterIds) // removed: the change took them away; added: the change put them there
  const key = (e: Link) => `${e.app_id}\0${e.external_id}`
  const cur = new Set(current.map(key))
  const toDelete = change.added.filter(e => cur.has(key(e)))
  const toInsert = change.removed.filter(e => !cur.has(key(e)))
  const drop = new Set(toDelete.map(key))
  const next = sortExternalIds([...current.filter(e => !drop.has(key(e))), ...toInsert])
  return { toDelete, toInsert, next }
}

async function revertMasjid(
  ctx: WriteCtx, change: ChangeRow, afterJson: Record<string, unknown>, target: unknown, now: string, opts: RevertOptions,
): Promise<WriteSpec[]> {
  const id = change.entity_id
  const current = await loadMasjid(ctx.db, id)
  if (!current) throw fail(404, 'not_found', 'Masjid not found', { masjid_id: id })
  if (current.status === 'merged') {
    throw fail(422, 'validation_failed', 'The masjid was merged into another; revert is refused', {
      reason: 'entity_merged', masjid_id: id, merged_into: current.merged_into,
    })
  }

  if (target === null) {
    if (current.status !== 'active') {
      throw fail(422, 'validation_failed', 'The masjid is already deleted', { reason: 'already_deleted', masjid_id: id })
    }
    return (await masjidDeleteSpecs(ctx, current, now)).map(sp => ({ ...sp, originApp: ADMIN_APP }))
  }

  if (change.op === 'delete' && current.status !== 'deleted') {
    throw fail(422, 'validation_failed', 'The masjid is not deleted', { reason: 'not_deleted', masjid_id: id })
  }
  if (change.op !== 'delete' && current.status === 'deleted') {
    throw fail(422, 'validation_failed', 'The masjid is deleted; revert the delete first', { reason: 'entity_deleted', masjid_id: id })
  }
  const t = sanity(target, id, ['status', 'external_ids']) as unknown as MasjidEntity
  if (t.status === 'merged') {
    throw fail(422, 'validation_failed', 'The logged state is a merged masjid', { reason: 'entity_merged', masjid_id: id })
  }

  let restored: MasjidEntity
  let plan: { scalarFields: string[]; collectionFields: string[]; linksTouched: boolean; forced: boolean }
  if (change.op === 'delete') {
    // Revert of a delete: the whole logged state comes back (the masjid was inert while deleted).
    sanity(target, id, ['name', 'type_id', 'lat', 'lng', 'geohash', 'country_id', 'state_id', 'contacts', 'facilities', 'images'])
    plan = { scalarFields: [...MASJID_SCALARS], collectionFields: [...MASJID_COLLECTIONS], linksTouched: true, forced: false }
    restored = { ...current, ...t, id, merged_into: t.merged_into ?? null }
  } else {
    plan = await planFieldRevert(ctx, change, afterJson, t as unknown as Record<string, unknown>, MASJID_SCALARS, MASJID_COLLECTIONS, opts)
    restored = { ...current }
    for (const f of plan.scalarFields) (restored as unknown as Record<string, unknown>)[f] = (t as unknown as Record<string, unknown>)[f]
    for (const f of plan.collectionFields) (restored as unknown as Record<string, unknown>)[f] = (t as unknown as Record<string, unknown>)[f]
  }

  let toDelete: Link[] = []
  let toInsert: Link[] = []
  if (change.op === 'delete') {
    const links = linkDiff(current.external_ids, t.external_ids)
    toDelete = links.removed
    toInsert = links.added
    restored.external_ids = t.external_ids
  } else if (plan.linksTouched) {
    const lp = linkRevertPlan(current.external_ids, t.external_ids, (afterJson as { external_ids: Link[] }).external_ids)
    toDelete = lp.toDelete
    toInsert = lp.toInsert
    restored.external_ids = lp.next
  }
  await assertLinksFree(ctx.db, 'masjid', id, toInsert)

  restored = { ...restored, id, version: current.version + 1, updated_by_app: ADMIN_APP, updated_at: now }
  const fields = diffFields(current, restored)

  return [{
    entity: 'masjid',
    op: 'update',
    entityId: id,
    baseVersion: current.version,
    masjidId: null,
    changedFields: fields,
    before: current,
    after: restored,
    originApp: ADMIN_APP,
    ...(plan.forced ? { changeExtra: { forced: true } } : {}),
    entityStatement: ctx.db
      .prepare(
        `UPDATE masjids SET name = ?, type_id = ?, lat = ?, lng = ?, geohash = ?, city_id = ?, state_id = ?, country_id = ?,
           address = ?, description = ?, status = ?, deleted_at = NULL, merged_into = ?, jumaat_available = ?,
           telephone = ?, email = ?, google_url = ?, version = version + 1, updated_by_app = ?, updated_at = ?
         WHERE id = ? AND version = ?`,
      )
      .bind(
        restored.name, restored.type_id, restored.lat, restored.lng, restored.geohash, restored.city_id, restored.state_id,
        restored.country_id, restored.address, restored.description, restored.status, restored.merged_into,
        restored.jumaat_available ? 1 : 0, restored.telephone, restored.email, restored.google_url,
        ADMIN_APP, now, id, current.version,
      ),
    loadCurrent: () => loadMasjid(ctx.db, id),
    children: (b) => {
      const out: D1PreparedStatement[] = []
      if (plan.collectionFields.includes('contacts') && !same(current.contacts, restored.contacts)) {
        out.push(b.stmt('DELETE FROM masjid_contacts WHERE masjid_id = {{ID}}'))
        for (const c of restored.contacts) out.push(b.stmt('INSERT INTO masjid_contacts (masjid_id, type, value) VALUES ({{ID}}, ?, ?)', [c.type, c.value]))
      }
      if (plan.collectionFields.includes('facilities') && !same(current.facilities, restored.facilities)) {
        out.push(b.stmt('DELETE FROM masjid_facilities WHERE masjid_id = {{ID}}'))
        for (const f of restored.facilities) {
          out.push(b.stmt('INSERT INTO masjid_facilities (masjid_id, code, available) VALUES ({{ID}}, ?, ?)', [f.code, f.available ? 1 : 0]))
        }
      }
      if (plan.collectionFields.includes('images') && !same(current.images, restored.images)) {
        out.push(b.stmt('DELETE FROM masjid_images WHERE masjid_id = {{ID}}'))
        for (const im of restored.images) {
          out.push(b.stmt(
            'INSERT INTO masjid_images (masjid_id, url, is_thumbnail, sort_order, created_at) VALUES ({{ID}}, ?, ?, ?, ?)',
            [im.url, im.is_thumbnail ? 1 : 0, im.sort_order, now],
          ))
        }
      }
      for (const e of toDelete) {
        out.push(b.stmt('DELETE FROM masjid_external_ids WHERE masjid_id = {{ID}} AND app_id = ? AND external_id = ?', [e.app_id, e.external_id]))
      }
      for (const e of toInsert) {
        out.push(b.stmt(
          'INSERT INTO masjid_external_ids (app_id, external_id, masjid_id, created_at) VALUES (?, ?, {{ID}}, ?)',
          [e.app_id, e.external_id, now],
        ))
      }
      return out
    },
    status: 200,
  }]
}

async function revertEvent(
  ctx: WriteCtx, change: ChangeRow, afterJson: Record<string, unknown>, target: unknown, now: string, opts: RevertOptions,
): Promise<WriteSpec[]> {
  const id = change.entity_id
  const current = await loadEvent(ctx.db, id)
  if (!current) throw fail(404, 'not_found', 'Programme not found', { event_id: id })

  const withMasjidGuards = (spec: WriteSpec, masjidIds: number[]): WriteSpec => ({
    ...spec,
    preGuards: [...new Set(masjidIds)].map(activeMasjidGuard),
    onPreconditionLost: async () => {
      for (const m of new Set(masjidIds)) {
        const row = await ctx.db
          .prepare('SELECT status, merged_into FROM masjids WHERE id = ?')
          .bind(m)
          .first<{ status: string; merged_into: number | null }>()
        if (!row || row.status !== 'active') {
          return new ApiError(422, 'validation_failed', "The programme's masjid is not active; revert is refused", {
            reason: 'masjid_not_active', masjid_id: m, ...(row?.status === 'merged' ? { merged_into: row.merged_into } : {}),
          })
        }
      }
      return versionConflict(await loadEvent(ctx.db, id))
    },
  })

  if (target === null) {
    if (current.status === 'deleted') {
      throw fail(422, 'validation_failed', 'The programme is already deleted', { reason: 'already_deleted', event_id: id })
    }
    return [withMasjidGuards({ ...eventDeleteSpec(ctx, current, now), originApp: ADMIN_APP }, [current.masjid_id])]
  }

  if (change.op === 'delete' && current.status !== 'deleted') {
    throw fail(422, 'validation_failed', 'The programme is not deleted', { reason: 'not_deleted', event_id: id })
  }
  if (change.op !== 'delete' && current.status === 'deleted') {
    throw fail(422, 'validation_failed', 'The programme is deleted; revert the delete first', { reason: 'entity_deleted', event_id: id })
  }
  const t = sanity(target, id, ['masjid_id', 'status', 'external_ids']) as unknown as EventEntity

  let restored: EventEntity
  let plan: { scalarFields: string[]; collectionFields: string[]; linksTouched: boolean; forced: boolean }
  if (change.op === 'delete') {
    sanity(target, id, ['title', 'category', 'start_at', 'timezone'])
    plan = { scalarFields: [...EVENT_SCALARS], collectionFields: [], linksTouched: true, forced: false }
    restored = { ...current, ...t, id }
  } else {
    plan = await planFieldRevert(ctx, change, afterJson, t as unknown as Record<string, unknown>, EVENT_SCALARS, [], opts)
    restored = { ...current }
    for (const f of plan.scalarFields) (restored as unknown as Record<string, unknown>)[f] = (t as unknown as Record<string, unknown>)[f]
  }

  let toDelete: Link[] = []
  let toInsert: Link[] = []
  if (change.op === 'delete') {
    const links = linkDiff(current.external_ids, t.external_ids)
    toDelete = links.removed
    toInsert = links.added
    restored.external_ids = t.external_ids
  } else if (plan.linksTouched) {
    const lp = linkRevertPlan(current.external_ids, t.external_ids, (afterJson as { external_ids: Link[] }).external_ids)
    toDelete = lp.toDelete
    toInsert = lp.toInsert
    restored.external_ids = lp.next
  }
  await assertLinksFree(ctx.db, 'event', id, toInsert)

  restored = { ...restored, id, version: current.version + 1, updated_by_app: ADMIN_APP, updated_at: now }
  const spec: WriteSpec = {
    entity: 'event',
    op: 'update',
    entityId: id,
    baseVersion: current.version,
    masjidId: restored.masjid_id,
    changedFields: diffFields(current, restored),
    before: current,
    after: restored,
    originApp: ADMIN_APP,
    ...(plan.forced ? { changeExtra: { forced: true } } : {}),
    entityStatement: ctx.db
      .prepare(
        `UPDATE masjid_events SET masjid_id = ?, title = ?, description = ?, category = ?, speaker = ?, start_at = ?, end_at = ?,
           timezone = ?, rrule = ?, status = ?, poster_url = ?, registration_url = ?,
           version = version + 1, updated_by_app = ?, updated_at = ?
         WHERE id = ? AND version = ?`,
      )
      .bind(
        restored.masjid_id, restored.title, restored.description, restored.category, restored.speaker, restored.start_at, restored.end_at,
        restored.timezone, restored.rrule, restored.status, restored.poster_url, restored.registration_url, ADMIN_APP, now, id, current.version,
      ),
    loadCurrent: () => loadEvent(ctx.db, id),
    children: (b) => [
      ...toDelete.map(e =>
        b.stmt('DELETE FROM event_external_ids WHERE event_id = {{ID}} AND app_id = ? AND external_id = ?', [e.app_id, e.external_id])),
      ...toInsert.map(e =>
        b.stmt('INSERT INTO event_external_ids (app_id, external_id, event_id, created_at) VALUES (?, ?, {{ID}}, ?)', [e.app_id, e.external_id, now])),
    ],
    status: 200,
  }
  return [withMasjidGuards(spec, [restored.masjid_id, current.masjid_id])]
}
