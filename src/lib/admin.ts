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

function fail(status: 404 | 409 | 422, code: 'not_found' | 'validation_failed' | 'already_linked', message: string, details?: Record<string, unknown>): ApiError {
  return new ApiError(status, code, message, details)
}

function sortExternalIds<T extends { app_id: string; external_id: string }>(list: T[]): T[] {
  return [...list].sort((a, b) => (a.app_id + '\0' + a.external_id < b.app_id + '\0' + b.external_id ? -1 : 1))
}

// ─── Merge ───────────────────────────────────────────────────────────────────

/**
 * Merge `loserId` into `survivorId`. Specs, in order (survivor first, so its guards and version check run before any
 * other write):
 *   1. survivor `update` (changed_fields ["external_ids"], version +1)
 *   2. loser `merge` (status merged, merged_into set, external ids moved to the survivor, version +1); this is the
 *      idempotent response. Also resolves queue rows: the pair row becomes `merged`, every other pending row that
 *      involves the loser becomes `dismissed` (the survivor's version bump makes the next scan look at it again).
 *   3. one `event` `update` per non-deleted programme of the loser (masjid_id moves to the survivor).
 * Pre-guards: both masjids still active and different; no programme appeared on the loser since it was listed.
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
    preGuards: [
      {
        condition: "(SELECT COUNT(*) FROM masjids WHERE id IN (?, ?) AND status = 'active') = 2 AND ? != ?",
        binds: [loserId, survivorId, loserId, survivorId],
      },
      {
        // A programme created on the loser after we listed them would be stranded: abort, the caller retries.
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
      return versionConflict(s) // a programme was added meanwhile: retry
    },
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
    changeExtra: {
      merged_into: survivorId,
      moved_external_ids: movedExternalIds,
      ...(reason !== null ? { reason } : {}),
    },
    entityStatement: ctx.db
      .prepare(
        `UPDATE masjids SET status = 'merged', merged_into = ?, version = version + 1, updated_by_app = ?, updated_at = ?
         WHERE id = ? AND version = ?`,
      )
      .bind(survivorId, ADMIN_APP, now, loserId, loser.version),
    loadCurrent: () => loadMasjid(ctx.db, loserId),
    children: (b) => [
      b.stmt('UPDATE masjid_external_ids SET masjid_id = ? WHERE masjid_id = {{ID}}', [survivorId]),
      b.stmt(
        `UPDATE duplicate_candidates SET status = 'merged', resolved_at = ?
         WHERE status = 'pending' AND masjid_a = ? AND masjid_b = ?`,
        [now, pairA, pairB],
      ),
      b.stmt(
        `UPDATE duplicate_candidates SET status = 'dismissed', resolved_at = ?
         WHERE status = 'pending' AND (masjid_a = {{ID}} OR masjid_b = {{ID}})`,
        [now],
      ),
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

  return [survivorSpec, loserSpec, ...eventSpecs]
}

// ─── Revert ──────────────────────────────────────────────────────────────────

interface ChangeRow {
  seq: number
  entity: string
  entity_id: number
  op: string
  before_json: string | null
  after_json: string
}

const REVERT_IGNORED_KEYS = new Set(['version', 'updated_at', 'updated_by_app'])

/** Fields whose value differs between two entities (the revert's `changed_fields`). */
function diffFields(current: object, target: object): string[] {
  const cur = current as Record<string, unknown>
  const tgt = target as Record<string, unknown>
  return Object.keys(tgt).filter(k => !REVERT_IGNORED_KEYS.has(k) && JSON.stringify(cur[k]) !== JSON.stringify(tgt[k]))
}

function linkDiff(
  current: Array<{ app_id: string; external_id: string }>,
  target: Array<{ app_id: string; external_id: string }>,
) {
  const key = (e: { app_id: string; external_id: string }) => `${e.app_id}\0${e.external_id}`
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
  added: Array<{ app_id: string; external_id: string }>,
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

export async function buildRevertSpecs(rawCtx: WriteCtx, seq: number, now: string): Promise<WriteSpec[]> {
  const ctx = adminCtx(rawCtx, `revert:${seq}`)
  const change = await ctx.db
    .prepare('SELECT seq, entity, entity_id, op, before_json, after_json FROM changes WHERE seq = ?')
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
  if (change.entity === 'masjid') return revertMasjid(ctx, change, target, now)
  if (change.entity === 'event') return revertEvent(ctx, change, target, now)
  throw fail(422, 'validation_failed', 'Unknown entity in the change log', { reason: 'unknown_entity', entity: change.entity })
}

async function revertMasjid(ctx: WriteCtx, change: ChangeRow, target: unknown, now: string): Promise<WriteSpec[]> {
  const id = change.entity_id
  const current = await loadMasjid(ctx.db, id)
  if (!current) throw fail(404, 'not_found', 'Masjid not found', { masjid_id: id })
  if (current.status === 'merged') {
    throw fail(422, 'validation_failed', 'The masjid was merged into another; revert is refused', {
      reason: 'entity_merged', masjid_id: id, merged_into: current.merged_into,
    })
  }

  // Reverting a create = soft delete (with the programme cascade).
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
  const t = sanity(target, id, ['name', 'type_id', 'lat', 'lng', 'geohash', 'country_id', 'state_id', 'status', 'contacts', 'facilities', 'images', 'external_ids']) as unknown as MasjidEntity
  if (t.status === 'merged') {
    throw fail(422, 'validation_failed', 'The logged state is a merged masjid', { reason: 'entity_merged', masjid_id: id })
  }

  const links = linkDiff(current.external_ids, t.external_ids)
  await assertLinksFree(ctx.db, 'masjid', id, links.added)

  const restored: MasjidEntity = {
    ...t,
    id,
    version: current.version + 1,
    updated_by_app: ADMIN_APP,
    updated_at: now,
  }
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
    entityStatement: ctx.db
      .prepare(
        `UPDATE masjids SET name = ?, type_id = ?, lat = ?, lng = ?, geohash = ?, city_id = ?, state_id = ?, country_id = ?,
           address = ?, description = ?, status = ?, deleted_at = NULL, merged_into = ?, jumaat_available = ?,
           telephone = ?, email = ?, google_url = ?, version = version + 1, updated_by_app = ?, updated_at = ?
         WHERE id = ? AND version = ?`,
      )
      .bind(
        t.name, t.type_id, t.lat, t.lng, t.geohash, t.city_id, t.state_id, t.country_id,
        t.address, t.description, t.status, t.merged_into, t.jumaat_available ? 1 : 0,
        t.telephone, t.email, t.google_url, ADMIN_APP, now, id, current.version,
      ),
    loadCurrent: () => loadMasjid(ctx.db, id),
    children: (b) => {
      const out: D1PreparedStatement[] = []
      if (!same(current.contacts, t.contacts)) {
        out.push(b.stmt('DELETE FROM masjid_contacts WHERE masjid_id = {{ID}}'))
        for (const c of t.contacts) out.push(b.stmt('INSERT INTO masjid_contacts (masjid_id, type, value) VALUES ({{ID}}, ?, ?)', [c.type, c.value]))
      }
      if (!same(current.facilities, t.facilities)) {
        out.push(b.stmt('DELETE FROM masjid_facilities WHERE masjid_id = {{ID}}'))
        for (const f of t.facilities) {
          out.push(b.stmt('INSERT INTO masjid_facilities (masjid_id, code, available) VALUES ({{ID}}, ?, ?)', [f.code, f.available ? 1 : 0]))
        }
      }
      if (!same(current.images, t.images)) {
        out.push(b.stmt('DELETE FROM masjid_images WHERE masjid_id = {{ID}}'))
        for (const im of t.images) {
          out.push(b.stmt(
            'INSERT INTO masjid_images (masjid_id, url, is_thumbnail, sort_order, created_at) VALUES ({{ID}}, ?, ?, ?, ?)',
            [im.url, im.is_thumbnail ? 1 : 0, im.sort_order, now],
          ))
        }
      }
      // External-id links: delete the rows the logged state does not have, re-add the ones it had.
      for (const e of links.removed) {
        out.push(b.stmt('DELETE FROM masjid_external_ids WHERE masjid_id = {{ID}} AND app_id = ? AND external_id = ?', [e.app_id, e.external_id]))
      }
      for (const e of links.added) {
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

async function revertEvent(ctx: WriteCtx, change: ChangeRow, target: unknown, now: string): Promise<WriteSpec[]> {
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
  const t = sanity(target, id, ['masjid_id', 'title', 'category', 'start_at', 'timezone', 'status', 'external_ids']) as unknown as EventEntity

  const links = linkDiff(current.external_ids, t.external_ids)
  await assertLinksFree(ctx.db, 'event', id, links.added)

  const restored: EventEntity = { ...t, id, version: current.version + 1, updated_by_app: ADMIN_APP, updated_at: now }
  const spec: WriteSpec = {
    entity: 'event',
    op: 'update',
    entityId: id,
    baseVersion: current.version,
    masjidId: t.masjid_id,
    changedFields: diffFields(current, restored),
    before: current,
    after: restored,
    originApp: ADMIN_APP,
    entityStatement: ctx.db
      .prepare(
        `UPDATE masjid_events SET masjid_id = ?, title = ?, description = ?, category = ?, speaker = ?, start_at = ?, end_at = ?,
           timezone = ?, rrule = ?, status = ?, poster_url = ?, registration_url = ?,
           version = version + 1, updated_by_app = ?, updated_at = ?
         WHERE id = ? AND version = ?`,
      )
      .bind(
        t.masjid_id, t.title, t.description, t.category, t.speaker, t.start_at, t.end_at,
        t.timezone, t.rrule, t.status, t.poster_url, t.registration_url, ADMIN_APP, now, id, current.version,
      ),
    loadCurrent: () => loadEvent(ctx.db, id),
    children: (b) => [
      ...links.removed.map(e =>
        b.stmt('DELETE FROM event_external_ids WHERE event_id = {{ID}} AND app_id = ? AND external_id = ?', [e.app_id, e.external_id])),
      ...links.added.map(e =>
        b.stmt('INSERT INTO event_external_ids (app_id, external_id, event_id, created_at) VALUES (?, ?, {{ID}}, ?)', [e.app_id, e.external_id, now])),
    ],
    status: 200,
  }
  return [withMasjidGuards(spec, [t.masjid_id, current.masjid_id])]
}
