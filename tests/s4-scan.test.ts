import { describe, it, expect, beforeEach } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import ngeohash from 'ngeohash'
import { BASE, KEYS, api, bearer, createMasjid, getMasjid, spot } from './helpers'
import { runDuplicateScan, scanStatus, SCAN_MAX_MASJIDS, SCAN_BATCH } from '../src/lib/scan'
import worker from '../src/index'

interface Err { error: string; code: string; details?: Record<string, any> }
interface Dup {
  id: number; status: string; score: number; distance_m: number; same_type: boolean
  masjid_a: { id: number; name: string; type_id: string; status: string; external_ids: unknown[] }
  masjid_b: { id: number; name: string; type_id: string; status: string; external_ids: unknown[] }
  resolved_at: string | null
}
const admin = KEYS.admin.token

const resetCursor = () => env.DB.prepare("UPDATE scan_state SET last_updated_at = '', last_id = 0, last_run_at = NULL, last_error = NULL, consecutive_failures = 0, skipped_ids = '[]' WHERE id = 1").run()
async function pair(a: number, b: number) {
  const [x, y] = [Math.min(a, b), Math.max(a, b)]
  return env.DB.prepare('SELECT * FROM duplicate_candidates WHERE masjid_a = ? AND masjid_b = ?').bind(x, y).all<Record<string, any>>()
}
async function mk(n: number, name: string, dLatM = 0, extra: Record<string, unknown> = {}) {
  return createMasjid({ ...spot(n, dLatM), name, ...extra })
}
const get = (path: string, token: string = admin) => SELF.fetch(`${BASE}${path}`, { headers: bearer(token) })

beforeEach(resetCursor)

describe('duplicate scan', () => {
  it('inserts each qualifying pair once, ordered masjid_a < masjid_b, and never twice', async () => {
    const a = await mk(40, 'MASJID AL-HIDAYAH')
    const b = await mk(40, 'Masjid Al Hidayah', 60) // 60 m: duplicate
    const far = await mk(40, 'Masjid Al Hidayah', 400) // same name, 400 m: not within 150 m
    const other = await mk(40, 'Surau An-Nur', 30) // 30 m but a different name
    const blok = await mk(41, 'Surau Hidayah Blok A')
    const blokB = await mk(41, 'Surau Hidayah Blok B', 40) // 0.836: >= 0.8 so queued for a person

    const stats = await runDuplicateScan(env.DB)
    expect(stats.caught_up).toBe(true)
    const ab = (await pair(a.id, b.id)).results
    expect(ab).toHaveLength(1)
    expect(ab[0]).toMatchObject({ masjid_a: Math.min(a.id, b.id), masjid_b: Math.max(a.id, b.id), status: 'pending' })
    expect(ab[0].score).toBeGreaterThanOrEqual(0.8)
    expect(ab[0].distance_m).toBeLessThanOrEqual(150)
    expect((await pair(a.id, far.id)).results).toHaveLength(0)
    expect((await pair(a.id, other.id)).results).toHaveLength(0)
    expect((await pair(blok.id, blokB.id)).results).toHaveLength(1)

    // Scanning again (from the start) inserts nothing new: one row per pair.
    await resetCursor()
    const again = await runDuplicateScan(env.DB)
    expect(again.inserted).toBe(0)
    expect((await pair(a.id, b.id)).results).toHaveLength(1)
  })

  it('skips pairs where either masjid is not active', async () => {
    const a = await mk(42, 'Masjid Nur Iman')
    const deleted = await mk(42, 'Masjid Nur Iman', 20)
    const merged = await mk(42, 'Masjid Nur Iman', 25)
    await env.DB.prepare("UPDATE masjids SET status = 'deleted' WHERE id = ?").bind(deleted.id).run()
    await env.DB.prepare("UPDATE masjids SET status = 'merged', merged_into = ? WHERE id = ?").bind(a.id, merged.id).run()
    await runDuplicateScan(env.DB)
    expect((await pair(a.id, deleted.id)).results).toHaveLength(0)
    expect((await pair(a.id, merged.id)).results).toHaveLength(0)
    expect((await pair(deleted.id, merged.id)).results).toHaveLength(0)
  })

  it('does not re-queue a dismissed pair', async () => {
    const a = await mk(43, 'Masjid Ar-Rahman')
    const b = await mk(43, 'Masjid Ar Rahman', 50)
    await runDuplicateScan(env.DB)
    const row = (await pair(a.id, b.id)).results[0]
    expect((await api('POST', `/admin/duplicates/${row.id}/dismiss`, { token: admin, body: {} })).status).toBe(200)
    await resetCursor()
    expect((await runDuplicateScan(env.DB)).inserted).toBe(0)
    expect((await pair(a.id, b.id)).results[0].status).toBe('dismissed')
  })

  it('continues from its cursor: at most N masjids per run, then the rest next run', async () => {
    const created = []
    for (let i = 0; i < 5; i++) created.push(await mk(44 + i, `Masjid Cursor ${i}`))
    const total = (await env.DB.prepare("SELECT COUNT(*) AS n FROM masjids WHERE status = 'active'").first<{ n: number }>())!.n

    let scanned = 0
    let runs = 0
    for (;;) {
      const s = await runDuplicateScan(env.DB, { maxMasjids: 2 })
      expect(s.scanned).toBeLessThanOrEqual(2)
      scanned += s.scanned
      runs++
      if (s.caught_up) break
      expect(runs).toBeLessThan(500)
    }
    expect(scanned).toBe(total)
    expect(runs).toBe(Math.ceil(total / 2) + (total % 2 === 0 ? 1 : 0))

    // Caught up: a later change is picked up by the next run, and only that.
    const late = await mk(60, 'Masjid Late Arrival')
    const lateTwin = await mk(60, 'Masjid Late Arrival', 30)
    const s = await runDuplicateScan(env.DB)
    expect(s.scanned).toBeGreaterThanOrEqual(2)
    expect((await pair(late.id, lateTwin.id)).results).toHaveLength(1)
    const state = await env.DB.prepare('SELECT * FROM scan_state WHERE id = 1').first<Record<string, any>>()
    expect(state!.last_run_at).toBeTruthy()
  })

  it('the hourly cron trigger runs the scan; the per-minute trigger does not', async () => {
    const a = await mk(61, 'Masjid Cron Check')
    const b = await mk(61, 'Masjid Cron Check', 40)
    const run = async (cron: string | undefined) => {
      const pending: Promise<unknown>[] = []
      await worker.scheduled({ cron } as ScheduledController, env, { waitUntil: (p: Promise<unknown>) => { pending.push(p) } } as unknown as ExecutionContext)
      await Promise.all(pending)
    }
    await run('* * * * *')
    expect((await pair(a.id, b.id)).results).toHaveLength(0)
    await run('0 * * * *')
    expect((await pair(a.id, b.id)).results).toHaveLength(1)
  })
})

describe('GET /admin/duplicates and the queue actions', () => {
  it('lists pending pairs with both masjids and same_type, paginated; filters by status', async () => {
    const a = await mk(62, 'Masjid Queue One', 0, { external_id: 'queue-a' })
    const b = await mk(62, 'Masjid Queue One', 40, { type_id: 'surau' })
    const c = await mk(63, 'Masjid Queue Two')
    const d = await mk(63, 'Masjid Queue Two', 40)
    await runDuplicateScan(env.DB)

    const res = await get('/admin/duplicates?status=pending&limit=1')
    expect(res.status).toBe(200)
    const first = await res.json() as { data: Dup[]; next_cursor: string | null }
    expect(first.data).toHaveLength(1)
    expect(first.next_cursor).toBeTruthy()

    const all: Dup[] = [...first.data]
    let cursor = first.next_cursor
    while (cursor) {
      const next = await (await get(`/admin/duplicates?limit=1&cursor=${cursor}`)).json() as { data: Dup[]; next_cursor: string | null }
      all.push(...next.data)
      cursor = next.next_cursor
    }
    const ids = all.map(x => x.id)
    expect(ids).toEqual([...ids].sort((x, y) => x - y))
    const ab = all.find(x => x.masjid_a.id === Math.min(a.id, b.id) && x.masjid_b.id === Math.max(a.id, b.id))!
    expect(ab).toBeTruthy()
    expect(ab.same_type).toBe(false)
    expect(ab.status).toBe('pending')
    const sideOfA = ab.masjid_a.id === a.id ? ab.masjid_a : ab.masjid_b
    expect(sideOfA).toMatchObject({ name: 'Masjid Queue One', type_id: 'masjid', status: 'active' })
    expect(sideOfA.external_ids).toEqual([{ app_id: 'jejak_masjid', external_id: 'queue-a' }])
    const cd = all.find(x => x.masjid_a.id === Math.min(c.id, d.id))!
    expect(cd.same_type).toBe(true)

    const merged = await (await get('/admin/duplicates?status=merged')).json() as { data: Dup[] }
    expect(merged.data.find(x => x.id === ab.id)).toBeUndefined()
    expect((await get('/admin/duplicates?status=bogus')).status).toBe(422)
    expect((await get('/admin/duplicates?cursor=%21%21')).status).toBe(422)
  })

  it('dismiss marks the row, is a no-op the second time, and 404s on a missing id', async () => {
    const a = await mk(64, 'Masjid Dismiss Me')
    const b = await mk(64, 'Masjid Dismiss Me', 40)
    await runDuplicateScan(env.DB)
    const row = (await pair(a.id, b.id)).results[0]
    const res = await api('POST', `/admin/duplicates/${row.id}/dismiss`, { token: admin, body: {} })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ id: row.id, status: 'dismissed' })
    expect((await api('POST', `/admin/duplicates/${row.id}/dismiss`, { token: admin, body: {} })).status).toBe(200)
    expect((await api('POST', '/admin/duplicates/99999999/dismiss', { token: admin, body: {} })).status).toBe(404)
    // a dismissed pair cannot be merged through the queue
    const m = await api('POST', `/admin/duplicates/${row.id}/merge`, { token: admin, body: { into: a.id } })
    expect(m.status).toBe(422)
    expect(((await m.json()) as Err).details).toMatchObject({ reason: 'not_pending' })
  })

  it('merge via the queue: into must be one of the pair; marks the row merged; other pending rows of the loser are dismissed', async () => {
    const keep = await mk(65, 'Masjid Triple', 0, { external_id: 'tri-keep' })
    const loser = await mk(65, 'Masjid Triple', 40, { external_id: 'tri-lose' })
    const third = await mk(65, 'Masjid Triple', 80) // pairs with both
    const outsider = await mk(66, 'Masjid Outsider')
    await runDuplicateScan(env.DB)
    const main = (await pair(keep.id, loser.id)).results[0]
    const other = (await pair(loser.id, third.id)).results[0]
    const untouched = (await pair(keep.id, third.id)).results[0]
    expect(main && other && untouched).toBeTruthy()

    const bad = await api('POST', `/admin/duplicates/${main.id}/merge`, { token: admin, body: { into: outsider.id } })
    expect(bad.status).toBe(422)
    expect(((await bad.json()) as Err).details).toMatchObject({ field: 'into' })
    expect((await api('POST', `/admin/duplicates/${main.id}/merge`, { token: admin, body: {} })).status).toBe(422)
    expect((await api('POST', `/admin/duplicates/${main.id}/merge`, { token: KEYS.jm.token, body: { into: keep.id } })).status).toBe(403)

    const res = await api('POST', `/admin/duplicates/${main.id}/merge`, { token: admin, body: { into: keep.id }, actor: 'admin-1' })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ id: loser.id, status: 'merged', merged_into: keep.id })
    expect((await getMasjid(keep.id)).external_ids).toEqual([
      { app_id: 'jejak_masjid', external_id: 'tri-keep' },
      { app_id: 'jejak_masjid', external_id: 'tri-lose' },
    ])
    const rows = async (id: number) => (await env.DB.prepare('SELECT status, resolved_at FROM duplicate_candidates WHERE id = ?').bind(id).first<Record<string, any>>())!
    expect(await rows(main.id)).toMatchObject({ status: 'merged' })
    expect((await rows(main.id)).resolved_at).toBeTruthy()
    expect(await rows(other.id)).toMatchObject({ status: 'dismissed' }) // involves the removed masjid
    expect(await rows(untouched.id)).toMatchObject({ status: 'pending' }) // survivor's other pair stays

    // The survivor's version bump makes the next scan look at it again (its pair with `third` already exists).
    await resetCursor()
    expect((await runDuplicateScan(env.DB)).inserted).toBe(0)
  })

  it('a plain merge (not via the queue) resolves its queue row too', async () => {
    const a = await mk(67, 'Masjid Plain Merge')
    const b = await mk(67, 'Masjid Plain Merge', 40)
    await runDuplicateScan(env.DB)
    const row = (await pair(a.id, b.id)).results[0]
    expect((await api('POST', `/admin/masjids/${b.id}/merge`, { token: admin, body: { into: a.id }, actor: 'admin-1' })).status).toBe(200)
    expect((await pair(a.id, b.id)).results[0].status).toBe('merged')
    expect(row.status).toBe('pending')
  })

  it('every /admin/duplicates route needs the admin scope', async () => {
    for (const token of [KEYS.jm.token, KEYS.read.token]) {
      expect((await get('/admin/duplicates', token)).status).toBe(403)
      expect((await api('POST', '/admin/duplicates/1/dismiss', { token, body: {} })).status).toBe(403)
    }
    expect((await SELF.fetch(`${BASE}/admin/duplicates`)).status).toBe(401)
  })
})

describe('scan cost', () => {
  it('a full-size run (150 masjids) stays inside the free-plan limits (D1 round trips, rows read)', async () => {
    const base = { lat: 3.0, lng: 101.0 }
    const rows: Array<[string, number, number]> = []
    // ~1,000 masjids on a 32 x 32 grid, 700 m apart (a dense urban spread), plus 20 deliberate twins.
    for (let i = 0; i < 1000; i++) {
      const lat = base.lat + Math.floor(i / 32) * 0.0063
      const lng = base.lng + (i % 32) * 0.0063
      rows.push([`Masjid Grid ${i}`, lat, lng])
    }
    for (let i = 0; i < 20; i++) {
      const [name, lat, lng] = rows[i * 40]
      rows.push([name.replace('Masjid', 'Surau'), lat + 0.0003, lng])
    }
    const now = '2026-11-14T00:00:00Z'
    for (let i = 0; i < rows.length; i += 100) {
      await env.DB.batch(rows.slice(i, i + 100).map(([name, lat, lng]) => env.DB
        .prepare(
          `INSERT INTO masjids (name, type_id, lat, lng, geohash, state_id, country_id, updated_at, created_at)
           VALUES (?, 'masjid', ?, ?, ?, 'my-kul', 'my', ?, ?)`,
        )
        .bind(name, lat, lng, ngeohash.encode(lat, lng, 9), now, now)))
    }
    await resetCursor()
    const t0 = Date.now()
    const stats = await runDuplicateScan(env.DB, { maxMasjids: SCAN_MAX_MASJIDS })
    const ms = Date.now() - t0
    console.log('SCAN COST', JSON.stringify({ ...stats, ms, masjids_in_db: rows.length }))

    expect(stats.scanned).toBe(SCAN_MAX_MASJIDS)
    expect(stats.caught_up).toBe(false) // 1,020 masjids: the next runs continue
    expect(stats.completed).toBe(SCAN_MAX_MASJIDS)
    expect(stats.pairs_found).toBeGreaterThanOrEqual(3) // the first four grid masjids have a twin
    // Free plan: 50 subrequests per invocation. State + start mark + select + 6 x (search + write batch) + final state update = 16.
    expect(stats.d1_calls).toBeLessThanOrEqual(20)
    // Each search reads a handful of index entries, not the table.
    expect(stats.rows_read / stats.scanned).toBeLessThan(60)

    let runs = 1
    let caught = false
    while (!caught && runs < 20) {
      caught = (await runDuplicateScan(env.DB)).caught_up
      runs++
    }
    expect(caught).toBe(true)
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM duplicate_candidates').first<{ n: number }>())!.n).toBeGreaterThanOrEqual(10)
  })
})

describe('scan resilience and status (H2)', () => {
  async function bulk(n: number, prefix: string) {
    const lat0 = 4.5
    const now = '2026-11-14T00:00:00Z'
    const stmts = Array.from({ length: n }, (_, i) => {
      const lat = lat0 + Math.floor(i / 20) * 0.01
      const lng = 102.0 + (i % 20) * 0.01
      return env.DB
        .prepare(
          `INSERT INTO masjids (name, type_id, lat, lng, geohash, state_id, country_id, updated_at, created_at)
           VALUES (?, 'masjid', ?, ?, ?, 'my-kul', 'my', ?, ?)`,
        )
        .bind(`${prefix} ${i}`, lat, lng, ngeohash.encode(lat, lng, 9), now, now)
    })
    for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50))
  }

  it('a run that throws mid-way keeps the cursor of the completed batches and records the error', async () => {
    await bulk(130, 'Masjid Resume')
    await resetCursor()
    const ids = (await env.DB.prepare("SELECT id FROM masjids WHERE status = 'active' ORDER BY updated_at, id LIMIT 130").all<{ id: number }>()).results
    // search batch 1, write batch 1, then the second search batch fails
    let batches = 0
    const flaky = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === 'batch') {
          return async (stmts: D1PreparedStatement[]) => {
            if (++batches === 3) throw new Error('D1 exploded')
            return target.batch(stmts)
          }
        }
        const v = Reflect.get(target, prop, target)
        return typeof v === 'function' ? v.bind(target) : v
      },
    })
    await expect(runDuplicateScan(flaky, { maxMasjids: 130 })).rejects.toThrow('D1 exploded')
    const state = await env.DB.prepare('SELECT * FROM scan_state WHERE id = 1').first<Record<string, any>>()
    expect(state!.last_id).toBe(ids[24].id)
    expect(state!.last_run_scanned).toBe(25)
    expect(state!.last_error).toContain('D1 exploded')

    const rest = await runDuplicateScan(env.DB, { maxMasjids: 130 })
    expect(rest.scanned).toBeGreaterThanOrEqual(1)
    expect((await env.DB.prepare('SELECT last_error FROM scan_state WHERE id = 1').first<{ last_error: string | null }>())!.last_error).toBeNull()
  })

  it('GET /admin/scan reports the cursor, the last run and the masjids remaining (admin only)', async () => {
    await resetCursor()
    const total = (await env.DB.prepare("SELECT COUNT(*) AS n FROM masjids WHERE status = 'active'").first<{ n: number }>())!.n
    const before = await (await get('/admin/scan')).json() as Record<string, any>
    expect(before).toMatchObject({ last_run_at: null, last_error: null, masjids_remaining: total, max_masjids_per_run: SCAN_MAX_MASJIDS })
    await runDuplicateScan(env.DB, { maxMasjids: 10 })
    const after = await (await get('/admin/scan')).json() as Record<string, any>
    expect(after.last_run_scanned).toBe(10)
    expect(after.masjids_remaining).toBe(total - 10)
    expect(after.last_run_at).toBeTruthy()
    expect(after.cursor.id).toBeGreaterThan(0)
    for (const token of [KEYS.jm.token, KEYS.read.token]) expect((await get('/admin/scan', token)).status).toBe(403)
  })
})

describe('scan stall visibility and poisoned-batch skip', () => {
  const row = () => env.DB.prepare('SELECT * FROM scan_state WHERE id = 1').first<Record<string, any>>()
  const status = async () => (await (await get('/admin/scan')).json()) as Record<string, any>

  async function bulkPoison(n: number) {
    const now = '2026-11-14T00:00:00Z'
    for (let i = 0; i < n; i += 50) {
      await env.DB.batch(Array.from({ length: Math.min(50, n - i) }, (_, k) => {
        const j = i + k
        const lat = 3.0 + Math.floor(j / 20) * 0.01
        const lng = 101.0 + (j % 20) * 0.01
        return env.DB
          .prepare(
            `INSERT INTO masjids (name, type_id, lat, lng, geohash, state_id, country_id, updated_at, created_at)
             VALUES (?, 'masjid', ?, ?, ?, 'my-kul', 'my', ?, ?)`,
          )
          .bind(`Poison Test ${j}`, lat, lng, ngeohash.encode(lat, lng, 9), now, now)
      }))
    }
  }

  /** A DB whose search statements throw when they involve `badLat`. */
  function poisonedDb(badLat: number) {
    return new Proxy(env.DB, {
      get(target, prop) {
        if (prop === 'prepare') {
          return (sql: string) => {
            const st = target.prepare(sql)
            const bind = st.bind.bind(st)
            ;(st as any).bind = (...args: unknown[]) => {
              const bound = bind(...args)
              ;(bound as any).__args = args
              return bound
            }
            return st
          }
        }
        if (prop === 'batch') {
          return async (stmts: any[]) => {
            // search statements bind the lat/lng window around the masjid: poison the one that encloses badLat
            const hits = (s: any) => {
              const nums = ((s.__args ?? []) as unknown[]).filter((a): a is number => typeof a === 'number')
              return nums.some(a => a < badLat && badLat - a < 0.01) && nums.some(a => a > badLat && a - badLat < 0.01)
            }
            if (stmts.some(hits)) {
              throw new Error('poisoned row')
            }
            return target.batch(stmts)
          }
        }
        const v = Reflect.get(target, prop, target)
        return typeof v === 'function' ? v.bind(target) : v
      },
    })
  }

  it('a killed run (start written, never finished) shows as stalled once it is older than 15 minutes', async () => {
    await resetCursor()
    const start = new Date('2026-11-14T10:00:00Z')
    await env.DB.prepare("UPDATE scan_state SET last_run_at = ?, last_error = 'running' WHERE id = 1").bind('2026-11-14T10:00:00Z').run()
    expect((await scanStatus(env.DB, new Date(start.getTime() + 5 * 60_000))).stalled).toBe(false)
    const late = await scanStatus(env.DB, new Date(start.getTime() + 16 * 60_000))
    expect(late).toMatchObject({ stalled: true, last_error: 'running', last_run_at: '2026-11-14T10:00:00Z' })
    // a real run replaces it and is not stalled
    await runDuplicateScan(env.DB, { maxMasjids: 5 })
    expect(await status()).toMatchObject({ stalled: false, last_error: null })
    expect((await status()).consecutive_failures).toBe(0)
  })

  it('a run writes last_error = running with its start time before doing any work', async () => {
    await resetCursor()
    const t = new Date('2026-11-14T12:00:00Z')
    let seen: Record<string, any> | null = null
    const spy = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === 'batch') {
          return async (stmts: D1PreparedStatement[]) => {
            seen ??= await row()
            return target.batch(stmts)
          }
        }
        const v = Reflect.get(target, prop, target)
        return typeof v === 'function' ? v.bind(target) : v
      },
    })
    await runDuplicateScan(spy, { now: t, maxMasjids: 3 })
    expect(seen).toMatchObject({ last_error: 'running', last_run_at: '2026-11-14T12:00:00Z' })
  })

  it('three failing runs on one batch: the next run skips the poisoned masjid, records it, scans the rest, counter resets', async () => {
    await bulkPoison(40)
    const ids = (await env.DB.prepare("SELECT id, lat FROM masjids WHERE name LIKE 'Poison Test %' ORDER BY updated_at, id").all<{ id: number; lat: number }>()).results
    await resetCursor()
    await env.DB.prepare("UPDATE scan_state SET last_updated_at = '2026-11-14T00:00:00Z', last_id = ? WHERE id = 1").bind(ids[0].id - 1).run()
    const bad = ids[7]
    // the poisoned masjid shares its lat with 19 others in the same row; make it unique
    await env.DB.prepare('UPDATE masjids SET lat = lat + 0.005 WHERE id = ?').bind(bad.id).run()
    const badLat = (await env.DB.prepare('SELECT lat FROM masjids WHERE id = ?').bind(bad.id).first<{ lat: number }>())!.lat
    const poisoned = poisonedDb(badLat)

    for (let n = 1; n <= 3; n++) {
      await expect(runDuplicateScan(poisoned, { maxMasjids: 40 })).rejects.toThrow('poisoned row')
      expect((await row())!.consecutive_failures).toBe(n)
      expect((await row())!.last_id).toBe(ids[0].id - 1) // cursor never moved
    }
    expect(await status()).toMatchObject({ consecutive_failures: 3, skipped_ids: [] })

    const stats = await runDuplicateScan(poisoned, { maxMasjids: 40 })
    expect(stats.skipped).toBe(1)
    const after = await status()
    expect(after.skipped_ids).toEqual([bad.id])
    expect(after.consecutive_failures).toBe(0)
    expect(after.last_error).toBeNull()
    expect(after.stalled).toBe(false)
    // single mode covered the first SCAN_SINGLE_MAX masjids, including the ones around the poisoned one
    expect(stats.scanned).toBe(20)
    expect(stats.completed).toBe(20)
    expect(after.cursor.id).toBe(ids[19].id)

    // the rest is scanned normally afterwards, never revisiting the skipped masjid
    const rest = await runDuplicateScan(poisoned, { maxMasjids: 20 })
    expect(rest.scanned).toBe(20)
    expect(rest.skipped).toBe(0)
    expect((await status()).cursor.id).toBe(ids[39].id)
    expect((await status()).skipped_ids).toEqual([bad.id])
    expect(SCAN_BATCH).toBe(25)
  })

  it('the skipped list is capped at 100 (newest kept)', async () => {
    await resetCursor()
    const old = Array.from({ length: 100 }, (_, i) => i + 1)
    await env.DB.prepare('UPDATE scan_state SET skipped_ids = ?, consecutive_failures = 3 WHERE id = 1').bind(JSON.stringify(old)).run()
    const m = await mk(70, 'Masjid Skip Cap')
    const poisoned = poisonedDb(m.lat)
    const mrow = (await env.DB.prepare('SELECT updated_at FROM masjids WHERE id = ?').bind(m.id).first<{ updated_at: string }>())!
    await env.DB.prepare('UPDATE scan_state SET last_updated_at = ?, last_id = ? WHERE id = 1').bind(mrow.updated_at, m.id - 1).run()
    await runDuplicateScan(poisoned, { maxMasjids: 5 })
    const list = (await status()).skipped_ids as number[]
    expect(list).toHaveLength(100)
    expect(list.at(-1)).toBe(m.id)
    expect(list[0]).toBe(2)
  })
})
