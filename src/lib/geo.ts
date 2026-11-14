// Geohash proximity helpers and Haversine distance calculation for proximity search.

import ngeohash from 'ngeohash'

/**
 * Returns an array of 9 geohash prefix strings (center + 8 neighbors) for the given
 * lat/lng and radius. Prefix length is tiered: 5 for <=5km, 4 for <=20km.
 */
export function geohashPrefixes(lat: number, lng: number, radiusKm: number): string[] {
  // Encode at precision 7 (~153m cells), then truncate to coverage-appropriate prefix length.
  // p5 cells (~4.9km) cover up to 5km radius; p4 (~39km cells) cover up to 20km.
  const hash7 = ngeohash.encode(lat, lng, 7)
  const prefixLen = radiusKm <= 5 ? 5 : 4
  const centerPrefix = hash7.slice(0, prefixLen)
  const neighborPrefixes = ngeohash.neighbors(centerPrefix)
  return [centerPrefix, ...neighborPrefixes] // 9 cells total
}

/**
 * Haversine distance between two lat/lng points, in kilometers.
 */
export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371 // Earth radius in km (use 6_371_000 for meters — see deduplicate.js)
  const toRad = (deg: number) => (deg * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

/** Haversine distance in metres. */
export function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  return haversineKm(lat1, lng1, lat2, lng2) * 1000
}

export const MAX_COVER_CELLS = 16

export interface SearchWindow {
  minLat: number
  maxLat: number
  minLng: number
  /** null when the window wraps the antimeridian or reaches a pole (no longitude predicate). */
  maxLng: number
  /** Geohash prefixes (all one length, at most MAX_COVER_CELLS) covering the box; [] = no geohash predicate. */
  prefixes: string[]
}

/** Number of geohash cells of `precision` characters that a lat/lng box touches. */
function cellCount(minLat: number, maxLat: number, minLng: number, maxLng: number, precision: number): number {
  const bits = precision * 5
  const lngBits = Math.ceil(bits / 2)
  const latBits = Math.floor(bits / 2)
  const h = 180 / 2 ** latBits
  const w = 360 / 2 ** lngBits
  const rows = Math.floor((maxLat + 90) / h) - Math.floor((minLat + 90) / h) + 1
  const cols = Math.floor((maxLng + 180) / w) - Math.floor((minLng + 180) / w) + 1
  return rows * cols
}

/**
 * Bounding box of a circle plus the coarsest-to-finest geohash cover: the finest precision (1-8 characters)
 * whose cells covering the box number at most 16 (so at most 32 geohash binds). Callers add
 * `lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?` (index idx_masjids_lat_lng) and the geohash ranges, then
 * filter by haversine.
 */
export function searchWindow(lat: number, lng: number, radiusM: number): SearchWindow {
  const dLat = radiusM / 110_000 // a degree of latitude is at least ~110.5 km
  const minLat = Math.max(-90, lat - dLat)
  const maxLat = Math.min(90, lat + dLat)
  const worstLat = Math.min(89.9, Math.max(Math.abs(minLat), Math.abs(maxLat)))
  const dLng = radiusM / (111_000 * Math.cos((worstLat * Math.PI) / 180))
  let minLng = lng - dLng
  let maxLng = lng + dLng
  if (minLng < -180 || maxLng > 180 || dLng >= 180) {
    // Wraps the antimeridian: give up on the longitude bound (haversine still decides).
    return { minLat, maxLat, minLng: -180, maxLng: 180, prefixes: [] }
  }
  minLng = Math.max(-180, minLng)
  maxLng = Math.min(180, maxLng)

  for (let precision = 8; precision >= 1; precision--) {
    if (cellCount(minLat, maxLat, minLng, maxLng, precision) <= MAX_COVER_CELLS) {
      return { minLat, maxLat, minLng, maxLng, prefixes: ngeohash.bboxes(minLat, minLng, maxLat, maxLng, precision) }
    }
  }
  return { minLat, maxLat, minLng, maxLng, prefixes: [] }
}

/**
 * SQL predicate (+ binds) for a search window: lat/lng box AND (geohash cell ranges).
 * `index` is the index to force with `FROM masjids INDEXED BY <index>`: without stats SQLite prefers
 * idx_masjids_status (equality on status) and scans every active masjid. The geohash ranges are the most
 * selective access path; the lat/lng index is the fallback when there is no geohash cover.
 */
export function windowWhere(w: SearchWindow): { sql: string; binds: Array<string | number>; index: string } {
  // '~' sorts after every geohash character, so [p, p~) is exactly "starts with p" on the plain index.
  const cells = w.prefixes.map(() => '(geohash >= ? AND geohash < ?)').join(' OR ')
  return {
    sql: `lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?${cells === '' ? '' : ` AND (${cells})`}`,
    binds: [w.minLat, w.maxLat, w.minLng, w.maxLng, ...w.prefixes.flatMap(p => [p, `${p}~`])],
    index: w.prefixes.length > 0 ? 'idx_masjids_geohash' : 'idx_masjids_lat_lng',
  }
}
