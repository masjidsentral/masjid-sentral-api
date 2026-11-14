/** Programme categories (contract section 4.2). Unknown values are rejected with 422. */
export const EVENT_CATEGORIES = [
  'kuliah', 'ceramah', 'tazkirah', 'kelas', 'qiamullail', 'gotong_royong', 'sukan', 'majlis',
  'program_belia', 'korban', 'iftar', 'jualan', 'lain',
] as const

export const CONTACT_TYPES = [
  'facebook', 'instagram', 'twitter', 'youtube', 'whatsapp', 'tiktok', 'threads', 'website',
] as const

/** Statuses a client may set on a programme (deleted only through DELETE). */
export const EVENT_WRITABLE_STATUSES = ['active', 'cancelled', 'completed'] as const

export const DEFAULT_TIMEZONE = 'Asia/Kuala_Lumpur'
