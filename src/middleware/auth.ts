// Auth middleware — Bearer token validation against D1 api_keys table.
// Applied only to write routes (POST, PATCH). GET routes remain unauthenticated.

import { bearerAuth } from 'hono/bearer-auth'
import { createMiddleware } from 'hono/factory'
import type { Context } from 'hono'

// ─── SHA-256 helper ───────────────────────────────────────────────────────────

async function hashToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  return [...new Uint8Array(hashBuffer)]
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

// ─── Auth middleware ──────────────────────────────────────────────────────────

export const authMiddleware = createMiddleware<{ Bindings: CloudflareBindings }>(
  async (c, next) => {
    const env = c.env
    const auth = bearerAuth({
      verifyToken: async (token, _ctx: Context) => {
        const hash = await hashToken(token)
        const row = await env.DB
          .prepare('SELECT id FROM api_keys WHERE key_hash = ? AND is_active = 1')
          .bind(hash)
          .first()
        return row !== null
      },
      noAuthenticationHeader:      { message: { error: 'Unauthorized' } },
      invalidAuthenticationHeader: { message: { error: 'Unauthorized' } },
      invalidToken:                { message: { error: 'Unauthorized' } },
    })
    return auth(c as unknown as Context, next)
  }
)
