// Test helpers: seeded API keys and request builders.
// Keys are inserted by tests/setup.ts after migrations (migration 003 removes the dev key).

/** Test token in the issued format: ms_live_ + 43 base64url chars. */
export function tok(name: string): string {
  return 'ms_live_' + name.padEnd(43, '_')
}

export const KEYS = {
  read:    { token: tok('read'),    app_id: null,           scopes: 'read' },
  jm:      { token: tok('jm'),      app_id: 'jejak_masjid', scopes: 'read,write' },
  qiyam:   { token: tok('qiyam'),   app_id: 'qiyam',        scopes: 'read,write' },
  webhook: { token: tok('webhook'), app_id: 'qiyam_hooks',  scopes: 'read,write,webhook' },
  admin:   { token: tok('admin'),   app_id: 'sentral_admin', scopes: 'admin' },
} as const

export const DEV_KEY_TOKEN = 'test-api-key-dev'

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
}

export function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` }
}

/** Headers for a read request. */
export const readHeaders = () => bearer(KEYS.read.token)

/** Headers for a write request from the JM key, with an actor. */
export function writeHeaders(
  token: string = KEYS.jm.token,
  actor = 'user-1',
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    ...bearer(token),
    'Content-Type': 'application/json',
    'X-Sentral-Actor': actor,
    'Idempotency-Key': crypto.randomUUID(),
    ...extra,
  }
}

// ─── S2 helpers ──────────────────────────────────────────────────────────────

export const BASE = 'http://example.com'

export const MASJID_BODY = {
  name: 'Masjid Sync Test',
  type_id: 'masjid',
  state_id: 'my-kul',
  country_id: 'my',
  lat: 3.147123456,
  lng: 101.698123456,
  address: '1 Jalan Sync',
}

export interface MasjidJson {
  id: number
  version: number
  name: string
  images: Array<{ url: string; is_thumbnail: boolean; sort_order: number }>
  [k: string]: unknown
}

/** Create a masjid through the API and return the entity. */
export async function createMasjid(overrides: Record<string, unknown> = {}, token: string = KEYS.jm.token): Promise<MasjidJson> {
  const { SELF } = await import('cloudflare:test')
  const res = await SELF.fetch(`${BASE}/masjids`, {
    method: 'POST',
    headers: writeHeaders(token),
    body: JSON.stringify({ ...MASJID_BODY, ...overrides }),
  })
  if (res.status !== 201) throw new Error(`createMasjid failed: ${res.status} ${await res.text()}`)
  return res.json() as Promise<MasjidJson>
}

export async function patchMasjid(
  id: number,
  version: number | string | null,
  body: Record<string, unknown>,
  opts: { token?: string; idemKey?: string } = {},
): Promise<Response> {
  const { SELF } = await import('cloudflare:test')
  const extra: Record<string, string> = {}
  if (version !== null) extra['If-Match'] = String(version)
  if (opts.idemKey) extra['Idempotency-Key'] = opts.idemKey
  return SELF.fetch(`${BASE}/masjids/${id}`, {
    method: 'PATCH',
    headers: writeHeaders(opts.token ?? KEYS.jm.token, 'user-1', extra),
    body: JSON.stringify(body),
  })
}

export async function getMasjid(id: number): Promise<MasjidJson> {
  const { SELF } = await import('cloudflare:test')
  const res = await SELF.fetch(`${BASE}/masjids/${id}`, { headers: readHeaders() })
  return res.json() as Promise<MasjidJson>
}
