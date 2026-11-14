import { Hono } from 'hono'
import { requireScope, type AppEnv } from '../middleware/auth'
import { ApiError } from '../lib/errors'
import { EVENT_COLUMNS, hydrateEvents, loadEvent, type EventEntity } from '../lib/entities'
import {
  beginWrite, commitWrite, replayOnConflict, parseJsonObject, versionConflict, type WriteCtx, type WriteSpec,
} from '../lib/write'
import {
  activeMasjidGuard, eventDeleteSpec, findHolder, lostActiveMasjid, masjidNotActive, tombstoneUnlinkSpec,
} from '../lib/specs'
import { isoNow } from '../lib/time'
import { DEFAULT_TIMEZONE, EVENT_CATEGORIES, EVENT_WRITABLE_STATUSES } from '../lib/constants'
import { decodeCursor, encodeCursor, intParam, invalid, normaliseInstant, validateExternalId } from '../lib/page'

export const eventsRouter = new Hono<AppEnv>()

eventsRouter.use('*', async (c, next) => (c.req.method === 'GET' || c.req.method === 'HEAD' ? requireScope('read')(c, next) : next()))

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 100
const DEFAULT_WINDOW_MS = 90 * 24 * 60 * 60 * 1000

function parseId(raw: string): number {
  if (!/^\d{1,15}$/.test(raw)) invalid('Invalid id', 'id')
  return Number(raw)
}

// ─── Validation ──────────────────────────────────────────────────────────────

const WRITABLE = [
  'title', 'description', 'category', 'speaker', 'start_at', 'end_at', 'timezone', 'rrule', 'status',
  'poster_url', 'registration_url',
] as const

type EventFields = Partial<Pick<EventEntity,
  'title' | 'description' | 'category' | 'speaker' | 'start_at' | 'end_at' | 'timezone' | 'rrule' | 'status' |
  'poster_url' | 'registration_url'>>

/** The canonical IANA name for a time zone ("asia/kuala_lumpur" gives "Asia/Kuala_Lumpur"), or null when unknown. */
function canonicalTimezone(tz: string): string | null {
  try {
    return new Intl.DateTimeFormat(undefined, { timeZone: tz }).resolvedOptions().timeZone
  } catch {
    return null
  }
}

function nullableText(v: unknown, key: string, max: number): string | null {
  if (v === null) return null
  if (typeof v !== 'string' || v.length > max) invalid(`${key} must be a string of at most ${max} characters, or null`, key)
  return v
}

function httpsUrl(v: unknown, key: string): string | null {
  if (v === null) return null
  if (typeof v !== 'string' || !/^https:\/\/\S+$/.test(v) || v.length > 2000) invalid(`${key} must be an https URL, or null`, key)
  return v
}

/** Validates the programme fields present in `body` (spec 4.7). Unknown fields are ignored (contract R10). */
function validateFields(body: Record<string, unknown>): EventFields {
  const out: Record<string, unknown> = {}
  for (const key of WRITABLE) {
    if (!(key in body)) continue
    const v = body[key]
    switch (key) {
      case 'title':
        if (typeof v !== 'string' || v.trim() === '' || v.length > 200) invalid('title must be a non-empty string of at most 200 characters', key)
        out.title = v.trim()
        break
      case 'description': out.description = nullableText(v, key, 5000); break
      case 'speaker': out.speaker = nullableText(v, key, 200); break
      case 'category':
        if (typeof v !== 'string' || !(EVENT_CATEGORIES as readonly string[]).includes(v)) {
          invalid(`category must be one of ${EVENT_CATEGORIES.join(', ')}`, key)
        }
        out.category = v
        break
      case 'start_at': {
        const t = normaliseInstant(v)
        if (!t) invalid('start_at must be an RFC 3339 timestamp (e.g. 2026-11-14T10:00:00Z or with an offset such as +08:00)', key)
        out.start_at = t
        break
      }
      case 'end_at': {
        if (v === null) { out.end_at = null; break }
        const t = normaliseInstant(v)
        if (!t) invalid('end_at must be an RFC 3339 timestamp (e.g. 2026-11-14T10:00:00Z or with an offset such as +08:00), or null', key)
        out.end_at = t
        break
      }
      case 'timezone':
        {
          const tz = typeof v === 'string' ? canonicalTimezone(v) : null
          if (tz === null) invalid('timezone must be an IANA time zone name, e.g. Asia/Kuala_Lumpur', key)
          out.timezone = tz
        }
        break
      case 'rrule':
        // eslint-disable-next-line no-control-regex
        if (v !== null && (typeof v !== 'string' || !v.startsWith('FREQ=') || v.length > 500 || /[\u0000-\u001f]/.test(v))) {
          invalid('rrule must be an RFC 5545 RRULE without the "RRULE:" prefix (starting with FREQ=), or null', key)
        }
        out.rrule = v
        break
      case 'status':
        if (v === 'deleted') invalid('Use DELETE /events/{id} to delete a programme', key)
        if (typeof v !== 'string' || !(EVENT_WRITABLE_STATUSES as readonly string[]).includes(v)) {
          invalid(`status must be one of ${EVENT_WRITABLE_STATUSES.join(', ')}`, key)
        }
        out.status = v
        break
      case 'poster_url':
      case 'registration_url':
        out[key] = httpsUrl(v, key)
        break
    }
  }
  return out as EventFields
}

function checkRange(startAt: string, endAt: string | null): void {
  if (endAt !== null && endAt < startAt) invalid('end_at must not be before start_at', 'end_at')
}

function alreadyLinked(eventId: number, appId: string, externalId: string): ApiError {
  return new ApiError(409, 'already_linked', 'That external id is already linked to a programme', {
    event_id: eventId, app_id: appId, external_id: externalId,
  })
}

function isExternalIdCollision(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 4; depth++) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes('UNIQUE') && msg.includes('event_external_ids')) return true
    e = (e as { cause?: unknown }).cause
  }
  return false
}

// ─── Reads ───────────────────────────────────────────────────────────────────

/**
 * Programme list rule (spec 4.7): status active or cancelled, repeating (rrule set) or not yet over, and starting
 * before `to`. Ordered by start_at, id. No server-side rrule expansion. Programmes of non-active masjids are hidden.
 */
async function listEvents(
  c: { req: { query(name: string): string | undefined }; env: CloudflareBindings },
  masjidIds: number[],
): Promise<{ data: EventEntity[]; next_cursor: string | null }> {
  const fromRaw = c.req.query('from')
  const toRaw = c.req.query('to')
  const from = fromRaw === undefined || fromRaw === '' ? isoNow() : normaliseInstant(fromRaw)
  if (!from) invalid('from must be an RFC 3339 timestamp (e.g. 2026-11-14T10:00:00Z or with an offset such as +08:00)', 'from')
  const to = toRaw === undefined || toRaw === '' ? isoNow(new Date(Date.now() + DEFAULT_WINDOW_MS)) : normaliseInstant(toRaw)
  if (!to) invalid('to must be an RFC 3339 timestamp (e.g. 2026-11-14T10:00:00Z or with an offset such as +08:00)', 'to')
  const limit = intParam(c.req.query('limit'), 'limit', DEFAULT_LIMIT, 1, MAX_LIMIT)

  const conds = [
    'masjid_id IN (SELECT value FROM json_each(?))',
    "EXISTS (SELECT 1 FROM masjids m WHERE m.id = masjid_events.masjid_id AND m.status = 'active')",
    "status IN ('active', 'cancelled')",
    '(rrule IS NOT NULL OR COALESCE(end_at, start_at) >= ?)',
    'start_at < ?',
  ]
  const binds: Array<string | number> = [JSON.stringify(masjidIds), from, to]

  const cursor = decodeCursor(c.req.query('cursor'))
  if (cursor !== null) {
    const m = /^(.+)\|(\d{1,15})$/.exec(cursor)
    if (!m) invalid('cursor is not valid', 'cursor')
    conds.push('(start_at > ? OR (start_at = ? AND id > ?))')
    binds.push(m[1], m[1], Number(m[2]))
  }

  const rows = await c.env.DB
    .prepare(`SELECT ${EVENT_COLUMNS} FROM masjid_events WHERE ${conds.join(' AND ')} ORDER BY start_at, id LIMIT ?`)
    .bind(...binds, limit + 1)
    .all<Omit<EventEntity, 'external_ids'>>()

  const page = rows.results.slice(0, limit)
  const last = page[page.length - 1]
  return {
    data: await hydrateEvents(c.env.DB, page),
    next_cursor: rows.results.length > limit ? encodeCursor(`${last.start_at}|${last.id}`) : null,
  }
}

eventsRouter.get('/', async (c) => {
  const raw = c.req.query('masjid_ids')
  if (raw === undefined || raw.trim() === '') invalid('masjid_ids is required (comma-separated ids, up to 100)', 'masjid_ids')
  const parts = raw.split(',').map(p => p.trim())
  if (parts.length > 100) invalid('masjid_ids accepts at most 100 ids', 'masjid_ids')
  if (parts.some(p => !/^\d{1,15}$/.test(p))) invalid('masjid_ids must be comma-separated integers', 'masjid_ids')
  return c.json(await listEvents(c, [...new Set(parts.map(Number))]))
})

eventsRouter.get('/by-external/:app_id/:external_id', async (c) => {
  const row = await c.env.DB
    .prepare('SELECT event_id FROM event_external_ids WHERE app_id = ? AND external_id = ?')
    .bind(c.req.param('app_id'), c.req.param('external_id'))
    .first<{ event_id: number }>()
  const event = row ? await loadEvent(c.env.DB, row.event_id) : null
  if (!event) throw new ApiError(404, 'not_found', 'No programme is linked to that external id')
  return c.json(event)
})

eventsRouter.get('/:id', async (c) => {
  const event = await loadEvent(c.env.DB, parseId(c.req.param('id')))
  if (!event) throw new ApiError(404, 'not_found', 'Programme not found')
  return c.json(event)
})

// ─── Writes ──────────────────────────────────────────────────────────────────

eventsRouter.patch('/:id', async (c) => {
  const id = parseId(c.req.param('id'))
  const begin = await beginWrite(c, { requireIfMatch: true })
  if ('replay' in begin) return begin.replay
  const ctx: WriteCtx = begin.ctx

  return replayOnConflict(ctx, async () => {
    const body = parseJsonObject(ctx)
    const before = await loadEvent(ctx.db, id)
    if (!before || before.status === 'deleted') throw new ApiError(404, 'not_found', 'Programme not found')
    await requireActiveMasjid(ctx.db, before.masjid_id)

    const f = validateFields(body)
    if (Object.keys(f).length === 0) invalid('No patchable fields provided', 'body')
    if (before.version !== ctx.ifMatch) throw versionConflict(before)

    const now = isoNow()
    const after: EventEntity = { ...before, ...f, version: before.version + 1, updated_by_app: ctx.originApp, updated_at: now }
    checkRange(after.start_at, after.end_at)

    const changedFields = (Object.keys(f) as Array<keyof EventFields>).filter(k => before[k] !== after[k]).sort()
    const sets = (Object.keys(f) as Array<keyof EventFields>).map(k => `${k} = ?`)
    const binds = (Object.keys(f) as Array<keyof EventFields>).map(k => after[k])
    sets.push('version = version + 1', 'updated_by_app = ?', 'updated_at = ?')
    binds.push(ctx.originApp, now)

    return commitWrite(c, ctx, {
      entity: 'event',
      op: 'update',
      entityId: id,
      baseVersion: before.version,
      masjidId: before.masjid_id,
      changedFields,
      before,
      after,
      entityStatement: ctx.db
        .prepare(`UPDATE masjid_events SET ${sets.join(', ')} WHERE id = ? AND version = ?`)
        .bind(...binds, id, before.version),
      loadCurrent: () => loadEvent(ctx.db, id),
      preGuards: [activeMasjidGuard(before.masjid_id)],
      onPreconditionLost: lostActiveMasjid(ctx.db, before.masjid_id),
      status: 200,
    })
  })
})

eventsRouter.delete('/:id', async (c) => {
  const id = parseId(c.req.param('id'))
  const begin = await beginWrite(c, { requireIfMatch: true })
  if ('replay' in begin) return begin.replay
  const ctx: WriteCtx = begin.ctx

  return replayOnConflict(ctx, async () => {
    const before = await loadEvent(ctx.db, id)
    if (!before || before.status === 'deleted') throw new ApiError(404, 'not_found', 'Programme not found')
    if (before.version !== ctx.ifMatch) throw versionConflict(before)

    await requireActiveMasjid(ctx.db, before.masjid_id)

    return commitWrite(c, ctx, {
      ...eventDeleteSpec(ctx, before, isoNow()),
      preGuards: [activeMasjidGuard(before.masjid_id)],
      onPreconditionLost: lostActiveMasjid(ctx.db, before.masjid_id),
    })
  })
})

// Link: PUT /events/:id/external-ids/:app_id  { "external_id": "..." }. Same rules as the masjid link.
eventsRouter.put('/:id/external-ids/:app_id', async (c) => {
  const id = parseId(c.req.param('id'))
  const appId = c.req.param('app_id')
  if (appId !== c.get('key').app_id) {
    throw new ApiError(403, 'forbidden', 'You can only link your own app_id', { app_id: appId })
  }
  const begin = await beginWrite(c, { requireIfMatch: false, idempotencyOptional: true })
  if ('replay' in begin) return begin.replay
  const ctx: WriteCtx = begin.ctx

  return replayOnConflict(ctx, async () => {
    const body = parseJsonObject(ctx)
    const externalId = validateExternalId(body.external_id)

    for (let attempt = 0; ; attempt++) {
      const before = await loadEvent(ctx.db, id)
      if (!before || before.status === 'deleted') throw new ApiError(404, 'not_found', 'Programme not found')
      await requireActiveMasjid(ctx.db, before.masjid_id)

      const mine = before.external_ids.filter(e => e.app_id === appId)
      if (mine.some(e => e.external_id === externalId)) return c.json(before, 200) // already linked: no-op
      if (mine.length > 0) throw alreadyLinked(id, appId, mine[0].external_id)

      const owner = await findHolder(ctx.db, 'event', appId, externalId)
      if (owner && owner.status !== 'deleted') throw alreadyLinked(owner.id, appId, externalId)

      const now = isoNow()
      const after: EventEntity = {
        ...before,
        external_ids: [...before.external_ids, { app_id: appId, external_id: externalId }]
          .sort((a, b) => (a.app_id + '\0' + a.external_id < b.app_id + '\0' + b.external_id ? -1 : 1)),
        version: before.version + 1,
        updated_by_app: ctx.originApp,
        updated_at: now,
      }
      try {
        const unlink = owner ? [await tombstoneUnlinkSpec(ctx, 'event', owner.id, appId, externalId, now)] : []
        return await commitWrite(c, ctx, [...unlink, {
          entity: 'event',
          op: 'update',
          respond: true,
          entityId: id,
          baseVersion: before.version,
          masjidId: before.masjid_id,
          changedFields: ['external_ids'],
          before,
          after,
          entityStatement: ctx.db
            .prepare('UPDATE masjid_events SET version = version + 1, updated_by_app = ?, updated_at = ? WHERE id = ? AND version = ?')
            .bind(ctx.originApp, now, id, before.version),
          loadCurrent: () => loadEvent(ctx.db, id),
          preGuards: [activeMasjidGuard(before.masjid_id)],
          onPreconditionLost: lostActiveMasjid(ctx.db, before.masjid_id),
          children: (b) => [
            b.stmt(
              'INSERT INTO event_external_ids (app_id, external_id, event_id, created_at) VALUES (?, ?, {{ID}}, ?)',
              [appId, externalId, now],
            ),
          ],
          status: 200,
        }])
      } catch (err) {
        if (err instanceof ApiError && err.code === 'version_conflict' && attempt < 3) continue
        if (isExternalIdCollision(err)) {
          const cur = await loadEvent(ctx.db, id)
          if (cur?.external_ids.some(e => e.app_id === appId && e.external_id === externalId)) return c.json(cur, 200)
          const owner2 = await findHolder(ctx.db, 'event', appId, externalId)
          throw alreadyLinked(owner2?.id ?? 0, appId, externalId)
        }
        throw err
      }
    }
  })
})

async function requireActiveMasjid(db: D1Database, masjidId: number): Promise<void> {
  const m = await db
    .prepare('SELECT status, merged_into FROM masjids WHERE id = ?')
    .bind(masjidId)
    .first<{ status: string; merged_into: number | null }>()
  if (!m || m.status !== 'active') throw masjidNotActive(m, 'Masjid')
}

/** `GET|POST /masjids/:id/events`, mounted on the masjids router. */
export function registerMasjidEventRoutes(router: Hono<AppEnv>): void {
  router.get('/:id/events', async (c) => {
    const id = parseId(c.req.param('id'))
    const masjid = await c.env.DB
      .prepare('SELECT status, merged_into FROM masjids WHERE id = ?')
      .bind(id)
      .first<{ status: string; merged_into: number | null }>()
    if (masjid?.status === 'merged' && masjid.merged_into !== null) return c.redirect(`/masjids/${masjid.merged_into}/events`, 301)
    if (!masjid || masjid.status !== 'active') throw new ApiError(404, 'not_found', 'Masjid not found')
    return c.json(await listEvents(c, [id]))
  })

  router.post('/:id/events', async (c) => {
    const masjidId = parseId(c.req.param('id'))
    const begin = await beginWrite(c, { requireIfMatch: false })
    if ('replay' in begin) return begin.replay
    const ctx: WriteCtx = begin.ctx

    return replayOnConflict(ctx, async () => {
      const body = parseJsonObject(ctx)
      const masjid = await ctx.db
        .prepare('SELECT status, merged_into FROM masjids WHERE id = ?')
        .bind(masjidId)
        .first<{ status: string; merged_into: number | null }>()
      if (!masjid || masjid.status !== 'active') throw masjidNotActive(masjid)

      for (const field of ['title', 'start_at'] as const) {
        if (body[field] === undefined || body[field] === null || body[field] === '') invalid(`Missing required field: ${field}`, field)
      }
      const f = validateFields(body) as Required<Pick<EventFields, 'title' | 'start_at'>> & EventFields
      checkRange(f.start_at, f.end_at ?? null)

      let externalId: string | null = null
      if ('external_id' in body && body.external_id !== null) {
        const v = body.external_id
        // eslint-disable-next-line no-control-regex
        if (typeof v !== 'string' || v.trim() === '' || v.length > 255 || /[\u0000-\u001f\u007f-\u009f]/.test(v)) {
          invalid('external_id must be a non-empty string of at most 255 characters', 'external_id')
        }
        externalId = v.trim()
        // Held by a non-deleted programme: 409. Held by a deleted one: the link moves (see the commit below).
        const holder = await findHolder(ctx.db, 'event', ctx.originApp, externalId)
        if (holder && holder.status !== 'deleted') throw alreadyLinked(holder.id, ctx.originApp, externalId)
      }

      const now = isoNow()
      const after: EventEntity = {
        id: 0, // placeholder: the real id is filled in by the batch
        version: 1,
        masjid_id: masjidId,
        title: f.title,
        description: f.description ?? null,
        category: f.category ?? 'lain',
        speaker: f.speaker ?? null,
        start_at: f.start_at,
        end_at: f.end_at ?? null,
        timezone: f.timezone ?? DEFAULT_TIMEZONE,
        rrule: f.rrule ?? null,
        status: f.status ?? 'active',
        poster_url: f.poster_url ?? null,
        registration_url: f.registration_url ?? null,
        external_ids: externalId === null ? [] : [{ app_id: ctx.originApp, external_id: externalId }],
        source_app: ctx.originApp,
        updated_by_app: ctx.originApp,
        created_at: now,
        updated_at: now,
      }

      const changedFields = Object.keys(body).filter(k => (WRITABLE as readonly string[]).includes(k))
      if (externalId !== null) changedFields.push('external_ids')

      const spec: WriteSpec = {
        entity: 'event',
        op: 'create',
        entityId: null,
        baseVersion: null,
        masjidId,
        changedFields: changedFields.sort(),
        before: null,
        after,
        entityStatement: ctx.db
          .prepare(
            `INSERT INTO masjid_events (version, masjid_id, title, description, category, speaker, start_at, end_at,
               timezone, rrule, status, poster_url, registration_url, source_app, updated_by_app, created_at, updated_at)
             VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            masjidId, after.title, after.description, after.category, after.speaker, after.start_at, after.end_at,
            after.timezone, after.rrule, after.status, after.poster_url, after.registration_url,
            ctx.originApp, ctx.originApp, now, now,
          ),
        children: externalId === null ? undefined : (b) => [
          b.stmt(
            'INSERT INTO event_external_ids (app_id, external_id, event_id, created_at) VALUES (?, ?, {{ID}}, ?)',
            [ctx.originApp, externalId, now],
          ),
        ],
        preGuards: [activeMasjidGuard(masjidId)],
        onPreconditionLost: lostActiveMasjid(ctx.db, masjidId),
        respond: true,
        status: 201,
      }
      for (let attempt = 0; ; attempt++) {
        const specs: WriteSpec[] = []
        if (externalId !== null) {
          const holder = await findHolder(ctx.db, 'event', ctx.originApp, externalId)
          if (holder && holder.status !== 'deleted') throw alreadyLinked(holder.id, ctx.originApp, externalId)
          if (holder) specs.push(await tombstoneUnlinkSpec(ctx, 'event', holder.id, ctx.originApp, externalId, now))
        }
        specs.push(spec)
        try {
          return await commitWrite(c, ctx, specs)
        } catch (err) {
          if (err instanceof ApiError && err.code === 'version_conflict' && attempt < 3) continue
          if (externalId !== null && isExternalIdCollision(err)) {
            const linked = await findHolder(ctx.db, 'event', ctx.originApp, externalId)
            throw alreadyLinked(linked?.id ?? 0, ctx.originApp, externalId)
          }
          throw err
        }
      }
    })
  })
}
