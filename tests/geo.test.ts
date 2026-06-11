import { describe, it, expect } from 'vitest'
import { geohashPrefixes, haversineKm } from '../src/lib/geo'

// Unit tests for geo helper functions

describe('geohashPrefixes', () => {
  it('returns an array of exactly 9 prefix strings for valid lat/lng (D-09)', () => {
    const prefixes = geohashPrefixes(3.1, 101.7, 5)
    expect(Array.isArray(prefixes)).toBe(true)
    expect(prefixes.length).toBe(9)
    for (const p of prefixes) {
      expect(typeof p).toBe('string')
      expect(p.length).toBeGreaterThan(0)
    }
  })

  it('uses prefix length 5 for radius <= 5km', () => {
    const prefixes = geohashPrefixes(3.1, 101.7, 5)
    for (const p of prefixes) {
      expect(p.length).toBe(5)
    }
  })

  it('uses prefix length 4 for radius > 5km (up to 20km)', () => {
    const prefixes = geohashPrefixes(3.1, 101.7, 10)
    for (const p of prefixes) {
      expect(p.length).toBe(4)
    }
  })
})

describe('haversineKm', () => {
  it('returns 0 for identical coordinates', () => {
    const dist = haversineKm(3.1, 101.7, 3.1, 101.7)
    expect(dist).toBe(0)
  })

  it('returns approximately 5km for two ~5km-apart points', () => {
    // ~5km north of 3.1, 101.7 is approximately 3.145, 101.7
    // 1 degree lat ≈ 111km, so 0.045 deg ≈ 5km
    const dist = haversineKm(3.1, 101.7, 3.145, 101.7)
    expect(dist).toBeGreaterThan(4.5)
    expect(dist).toBeLessThan(5.5)
  })

  it('returns correct distance between Kuala Lumpur and Petaling Jaya (~12km)', () => {
    // KL city center to PJ approximate coordinates
    const dist = haversineKm(3.1412, 101.6865, 3.1073, 101.6067)
    expect(dist).toBeGreaterThan(8)
    expect(dist).toBeLessThan(15)
  })
})
