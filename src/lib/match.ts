import { searchWindow, windowWhere, haversineM } from './geo'

/** Words dropped from the start of a name (spec 4.1 + S3 review). */
const LEADING_WORDS = new Set([
  'masjid', 'mosque', 'surau', 'musolla', 'musalla', 'musholla', 'mushola', 'langgar', 'mini',
])
/** Arabic definite-article forms that join the next word: "al hidayah" and "al-hidayah" are both "alhidayah". */
const ARTICLES = new Set(['al', 'ar', 'an', 'as', 'ad', 'at', 'az', 'ash', 'adh', 'ath', 'el'])
/** Common abbreviations and spelling variants expanded before comparing ("Kg Baru" = "Kampung Baru"). */
const ABBREVIATIONS: Record<string, string> = {
  kg: 'kampung', kpg: 'kampung', tmn: 'taman', jln: 'jalan', bdr: 'bandar', bt: 'batu',
  seri: 'sri', sg: 'sungai', bkt: 'bukit', tg: 'tanjung',
}
const ROMAN = new Set(['ii', 'iii', 'iv', 'vi', 'vii', 'viii', 'ix'])

/** Lowercase, diacritics and punctuation removed, abbreviations expanded, leading mosque words dropped. */
function nameTokens(raw: string): string[] {
  const tokens = raw
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map(t => ABBREVIATIONS[t] ?? t)

  let start = 0
  while (start < tokens.length && LEADING_WORDS.has(tokens[start])) start++
  // A name made only of those leading words ("Masjid") keeps them, so it can still be compared.
  return start === tokens.length ? tokens : tokens.slice(start)
}

/** Glues articles to the next word (`glue`) or drops them (`!glue`: "al hidayah" -> "hidayah"). */
function applyArticles(tokens: string[], glue: boolean): string {
  const out: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    if (ARTICLES.has(tokens[i]) && i + 1 < tokens.length) {
      if (glue) out.push(tokens[i] + tokens[i + 1])
      else out.push(tokens[i + 1])
      i++
    } else {
      out.push(tokens[i])
    }
  }
  return out.join(' ')
}

/**
 * Normalises a masjid name for comparison: lowercase, strip diacritics and punctuation, collapse spaces,
 * expand abbreviations, drop leading masjid/mosque/surau/musolla/musalla/musholla/mushola/langgar/mini,
 * glue articles to the next word.
 */
export function normaliseName(raw: string): string {
  return applyArticles(nameTokens(raw), true)
}

/** Both article forms: glued ("alhidayah") and with the article removed ("hidayah"). */
export function normaliseVariants(raw: string): string[] {
  const tokens = nameTokens(raw)
  return [...new Set([applyArticles(tokens, true), applyArticles(tokens, false)])]
}

/** Number tokens (digits, roman numerals ii-ix) and single-letter tokens: "Fasa 1", "Blok A". */
function distinguishingTokens(raw: string): string[] {
  return nameTokens(raw)
    .filter(t => /^\d+$/.test(t) || ROMAN.has(t) || /^\p{L}$/u.test(t))
    .sort()
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

/** Name similarity is capped here when the names differ in a number or single-letter token. */
export const TOKEN_CONFLICT_CAP = 0.8

/**
 * Name similarity of two raw names, 0-1: the best Jaro-Winkler over the article forms of each name (glued and
 * removed), capped at 0.8 when they differ in a number or single-letter token ("Fasa 1" vs "Fasa 2",
 * "Blok A" vs "Blok B"). Two names that are empty after normalising score 0.
 */
export function nameSimilarity(a: string, b: string): number {
  const va = normaliseVariants(a)
  const vb = normaliseVariants(b)
  if (va[0] === '' || vb[0] === '') return 0
  let best = 0
  for (const x of va) for (const y of vb) best = Math.max(best, jaroWinkler(x, y))
  const ta = distinguishingTokens(a)
  const tb = distinguishingTokens(b)
  if (ta.join(' ') !== tb.join(' ')) best = Math.min(best, TOKEN_CONFLICT_CAP)
  return best
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
  /** Same type_id as the one supplied; null when the caller supplied none. */
  same_type: boolean | null
}

export const CANDIDATE_RADIUS_M = 1000

/**
 * Active masjids within 1 km of the point, scored against `name` and sorted best first
 * (ties: nearer, then lower id). Uses a lat/lng box plus at most 16 geohash cells, then haversine. Returns the best 50 (callers slice the top N).
 */
export async function findCandidates(
  db: D1Database,
  lat: number,
  lng: number,
  name: string,
  opts: { excludeId?: number; typeId?: string } = {},
): Promise<MatchCandidate[]> {
  const where = windowWhere(searchWindow(lat, lng, CANDIDATE_RADIUS_M))
  const rows = await db
    .prepare(
      `SELECT id, name, type_id, lat, lng, address FROM masjids INDEXED BY ${where.index}
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
    same_type: opts.typeId === undefined ? null : x.r.type_id === opts.typeId,
  }))
}
