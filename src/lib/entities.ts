// Entity shapes (contract section 4) and loaders. The change log stores these exactly as GET returns them.

export interface MasjidEntity {
  id: number
  version: number
  name: string
  type_id: string
  lat: number
  lng: number
  geohash: string
  country_id: string
  state_id: string
  city_id: string | null
  address: string | null
  description: string | null
  jumaat_available: boolean
  telephone: string | null
  email: string | null
  google_url: string | null
  contacts: Array<{ type: string; value: string }>
  facilities: Array<{ code: string; available: boolean }>
  images: Array<{ url: string; is_thumbnail: boolean; sort_order: number }>
  external_ids: Array<{ app_id: string; external_id: string }>
  status: 'active' | 'deleted' | 'merged'
  merged_into: number | null
  updated_by_app: string | null
  created_at: string
  updated_at: string
}

type MasjidScalars = Omit<MasjidEntity, 'contacts' | 'facilities' | 'images' | 'external_ids' | 'jumaat_available'> & {
  jumaat_available: number
}

export const MASJID_COLUMNS = `id, version, name, type_id, lat, lng, geohash, country_id, state_id, city_id,
  address, description, jumaat_available, telephone, email, google_url, status, merged_into,
  updated_by_app, created_at, updated_at`

/** Five statements, one per table. Child ordering is part of the contract shape (deterministic). */
export function masjidStatements(db: D1Database, id: number): D1PreparedStatement[] {
  return [
    db.prepare(`SELECT ${MASJID_COLUMNS} FROM masjids WHERE id = ?`).bind(id),
    db.prepare('SELECT type, value FROM masjid_contacts WHERE masjid_id = ? ORDER BY type').bind(id),
    db.prepare('SELECT code, available FROM masjid_facilities WHERE masjid_id = ? ORDER BY code').bind(id),
    db.prepare('SELECT url, is_thumbnail, sort_order FROM masjid_images WHERE masjid_id = ? ORDER BY sort_order, id').bind(id),
    db.prepare('SELECT app_id, external_id FROM masjid_external_ids WHERE masjid_id = ? ORDER BY app_id, external_id').bind(id),
  ]
}

type ContactRow = { type: string; value: string }
type FacilityRow = { code: string; available: number }
type ImageRow = { url: string; is_thumbnail: number; sort_order: number }
type ExternalRow = { app_id: string; external_id: string }

export function buildMasjid(
  m: MasjidScalars,
  contacts: ContactRow[],
  facilities: FacilityRow[],
  images: ImageRow[],
  externals: ExternalRow[],
): MasjidEntity {
  return {
    id: m.id,
    version: m.version,
    name: m.name,
    type_id: m.type_id,
    lat: m.lat,
    lng: m.lng,
    geohash: m.geohash,
    country_id: m.country_id,
    state_id: m.state_id,
    city_id: m.city_id,
    address: m.address,
    description: m.description,
    jumaat_available: m.jumaat_available === 1,
    telephone: m.telephone,
    email: m.email,
    google_url: m.google_url,
    contacts: contacts.map(r => ({ type: r.type, value: r.value })),
    facilities: facilities.map(r => ({ code: r.code, available: r.available === 1 })),
    images: images.map(r => ({ url: r.url, is_thumbnail: r.is_thumbnail === 1, sort_order: r.sort_order })),
    external_ids: externals.map(r => ({ app_id: r.app_id, external_id: r.external_id })),
    status: m.status,
    merged_into: m.merged_into,
    updated_by_app: m.updated_by_app,
    created_at: m.created_at,
    updated_at: m.updated_at,
  }
}

export function assembleMasjid(results: D1Result[]): MasjidEntity | null {
  const m = results[0].results[0] as MasjidScalars | undefined
  if (!m) return null
  return buildMasjid(
    m,
    results[1].results as ContactRow[],
    results[2].results as FacilityRow[],
    results[3].results as ImageRow[],
    results[4].results as ExternalRow[],
  )
}

/**
 * Hydrates masjid rows (MASJID_COLUMNS) with their children in four batched queries, whatever the page size
 * (list endpoints: no N+1). Children are bound as one JSON array (D1 allows 100 bound parameters).
 */
export async function hydrateMasjids(db: D1Database, rows: MasjidScalars[]): Promise<MasjidEntity[]> {
  if (rows.length === 0) return []
  const ids = JSON.stringify(rows.map(r => r.id))
  const [contacts, facilities, images, externals] = await db.batch([
    db.prepare('SELECT masjid_id, type, value FROM masjid_contacts WHERE masjid_id IN (SELECT value FROM json_each(?)) ORDER BY type').bind(ids),
    db.prepare('SELECT masjid_id, code, available FROM masjid_facilities WHERE masjid_id IN (SELECT value FROM json_each(?)) ORDER BY code').bind(ids),
    db.prepare('SELECT masjid_id, url, is_thumbnail, sort_order FROM masjid_images WHERE masjid_id IN (SELECT value FROM json_each(?)) ORDER BY sort_order, id').bind(ids),
    db.prepare('SELECT masjid_id, app_id, external_id FROM masjid_external_ids WHERE masjid_id IN (SELECT value FROM json_each(?)) ORDER BY app_id, external_id').bind(ids),
  ])
  return rows.map(m => buildMasjid(
    m,
    groupBy(contacts.results as Array<ContactRow & { masjid_id: number }>, m.id),
    groupBy(facilities.results as Array<FacilityRow & { masjid_id: number }>, m.id),
    groupBy(images.results as Array<ImageRow & { masjid_id: number }>, m.id),
    groupBy(externals.results as Array<ExternalRow & { masjid_id: number }>, m.id),
  ))
}

function groupBy<T extends { masjid_id?: number; event_id?: number }>(rows: T[], id: number): T[] {
  return rows.filter(r => (r.masjid_id ?? r.event_id) === id)
}

export type { MasjidScalars }

/** Masjid rows by id in the given order (missing ids skipped), hydrated. Any status. */
export async function loadMasjidsByIds(db: D1Database, ids: number[]): Promise<MasjidEntity[]> {
  if (ids.length === 0) return []
  const rows = await db
    .prepare(`SELECT ${MASJID_COLUMNS} FROM masjids WHERE id IN (SELECT value FROM json_each(?))`)
    .bind(JSON.stringify(ids))
    .all<MasjidScalars>()
  const byId = new Map(rows.results.map(r => [r.id, r]))
  return hydrateMasjids(db, ids.flatMap(id => (byId.has(id) ? [byId.get(id)!] : [])))
}

/** Full masjid entity, any status (callers decide what a deleted or merged row means). */
export async function loadMasjid(db: D1Database, id: number): Promise<MasjidEntity | null> {
  return assembleMasjid(await db.batch(masjidStatements(db, id)))
}

/** Image list in storage order: sort_order, then insertion order. */
export function normaliseImages(
  images: Array<{ url: string; is_thumbnail?: boolean; sort_order?: number }>,
): MasjidEntity['images'] {
  return images
    .map((img, i) => ({ url: img.url, is_thumbnail: img.is_thumbnail === true, sort_order: img.sort_order ?? i, i }))
    .sort((a, b) => a.sort_order - b.sort_order || a.i - b.i)
    .map(({ i: _i, ...rest }) => rest)
}

// ─── Programmes (events) ─────────────────────────────────────────────────────

export interface EventEntity {
  id: number
  version: number
  masjid_id: number
  title: string
  description: string | null
  category: string
  speaker: string | null
  start_at: string
  end_at: string | null
  timezone: string
  rrule: string | null
  status: 'active' | 'cancelled' | 'completed' | 'deleted'
  poster_url: string | null
  registration_url: string | null
  external_ids: Array<{ app_id: string; external_id: string }>
  source_app: string
  updated_by_app: string | null
  created_at: string
  updated_at: string
}

export const EVENT_COLUMNS = `id, version, masjid_id, title, description, category, speaker, start_at, end_at,
  timezone, rrule, status, poster_url, registration_url, source_app, updated_by_app, created_at, updated_at`

type EventScalars = Omit<EventEntity, 'external_ids'>

function buildEvent(e: EventScalars, externals: ExternalRow[]): EventEntity {
  return {
    id: e.id,
    version: e.version,
    masjid_id: e.masjid_id,
    title: e.title,
    description: e.description,
    category: e.category,
    speaker: e.speaker,
    start_at: e.start_at,
    end_at: e.end_at,
    timezone: e.timezone,
    rrule: e.rrule,
    status: e.status,
    poster_url: e.poster_url,
    registration_url: e.registration_url,
    external_ids: externals.map(r => ({ app_id: r.app_id, external_id: r.external_id })),
    source_app: e.source_app,
    updated_by_app: e.updated_by_app,
    created_at: e.created_at,
    updated_at: e.updated_at,
  }
}

/** Hydrates event rows (EVENT_COLUMNS) with external ids in one extra query. */
export async function hydrateEvents(db: D1Database, rows: EventScalars[]): Promise<EventEntity[]> {
  if (rows.length === 0) return []
  const ext = await db
    .prepare('SELECT event_id, app_id, external_id FROM event_external_ids WHERE event_id IN (SELECT value FROM json_each(?)) ORDER BY app_id, external_id')
    .bind(JSON.stringify(rows.map(r => r.id)))
    .all<ExternalRow & { event_id: number }>()
  return rows.map(e => buildEvent(e, groupBy(ext.results, e.id)))
}

/** Full programme entity, any status. */
export async function loadEvent(db: D1Database, id: number): Promise<EventEntity | null> {
  const row = await db.prepare(`SELECT ${EVENT_COLUMNS} FROM masjid_events WHERE id = ?`).bind(id).first<EventScalars>()
  if (!row) return null
  return (await hydrateEvents(db, [row]))[0]
}
