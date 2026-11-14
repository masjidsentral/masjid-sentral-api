// Test helpers: seeded API keys and request builders.
// Keys are inserted by tests/setup.ts after migrations (migration 003 removes the dev key).

export const KEYS = {
  read:    { token: 'test-key-read',    app_id: null,           scopes: 'read' },
  jm:      { token: 'test-key-jm',      app_id: 'jejak_masjid', scopes: 'read,write' },
  qiyam:   { token: 'test-key-qiyam',   app_id: 'qiyam',        scopes: 'read,write' },
  webhook: { token: 'test-key-webhook', app_id: 'qiyam_hooks',  scopes: 'read,write,webhook' },
  admin:   { token: 'test-key-admin',   app_id: 'sentral_admin', scopes: 'admin' },
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
export function writeHeaders(token: string = KEYS.jm.token, actor = 'user-1'): Record<string, string> {
  return { ...bearer(token), 'Content-Type': 'application/json', 'X-Sentral-Actor': actor }
}
