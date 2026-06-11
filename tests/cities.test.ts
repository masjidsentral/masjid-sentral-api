import { describe, it, expect } from 'vitest'
import { SELF } from 'cloudflare:test'

// Integration tests for GET /cities (APIREF-03)

describe('GET /cities', () => {
  it('returns 200 with array when ?state=my-sgr is provided (APIREF-03)', async () => {
    const response = await SELF.fetch('http://example.com/cities?state=my-sgr')
    expect(response.status).toBe(200)
    const body = await response.json() as { data: unknown[] }
    expect(Array.isArray(body.data)).toBe(true)
  })

  it('returns 400 with { error } when no state param is provided (APIREF-03)', async () => {
    const response = await SELF.fetch('http://example.com/cities')
    expect(response.status).toBe(400)
    const body = await response.json() as { error: string }
    expect(typeof body.error).toBe('string')
    expect(body.error.length).toBeGreaterThan(0)
  })
})
