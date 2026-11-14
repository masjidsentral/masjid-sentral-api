import { describe, it, expect } from 'vitest'
import { SELF } from 'cloudflare:test'

describe('GET /openapi.json', () => {
  it('returns 200 with application/json content-type', async () => {
    const response = await SELF.fetch('http://example.com/openapi.json')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')
  })

  it('is public: needs no API key and emits no CORS header', async () => {
    const response = await SELF.fetch('http://example.com/openapi.json')
    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('parsed body has openapi === "3.1.0"', async () => {
    const response = await SELF.fetch('http://example.com/openapi.json')
    const body = await response.json() as { openapi: string }
    expect(body.openapi).toBe('3.1.0')
  })
})
