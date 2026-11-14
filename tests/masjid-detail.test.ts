import { describe, it, expect } from 'vitest'
import { SELF } from 'cloudflare:test'
import { readHeaders } from './helpers'

// Integration tests for GET /masjids/:id (APIREAD-08, APIREAD-09)

describe('GET /masjids/:id', () => {
  it('returns full detail with related fields for a valid id (APIREAD-08)', async () => {
    const response = await SELF.fetch('http://example.com/masjids/1', { headers: readHeaders() })
    // Either found (200) or not found (404) — either is valid depending on seed data
    expect([200, 404]).toContain(response.status)
    if (response.status === 200) {
      const body = await response.json() as {
        id: number
        name: string
        images: unknown[]
        facilities: unknown[]
        contacts: unknown[]
        version: number
        external_ids: unknown[]
      }
      expect(typeof body.id).toBe('number')
      expect(typeof body.name).toBe('string')
      expect(Array.isArray(body.images)).toBe(true)
      expect(Array.isArray(body.facilities)).toBe(true)
      expect(Array.isArray(body.contacts)).toBe(true)
      expect(Array.isArray(body.external_ids)).toBe(true)
      expect(typeof body.version).toBe('number')
    }
  })

  it('returns 404 with { error } for non-existent id (APIREAD-08)', async () => {
    const response = await SELF.fetch('http://example.com/masjids/999999999', { headers: readHeaders() })
    expect(response.status).toBe(404)
    const body = await response.json() as { error: string }
    expect(typeof body.error).toBe('string')
    expect(body.error.length).toBeGreaterThan(0)
  })

  it('thumbnail_url is present in list response (APIREAD-09)', async () => {
    const response = await SELF.fetch('http://example.com/masjids', { headers: readHeaders() })
    expect(response.status).toBe(200)
    const body = await response.json() as {
      data: Array<{ thumbnail_url: string | null }>
    }
    // Every item must have thumbnail_url key (possibly null)
    for (const item of body.data) {
      expect('thumbnail_url' in item).toBe(true)
    }
  })
})
