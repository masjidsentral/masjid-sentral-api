import { describe, it, expect } from 'vitest'
import { SELF } from 'cloudflare:test'
import { readHeaders } from './helpers'

// Integration tests for GET /masjids/nearby (APIREAD-07)

describe('GET /masjids/nearby', () => {
  it('returns within-radius rows for valid lat/lng/radius (APIREAD-07)', async () => {
    // Kuala Lumpur coordinates
    const response = await SELF.fetch('http://example.com/masjids/nearby?lat=3.1412&lng=101.6865&radius=5000', { headers: readHeaders() })
    expect(response.status).toBe(200)
    const body = await response.json() as {
      data: unknown[]
      next_cursor: string | null
    }
    expect(Array.isArray(body.data)).toBe(true)
    expect('next_cursor' in body).toBe(true)
  })

  it('returns 422 with { error } when radius > 20000 m (APIREAD-07)', async () => {
    const response = await SELF.fetch('http://example.com/masjids/nearby?lat=3.1&lng=101.7&radius=25000', { headers: readHeaders() })
    expect(response.status).toBe(422)
    const body = await response.json() as { error: string }
    expect(typeof body.error).toBe('string')
    expect(body.error.length).toBeGreaterThan(0)
  })

  it('returns 422 with { error } when lat/lng are missing', async () => {
    const response = await SELF.fetch('http://example.com/masjids/nearby', { headers: readHeaders() })
    expect(response.status).toBe(422)
    const body = await response.json() as { error: string }
    expect(typeof body.error).toBe('string')
    expect(body.error.length).toBeGreaterThan(0)
  })

  it('returns 422 with { error } when lat is missing', async () => {
    const response = await SELF.fetch('http://example.com/masjids/nearby?lng=101.7', { headers: readHeaders() })
    expect(response.status).toBe(422)
    const body = await response.json() as { error: string }
    expect(typeof body.error).toBe('string')
  })
})
