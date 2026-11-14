// Masjid routes — GET /masjids (list+filters), GET /masjids/nearby, GET /masjids/:id,
//                  POST /masjids (create), PATCH /masjids/:id (update)

import { Hono } from 'hono'
import ngeohash from 'ngeohash'
import type { MasjidRow } from '../types/db'
import { geohashPrefixes, haversineKm } from '../lib/geo'
import type { AppEnv } from '../middleware/auth'
import { ApiError, errorBody } from '../lib/errors'
import { loadMasjid, normaliseImages, type MasjidEntity } from '../lib/entities'
import { beginWrite, commitWrite, replayOnConflict, parseJsonObject, versionConflict, type WriteCtx, type WriteSpec } from '../lib/write'
import { isoNow } from '../lib/time'

export const masjidsRouter = new Hono<AppEnv>()

// ─── GET /masjids ── paginated filterable list ─────────────────────────────

masjidsRouter.get('/', async (c) => {
  // Build dynamic WHERE conditions — always seed with soft-delete filter (APIREAD-10)
  const conditions: string[] = ["status = 'active'"]
  const params: (string | number)[] = []

  const state = c.req.query('state')
  if (state) { conditions.push('state_id = ?'); params.push(state.toLowerCase()) }

  const city = c.req.query('city')
  if (city) { conditions.push('city_id = ?'); params.push(city.toLowerCase()) }

  const type = c.req.query('type')
  if (type) { conditions.push('type_id = ?'); params.push(type.toLowerCase()) }

  const jumaat = c.req.query('jumaat')
  if (jumaat === '1') { conditions.push('jumaat_available = 1') }

  const q = c.req.query('q')
  if (q) {
    // Escape LIKE wildcards before binding; ESCAPE clause tells SQLite to treat \% and \_ literally
    const safe = q.slice(0, 48).replace(/%/g, '\\%').replace(/_/g, '\\_') // D1 LIKE limit: 50 bytes; '%..%' uses 2 (Pitfall 4)
    conditions.push("name LIKE ? ESCAPE '\\'")
    params.push(`%${safe}%`)
  }

  const where = conditions.join(' AND ')

  // Pagination — default page 1, always 20 per page
  // Use Number() so scientific notation (e.g. '1e5') parses correctly; Math.floor guards floats
  const pageRaw = Number(c.req.query('page') ?? '1')
  const page = isNaN(pageRaw) || pageRaw < 1 ? 1 : Math.floor(pageRaw)
  const perPage = 20
  const offset = (page - 1) * perPage

  // Single D1 round-trip via batch() — count + data (Pattern 2, APIREAD-11)
  const [countResult, dataResult] = await c.env.DB.batch([
    c.env.DB.prepare(`SELECT COUNT(*) as total FROM masjids WHERE ${where}`)
      .bind(...params),
    c.env.DB.prepare(
      `SELECT id, name, type_id, state_id, city_id, country_id,
        address, lat, lng, jumaat_available, status, version, created_at, updated_at
       FROM masjids WHERE ${where}
       ORDER BY id ASC LIMIT ? OFFSET ?`
    ).bind(...params, perPage, offset),
  ])

  const total = (countResult.results[0] as { total: number }).total
  const masjids = dataResult.results as MasjidRow[]

  // Fetch thumbnails for this page's masjids (Pitfall 6 — always emit thumbnail_url key)
  const ids = masjids.map(m => m.id)
  let thumbnailMap: Record<number, string> = {}

  if (ids.length > 0) {
    // Build placeholders for IN clause — parameterized, no string interpolation (T-02-01)
    const placeholders = ids.map(() => '?').join(', ')
    const imageResult = await c.env.DB.prepare(
      `SELECT masjid_id, url FROM masjid_images
       WHERE masjid_id IN (${placeholders}) AND is_thumbnail = 1
       ORDER BY masjid_id ASC, sort_order ASC`
    ).bind(...ids).run<{ masjid_id: number; url: string }>()

    // Take first thumbnail per masjid (lowest sort_order, due to ORDER BY)
    for (const img of imageResult.results) {
      if (!(img.masjid_id in thumbnailMap)) {
        thumbnailMap[img.masjid_id] = img.url
      }
    }
  }

  const data = masjids.map(m => ({
    ...m,
    thumbnail_url: thumbnailMap[m.id] ?? null,
  }))

  return c.json({ data, meta: { total, page, per_page: perPage } })
})

// ─── GET /masjids/nearby ── proximity search ──────────────────────────────
// CRITICAL: Must be registered BEFORE /:id — Hono matches in registration order (Pitfall 3)

masjidsRouter.get('/nearby', async (c) => {
  const lat = parseFloat(c.req.query('lat') ?? '')
  const lng = parseFloat(c.req.query('lng') ?? '')
  // Use explicit empty-string guard so '?radius=' or '?radius=abc' does not silently become NaN
  const radiusRaw = c.req.query('radius')
  const radius = radiusRaw !== undefined && radiusRaw !== '' ? parseFloat(radiusRaw) : 5

  // Validate presence — isNaN when param missing or non-numeric (T-02-04)
  if (isNaN(lat) || isNaN(lng)) {
    return c.json(errorBody('Missing required param: lat, lng', 'validation_failed'), 422)
  }

  // Validate ranges
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return c.json(errorBody('Invalid lat/lng range', 'validation_failed'), 422)
  }

  // Validate radius — must be a positive number, capped at 20km (CR-01, WR-05, D-10)
  if (isNaN(radius) || radius <= 0) {
    return c.json(errorBody('Invalid radius: must be greater than 0', 'validation_failed'), 422)
  }
  if (radius > 20) {
    return c.json(errorBody('Radius exceeds maximum of 20km', 'validation_failed'), 422)
  }

  // Geohash prefix search — 9 cells (center + 8 neighbors) at tiered precision (D-09)
  const prefixes = geohashPrefixes(lat, lng, radius)
  const likeConditions = prefixes.map(() => 'geohash LIKE ?').join(' OR ')
  const likeParams = prefixes.map(p => `${p}%`)

  const candidates = await c.env.DB.prepare(
    `SELECT id, name, type_id, lat, lng, geohash, state_id, city_id,
      country_id, address, jumaat_available, status, version, created_at, updated_at
     FROM masjids WHERE status = 'active' AND (${likeConditions})
     ORDER BY id ASC`
  ).bind(...likeParams).run<MasjidRow>()

  // Haversine filter to exact radius — geohash prefix may include cells slightly outside (D-09)
  const results = candidates.results.filter(m =>
    haversineKm(lat, lng, m.lat, m.lng) <= radius
  )

  return c.json({
    data: results,
    meta: { total: results.length, page: 1, per_page: results.length || 20 },
  })
})

// ─── GET /masjids/:id ── full detail ─────────────────────────────────────
// Must be registered AFTER /nearby (Pitfall 3)

masjidsRouter.get('/:id', async (c) => {
  const id = parseId(c.req.param('id'))

  const masjid = await loadMasjid(c.env.DB, id)
  if (!masjid) throw new ApiError(404, 'not_found', 'Masjid not found')

  // A merged id points at the survivor; a deleted one returns its tombstone (contract 5.1, spec 4.8).
  if (masjid.status === 'merged' && masjid.merged_into !== null) {
    return c.redirect(`/masjids/${masjid.merged_into}`, 301)
  }
  return c.json(masjid)
})

// ─── writes (through the S2 write pipeline) ───────────────────────────────────

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

const REQUIRED_ON_CREATE = ['name', 'type_id', 'state_id', 'country_id', 'lat', 'lng', 'address'] as const

masjidsRouter.post('/', async (c) => {
  const begin = await beginWrite(c, { requireIfMatch: false })
  if ('replay' in begin) return begin.replay
  const ctx: WriteCtx = begin.ctx

  const body = parseJsonObject(ctx)
  for (const field of REQUIRED_ON_CREATE) {
    if (body[field] === undefined || body[field] === null || body[field] === '') fail(`Missing required field: ${field}`, field)
  }
  const s = validateScalars(body) as Required<Pick<Scalars, 'name' | 'type_id' | 'state_id' | 'country_id' | 'lat' | 'lng'>> & Scalars
  const images = 'images' in body ? validateImages(body.images) : []
  await checkReferences(ctx.db, s)

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
    contacts: [],
    facilities: [],
    images,
    external_ids: [],
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

  return commitWrite(c, ctx, {
    entity: 'masjid',
    op: 'create',
    entityId: null,
    baseVersion: null,
    masjidId: null,
    changedFields: Object.keys(body).filter(k => (WRITABLE as readonly string[]).includes(k) || k === 'images').sort(),
    before: null,
    after,
    entityStatement,
    children: imageStatements(images, now),
    status: 201,
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
    if (!before || before.status !== 'active') throw new ApiError(404, 'not_found', 'Masjid not found')

    if (('lat' in body) !== ('lng' in body)) fail('lat and lng must both be provided together', 'lat')
    const s = validateScalars(body)
    const images = 'images' in body ? validateImages(body.images) : undefined
    if (Object.keys(s).length === 0 && images === undefined) fail('No patchable fields provided', 'body')
    await checkReferences(ctx.db, s)

    if (before.version !== ctx.ifMatch) throw versionConflict(before)

    const now = isoNow()
    const after: MasjidEntity = { ...before, ...s, version: before.version + 1, updated_by_app: ctx.originApp, updated_at: now }
    if (images !== undefined) after.images = images
    if (s.lat !== undefined && s.lng !== undefined) after.geohash = ngeohash.encode(s.lat, s.lng, 9)

    const changedFields: string[] = []
    for (const key of Object.keys(s) as Array<keyof Scalars>) {
      if (before[key] !== after[key]) changedFields.push(key)
    }
    if (images !== undefined && JSON.stringify(images) !== JSON.stringify(before.images)) changedFields.push('images')
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
      children: images === undefined ? undefined : (b) => [
        b.stmt('DELETE FROM masjid_images WHERE masjid_id = {{ID}}'),
        ...imageStatements(images, now)(b),
      ],
      status: 200,
    })
  })
})
