import { describe, it, expect } from 'vitest'
import { SELF } from 'cloudflare:test'
import { readHeaders } from './helpers'

// Integration tests for GET /states (APIREF-01, APIREF-02)

describe('GET /states', () => {
  it('returns 200 with array of states (APIREF-01)', async () => {
    const response = await SELF.fetch('http://example.com/states', { headers: readHeaders() })
    expect(response.status).toBe(200)
    const body = await response.json() as { data: unknown[] }
    expect(Array.isArray(body.data)).toBe(true)
  })

  it('filters states by country when ?country=MY is provided (APIREF-02)', async () => {
    const response = await SELF.fetch('http://example.com/states?country=MY', { headers: readHeaders() })
    expect(response.status).toBe(200)
    const body = await response.json() as { data: Array<{ country_id: string }> }
    expect(Array.isArray(body.data)).toBe(true)
    // All returned states should belong to country 'my' (lowercased)
    for (const state of body.data) {
      expect(state.country_id).toBe('my')
    }
  })
})
