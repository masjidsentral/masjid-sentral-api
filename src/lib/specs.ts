// Reusable pieces of write specs shared by the masjid and programme routes: external-id holders and relinking,
// programme soft deletes (also used by the masjid delete cascade) and the "masjid is active" pre-guard.

import { ApiError } from './errors'
import { EVENT_COLUMNS, hydrateEvents, loadEvent, loadMasjid, type EventEntity, type MasjidEntity } from './entities'
import { versionConflict, type WriteCtx, type WriteSpec } from './write'

export type LinkKind = 'masjid' | 'event'

const LINKS = {
  masjid: { table: 'masjids', links: 'masjid_external_ids', col: 'masjid_id' },
  event: { table: 'masjid_events', links: 'event_external_ids', col: 'event_id' },
} as const

export interface Holder {
  id: number
  status: string
}

/** The entity that holds `(app_id, external_id)`, whatever its status; null when the id is free. */
export async function findHolder(db: D1Database, kind: LinkKind, appId: string, externalId: string): Promise<Holder | null> {
  const t = LINKS[kind]
  return db
    .prepare(
      `SELECT e.id AS id, e.status AS status FROM ${t.links} l JOIN ${t.table} e ON e.id = l.${t.col}
       WHERE l.app_id = ? AND l.external_id = ?`,
    )
    .bind(appId, externalId)
    .first<Holder>()
}

/**
 * A deleted entity keeps its external ids, so a relink moves the id off the tombstone: this spec deletes the old
 * link row, bumps the tombstone's version and records an `update` change (`changed_fields: ["external_ids"]`).
 * Put it BEFORE the spec that inserts the link on the new holder.
 */
export async function tombstoneUnlinkSpec(
  ctx: WriteCtx,
  kind: LinkKind,
  holderId: number,
  appId: string,
  externalId: string,
  now: string,
): Promise<WriteSpec> {
  const t = LINKS[kind]
  const before = kind === 'masjid' ? await loadMasjid(ctx.db, holderId) : await loadEvent(ctx.db, holderId)
  if (!before) throw new ApiError(404, 'not_found', 'Link holder not found')
  const after = {
    ...before,
    external_ids: before.external_ids.filter(e => !(e.app_id === appId && e.external_id === externalId)),
    version: before.version + 1,
    updated_by_app: ctx.originApp,
    updated_at: now,
  }
  return {
    entity: kind,
    op: 'update',
    entityId: holderId,
    baseVersion: before.version,
    masjidId: kind === 'event' ? (before as EventEntity).masjid_id : null,
    changedFields: ['external_ids'],
    before,
    after,
    entityStatement: ctx.db
      .prepare(`UPDATE ${t.table} SET version = version + 1, updated_by_app = ?, updated_at = ? WHERE id = ? AND version = ?`)
      .bind(ctx.originApp, now, holderId, before.version),
    loadCurrent: () => (kind === 'masjid' ? loadMasjid(ctx.db, holderId) : loadEvent(ctx.db, holderId)),
    children: (b) => [b.stmt(`DELETE FROM ${t.links} WHERE app_id = ? AND external_id = ?`, [appId, externalId])],
    status: 200,
  }
}

/** Soft delete of a programme (DELETE /events/:id and the masjid delete cascade). */
export function eventDeleteSpec(ctx: WriteCtx, before: EventEntity, now: string): WriteSpec {
  const after = { ...before, status: 'deleted' as const, version: before.version + 1, updated_by_app: ctx.originApp, updated_at: now }
  return {
    entity: 'event',
    op: 'delete',
    entityId: before.id,
    baseVersion: before.version,
    masjidId: before.masjid_id,
    changedFields: ['status'],
    before,
    after,
    entityStatement: ctx.db
      .prepare(
        `UPDATE masjid_events SET status = 'deleted', version = version + 1, updated_by_app = ?, updated_at = ?
         WHERE id = ? AND version = ?`,
      )
      .bind(ctx.originApp, now, before.id, before.version),
    loadCurrent: () => loadEvent(ctx.db, before.id),
    status: 200,
  }
}

/** 404 for a masjid that is gone, deleted or merged; `details.merged_into` names the survivor of a merge. */
export function masjidNotActive(m: { status: string; merged_into: number | null } | null | undefined, what = 'Masjid'): ApiError {
  return new ApiError(
    404, 'not_found', `${what} not found or not active`,
    m?.status === 'merged' && m.merged_into !== null ? { merged_into: m.merged_into } : undefined,
  )
}

/** Pre-guard: the masjid is still active when the batch runs. */
export function activeMasjidGuard(masjidId: number): NonNullable<WriteSpec['preGuards']>[number] {
  return { condition: "EXISTS (SELECT 1 FROM masjids WHERE id = ? AND status = 'active')", binds: [masjidId] }
}

/** Builds the error for a lost active-masjid pre-guard (re-reads the masjid for `merged_into`). */
export function lostActiveMasjid(db: D1Database, masjidId: number): () => Promise<ApiError> {
  return async () => {
    const m = await db
      .prepare('SELECT status, merged_into FROM masjids WHERE id = ?')
      .bind(masjidId)
      .first<{ status: string; merged_into: number | null }>()
    return masjidNotActive(m)
  }
}

export const MAX_CASCADE_EVENTS = 200

/** Every non-deleted programme of a masjid, hydrated. More than MAX_CASCADE_EVENTS: 422 `too_many_events`. */
export async function loadLiveEvents(db: D1Database, masjidId: number, verb: 'delete' | 'merge'): Promise<EventEntity[]> {
  const eventRows = await db
    .prepare(`SELECT ${EVENT_COLUMNS} FROM masjid_events WHERE masjid_id = ? AND status != 'deleted' ORDER BY id LIMIT ?`)
    .bind(masjidId, MAX_CASCADE_EVENTS + 1)
    .all<Omit<EventEntity, 'external_ids'>>()
  if (eventRows.results.length > MAX_CASCADE_EVENTS) {
    throw new ApiError(
      422, 'validation_failed',
      verb === 'delete'
        ? `This masjid has more than ${MAX_CASCADE_EVENTS} programmes; delete some of them first, then delete the masjid`
        : `This masjid has more than ${MAX_CASCADE_EVENTS} programmes; delete or move some of them first, then merge it`,
      { reason: 'too_many_events', max_events: MAX_CASCADE_EVENTS },
    )
  }
  return hydrateEvents(db, eventRows.results)
}

/**
 * Soft delete of an active masjid plus every non-deleted programme (one batch; each programme gets a version bump
 * and an `event` `delete` change). Used by DELETE /masjids/:id and by the revert of a masjid create. More than
 * MAX_CASCADE_EVENTS programmes: 422 `too_many_events`. A programme created after the listing aborts the batch
 * (409 version_conflict, retry). The masjid spec comes first.
 */
export async function masjidDeleteSpecs(ctx: WriteCtx, before: MasjidEntity, now: string): Promise<WriteSpec[]> {
  const id = before.id
  const events = await loadLiveEvents(ctx.db, id, 'delete')

  const after: MasjidEntity = { ...before, status: 'deleted', version: before.version + 1, updated_by_app: ctx.originApp, updated_at: now }
  const masjidSpec: WriteSpec = {
    entity: 'masjid',
    op: 'delete',
    entityId: id,
    baseVersion: before.version,
    masjidId: null,
    changedFields: ['status'],
    before,
    after,
    entityStatement: ctx.db
      .prepare(
        `UPDATE masjids SET status = 'deleted', deleted_at = ?, version = version + 1, updated_by_app = ?, updated_at = ?
         WHERE id = ? AND version = ?`,
      )
      .bind(now, ctx.originApp, now, id, before.version),
    // A programme created after we listed them would be left active under a deleted masjid: abort and let the client retry.
    preGuards: [{
      condition: `NOT EXISTS (SELECT 1 FROM masjid_events WHERE masjid_id = ? AND status != 'deleted'
                              AND id NOT IN (SELECT value FROM json_each(?)))`,
      binds: [id, JSON.stringify(events.map(e => e.id))],
    }],
    onPreconditionLost: async () => versionConflict(await loadMasjid(ctx.db, id)),
    loadCurrent: () => loadMasjid(ctx.db, id),
    status: 200,
  }
  return [masjidSpec, ...events.map(e => eventDeleteSpec(ctx, e, now))]
}
