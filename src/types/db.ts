// DB row shapes derived from masjidsentral-db-schema/migrations/001_initial.sql

export interface CountryRow {
  id: string
  name: string
  code: string
}

export interface StateRow {
  id: string
  name: string
  country_id: string
}

export interface CityRow {
  id: string
  name: string
  state_id: string
}

export interface MasjidTypeRow {
  id: string
  name: string
  name_en: string | null
}

export interface MasjidRow {
  id: number
  name: string
  type_id: string
  lat: number
  lng: number
  geohash: string
  city_id: string | null
  state_id: string
  country_id: string
  address: string | null
  description: string | null
  status: 'active' | 'deleted'
  deleted_at: string | null
  jumaat_available: 0 | 1
  telephone: string | null
  email: string | null
  google_url: string | null
  source: string
  created_at: string
  updated_at: string
}

export interface MasjidImageRow {
  id: number
  masjid_id: number
  path: string
  is_thumbnail: 0 | 1
  sort_order: number
  created_at: string
}

export interface MasjidFacilityRow {
  id: number
  masjid_id: number
  facility: string
}

export interface MasjidContactRow {
  id: number
  masjid_id: number
  type: 'facebook' | 'instagram' | 'twitter' | 'youtube' | 'whatsapp'
  value: string
}

export interface MasjidReviewRow {
  id: number
  masjid_id: number
  rating: number
  message: string | null
  source_app: string
  source_user_id: string | null
  created_at: string
}

export interface MasjidEventRow {
  id: number
  masjid_id: number
  title: string
  description: string | null
  start_at: string          // Column is start_at per 001_initial.sql (NOT start_time)
  end_at: string | null
  status: 'active' | 'cancelled' | 'completed'
  rrule: string | null
  source_app: string
  source_user_id: string | null
  created_at: string
  updated_at: string
}

export interface ApiKeyRow {
  id: number
  key_hash: string
  name: string
  is_active: 0 | 1
  created_at: string
}
