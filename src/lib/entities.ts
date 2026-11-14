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

const MASJID_COLUMNS = `id, version, name, type_id, lat, lng, geohash, country_id, state_id, city_id,
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

export function assembleMasjid(results: D1Result[]): MasjidEntity | null {
  const m = results[0].results[0] as MasjidScalars | undefined
  if (!m) return null
  const contacts = (results[1].results as Array<{ type: string; value: string }>).map(r => ({ type: r.type, value: r.value }))
  const facilities = (results[2].results as Array<{ code: string; available: number }>)
    .map(r => ({ code: r.code, available: r.available === 1 }))
  const images = (results[3].results as Array<{ url: string; is_thumbnail: number; sort_order: number }>)
    .map(r => ({ url: r.url, is_thumbnail: r.is_thumbnail === 1, sort_order: r.sort_order }))
  const external_ids = (results[4].results as Array<{ app_id: string; external_id: string }>)
    .map(r => ({ app_id: r.app_id, external_id: r.external_id }))
  // Key order follows contract section 4.1.
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
    contacts,
    facilities,
    images,
    external_ids,
    status: m.status,
    merged_into: m.merged_into,
    updated_by_app: m.updated_by_app,
    created_at: m.created_at,
    updated_at: m.updated_at,
  }
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
