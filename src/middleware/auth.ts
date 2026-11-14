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
  Variables: { key: AuthKey }
}

// ─── SHA-256 helper ───────────────────────────────────────────────────────────

export async function hashToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  return [...new Uint8Array(hashBuffer)]
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

const PUBLIC_PATHS = new Set(['/', '/openapi.json'])

// ─── Auth middleware ──────────────────────────────────────────────────────────

export const authMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  if (c.req.method === 'GET' && PUBLIC_PATHS.has(c.req.path)) return next()

  const header = c.req.header('Authorization') ?? ''
  const match = /^Bearer\s+(\S+)$/i.exec(header)
  if (!match) throw new ApiError(401, 'unauthorized', 'Missing or invalid API key')

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

/**
 * Guard for every mutating request outside /admin (admin routes require the
 * `admin` scope via requireScope('admin') in their own router).
 * Needs the `write` scope, a key with an app_id, and X-Sentral-Actor (1-128 chars).
 */
export const writeGuard = createMiddleware<AppEnv>(async (c, next) => {
  if (!MUTATING.has(c.req.method)) return next()
  if (c.req.path === '/admin' || c.req.path.startsWith('/admin/')) return next()

  const key = c.get('key')
  if (!key.scopes.includes('write')) {
    throw new ApiError(403, 'forbidden', "API key lacks the 'write' scope", { required_scope: 'write' })
  }
  if (!key.app_id) {
    throw new ApiError(403, 'forbidden', 'API key has no app_id; it cannot write')
  }
  const actor = c.req.header('X-Sentral-Actor')
  if (actor === undefined || actor.length < 1 || actor.length > 128) {
    throw new ApiError(422, 'validation_failed', 'X-Sentral-Actor header is required (1-128 characters)', {
      field: 'X-Sentral-Actor',
    })
  }
  return next()
})

/** The validated actor for the current write. Only call after writeGuard. */
export function getActor(c: { req: { header(name: string): string | undefined } }): string {
  return c.req.header('X-Sentral-Actor') as string
}
