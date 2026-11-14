import { describe, it, expect } from 'vitest'
import { SELF } from 'cloudflare:test'
import { writeHeaders } from './helpers'

// Integration tests for write endpoints (POST /masjids, PATCH /masjids/:id)
// Covers: APIWRITE-01, APIWRITE-02, APIWRITE-03, APIWRITE-04, APIWRITE-05, APIWRITE-06

const VALID_POST_BODY = {
  name: 'Test Masjid Integration',
  type_id: 'masjid',
  state_id: 'my-kul',
  country_id: 'my',
  lat: 3.147,
  lng: 101.698,
  address: '1 Jalan Test',
}

describe('POST /masjids', () => {
  it('returns 201 with created resource (APIWRITE-01)', async () => {
    const response = await SELF.fetch('http://example.com/masjids?force=true', {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify(VALID_POST_BODY),
    })
    expect(response.status).toBe(201)
    const body = await response.json() as {
      id: number
      name: string
    }
    expect(typeof body.id).toBe('number')
    expect(typeof body.name).toBe('string')
    expect(body.name).toBe(VALID_POST_BODY.name)
  })
})

describe('PATCH /masjids/:id', () => {
  it('returns 200 with updated resource including updated_at (APIWRITE-02, APIWRITE-05)', async () => {
    // First create a masjid via POST
    const postResponse = await SELF.fetch('http://example.com/masjids?force=true', {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify(VALID_POST_BODY),
    })
    expect(postResponse.status).toBe(201)
    const created = await postResponse.json() as { id: number; version: number }
    const createdId = created.id

    // Then PATCH it
    const patchResponse = await SELF.fetch(`http://example.com/masjids/${createdId}`, {
      method: 'PATCH',
      headers: writeHeaders(undefined, undefined, { 'If-Match': String(created.version) }),
      body: JSON.stringify({ name: 'Test Masjid Integration Updated' }),
    })
    expect(patchResponse.status).toBe(200)
    const updated = await patchResponse.json() as {
      id: number
      name: string
      version: number
      updated_at: string
    }
    expect(updated.version).toBe(created.version + 1)
    expect(updated.id).toBe(createdId)
    expect(updated.name).toBe('Test Masjid Integration Updated')
    // APIWRITE-05: updated_at is a string (timestamp set by server)
    expect(typeof updated.updated_at).toBe('string')
    expect(updated.updated_at.length).toBeGreaterThan(0)
  })
})

describe('Auth middleware', () => {
  it('POST /masjids with no Authorization header returns 401 (APIWRITE-03, APIWRITE-04)', async () => {
    const response = await SELF.fetch('http://example.com/masjids?force=true', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(VALID_POST_BODY),
    })
    expect(response.status).toBe(401)
    const body = await response.json() as { error: string }
    expect(typeof body.error).toBe('string')
    expect(body.error.length).toBeGreaterThan(0)
  })

  it('POST /masjids with invalid Bearer token returns 401 (APIWRITE-03, APIWRITE-04, APIWRITE-06)', async () => {
    const response = await SELF.fetch('http://example.com/masjids?force=true', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer invalid-key-xyz',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(VALID_POST_BODY),
    })
    expect(response.status).toBe(401)
    const body = await response.json() as { error: string }
    expect(typeof body.error).toBe('string')
    expect(body.error.length).toBeGreaterThan(0)
  })

  it('PATCH /masjids/1 with no Authorization header returns 401 (APIWRITE-03, APIWRITE-04)', async () => {
    const response = await SELF.fetch('http://example.com/masjids/1', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'Should Not Update' }),
    })
    expect(response.status).toBe(401)
    const body = await response.json() as { error: string }
    expect(typeof body.error).toBe('string')
    expect(body.error.length).toBeGreaterThan(0)
  })
})
