import { geohashRanges, geohashWhere, haversineM } from './geo'

/** Words dropped from the start of a name (spec 4.1). */
const LEADING_WORDS = new Set(['masjid', 'surau', 'musolla', 'musalla', 'mini'])
/** Arabic definite-article forms that join the next word: "al hidayah" and "al-hidayah" are both "alhidayah". */
const ARTICLES = new Set(['al', 'ar', 'an', 'as', 'ad', 'at', 'az', 'ash', 'adh', 'ath', 'el'])

/**
 * Normalises a masjid name for comparison: lowercase, strip diacritics and punctuation, collapse spaces,
 * drop leading masjid/surau/musolla/musalla/mini, glue articles to the next word.
 * A name made only of those leading words ("Masjid") keeps them, so it can still be compared.
 */
export function normaliseName(raw: string): string {
  const tokens = raw
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)

  let start = 0
  while (start < tokens.length && LEADING_WORDS.has(tokens[start])) start++
  const kept = start === tokens.length ? tokens : tokens.slice(start)

  const out: string[] = []
  for (let i = 0; i < kept.length; i++) {
    if (ARTICLES.has(kept[i]) && i + 1 < kept.length) {
      out.push(kept[i] + kept[i + 1])
      i++
    } else {
      out.push(kept[i])
    }
  }
  return out.join(' ')
}

export function jaro(a: string, b: string): number {
  const s1 = Array.from(a)
  const s2 = Array.from(b)
  if (s1.length === 0 && s2.length === 0) return 1
  if (s1.length === 0 || s2.length === 0) return 0

  const window = Math.max(0, Math.floor(Math.max(s1.length, s2.length) / 2) - 1)
  const m1 = new Array<boolean>(s1.length).fill(false)
  const m2 = new Array<boolean>(s2.length).fill(false)
  let matches = 0
  for (let i = 0; i < s1.length; i++) {
    const lo = Math.max(0, i - window)
    const hi = Math.min(s2.length - 1, i + window)
    for (let j = lo; j <= hi; j++) {
      if (!m2[j] && s1[i] === s2[j]) {
        m1[i] = true
        m2[j] = true
        matches++
        break
      }
    }
  }
  if (matches === 0) return 0

  let transpositions = 0
  let k = 0
  for (let i = 0; i < s1.length; i++) {
    if (!m1[i]) continue
    while (!m2[k]) k++
    if (s1[i] !== s2[k]) transpositions++
    k++
  }
  return (matches / s1.length + matches / s2.length + (matches - transpositions / 2) / matches) / 3
}

/**
 * Jaro-Winkler similarity. As in Winkler's original, the common-prefix boost (up to 4 characters,
 * scaling 0.1) applies only when the Jaro score is above 0.7.
 */
export function jaroWinkler(a: string, b: string): number {
  const j = jaro(a, b)
  if (j <= 0.7) return j
  const s1 = Array.from(a)
  const s2 = Array.from(b)
  let prefix = 0
  while (prefix < 4 && prefix < s1.length && prefix < s2.length && s1[prefix] === s2[prefix]) prefix++
  return j + prefix * 0.1 * (1 - j)
}

/** Name similarity of two raw names, 0-1. Two names that are empty after normalising score 0. */
export function nameSimilarity(a: string, b: string): number {
  const na = normaliseName(a)
  const nb = normaliseName(b)
  if (na === '' || nb === '') return 0
  return jaroWinkler(na, nb)
}

/** score = round(0.7 * name_sim + 0.3 * dist_score, 3), dist_score = max(0, 1 - distance_m / 500). */
export function matchScore(nameA: string, nameB: string, distanceM: number): number {
  const distScore = Math.max(0, 1 - distanceM / 500)
  return Math.round((0.7 * nameSimilarity(nameA, nameB) + 0.3 * distScore) * 1000) / 1000
}

export interface MatchCandidate {
  id: number
  name: string
  type_id: string
  lat: number
  lng: number
  address: string | null
  external_ids: Array<{ app_id: string; external_id: string }>
  score: number
  distance_m: number
}

export const CANDIDATE_RADIUS_M = 1000

/**
 * Active masjids within 1 km of the point, scored against `name` and sorted best first
 * (ties: nearer, then lower id). Uses the geohash index, then haversine. Callers slice the top N.
 */
export async function findCandidates(
  db: D1Database,
  lat: number,
  lng: number,
  name: string,
  opts: { excludeId?: number } = {},
): Promise<MatchCandidate[]> {
  const where = geohashWhere(geohashRanges(lat, lng, CANDIDATE_RADIUS_M))
  const rows = await db
    .prepare(
      `SELECT id, name, type_id, lat, lng, address FROM masjids
       WHERE status = 'active' AND ${where.sql}`,
    )
    .bind(...where.binds)
    .all<{ id: number; name: string; type_id: string; lat: number; lng: number; address: string | null }>()

  const scored = rows.results
    .filter(r => r.id !== opts.excludeId)
    .map(r => ({ r, d: haversineM(lat, lng, r.lat, r.lng) }))
    .filter(x => x.d <= CANDIDATE_RADIUS_M)
    .map(x => ({ ...x, score: matchScore(name, x.r.name, x.d) }))
    .sort((a, b) => b.score - a.score || a.d - b.d || a.r.id - b.r.id)

  if (scored.length === 0) return []

  const top = scored.slice(0, 50)
  const ids = top.map(x => x.r.id)
  const ext = await db
    .prepare(
      `SELECT masjid_id, app_id, external_id FROM masjid_external_ids
       WHERE masjid_id IN (SELECT value FROM json_each(?)) ORDER BY app_id, external_id`,
    )
    .bind(JSON.stringify(ids))
    .all<{ masjid_id: number; app_id: string; external_id: string }>()
  const byMasjid = new Map<number, Array<{ app_id: string; external_id: string }>>()
  for (const e of ext.results) {
    const list = byMasjid.get(e.masjid_id) ?? []
    list.push({ app_id: e.app_id, external_id: e.external_id })
    byMasjid.set(e.masjid_id, list)
  }

  return top.map(x => ({
    id: x.r.id,
    name: x.r.name,
    type_id: x.r.type_id,
    lat: x.r.lat,
    lng: x.r.lng,
    address: x.r.address,
    external_ids: byMasjid.get(x.r.id) ?? [],
    score: x.score,
    distance_m: Math.round(x.d),
  }))
}
