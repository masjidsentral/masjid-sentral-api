// DB row shapes (masjidsentral-db-schema migrations 001-004)

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
  version: number
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
  status: 'active' | 'deleted' | 'merged'
  deleted_at: string | null
  merged_into: number | null
  jumaat_available: 0 | 1
  telephone: string | null
  email: string | null
  google_url: string | null
  updated_by_app: string | null
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
