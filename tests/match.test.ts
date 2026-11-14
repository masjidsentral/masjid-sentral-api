import { describe, it, expect } from 'vitest'
import { jaro, jaroWinkler, matchScore, nameSimilarity, normaliseName } from '../src/lib/match'

describe('normaliseName', () => {
  it('lowercases, strips leading masjid words and joins articles', () => {
    expect(normaliseName('MASJID AL-HIDAYAH')).toBe('alhidayah')
    expect(normaliseName('Masjid Al Hidayah')).toBe('alhidayah')
    expect(normaliseName('Surau An-Nur')).toBe('annur')
    expect(normaliseName('Mini Surau Ar-Rahman')).toBe('arrahman')
    expect(normaliseName('Musolla Al Falah')).toBe('alfalah')
    expect(normaliseName('Musalla  Taman   Ria')).toBe('taman ria')
  })

  it('strips diacritics and punctuation', () => {
    expect(normaliseName('Masjid Al-Hidāyah')).toBe('alhidayah')
    expect(normaliseName("Masjid Al-Ikhlas (Ṭaman) & Co.")).toBe('alikhlas taman co')
  })

  it('handles JAKIM uppercase names', () => {
    expect(normaliseName('MASJID JAMEK SULTAN ABDUL SAMAD')).toBe('jamek sultan abdul samad')
    expect(normaliseName('MASJID AS-SYAKIRIN')).toBe('assyakirin')
  })

  it('removes only leading words, not ones inside the name', () => {
    expect(normaliseName('Taman Masjid Indah')).toBe('taman masjid indah')
  })

  it('keeps a name made only of leading words (nothing left to compare otherwise)', () => {
    expect(normaliseName('Masjid')).toBe('masjid')
    expect(normaliseName('Mini Surau')).toBe('mini surau')
  })

  it('returns an empty string for empty or punctuation-only input', () => {
    expect(normaliseName('')).toBe('')
    expect(normaliseName(' -- ')).toBe('')
  })

  it('a trailing article has nothing to join', () => {
    expect(normaliseName('Masjid Al')).toBe('al')
  })
})

describe('Jaro-Winkler', () => {
  it('matches the reference values', () => {
    expect(jaro('martha', 'marhta')).toBeCloseTo(0.944, 3)
    expect(jaroWinkler('martha', 'marhta')).toBeCloseTo(0.961, 3)
    expect(jaroWinkler('dixon', 'dicksonx')).toBeCloseTo(0.813, 3)
    expect(jaroWinkler('abc', 'abc')).toBe(1)
    expect(jaroWinkler('abc', 'xyz')).toBe(0)
    expect(jaroWinkler('', 'abc')).toBe(0)
  })

  it('gives no prefix boost to weak matches (Jaro <= 0.7)', () => {
    expect(jaroWinkler('alikhlas', 'annur')).toBe(jaro('alikhlas', 'annur'))
  })
})

describe('matchScore', () => {
  it('empty-after-normalising names score 0 similarity', () => {
    expect(nameSimilarity('---', 'Masjid Al-Hidayah')).toBe(0)
    expect(nameSimilarity('Masjid', 'Masjid')).toBe(1)
  })

  it('fixture: MASJID AL-HIDAYAH vs Masjid Al Hidayah 20 m apart is >= 0.9', () => {
    expect(matchScore('MASJID AL-HIDAYAH', 'Masjid Al Hidayah', 20)).toBeGreaterThanOrEqual(0.9)
    expect(matchScore('MASJID AL-HIDAYAH', 'Masjid Al Hidayah', 20)).toBe(0.988)
  })

  it('fixture: Surau Al-Ikhlas vs Surau An-Nur 30 m apart is < 0.6', () => {
    expect(matchScore('Surau Al-Ikhlas', 'Surau An-Nur', 30)).toBeLessThan(0.6)
  })

  it('distance fades to nothing at 500 m', () => {
    expect(matchScore('Masjid Taman Ria', 'Masjid Taman Ria', 500)).toBe(0.7)
    expect(matchScore('Masjid Taman Ria', 'Masjid Taman Ria', 900)).toBe(0.7)
    expect(matchScore('Masjid Taman Ria', 'Masjid Taman Ria', 0)).toBe(1)
  })
})
