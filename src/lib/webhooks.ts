// Webhooks (spec 3.3): thin "changes.available" pings, HMAC-signed, retried with backoff.

import { isoNow } from './time'

/** Retry delays after failed attempt 1..5 (contract section 7): 1 m, 5 m, 30 m, 2 h, 6 h, then dropped. */
export const BACKOFF_SECONDS = [60, 5 * 60, 30 * 60, 2 * 3600, 6 * 3600] as const

/** Free plan: 50 subrequests per invocation; keep headroom for the D1 calls. */
const BATCH_LIMIT = 40
const LEASE_SECONDS = 120
const TIMEOUT_MS = 5000

/** After `attempts` failed attempts: seconds until the next try, or null when the delivery is dropped. */
export function backoffSeconds(attempts: number): number | null {
  return attempts >= 1 && attempts <= BACKOFF_SECONDS.length ? BACKOFF_SECONDS[attempts - 1] : null
}

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)))
}

/** `t=<unix>,v1=<hex HMAC-SHA256(secret, t + "." + body)>` */
export async function signPayload(secret: string, body: string, unixSeconds: number): Promise<string> {
  return `t=${unixSeconds},v1=${await hmacHex(secret, `${unixSeconds}.${body}`)}`
}

/** Receiver-side check (what clients implement): constant-time compare and a 300 s clock window. */
export async function verifySignature(
  header: string | null,
  secret: string,
  rawBody: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
  toleranceSeconds = 300,
): Promise<boolean> {
  if (!header) return false
  const parts = Object.fromEntries(header.split(',').map(p => p.trim().split('=') as [string, string]))
  const t = Number(parts.t)
  if (!Number.isInteger(t) || typeof parts.v1 !== 'string') return false
  if (Math.abs(nowSeconds - t) > toleranceSeconds) return false
  const expected = await hmacHex(secret, `${t}.${rawBody}`)
  if (expected.length !== parts.v1.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ parts.v1.charCodeAt(i)
  return diff === 0
}

export function newSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return 'whsec_' + hex(bytes.buffer)
}

interface DueRow {
  subscription_id: number
  latest_seq: number
  attempts: number
  url: string
  secret: string
}

export interface DispatchOptions {
  fetchFn?: typeof fetch
  now?: Date
  limit?: number
}

export interface DispatchSummary {
  claimed: number
  delivered: number
  failed: number
  dropped: number
}

/**
 * Sends every due ping (status pending, next_attempt_at reached). Rows are leased (next_attempt_at pushed out)
 * before sending so the cron and a waitUntil dispatch never send the same ping twice. A result only applies
 * while latest_seq is unchanged: a newer change resets the row to pending and is sent next time. A failure counts regardless of newer changes
 * (the endpoint is down either way), so steady writes cannot keep a dead endpoint from backing off and dropping.
 */
export async function dispatchDue(db: D1Database, opts: DispatchOptions = {}): Promise<DispatchSummary> {
  const fetchFn = opts.fetchFn ?? fetch
  const now = opts.now ?? new Date()
  const nowIso = isoNow(now)
  const leaseIso = isoNow(new Date(now.getTime() + LEASE_SECONDS * 1000))

  const claimed = await db
    .prepare(
      `UPDATE webhook_deliveries SET next_attempt_at = ?
       WHERE subscription_id IN (
         SELECT d.subscription_id FROM webhook_deliveries d
         JOIN webhook_subscriptions s ON s.id = d.subscription_id
         JOIN api_keys k ON k.id = s.api_key_id
         WHERE d.status = 'pending' AND d.next_attempt_at <= ? AND s.active = 1
           AND k.is_active = 1 AND k.revoked_at IS NULL
         ORDER BY d.next_attempt_at LIMIT ?)
       RETURNING subscription_id, latest_seq, attempts`,
    )
    .bind(leaseIso, nowIso, opts.limit ?? BATCH_LIMIT)
    .run<{ subscription_id: number; latest_seq: number; attempts: number }>()
  if (claimed.results.length === 0) return { claimed: 0, delivered: 0, failed: 0, dropped: 0 }

  const ids = claimed.results.map(r => r.subscription_id)
  const subs = await db
    .prepare(`SELECT id, url, secret FROM webhook_subscriptions WHERE id IN (${ids.map(() => '?').join(',')})`)
    .bind(...ids)
    .run<{ id: number; url: string; secret: string }>()
  const subById = new Map(subs.results.map(s => [s.id, s]))

  const due: DueRow[] = claimed.results.flatMap(r => {
    const s = subById.get(r.subscription_id)
    return s ? [{ ...r, url: s.url, secret: s.secret }] : []
  })

  const summary: DispatchSummary = { claimed: due.length, delivered: 0, failed: 0, dropped: 0 }
  const updates: D1PreparedStatement[] = []

  await Promise.all(due.map(async (row) => {
    const body = JSON.stringify({ type: 'changes.available', latest_seq: row.latest_seq })
    let error: string | null = null
    try {
      const res = await fetchFn(row.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Sentral-Signature': await signPayload(row.secret, body, Math.floor(now.getTime() / 1000)),
          'X-Sentral-Delivery': `dlv_${crypto.randomUUID().replace(/-/g, '')}`,
        },
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (!(res.status >= 200 && res.status < 300)) error = `HTTP ${res.status}`
      await res.body?.cancel().catch(() => {})
    } catch (e) {
      error = e instanceof Error ? e.message.slice(0, 200) : 'request failed'
    }

    if (error === null) {
      summary.delivered++
      updates.push(
        db.prepare(
          `UPDATE webhook_deliveries SET status = 'delivered', last_error = NULL, updated_at = ?
           WHERE subscription_id = ? AND latest_seq = ?`,
        ).bind(nowIso, row.subscription_id, row.latest_seq),
      )
      return
    }
    const attempts = row.attempts + 1
    const delay = backoffSeconds(attempts)
    if (delay === null) {
      summary.dropped++
      updates.push(
        db.prepare(
          `UPDATE webhook_deliveries SET status = 'dropped', attempts = ?, last_error = ?, updated_at = ?
           WHERE subscription_id = ? AND status = 'pending'`,
        ).bind(attempts, error, nowIso, row.subscription_id),
      )
    } else {
      summary.failed++
      updates.push(
        db.prepare(
          `UPDATE webhook_deliveries SET attempts = ?, next_attempt_at = ?, last_error = ?, updated_at = ?
           WHERE subscription_id = ? AND status = 'pending'`,
        ).bind(attempts, isoNow(new Date(now.getTime() + delay * 1000)), error, nowIso, row.subscription_id),
      )
    }
  }))

  if (updates.length) await db.batch(updates)
  return summary
}

/** Deletes idempotency rows older than 24 h. */
export async function purgeIdempotency(db: D1Database, now: Date = new Date()): Promise<void> {
  await db
    .prepare('DELETE FROM idempotency_keys WHERE created_at < ?')
    .bind(isoNow(new Date(now.getTime() - 24 * 3600 * 1000)))
    .run()
}
