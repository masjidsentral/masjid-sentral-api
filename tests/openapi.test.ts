import { describe, it, expect } from 'vitest'
import { SELF } from 'cloudflare:test'

describe('GET /openapi.json', () => {
  it('returns 200 with application/json content-type', async () => {
    const response = await SELF.fetch('http://example.com/openapi.json')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')
  })

  it('returns CORS header Access-Control-Allow-Origin: *', async () => {
    const response = await SELF.fetch('http://example.com/openapi.json')
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
  })

  it('parsed body has openapi === "3.1.0"', async () => {
    const response = await SELF.fetch('http://example.com/openapi.json')
    const body = await response.json() as { openapi: string }
    expect(body.openapi).toBe('3.1.0')
  })
})

describe('GET /masjids CORS middleware', () => {
  it('CORS middleware emits Access-Control-Allow-Origin: * (even on error responses)', async () => {
    const response = await SELF.fetch('http://example.com/masjids')
    // NOTE: /masjids returns 500 until D1 binding is wired in wrangler.jsonc —
    // this test only verifies that the global CORS middleware header is present
    // on all responses, including error responses from unimplemented routes.
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
  })
})
