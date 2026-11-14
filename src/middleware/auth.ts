// Auth middleware — Bearer API key validation against the D1 api_keys table.
// Every route needs a key (contract R1), reads included, except GET / and GET /openapi.json.

import { createMiddleware } from 'hono/factory'
import { ApiError } from '../lib/errors'

export type Scope = 'read' | 'write' | 'webhook' | 'admin'

export interface AuthKey {
  id: number
  app_id: string | null
  scopes: string[]
}

export type AppEnv = {
  Bindings: CloudflareBindings
  Variables: { key: AuthKey; actor?: string }
}

// ─── SHA-256 helper ───────────────────────────────────────────────────────────

export async function hashToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  return [...new Uint8Array(hashBuffer)]
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

// Issued token format (scripts/issue-key.mjs): ms_live_ + base64url of 32 random bytes (43 chars).
// Anything else is rejected without a D1 query.
export const TOKEN_FORMAT = /^ms_live_[A-Za-z0-9_-]{43}$/

const PUBLIC_PATHS = new Set(['/', '/openapi.json'])

// ─── Auth middleware ──────────────────────────────────────────────────────────

export const authMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  if (c.req.method === 'GET' && PUBLIC_PATHS.has(c.req.path)) return next()

  const header = c.req.header('Authorization') ?? ''
  const match = /^Bearer\s+(\S+)$/i.exec(header)
  if (!match || !TOKEN_FORMAT.test(match[1])) throw new ApiError(401, 'unauthorized', 'Missing or invalid API key')

  const hash = await hashToken(match[1])
  const row = await c.env.DB
    .prepare(
      `SELECT id, app_id, scopes FROM api_keys
       WHERE key_hash = ? AND is_active = 1 AND revoked_at IS NULL`
    )
    .bind(hash)
    .first<{ id: number; app_id: string | null; scopes: string }>()
  if (!row) throw new ApiError(401, 'unauthorized', 'Missing or invalid API key')

  c.set('key', {
    id: row.id,
    app_id: row.app_id,
    scopes: row.scopes.split(',').map(s => s.trim()).filter(Boolean),
  })
  return next()
})

// ─── Scopes ───────────────────────────────────────────────────────────────────

export function requireScope(scope: Scope) {
  return createMiddleware<AppEnv>(async (c, next) => {
    if (!c.get('key').scopes.includes(scope)) {
      throw new ApiError(403, 'forbidden', `API key lacks the '${scope}' scope`, { required_scope: scope })
    }
    return next()
  })
}

const MUTATING = new Set(['POST', 'PATCH', 'PUT', 'DELETE'])
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/

function validateActor(raw: string | undefined): string {
  const actor = raw?.trim() ?? ''
  if (actor.length < 1 || actor.length > 128 || CONTROL_CHARS.test(actor)) {
    throw new ApiError(
      422, 'validation_failed',
      'X-Sentral-Actor header is required (1-128 characters, no control characters)',
      { field: 'X-Sentral-Actor' },
    )
  }
  return actor
}

/**
 * Guard for every mutating request. Always needs a valid X-Sentral-Actor.
 * Outside /admin it also needs the `write` scope and a key with an app_id
 * (admin routes get their scope check from requireScope('admin') in index.ts).
 */
export const writeGuard = createMiddleware<AppEnv>(async (c, next) => {
  if (!MUTATING.has(c.req.method)) return next()
  const isAdmin = c.req.path === '/admin' || c.req.path.startsWith('/admin/')

  if (!isAdmin) {
    const key = c.get('key')
    if (!key.scopes.includes('write')) {
      throw new ApiError(403, 'forbidden', "API key lacks the 'write' scope", { required_scope: 'write' })
    }
    if (!key.app_id) {
      throw new ApiError(403, 'forbidden', 'API key has no app_id; it cannot write')
    }
  }
  c.set('actor', validateActor(c.req.header('X-Sentral-Actor')))
  return next()
})

/** The validated actor for the current write. Throws (500) if writeGuard did not run. */
export function getActor(c: { get(name: 'actor'): string | undefined }): string {
  const actor = c.get('actor')
  if (!actor) throw new Error('getActor() called without a validated actor (writeGuard missing)')
  return actor
}
