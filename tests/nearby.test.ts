import { describe, it, expect } from 'vitest'
import { SELF } from 'cloudflare:test'

// Integration tests for GET /masjids/nearby (APIREAD-07)

describe('GET /masjids/nearby', () => {
  it('returns within-radius rows for valid lat/lng/radius (APIREAD-07)', async () => {
    // Kuala Lumpur coordinates
    const response = await SELF.fetch('http://example.com/masjids/nearby?lat=3.1412&lng=101.6865&radius=5')
    expect(response.status).toBe(200)
    const body = await response.json() as {
      data: unknown[]
      meta: { total: number; page: number; per_page: number }
    }
    expect(Array.isArray(body.data)).toBe(true)
    expect(typeof body.meta).toBe('object')
  })

  it('returns 400 with { error } when radius > 20 (APIREAD-07)', async () => {
    const response = await SELF.fetch('http://example.com/masjids/nearby?lat=3.1&lng=101.7&radius=25')
    expect(response.status).toBe(400)
    const body = await response.json() as { error: string }
    expect(typeof body.error).toBe('string')
    expect(body.error.length).toBeGreaterThan(0)
  })

  it('returns 400 with { error } when lat/lng are missing', async () => {
    const response = await SELF.fetch('http://example.com/masjids/nearby')
    expect(response.status).toBe(400)
    const body = await response.json() as { error: string }
    expect(typeof body.error).toBe('string')
    expect(body.error.length).toBeGreaterThan(0)
  })

  it('returns 400 with { error } when lat is missing', async () => {
    const response = await SELF.fetch('http://example.com/masjids/nearby?lng=101.7')
    expect(response.status).toBe(400)
    const body = await response.json() as { error: string }
    expect(typeof body.error).toBe('string')
  })
})
