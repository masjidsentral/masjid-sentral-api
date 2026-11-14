import { ApiError } from './errors'

export function invalid(message: string, field: string): never {
  throw new ApiError(422, 'validation_failed', message, { field })
}

/** Parses a non-negative integer query value. Missing or empty gives the fallback. */
export function intParam(raw: string | undefined, name: string, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw === '') return fallback
  if (!/^\d{1,15}$/.test(raw)) invalid(`${name} must be an integer`, name)
  const n = Number(raw)
  if (n < min || n > max) invalid(`${name} must be between ${min} and ${max}`, name)
  return n
}

export function encodeCursor(payload: string): string {
  return btoa(payload).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Opaque cursor back to its payload. A malformed cursor is a 422. */
export function decodeCursor(raw: string | undefined): string | null {
  if (raw === undefined || raw === '') return null
  try {
    const b64 = raw.replace(/-/g, '+').replace(/_/g, '/')
    return atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
  } catch {
    return invalid('cursor is not valid', 'cursor')
  }
}

const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:[Zz]|([+\- ])(\d{2}):(\d{2}))$/

/**
 * An RFC 3339 instant (`Z` or a `+08:00` offset) normalised to UTC `Z` at second precision, or null when it is not
 * a real instant (bad calendar date, hour > 23, offset beyond 23:59). A space where the offset sign belongs is read
 * as `+` (an unescaped `+` in a query string decodes to a space).
 */
export function normaliseInstant(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const m = RFC3339.exec(raw)
  if (!m) return null
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? '00'].map(Number)
  const offH = m[8] === undefined ? 0 : Number(m[8])
  const offM = m[9] === undefined ? 0 : Number(m[9])
  if (offH > 23 || offM > 59 || h > 23 || mi > 59 || s > 59) return null
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, s))
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null
  const sign = m[7] === '-' ? -1 : 1
  const utc = new Date(date.getTime() - sign * (offH * 60 + offM) * 60_000)
  return utc.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

export function validateExternalId(raw: unknown): string {
  // eslint-disable-next-line no-control-regex
  if (typeof raw !== 'string' || raw.trim() === '' || raw.length > 255 || /[\u0000-\u001f\u007f-\u009f]/.test(raw)) {
    invalid('external_id must be a non-empty string of at most 255 characters', 'external_id')
  }
  return raw.trim()
}
