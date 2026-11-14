import { describe, it, expect } from 'vitest'
import { jaro, jaroWinkler, matchScore, nameSimilarity, normaliseName, normaliseVariants } from '../src/lib/match'
import { MAX_COVER_CELLS, searchWindow, windowWhere } from '../src/lib/geo'

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

describe('S3 review: normalisation and conflicts', () => {
  it('expands abbreviations and spelling variants', () => {
    expect(normaliseName('Kg Baru')).toBe('kampung baru')
    expect(normaliseName('Kpg. Baru')).toBe('kampung baru')
    expect(normaliseName('Tmn Melati')).toBe('taman melati')
    expect(normaliseName('Jln Bt 5 Bdr Seri Bkt Sg Tg')).toBe('jalan batu 5 bandar sri bukit sungai tanjung')
  })

  it('drops mosque, musholla, mushola and langgar as leading words', () => {
    expect(normaliseName('Mosque Al-Falah')).toBe('alfalah')
    expect(normaliseName('Musholla An-Nur')).toBe('annur')
    expect(normaliseName('Mushola Taman Ria')).toBe('taman ria')
    expect(normaliseName('Langgar Kampung Baru')).toBe('kampung baru')
  })

  it('offers both article forms', () => {
    expect(normaliseVariants('Masjid Al-Hidayah')).toEqual(['alhidayah', 'hidayah'])
    expect(normaliseVariants('Masjid Taman Ria')).toEqual(['taman ria'])
    expect(nameSimilarity('Masjid Al-Ikhlas', 'Masjid Ikhlas')).toBe(1)
  })

  it('reviewer pairs: abbreviations score >= 0.9, conflicting numbers/letters are capped at 0.8', () => {
    expect(matchScore('Kg Baru', 'Kampung Baru', 40)).toBeGreaterThanOrEqual(0.9)
    expect(matchScore('Tmn Melati', 'Taman Melati', 40)).toBeGreaterThanOrEqual(0.9)
    expect(nameSimilarity('Surau Al-Hidayah Blok A', 'Surau Al-Hidayah Blok B')).toBe(0.8)
    expect(matchScore('Surau Al-Hidayah Blok A', 'Surau Al-Hidayah Blok B', 40)).toBeLessThan(0.9)
    expect(matchScore('Surau Taman Desa Fasa 1', 'Surau Taman Desa Fasa 2', 40)).toBeLessThan(0.9)
    expect(matchScore('Masjid Seksyen II', 'Masjid Seksyen III', 10)).toBeLessThan(0.9)
    expect(matchScore('Masjid Seksyen 7', 'Masjid Seksyen 7', 10)).toBeGreaterThan(0.95)
    expect(matchScore('MASJID JAMEK SULTAN ABDUL SAMAD', 'Masjid Jamek Kuala Lumpur', 40)).toBeLessThan(0.9)
    expect(matchScore('Surau Al-Ikhlas', 'Surau An-Nur', 30)).toBeLessThan(0.6)
  })
})

describe('search window (bounding box + at most 16 geohash cells)', () => {
  it('never needs more than 16 cells / 32 geohash binds, whatever the place or radius', () => {
    for (const lat of [-60, -33.9, 0, 1.2, 3.1, 40, 51.5, 70]) {
      for (const lng of [-170, -0.1, 101.7, 103.5, 115.2, 139.7]) {
        for (const r of [10, 50, 300, 1000, 4999, 5000, 15001, 20000]) {
          const w = searchWindow(lat, lng, r)
          expect(w.prefixes.length, `${lat},${lng} r=${r}`).toBeLessThanOrEqual(MAX_COVER_CELLS)
          expect(windowWhere(w).binds.length).toBeLessThanOrEqual(4 + 2 * MAX_COVER_CELLS)
        }
      }
    }
  })

  it('the box contains the whole circle and prefixes all share one finer-than-ring precision', () => {
    const w = searchWindow(3.1, 101.7, 1000)
    expect(w.minLat).toBeLessThan(3.1 - 0.0089)
    expect(w.maxLat).toBeGreaterThan(3.1 + 0.0089)
    expect(w.prefixes.length).toBeGreaterThan(0)
    expect(new Set(w.prefixes.map(p => p.length)).size).toBe(1)
    expect(w.prefixes[0].length).toBeGreaterThanOrEqual(5)
  })

  it('drops the longitude bound across the antimeridian', () => {
    const w = searchWindow(-17.7, 179.99, 20000)
    expect(w.prefixes).toEqual([])
    expect([w.minLng, w.maxLng]).toEqual([-180, 180])
  })
})
