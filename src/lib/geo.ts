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

/**
 * Index-friendly geohash cell ranges (centre cell + 8 neighbours) that cover a circle of `radiusM`
 * around the point. The cell size is chosen so a neighbour ring always reaches the radius
 * (5 chars ~4.9 km, 4 chars ~19.5 km, 3 chars ~156 km).
 */
export function geohashRanges(lat: number, lng: number, radiusM: number): Array<[string, string]> {
  const len = radiusM <= 4000 ? 5 : radiusM <= 15000 ? 4 : 3
  const centre = ngeohash.encode(lat, lng, len)
  // '~' sorts after every geohash character, so [p, p~) is exactly "starts with p" on the plain index.
  return [centre, ...ngeohash.neighbors(centre)].map(p => [p, `${p}~`])
}

export function geohashWhere(ranges: Array<[string, string]>): { sql: string; binds: string[] } {
  return {
    sql: `(${ranges.map(() => '(geohash >= ? AND geohash < ?)').join(' OR ')})`,
    binds: ranges.flat(),
  }
}
