// Daily duplicate scan (S4): finds pairs of active masjids that look like the same place and queues them for review.

import { candidateStatement, scoreRows, type CandidateRow } from './match'

/** A pair is queued when its score is at least this ... */
export const SCAN_MIN_SCORE = 0.8
/** ... and the masjids are at most this far apart (metres). */
export const SCAN_MAX_DISTANCE_M = 150
/** Masjids scanned per run (hourly cron); the cursor continues on the next run. Small enough for the free plan's per-invocation budget. */
export const SCAN_MAX_MASJIDS = 150
/** Statements per D1 batch (one subrequest each; the free plan allows 50 per invocation). */
const SCAN_BATCH = 100
/**
 * When a run catches up, the cursor is parked this far behind "now" so a masjid written in the same second as
 * the cursor (or while the scan was running) is looked at again next time. Pairs are inserted with INSERT OR IGNORE,
 * so the overlap is harmless.
 */
const CATCH_UP_MARGIN_MS = 5 * 60 * 1000

export interface ScanStats {
  /** Masjids examined this run (<= maxMasjids). */
  scanned: number
  /** Candidate rows returned by the 150 m searches. */
  candidates_seen: number
  /** Distinct pairs at or above the thresholds. */
  pairs_found: number
  /** Rows newly inserted (pairs already queued, dismissed or merged are ignored). */
  inserted: number
  /** D1 round trips (each batch counts once). */
  d1_calls: number
  /** Sum of `meta.rows_read` over the run, as reported by D1. */
  rows_read: number
  /** True when no masjid is left past the cursor. */
  caught_up: boolean
  /** Masjids whose batch finished and whose cursor was persisted (== scanned unless a batch failed). */
  completed: number
}

interface ScanRow extends CandidateRow {
  updated_at: string
}

function isoSeconds(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

export async function runDuplicateScan(
  db: D1Database,
  opts: { now?: Date; maxMasjids?: number } = {},
): Promise<ScanStats> {
  const now = opts.now ?? new Date()
  const limit = opts.maxMasjids ?? SCAN_MAX_MASJIDS
  const stats: ScanStats = { scanned: 0, candidates_seen: 0, pairs_found: 0, inserted: 0, d1_calls: 0, rows_read: 0, caught_up: true, completed: 0 }
  const track = (meta: { rows_read?: number } | undefined) => { stats.rows_read += meta?.rows_read ?? 0 }
  const runAt = isoSeconds(now.getTime())

  const state = await db
    .prepare('SELECT last_updated_at, last_id FROM scan_state WHERE id = 1')
    .first<{ last_updated_at: string; last_id: number }>()
  stats.d1_calls++
  if (!state) throw new Error('scan_state row missing (migration 005 not applied?)')

  try {
    const rows = await db
      .prepare(
        `SELECT id, name, type_id, lat, lng, address, updated_at FROM masjids INDEXED BY idx_masjids_updated_at
         WHERE status = 'active' AND (updated_at > ? OR (updated_at = ? AND id > ?))
         ORDER BY updated_at, id LIMIT ?`,
      )
      .bind(state.last_updated_at, state.last_updated_at, state.last_id, limit)
      .all<ScanRow>()
    stats.d1_calls++
    track(rows.meta)
    const masjids = rows.results
    stats.scanned = masjids.length
    stats.caught_up = masjids.length < limit

    let cursorAt = state.last_updated_at
    let cursorId = state.last_id
    // One search batch, then ONE write batch that queues its pairs and advances the cursor past it (atomic): a failure
    // later in the run keeps everything the finished batches did, and the next run resumes after them.
    for (let i = 0; i < masjids.length; i += SCAN_BATCH) {
      const chunk = masjids.slice(i, i + SCAN_BATCH)
      const results = await db.batch(chunk.map(m => candidateStatement(db, m.lat, m.lng, SCAN_MAX_DISTANCE_M)))
      stats.d1_calls++
      const pairs = new Map<string, { a: number; b: number; score: number; distance: number }>()
      results.forEach((res, k) => {
        track(res.meta)
        const m = chunk[k]
        const found = res.results as CandidateRow[]
        stats.candidates_seen += found.length
        for (const s of scoreRows(found, m.lat, m.lng, m.name, SCAN_MAX_DISTANCE_M, m.id)) {
          if (s.score < SCAN_MIN_SCORE) continue
          const a = Math.min(m.id, s.r.id)
          const b = Math.max(m.id, s.r.id)
          const key = `${a}:${b}`
          const prev = pairs.get(key)
          if (!prev || s.score > prev.score) pairs.set(key, { a, b, score: s.score, distance: Math.round(s.d) })
        }
      })
      stats.pairs_found += pairs.size

      const last = chunk[chunk.length - 1]
      const stmts = [...pairs.values()].map(p =>
        db
          .prepare('INSERT OR IGNORE INTO duplicate_candidates (masjid_a, masjid_b, score, distance_m) VALUES (?, ?, ?, ?)')
          .bind(p.a, p.b, p.score, p.distance),
      )
      stmts.push(db.prepare('UPDATE scan_state SET last_updated_at = ?, last_id = ? WHERE id = 1').bind(last.updated_at, last.id))
      const written = await db.batch(stmts)
      stats.d1_calls++
      for (const r of written.slice(0, -1)) {
        track(r.meta)
        stats.inserted += r.meta.changes ?? 0
      }
      cursorAt = last.updated_at
      cursorId = last.id
      stats.completed += chunk.length
    }

    if (stats.caught_up) {
      // Caught up: park the cursor a little behind "now" (see CATCH_UP_MARGIN_MS).
      const parked = isoSeconds(now.getTime() - CATCH_UP_MARGIN_MS)
      if (parked > cursorAt) {
        cursorAt = parked
        cursorId = 0
      }
    }
    await db
      .prepare(
        `UPDATE scan_state SET last_updated_at = ?, last_id = ?, last_run_at = ?, last_run_scanned = ?, last_run_queued = ?, last_error = NULL
         WHERE id = 1`,
      )
      .bind(cursorAt, cursorId, runAt, stats.completed, stats.inserted)
      .run()
    stats.d1_calls++
    return stats
  } catch (err) {
    // Record the failure (cursor untouched beyond the batches that finished) and let the caller log it.
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 500)
    try {
      await db
        .prepare('UPDATE scan_state SET last_run_at = ?, last_run_scanned = ?, last_run_queued = ?, last_error = ? WHERE id = 1')
        .bind(runAt, stats.completed, stats.inserted, message)
        .run()
    } catch (inner) {
      console.error('could not record the scan error', inner)
    }
    throw err
  }
}

/** GET /admin/scan: the cursor, the last run and how many active masjids are still ahead of the cursor. */
export async function scanStatus(db: D1Database) {
  const state = await db
    .prepare(
      `SELECT last_updated_at, last_id, last_run_at, last_run_scanned, last_run_queued, last_error FROM scan_state WHERE id = 1`,
    )
    .first<{
      last_updated_at: string; last_id: number; last_run_at: string | null
      last_run_scanned: number; last_run_queued: number; last_error: string | null
    }>()
  if (!state) throw new Error('scan_state row missing (migration 005 not applied?)')
  const remaining = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM masjids WHERE status = 'active' AND (updated_at > ? OR (updated_at = ? AND id > ?))`,
    )
    .bind(state.last_updated_at, state.last_updated_at, state.last_id)
    .first<{ n: number }>()
  return {
    cursor: { updated_at: state.last_updated_at, id: state.last_id },
    last_run_at: state.last_run_at,
    last_run_scanned: state.last_run_scanned,
    last_run_queued: state.last_run_queued,
    last_error: state.last_error,
    masjids_remaining: remaining?.n ?? 0,
    max_masjids_per_run: SCAN_MAX_MASJIDS,
  }
}
