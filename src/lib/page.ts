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

const ISO_UTC = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?Z$/

/** A UTC instant (`...Z`) normalised to second precision, or null when it is not a real instant. */
export function normaliseInstant(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const m = ISO_UTC.exec(raw)
  if (!m) return null
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? '00'].map(Number)
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, s))
  if (
    date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d ||
    date.getUTCHours() !== h || date.getUTCMinutes() !== mi
  ) return null
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z')
}
