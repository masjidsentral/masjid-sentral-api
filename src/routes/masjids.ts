import { Hono } from 'hono'
import ngeohash from 'ngeohash'
import { searchWindow, windowWhere, haversineM } from '../lib/geo'
import { requireScope, type AppEnv } from '../middleware/auth'
import { ApiError } from '../lib/errors'
import {
  EVENT_COLUMNS, hydrateEvents, hydrateMasjids, loadMasjid, loadMasjidsByIds, MASJID_COLUMNS, normaliseImages,
  type EventEntity, type MasjidEntity, type MasjidScalars,
} from '../lib/entities'
import { eventDeleteSpec, findHolder, masjidNotActive, tombstoneUnlinkSpec } from '../lib/specs'
import {
  beginWrite, commitWrite, replayOnConflict, parseJsonObject, versionConflict, type WriteCtx, type WriteSpec,
} from '../lib/write'
import { isoNow } from '../lib/time'
import { CONTACT_TYPES } from '../lib/constants'
import { decodeCursor, encodeCursor, intParam, invalid, normaliseInstant, validateExternalId } from '../lib/page'
import { findCandidates } from '../lib/match'
import { registerMasjidEventRoutes } from './events'

export const masjidsRouter = new Hono<AppEnv>()

// Every read needs the `read` scope (contract section 5); writes are checked by writeGuard.
masjidsRouter.use('*', async (c, next) => (c.req.method === 'GET' || c.req.method === 'HEAD' ? requireScope('read')(c, next) : next()))

const LIST_DEFAULT_LIMIT = 20
const LIST_MAX_LIMIT = 100

masjidsRouter.get('/', async (c) => {
  const conditions: string[] = ["status = 'active'"]
  const params: (string | number)[] = []

  const state = c.req.query('state')
  if (state) { conditions.push('state_id = ?'); params.push(state.toLowerCase()) }

  const city = c.req.query('city')
  if (city) { conditions.push('city_id = ?'); params.push(city.toLowerCase()) }

  const type = c.req.query('type')
  if (type) { conditions.push('type_id = ?'); params.push(type.toLowerCase()) }

  const jumaat = c.req.query('jumaat')
  if (jumaat === '1' || jumaat === 'true') conditions.push('jumaat_available = 1')
  else if (jumaat === '0' || jumaat === 'false') conditions.push('jumaat_available = 0')

  const name = c.req.query('name') ?? c.req.query('q')
  if (name) {
    const safe = name.slice(0, 48).replace(/[\\%_]/g, '\\$&') // D1 LIKE pattern limit is 50 bytes; '%..%' uses 2
    conditions.push("name LIKE ? ESCAPE '\\'")
    params.push(`%${safe}%`)
  }

  const sinceRaw = c.req.query('updated_since')
  if (sinceRaw !== undefined && sinceRaw !== '') {
    const since = normaliseInstant(sinceRaw)
    if (!since) invalid('updated_since must be an RFC 3339 timestamp (e.g. 2026-11-14T10:00:00Z or with an offset such as +08:00)', 'updated_since')
    conditions.push('updated_at >= ?')
    params.push(since)
  }

  const limit = intParam(c.req.query('limit'), 'limit', LIST_DEFAULT_LIMIT, 1, LIST_MAX_LIMIT)
  const after = decodeCursor(c.req.query('cursor'))
  if (after !== null) {
    if (!/^\d{1,15}$/.test(after)) invalid('cursor is not valid', 'cursor')
    conditions.push('id > ?')
    params.push(Number(after))
  }

  const rows = await c.env.DB
    .prepare(`SELECT ${MASJID_COLUMNS} FROM masjids WHERE ${conditions.join(' AND ')} ORDER BY id ASC LIMIT ?`)
    .bind(...params, limit + 1)
    .all<MasjidScalars>()

  const page = rows.results.slice(0, limit)
  const data = await hydrateMasjids(c.env.DB, page)
  const next_cursor = rows.results.length > limit ? encodeCursor(String(page[page.length - 1].id)) : null
  return c.json({ data, next_cursor })
})

function requireLatLng(c: { req: { query(name: string): string | undefined } }): { lat: number; lng: number } {
  const latRaw = c.req.query('lat')
  const lngRaw = c.req.query('lng')
  const lat = latRaw === undefined || latRaw.trim() === '' ? NaN : Number(latRaw)
  const lng = lngRaw === undefined || lngRaw.trim() === '' ? NaN : Number(lngRaw)
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) invalid('Missing or invalid lat and lng', 'lat')
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) invalid('Invalid lat/lng range', 'lat')
  return { lat, lng }
}

const NEARBY_DEFAULT_RADIUS_M = 5000
const NEARBY_MAX_RADIUS_M = 20000

// Nearby: radius in METRES (contract 5.1), nearest first, keyset `cursor` on (distance, id), rows carry `distance_m`.
masjidsRouter.get('/nearby', async (c) => {
  const { lat, lng } = requireLatLng(c)
  const radiusRaw = c.req.query('radius')
  let radius = NEARBY_DEFAULT_RADIUS_M
  if (radiusRaw !== undefined && radiusRaw !== '') {
    radius = Number(radiusRaw)
    if (!Number.isFinite(radius) || radius <= 0) invalid('radius (metres) must be greater than 0', 'radius')
    if (radius > NEARBY_MAX_RADIUS_M) invalid('radius exceeds the maximum of 20000 metres', 'radius')
  }
  const limit = intParam(c.req.query('limit'), 'limit', LIST_DEFAULT_LIMIT, 1, LIST_MAX_LIMIT)
  const cursorRaw = decodeCursor(c.req.query('cursor'))
  let after: { d: number; id: number } | null = null
  if (cursorRaw !== null) {
    const m = /^(\d+(?:\.\d+)?(?:e[+-]?\d+)?)\|(\d{1,15})$/.exec(cursorRaw)
    if (!m) invalid('cursor is not valid', 'cursor')
    after = { d: Number(m[1]), id: Number(m[2]) }
  }

  const where = windowWhere(searchWindow(lat, lng, radius))
  const near = await c.env.DB
    .prepare(`SELECT id, lat, lng FROM masjids INDEXED BY ${where.index} WHERE status = 'active' AND ${where.sql}`)
    .bind(...where.binds)
    .all<{ id: number; lat: number; lng: number }>()

  const within = near.results
    .map(r => ({ id: r.id, d: haversineM(lat, lng, r.lat, r.lng) }))
    .filter(r => r.d <= radius)
    .sort((a, b) => a.d - b.d || a.id - b.id)
    .filter(r => after === null || r.d > after.d || (r.d === after.d && r.id > after.id))

  const slice = within.slice(0, limit)
  const entities = await loadMasjidsByIds(c.env.DB, slice.map(r => r.id))
  const dist = new Map(slice.map(r => [r.id, Math.round(r.d)]))
  const data = entities.map(m => ({ ...m, distance_m: dist.get(m.id) ?? 0 }))
  const last = slice[slice.length - 1]
  const next_cursor = within.length > limit ? encodeCursor(`${last.d}|${last.id}`) : null
  return c.json({ data, next_cursor })
})

masjidsRouter.get('/match', async (c) => {
  const { lat, lng } = requireLatLng(c)
  const name = c.req.query('name')?.trim() ?? ''
  if (name === '' || name.length > 200) invalid('name is required (1-200 characters)', 'name')
  const typeId = c.req.query('type_id')?.trim()
  if (typeId !== undefined && (typeId === '' || typeId.length > 64)) invalid('type_id must be a masjid type id', 'type_id')
  const candidates = (await findCandidates(c.env.DB, lat, lng, name, { typeId })).slice(0, 5)
  return c.json({ candidates })
})

masjidsRouter.get('/by-external/:app_id/:external_id', async (c) => {
  const row = await c.env.DB
    .prepare('SELECT masjid_id FROM masjid_external_ids WHERE app_id = ? AND external_id = ?')
    .bind(c.req.param('app_id'), c.req.param('external_id'))
    .first<{ masjid_id: number }>()
  // Whatever the holder's status: a deleted masjid keeps its ids (tombstone); a merged row that still holds ids
  // is followed to its survivor.
  let masjid = row ? await loadMasjid(c.env.DB, row.masjid_id) : null
  for (let hops = 0; masjid?.status === 'merged' && masjid.merged_into !== null && hops < 5; hops++) {
    masjid = await loadMasjid(c.env.DB, masjid.merged_into)
  }
  if (!masjid) throw new ApiError(404, 'not_found', 'No masjid is linked to that external id')
  return c.json(masjid)
})

masjidsRouter.get('/:id', async (c) => {
  const id = parseId(c.req.param('id'))

  const masjid = await loadMasjid(c.env.DB, id)
  if (!masjid) throw new ApiError(404, 'not_found', 'Masjid not found')

  if (masjid.status === 'merged' && masjid.merged_into !== null) {
    return c.redirect(`/masjids/${masjid.merged_into}`, 301)
  }
  return c.json(masjid)
})

function parseId(raw: string): number {
  if (!/^\d{1,15}$/.test(raw)) throw new ApiError(422, 'validation_failed', 'Invalid id', { field: 'id' })
  return Number(raw)
}

function fail(message: string, field: string): never {
  throw new ApiError(422, 'validation_failed', message, { field })
}

const NULLABLE_TEXT = ['address', 'description', 'telephone', 'email', 'google_url'] as const
const REF_FIELDS = ['type_id', 'state_id', 'country_id'] as const
const WRITABLE = [
  'name', ...REF_FIELDS, 'city_id', 'lat', 'lng', ...NULLABLE_TEXT, 'jumaat_available',
] as const

type Scalars = Partial<Pick<MasjidEntity,
  'name' | 'type_id' | 'state_id' | 'country_id' | 'city_id' | 'lat' | 'lng' | 'address' | 'description' |
  'telephone' | 'email' | 'google_url' | 'jumaat_available'>>

/** Validates and normalises the scalar fields present in `body`. Unknown fields are ignored (contract R10). */
function validateScalars(body: Record<string, unknown>): Scalars {
  const out: Record<string, unknown> = {}
  for (const key of WRITABLE) {
    if (!(key in body)) continue
    const v = body[key]
    if (key === 'name') {
      if (typeof v !== 'string' || v.trim() === '' || v.length > 200) fail('name must be a non-empty string of at most 200 characters', key)
      out.name = v.trim()
    } else if ((REF_FIELDS as readonly string[]).includes(key)) {
      if (typeof v !== 'string' || v === '') fail(`${key} must be a non-empty string`, key)
      out[key] = v
    } else if (key === 'city_id') {
      if (v !== null && (typeof v !== 'string' || v === '')) fail('city_id must be a string or null', key)
      out[key] = v
    } else if (key === 'lat' || key === 'lng') {
      const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
      const max = key === 'lat' ? 90 : 180
      if (!Number.isFinite(n) || n < -max || n > max) fail(`${key} must be a number between ${-max} and ${max}`, key)
      out[key] = n
    } else if (key === 'jumaat_available') {
      if (v === true || v === 1) out[key] = true
      else if (v === false || v === 0) out[key] = false
      else fail('jumaat_available must be a boolean', key)
    } else {
      if (v !== null && typeof v !== 'string') fail(`${key} must be a string or null`, key)
      if (typeof v === 'string' && v.length > 2000) fail(`${key} is too long`, key)
      out[key] = v
    }
  }
  return out as Scalars
}

function validateImages(raw: unknown): MasjidEntity['images'] {
  if (!Array.isArray(raw) || raw.length > 30) fail('images must be an array of at most 30 items', 'images')
  const items = (raw as unknown[]).map((img, i) => {
    const o = img as { url?: unknown; is_thumbnail?: unknown; sort_order?: unknown }
    if (typeof img !== 'object' || img === null) fail(`images[${i}] must be an object`, 'images')
    if (typeof o.url !== 'string' || !/^https:\/\/\S+$/.test(o.url) || o.url.length > 2000) {
      fail(`images[${i}].url must be an https URL`, 'images')
    }
    if (o.is_thumbnail !== undefined && typeof o.is_thumbnail !== 'boolean') fail(`images[${i}].is_thumbnail must be a boolean`, 'images')
    if (o.sort_order !== undefined && !Number.isInteger(o.sort_order)) fail(`images[${i}].sort_order must be an integer`, 'images')
    return { url: o.url, is_thumbnail: o.is_thumbnail as boolean | undefined, sort_order: o.sort_order as number | undefined }
  })
  return normaliseImages(items)
}

/** type_id / state_id / country_id / city_id must exist (422). */
async function checkReferences(db: D1Database, s: Scalars): Promise<void> {
  const checks: Array<[string, string, string]> = []
  if (s.type_id !== undefined) checks.push(['type_id', 'masjid_types', s.type_id])
  if (s.state_id !== undefined) checks.push(['state_id', 'states', s.state_id])
  if (s.country_id !== undefined) checks.push(['country_id', 'countries', s.country_id])
  if (typeof s.city_id === 'string') checks.push(['city_id', 'cities', s.city_id])
  if (checks.length === 0) return
  const results = await db.batch(checks.map(([, table, id]) => db.prepare(`SELECT 1 AS ok FROM ${table} WHERE id = ?`).bind(id)))
  results.forEach((r, i) => {
    if (r.results.length === 0) fail(`Unknown ${checks[i][0]}: ${checks[i][2]}`, checks[i][0])
  })
}

function imageStatements(images: MasjidEntity['images'], now: string) {
  return (b: Parameters<NonNullable<WriteSpec['children']>>[0]) =>
    images.map(img =>
      b.stmt(
        'INSERT INTO masjid_images (masjid_id, url, is_thumbnail, sort_order, created_at) VALUES ({{ID}}, ?, ?, ?, ?)',
        [img.url, img.is_thumbnail ? 1 : 0, img.sort_order, now],
      ),
    )
}

type ContactOp = { type: string; value: string | null }
type FacilityOp = { code: string; available: boolean | null }

/** contacts: an array of { type, value }; value null deletes that type (PATCH). */
function validateContacts(raw: unknown): ContactOp[] {
  if (!Array.isArray(raw) || raw.length > CONTACT_TYPES.length) invalid('contacts must be an array of { type, value }', 'contacts')
  const seen = new Set<string>()
  return (raw as unknown[]).map((item, i) => {
    const o = item as { type?: unknown; value?: unknown }
    if (typeof item !== 'object' || item === null) invalid(`contacts[${i}] must be an object`, 'contacts')
    if (typeof o.type !== 'string' || !(CONTACT_TYPES as readonly string[]).includes(o.type)) {
      invalid(`contacts[${i}].type must be one of ${CONTACT_TYPES.join(', ')}`, 'contacts')
    }
    if (seen.has(o.type)) invalid(`contacts lists "${o.type}" twice`, 'contacts')
    seen.add(o.type)
    if (o.value !== null && (typeof o.value !== 'string' || o.value.trim() === '' || o.value.length > 500)) {
      invalid(`contacts[${i}].value must be a non-empty string of at most 500 characters, or null to delete`, 'contacts')
    }
    return { type: o.type, value: o.value === null ? null : (o.value as string).trim() }
  })
}

/** facilities: an array of { code, available }; available null deletes that code (PATCH). Unknown code is a 422. */
async function validateFacilities(db: D1Database, raw: unknown): Promise<FacilityOp[]> {
  if (!Array.isArray(raw) || raw.length > 200) invalid('facilities must be an array of { code, available }', 'facilities')
  const seen = new Set<string>()
  const ops = (raw as unknown[]).map((item, i) => {
    const o = item as { code?: unknown; available?: unknown }
    if (typeof item !== 'object' || item === null) invalid(`facilities[${i}] must be an object`, 'facilities')
    if (typeof o.code !== 'string' || o.code === '') invalid(`facilities[${i}].code must be a string`, 'facilities')
    if (seen.has(o.code)) invalid(`facilities lists "${o.code}" twice`, 'facilities')
    seen.add(o.code)
    if (o.available !== null && typeof o.available !== 'boolean') {
      invalid(`facilities[${i}].available must be true, false or null (clear)`, 'facilities')
    }
    return { code: o.code, available: o.available as boolean | null }
  })
  if (ops.length > 0) {
    const known = await db
      .prepare('SELECT code, active FROM facility_catalogue WHERE code IN (SELECT value FROM json_each(?))')
      .bind(JSON.stringify(ops.map(o => o.code)))
      .all<{ code: string; active: number }>()
    const byCode = new Map(known.results.map(r => [r.code, r.active === 1]))
    for (const op of ops) {
      // A retired (inactive) code can still be cleared but not set.
      if (!byCode.has(op.code) || (op.available !== null && byCode.get(op.code) === false)) {
        throw new ApiError(422, 'validation_failed', `Unknown facility code: ${op.code}`, { field: 'facilities', code: op.code })
      }
    }
  }
  return ops
}

function applyContacts(current: MasjidEntity['contacts'], ops: ContactOp[]): MasjidEntity['contacts'] {
  const map = new Map(current.map(c => [c.type, c.value]))
  for (const op of ops) {
    if (op.value === null) map.delete(op.type)
    else map.set(op.type, op.value)
  }
  return [...map].map(([type, value]) => ({ type, value })).sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0))
}

function applyFacilities(current: MasjidEntity['facilities'], ops: FacilityOp[]): MasjidEntity['facilities'] {
  const map = new Map(current.map(f => [f.code, f.available]))
  for (const op of ops) {
    if (op.available === null) map.delete(op.code)
    else map.set(op.code, op.available)
  }
  return [...map].map(([code, available]) => ({ code, available })).sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
}

type Builder = Parameters<NonNullable<WriteSpec['children']>>[0]

function contactStatements(b: Builder, ops: ContactOp[]) {
  return ops.map(op =>
    op.value === null
      ? b.stmt('DELETE FROM masjid_contacts WHERE masjid_id = {{ID}} AND type = ?', [op.type])
      : b.stmt(
        `INSERT INTO masjid_contacts (masjid_id, type, value) VALUES ({{ID}}, ?, ?)
         ON CONFLICT (masjid_id, type) DO UPDATE SET value = excluded.value`,
        [op.type, op.value],
      ),
  )
}

function facilityStatements(b: Builder, ops: FacilityOp[]) {
  return ops.map(op =>
    op.available === null
      ? b.stmt('DELETE FROM masjid_facilities WHERE masjid_id = {{ID}} AND code = ?', [op.code])
      : b.stmt(
        `INSERT INTO masjid_facilities (masjid_id, code, available) VALUES ({{ID}}, ?, ?)
         ON CONFLICT (masjid_id, code) DO UPDATE SET available = excluded.available`,
        [op.code, op.available ? 1 : 0],
      ),
  )
}

function alreadyLinked(masjidId: number, appId: string, externalId: string): ApiError {
  return new ApiError(409, 'already_linked', 'That external id is already linked to a masjid', {
    masjid_id: masjidId, app_id: appId, external_id: externalId,
  })
}

/** True when a thrown D1 error is a primary-key collision on masjid_external_ids (a racing link). */
function isExternalIdCollision(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 4; depth++) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes('UNIQUE') && msg.includes('masjid_external_ids')) return true
    e = (e as { cause?: unknown }).cause
  }
  return false
}

const REQUIRED_ON_CREATE = ['name', 'type_id', 'state_id', 'country_id', 'lat', 'lng', 'address'] as const

masjidsRouter.post('/', async (c) => {
  const begin = await beginWrite(c, { requireIfMatch: false })
  if ('replay' in begin) return begin.replay
  const ctx: WriteCtx = begin.ctx

  return replayOnConflict(ctx, async () => {
    const body = parseJsonObject(ctx)
    for (const field of REQUIRED_ON_CREATE) {
      if (body[field] === undefined || body[field] === null || body[field] === '') fail(`Missing required field: ${field}`, field)
    }
    const s = validateScalars(body) as Required<Pick<Scalars, 'name' | 'type_id' | 'state_id' | 'country_id' | 'lat' | 'lng'>> & Scalars
    const images = 'images' in body ? validateImages(body.images) : []
    const contactOps = 'contacts' in body ? validateContacts(body.contacts) : []
    const facilityOps = 'facilities' in body ? await validateFacilities(ctx.db, body.facilities) : []
    const externalId = 'external_id' in body && body.external_id !== null ? validateExternalId(body.external_id) : null
    await checkReferences(ctx.db, s)

    if (externalId !== null) {
      // Held by an active (or merged) masjid: 409. Held by a deleted one: the link moves (see the commit below).
      const holder = await findHolder(ctx.db, 'masjid', ctx.originApp, externalId)
      if (holder && holder.status !== 'deleted') throw alreadyLinked(holder.id, ctx.originApp, externalId)
    }

    // Duplicate gate (spec 4.3): a >= 0.9 match within 50 m needs a person's ?force=true.
    const forceRaw = c.req.query('force')
    const force = forceRaw === 'true' || forceRaw === '1'
    if (!force) {
      const duplicates = (await findCandidates(ctx.db, s.lat, s.lng, s.name, { typeId: s.type_id }))
        .filter(cand => cand.score >= 0.9 && cand.distance_m <= 50 && cand.same_type === true)
        .slice(0, 5)
      if (duplicates.length > 0) {
        throw new ApiError(409, 'possible_duplicate', 'A masjid with a very similar name already exists at this spot', {
          candidates: duplicates,
        })
      }
    }

    const now = isoNow()
    const geohash = ngeohash.encode(s.lat, s.lng, 9)
    const after: MasjidEntity = {
      id: 0, // placeholder: the real id is filled in by the batch
      version: 1,
      name: s.name,
      type_id: s.type_id,
      lat: s.lat,
      lng: s.lng,
      geohash,
      country_id: s.country_id,
      state_id: s.state_id,
      city_id: s.city_id ?? null,
      address: s.address ?? null,
      description: s.description ?? null,
      jumaat_available: s.jumaat_available ?? false,
      telephone: s.telephone ?? null,
      email: s.email ?? null,
      google_url: s.google_url ?? null,
      contacts: applyContacts([], contactOps),
      facilities: applyFacilities([], facilityOps),
      images,
      external_ids: externalId === null ? [] : [{ app_id: ctx.originApp, external_id: externalId }],
      status: 'active',
      merged_into: null,
      updated_by_app: ctx.originApp,
      created_at: now,
      updated_at: now,
    }

    const entityStatement = ctx.db
      .prepare(
        `INSERT INTO masjids (version, name, type_id, lat, lng, geohash, city_id, state_id, country_id,
           address, description, telephone, email, google_url, jumaat_available, status, updated_by_app,
           created_at, updated_at)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
      )
      .bind(
        after.name, after.type_id, after.lat, after.lng, geohash, after.city_id, after.state_id, after.country_id,
        after.address, after.description, after.telephone, after.email, after.google_url,
        after.jumaat_available ? 1 : 0, ctx.originApp, now, now,
      )

    const changedFields = Object.keys(body)
      .filter(k => (WRITABLE as readonly string[]).includes(k) || k === 'images' || k === 'contacts' || k === 'facilities')
    if (externalId !== null) changedFields.push('external_ids')

    const createSpec: WriteSpec = {
      entity: 'masjid',
      op: 'create',
      entityId: null,
      baseVersion: null,
      masjidId: null,
      changedFields: changedFields.sort(),
      before: null,
      after,
      entityStatement,
      changeExtra: force ? { forced: true } : undefined,
      respond: true,
      children: (b) => [
        ...imageStatements(images, now)(b),
        ...contactStatements(b, contactOps.filter(o => o.value !== null)),
        ...facilityStatements(b, facilityOps.filter(o => o.available !== null)),
        ...(externalId === null ? [] : [
          b.stmt(
            'INSERT INTO masjid_external_ids (app_id, external_id, masjid_id, created_at) VALUES (?, ?, {{ID}}, ?)',
            [ctx.originApp, externalId, now],
          ),
        ]),
      ],
      status: 201,
    }

    for (let attempt = 0; ; attempt++) {
      const specs: WriteSpec[] = []
      if (externalId !== null) {
        const holder = await findHolder(ctx.db, 'masjid', ctx.originApp, externalId)
        if (holder && holder.status !== 'deleted') throw alreadyLinked(holder.id, ctx.originApp, externalId)
        if (holder) specs.push(await tombstoneUnlinkSpec(ctx, 'masjid', holder.id, ctx.originApp, externalId, now))
      }
      specs.push(createSpec)
      try {
        return await commitWrite(c, ctx, specs)
      } catch (err) {
        if (err instanceof ApiError && err.code === 'version_conflict' && attempt < 3) continue
        if (externalId !== null && isExternalIdCollision(err)) {
          // A concurrent request linked the same id between our check and the batch (the batch rolled back).
          const linked = await findHolder(ctx.db, 'masjid', ctx.originApp, externalId)
          throw alreadyLinked(linked?.id ?? 0, ctx.originApp, externalId)
        }
        throw err
      }
    }
  })
})

masjidsRouter.patch('/:id', async (c) => {
  const id = parseId(c.req.param('id'))
  const begin = await beginWrite(c, { requireIfMatch: true })
  if ('replay' in begin) return begin.replay
  const ctx: WriteCtx = begin.ctx

  return replayOnConflict(ctx, async () => {
    const body = parseJsonObject(ctx)
    const before = await loadMasjid(ctx.db, id)
    if (!before || before.status !== 'active') throw masjidNotActive(before)

    if (('lat' in body) !== ('lng' in body)) fail('lat and lng must both be provided together', 'lat')
    const s = validateScalars(body)
    const images = 'images' in body ? validateImages(body.images) : undefined
    const contactOps = 'contacts' in body ? validateContacts(body.contacts) : undefined
    const facilityOps = 'facilities' in body ? await validateFacilities(ctx.db, body.facilities) : undefined
    if (Object.keys(s).length === 0 && images === undefined && contactOps === undefined && facilityOps === undefined) {
      fail('No patchable fields provided', 'body')
    }
    await checkReferences(ctx.db, s)

    if (before.version !== ctx.ifMatch) throw versionConflict(before)

    const now = isoNow()
    const after: MasjidEntity = { ...before, ...s, version: before.version + 1, updated_by_app: ctx.originApp, updated_at: now }
    if (images !== undefined) after.images = images
    if (contactOps !== undefined) after.contacts = applyContacts(before.contacts, contactOps)
    if (facilityOps !== undefined) after.facilities = applyFacilities(before.facilities, facilityOps)
    if (s.lat !== undefined && s.lng !== undefined) after.geohash = ngeohash.encode(s.lat, s.lng, 9)

    const changedFields: string[] = []
    for (const key of Object.keys(s) as Array<keyof Scalars>) {
      if (before[key] !== after[key]) changedFields.push(key)
    }
    if (before.geohash !== after.geohash) changedFields.push('geohash')
    if (images !== undefined && JSON.stringify(images) !== JSON.stringify(before.images)) changedFields.push('images')
    if (JSON.stringify(after.contacts) !== JSON.stringify(before.contacts)) changedFields.push('contacts')
    if (JSON.stringify(after.facilities) !== JSON.stringify(before.facilities)) changedFields.push('facilities')
    changedFields.sort()

    const sets: string[] = []
    const binds: unknown[] = []
    for (const key of Object.keys(s) as Array<keyof Scalars>) {
      sets.push(`${key} = ?`)
      binds.push(key === 'jumaat_available' ? (after.jumaat_available ? 1 : 0) : after[key])
    }
    if (s.lat !== undefined) { sets.push('geohash = ?'); binds.push(after.geohash) }
    sets.push('version = version + 1', 'updated_by_app = ?', 'updated_at = ?')
    binds.push(ctx.originApp, now)

    const entityStatement = ctx.db
      .prepare(`UPDATE masjids SET ${sets.join(', ')} WHERE id = ? AND version = ?`)
      .bind(...binds, id, before.version)

    return commitWrite(c, ctx, {
      entity: 'masjid',
      op: 'update',
      entityId: id,
      baseVersion: before.version,
      masjidId: null,
      changedFields,
      before,
      after,
      entityStatement,
      loadCurrent: () => loadMasjid(ctx.db, id),
      children: (b) => [
        ...(images === undefined ? [] : [
          b.stmt('DELETE FROM masjid_images WHERE masjid_id = {{ID}}'),
          ...imageStatements(images, now)(b),
        ]),
        ...(contactOps === undefined ? [] : contactStatements(b, contactOps)),
        ...(facilityOps === undefined ? [] : facilityStatements(b, facilityOps)),
      ],
      status: 200,
    })
  })
})

// Link: PUT /masjids/:id/external-ids/:app_id  { "external_id": "..." }  (spec 4.5). One-to-one per app.
masjidsRouter.put('/:id/external-ids/:app_id', async (c) => {
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

    // No If-Match on a link: reload and retry if another write bumps the version between our read and commit.
    for (let attempt = 0; ; attempt++) {
      const before = await loadMasjid(ctx.db, id)
      if (!before || before.status !== 'active') throw masjidNotActive(before)

      const mine = before.external_ids.filter(e => e.app_id === appId)
      if (mine.some(e => e.external_id === externalId)) return c.json(before, 200) // already linked: no-op
      if (mine.length > 0) throw alreadyLinked(id, appId, mine[0].external_id)

      // Held by an active (or merged) masjid: 409. Held by a deleted one: the link moves off the tombstone.
      const owner = await findHolder(ctx.db, 'masjid', appId, externalId)
      if (owner && owner.status !== 'deleted') throw alreadyLinked(owner.id, appId, externalId)

      const now = isoNow()
      const after: MasjidEntity = {
        ...before,
        external_ids: [...before.external_ids, { app_id: appId, external_id: externalId }]
          .sort((a, b) => (a.app_id + '\0' + a.external_id < b.app_id + '\0' + b.external_id ? -1 : 1)),
        version: before.version + 1,
        updated_by_app: ctx.originApp,
        updated_at: now,
      }
      try {
        const unlink = owner ? [await tombstoneUnlinkSpec(ctx, 'masjid', owner.id, appId, externalId, now)] : []
        return await commitWrite(c, ctx, [...unlink, {
          entity: 'masjid',
          op: 'update',
          respond: true,
          entityId: id,
          baseVersion: before.version,
          masjidId: null,
          changedFields: ['external_ids'],
          before,
          after,
          entityStatement: ctx.db
            .prepare('UPDATE masjids SET version = version + 1, updated_by_app = ?, updated_at = ? WHERE id = ? AND version = ?')
            .bind(ctx.originApp, now, id, before.version),
          loadCurrent: () => loadMasjid(ctx.db, id),
          children: (b) => [
            b.stmt(
              'INSERT INTO masjid_external_ids (app_id, external_id, masjid_id, created_at) VALUES (?, ?, {{ID}}, ?)',
              [appId, externalId, now],
            ),
          ],
          status: 200,
        }])
      } catch (err) {
        if (err instanceof ApiError && err.code === 'version_conflict' && attempt < 3) continue
        if (isExternalIdCollision(err)) {
          const cur = await loadMasjid(ctx.db, id)
          if (cur?.external_ids.some(e => e.app_id === appId && e.external_id === externalId)) return c.json(cur, 200)
          const owner2 = await findHolder(ctx.db, 'masjid', appId, externalId)
          throw alreadyLinked(owner2?.id ?? 0, appId, externalId)
        }
        throw err
      }
    }
  })
})

const MAX_CASCADE_EVENTS = 200

// Soft delete. The tombstone keeps its external ids so apps can still match the delete. The masjid's programmes
// are soft-deleted in the same batch (each with a version bump and its own `event` `delete` change row).
masjidsRouter.delete('/:id', async (c) => {
  const id = parseId(c.req.param('id'))
  const begin = await beginWrite(c, { requireIfMatch: true })
  if ('replay' in begin) return begin.replay
  const ctx: WriteCtx = begin.ctx

  return replayOnConflict(ctx, async () => {
    const before = await loadMasjid(ctx.db, id)
    if (!before || before.status !== 'active') throw masjidNotActive(before)
    if (before.version !== ctx.ifMatch) throw versionConflict(before)

    const eventRows = await ctx.db
      .prepare(`SELECT ${EVENT_COLUMNS} FROM masjid_events WHERE masjid_id = ? AND status != 'deleted' ORDER BY id LIMIT ?`)
      .bind(id, MAX_CASCADE_EVENTS + 1)
      .all<Omit<EventEntity, 'external_ids'>>()
    if (eventRows.results.length > MAX_CASCADE_EVENTS) {
      throw new ApiError(
        422, 'validation_failed',
        `This masjid has more than ${MAX_CASCADE_EVENTS} programmes; delete some of them first, then delete the masjid`,
        { reason: 'too_many_events', max_events: MAX_CASCADE_EVENTS },
      )
    }
    const events = await hydrateEvents(ctx.db, eventRows.results)

    const now = isoNow()
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
    return commitWrite(c, ctx, [masjidSpec, ...events.map(e => eventDeleteSpec(ctx, e, now))])
  })
})

registerMasjidEventRoutes(masjidsRouter)
