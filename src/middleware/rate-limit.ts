// Rate limit: 600 requests/minute per key id (contract §1) via the Workers Rate Limiting binding.
// The limiter is resolved through `getLimiter` so tests can stub it.

import { createMiddleware } from 'hono/factory'
import { ApiError } from '../lib/errors'
import type { AppEnv } from './auth'

export interface Limiter {
  limit(options: { key: string }): Promise<{ success: boolean }>
}

// Matches the wrangler `ratelimits` period (60 s window).
export const RETRY_AFTER_SECONDS = 60

let warned = false

export function createRateLimit(getLimiter: (env: CloudflareBindings) => Limiter | undefined) {
  return createMiddleware<AppEnv>(async (c, next) => {
    // No key = public path (auth has already rejected everything else).
    const key = c.get('key')
    const limiter = getLimiter(c.env)
    if (!limiter && !warned) {
      warned = true
      console.warn('RATE_LIMITER binding is missing: rate limiting is DISABLED')
    }
    if (key && limiter) {
      const { success } = await limiter.limit({ key: `key:${key.id}` })
      if (!success) {
        throw new ApiError(429, 'rate_limited', 'Rate limit exceeded (600 requests per minute)', undefined, {
          'Retry-After': String(RETRY_AFTER_SECONDS),
        })
      }
    }
    return next()
  })
}

export const rateLimitMiddleware = createRateLimit(env => env.RATE_LIMITER)
