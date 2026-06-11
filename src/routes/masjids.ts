// Masjid routes — GET /masjids (list+filters), GET /masjids/nearby, GET /masjids/:id,
//                  POST /masjids (create), PATCH /masjids/:id (update)

import { Hono } from 'hono'
import ngeohash from 'ngeohash'
import type { MasjidRow, MasjidImageRow, MasjidFacilityRow, MasjidContactRow, MasjidReviewRow, MasjidEventRow } from '../types/db'
import { buildImageUrl } from '../lib/images'
import { geohashPrefixes, haversineKm } from '../lib/geo'
import { authMiddleware } from '../middleware/auth'

export const masjidsRouter = new Hono<{ Bindings: CloudflareBindings }>()

// ─── GET /masjids ── paginated filterable list ─────────────────────────────

masjidsRouter.get('/', async (c) => {
  // Build dynamic WHERE conditions — always seed with soft-delete filter (APIREAD-10)
  const conditions: string[] = ['status != ?']
  const params: (string | number)[] = ['deleted']

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
        address, lat, lng, jumaat_available, status, source, created_at, updated_at
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
      `SELECT masjid_id, path FROM masjid_images
       WHERE masjid_id IN (${placeholders}) AND is_thumbnail = 1
       ORDER BY masjid_id ASC, sort_order ASC`
    ).bind(...ids).run<Pick<MasjidImageRow, 'masjid_id' | 'path'>>()

    // Take first thumbnail per masjid (lowest sort_order, due to ORDER BY)
    for (const img of imageResult.results) {
      if (!(img.masjid_id in thumbnailMap)) {
        thumbnailMap[img.masjid_id] = img.path
      }
    }
  }

  const data = masjids.map(m => ({
    ...m,
    thumbnail_url: thumbnailMap[m.id]
      ? buildImageUrl(c.env.IMAGES_DELIVERY_URL, thumbnailMap[m.id], 'thumbnail')
      : null,
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
    return c.json({ error: 'Missing required param: lat, lng' }, 400)
  }

  // Validate ranges
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return c.json({ error: 'Invalid lat/lng range' }, 400)
  }

  // Validate radius — must be a positive number, capped at 20km (CR-01, WR-05, D-10)
  if (isNaN(radius) || radius <= 0) {
    return c.json({ error: 'Invalid radius: must be greater than 0' }, 400)
  }
  if (radius > 20) {
    return c.json({ error: 'Radius exceeds maximum of 20km' }, 400)
  }

  // Geohash prefix search — 9 cells (center + 8 neighbors) at tiered precision (D-09)
  const prefixes = geohashPrefixes(lat, lng, radius)
  const likeConditions = prefixes.map(() => 'geohash LIKE ?').join(' OR ')
  const likeParams = prefixes.map(p => `${p}%`)

  const candidates = await c.env.DB.prepare(
    `SELECT id, name, type_id, lat, lng, geohash, state_id, city_id,
      country_id, address, jumaat_available, status, source, created_at, updated_at
     FROM masjids WHERE status != 'deleted' AND (${likeConditions})
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
  const id = parseInt(c.req.param('id'))
  // Non-numeric id guard — T-02-04
  if (isNaN(id)) {
    return c.json({ error: 'Invalid id' }, 400)
  }

  // Batch all 7 queries in one D1 round-trip (Pattern 3)
  const [
    masjidResult,
    imagesResult,
    facilitiesResult,
    contactsResult,
    reviewsResult,
    eventsResult,
    ratingResult,
  ] = await c.env.DB.batch([
    // (1) Main masjid row — excludes deleted and internal soft-delete column (APIREAD-10, T-02-05, WR-02)
    c.env.DB.prepare(
      `SELECT id, name, type_id, lat, lng, geohash, city_id, state_id, country_id,
        address, description, status, jumaat_available, telephone, email, google_url,
        source, created_at, updated_at
       FROM masjids WHERE id = ? AND status != ?`
    ).bind(id, 'deleted'),
    // (2) Images ordered by sort_order (D-04)
    c.env.DB.prepare(
      'SELECT id, masjid_id, path, is_thumbnail, sort_order, created_at FROM masjid_images WHERE masjid_id = ? ORDER BY sort_order ASC'
    ).bind(id),
    // (3) Facilities
    c.env.DB.prepare(
      'SELECT id, masjid_id, facility FROM masjid_facilities WHERE masjid_id = ?'
    ).bind(id),
    // (4) Contacts — omit internal row id from public response
    c.env.DB.prepare(
      'SELECT masjid_id, type, value FROM masjid_contacts WHERE masjid_id = ?'
    ).bind(id),
    // (5) 10 most recent reviews — omit source_user_id (internal attribution, CR-04, WR-02)
    c.env.DB.prepare(
      'SELECT id, masjid_id, rating, message, source_app, created_at FROM masjid_reviews WHERE masjid_id = ? ORDER BY created_at DESC LIMIT 10'
    ).bind(id),
    // (6) Upcoming events — omit source_user_id (internal attribution, WR-02); column is start_at NOT start_time (Pitfall 1, D-06)
    c.env.DB.prepare(
      `SELECT id, masjid_id, title, description, start_at, end_at, status, rrule, source_app, created_at, updated_at
       FROM masjid_events WHERE masjid_id = ? AND start_at >= datetime('now') ORDER BY start_at ASC`
    ).bind(id),
    // (7) Aggregate rating (D-07)
    c.env.DB.prepare(
      'SELECT AVG(rating) as avg_rating, COUNT(*) as review_count FROM masjid_reviews WHERE masjid_id = ?'
    ).bind(id),
  ])

  const masjid = masjidResult.results[0] as MasjidRow | undefined
  // 404 for non-existent or deleted masjid (APIREAD-10)
  if (!masjid) {
    return c.json({ error: 'Masjid not found' }, 404)
  }

  const images = (imagesResult.results as MasjidImageRow[]).map(img => ({
    ...img,
    thumbnail_url: buildImageUrl(c.env.IMAGES_DELIVERY_URL, img.path, 'thumbnail'),
    full_url: buildImageUrl(c.env.IMAGES_DELIVERY_URL, img.path, 'public'),
  }))

  const facilities = facilitiesResult.results as MasjidFacilityRow[]
  const contacts = contactsResult.results as MasjidContactRow[]
  const reviews = reviewsResult.results as MasjidReviewRow[]
  const events = eventsResult.results as MasjidEventRow[]

  // avg_rating: null when no reviews, rounded to 1dp otherwise (D-07)
  const ratingRow = ratingResult.results[0] as { avg_rating: number | null; review_count: number }
  const avg_rating = ratingRow.avg_rating !== null
    ? Math.round(ratingRow.avg_rating * 10) / 10
    : null
  const review_count = ratingRow.review_count

  return c.json({
    ...masjid,
    images,
    facilities,
    contacts,
    reviews,
    events,
    avg_rating,
    review_count,
  })
})

// ─── POST /masjids ── create new masjid ─────────────────────────────────────

const REQUIRED_FIELDS = ['name', 'type_id', 'state_id', 'country_id', 'lat', 'lng', 'address', 'source'] as const

masjidsRouter.post('/', authMiddleware, async (c) => {
  let body: Record<string, unknown>
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  // D-07: validate required fields
  for (const field of REQUIRED_FIELDS) {
    if (body[field] === undefined || body[field] === null || body[field] === '') {
      return c.json({ error: `Missing required field: ${field}` }, 400)
    }
  }

  const name = body.name as string
  const type_id = body.type_id as string
  const state_id = body.state_id as string
  const country_id = body.country_id as string
  const lat = Number(body.lat)
  const lng = Number(body.lng)
  const address = body.address as string
  const source = body.source as string

  // D-10: handler computes geohash — caller value ignored
  const geohash = ngeohash.encode(lat, lng, 9)

  // D-08: city_id optional; D-09: nullable fields default to null
  const city_id = body.city_id ?? null
  const description = body.description ?? null
  const telephone = body.telephone ?? null
  const email = body.email ?? null
  const google_url = body.google_url ?? null
  // coerce boolean jumaat_available to integer (true → 1, false → 0, numeric passthrough)
  const jumaat_available =
    body.jumaat_available === true ? 1
    : body.jumaat_available === false ? 0
    : (body.jumaat_available ?? 0)

  // D-11: created_at and updated_at set server-side via datetime('now')
  const insertResult = await c.env.DB
    .prepare(
      `INSERT INTO masjids (name, type_id, lat, lng, geohash, city_id, state_id, country_id,
         address, description, telephone, email, google_url, jumaat_available, source,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
    )
    .bind(
      name, type_id, lat, lng, geohash,
      city_id, state_id, country_id,
      address, description, telephone, email, google_url, jumaat_available, source
    )
    .run()

  const newId = insertResult.meta.last_row_id

  // D-12: return full core masjid row (excludes deleted_at — internal column)
  const created = await c.env.DB
    .prepare(
      `SELECT id, name, type_id, lat, lng, geohash, city_id, state_id, country_id,
         address, description, status, jumaat_available, telephone, email, google_url,
         source, created_at, updated_at
       FROM masjids WHERE id = ?`
    )
    .bind(newId)
    .first<MasjidRow>()

  return c.json(created, 201)
})

// ─── PATCH /masjids/:id ── partial update ───────────────────────────────────

const PATCHABLE_FIELDS = [
  'name', 'type_id', 'state_id', 'country_id', 'city_id', 'lat', 'lng',
  'address', 'description', 'telephone', 'email', 'google_url', 'jumaat_available', 'source',
] as const

masjidsRouter.patch('/:id', authMiddleware, async (c) => {
  const id = parseInt(c.req.param('id'))
  if (isNaN(id)) {
    return c.json({ error: 'Invalid id' }, 400)
  }

  // D-16: pre-PATCH existence check — exclude deleted records (Pitfall 6)
  const existing = await c.env.DB
    .prepare(`SELECT id FROM masjids WHERE id = ? AND status != 'deleted'`)
    .bind(id)
    .first()
  if (!existing) {
    return c.json({ error: 'Masjid not found' }, 404)
  }

  let body: Record<string, unknown>
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  // D-14: lat and lng must both be present or neither (Pitfall 4)
  const hasLat = 'lat' in body
  const hasLng = 'lng' in body
  if (hasLat !== hasLng) {
    return c.json({ error: 'lat and lng must both be provided together' }, 400)
  }

  // Filter body to allowed fields only — strips internal fields (T-3-08)
  const updates: Record<string, unknown> = {}
  for (const key of PATCHABLE_FIELDS) {
    if (key in body) updates[key] = body[key]
  }

  if (Object.keys(updates).length === 0) {
    return c.json({ error: 'No patchable fields provided' }, 400)
  }

  // D-14: recompute geohash when coordinates change
  if (hasLat && hasLng) {
    updates.geohash = ngeohash.encode(Number(updates.lat), Number(updates.lng), 9)
  }

  // D-15: always set updated_at = datetime('now') — no SQLite trigger exists
  const setClauses = [...Object.keys(updates).map(k => `${k} = ?`), "updated_at = datetime('now')"]

  await c.env.DB
    .prepare(`UPDATE masjids SET ${setClauses.join(', ')} WHERE id = ?`)
    .bind(...Object.values(updates), id)
    .run()

  // D-17: re-SELECT for correct updated_at and geohash values
  const updated = await c.env.DB
    .prepare(
      `SELECT id, name, type_id, lat, lng, geohash, city_id, state_id, country_id,
         address, description, status, jumaat_available, telephone, email, google_url,
         source, created_at, updated_at
       FROM masjids WHERE id = ?`
    )
    .bind(id)
    .first<MasjidRow>()

  return c.json(updated, 200)
})
