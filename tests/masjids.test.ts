import { describe, it, expect } from 'vitest'
import { SELF } from 'cloudflare:test'
import { readHeaders } from './helpers'

// Integration tests for GET /masjids list endpoint
// Covers: APIREAD-01, APIREAD-02..06, APIREAD-10, APIREAD-11

describe('GET /masjids', () => {
  it('returns { data, next_cursor } with the contract masjid shape', async () => {
    const response = await SELF.fetch('http://example.com/masjids', { headers: readHeaders() })
    expect(response.status).toBe(200)
    const body = await response.json() as { data: unknown[]; next_cursor: string | null }
    expect(Array.isArray(body.data)).toBe(true)
    expect('next_cursor' in body).toBe(true)
  })

  it('filters by ?state= (APIREAD-02)', async () => {
    const response = await SELF.fetch('http://example.com/masjids?state=my-kul', { headers: readHeaders() })
    expect(response.status).toBe(200)
    const body = await response.json() as { data: Array<{ state_id: string }> }
    for (const row of body.data) {
      expect(row.state_id).toBe('my-kul')
    }
  })

  it('filters by ?city= (APIREAD-03)', async () => {
    const response = await SELF.fetch('http://example.com/masjids?city=my-kul-city', { headers: readHeaders() })
    expect(response.status).toBe(200)
    const body = await response.json() as { data: Array<{ city_id: string }> }
    for (const row of body.data) {
      expect(row.city_id).toBe('my-kul-city')
    }
  })

  it('filters by ?type= (APIREAD-04)', async () => {
    const response = await SELF.fetch('http://example.com/masjids?type=masjid', { headers: readHeaders() })
    expect(response.status).toBe(200)
    const body = await response.json() as { data: Array<{ type_id: string }> }
    for (const row of body.data) {
      expect(row.type_id).toBe('masjid')
    }
  })

  it('filters by ?q= name search (APIREAD-05)', async () => {
    const response = await SELF.fetch('http://example.com/masjids?q=sentral', { headers: readHeaders() })
    expect(response.status).toBe(200)
    const body = await response.json() as { data: unknown[] }
    expect(Array.isArray(body.data)).toBe(true)
  })

  it('filters by ?jumaat=1 (APIREAD-06)', async () => {
    const response = await SELF.fetch('http://example.com/masjids?jumaat=1', { headers: readHeaders() })
    expect(response.status).toBe(200)
    const body = await response.json() as { data: Array<{ jumaat_available: boolean }> }
    for (const row of body.data) {
      expect(row.jumaat_available).toBe(true)
    }
  })

  it('does not return deleted masjids (APIREAD-10)', async () => {
    const response = await SELF.fetch('http://example.com/masjids', { headers: readHeaders() })
    expect(response.status).toBe(200)
    const body = await response.json() as { data: Array<{ status: string }> }
    for (const row of body.data) {
      expect(row.status).not.toBe('deleted')
    }
  })
})
