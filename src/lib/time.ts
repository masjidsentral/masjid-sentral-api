// ISO 8601 UTC timestamps without milliseconds (contract section 1): 2026-11-14T10:30:00Z

export function isoNow(date: Date = new Date()): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z')
}
