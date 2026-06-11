# Masjid Sentral — Database Schema Proposal

**Version:** 0.1  
**Date:** 2026-05-19  
**Authors:** Jejak Masjid × Qiyam  
**Status:** Pending Agreement

---

## Background

MasjidDB is a joint, community-owned open database of every masjid, surau, and musolla in Malaysia (and eventually Singapore, Brunei, and Indonesia). Both Jejak Masjid and Qiyam will consolidate their existing masjid datasets into this single source of truth, and both apps will consume it via a shared public API.

**Goals for MVP:**
- One canonical masjid database combining both apps' data
- Public REST API — read without API key, write requires key
- Hosted on Cloudflare Workers + D1
- Open source under MIT (code) + ODC-ODbL (data)

---

## Entity Relationship

```
countries
  └── states
        └── cities
              └── masjids ──── masjid_types
                    ├── masjid_images
                    ├── masjid_facilities
                    ├── masjid_contacts
                    ├── masjid_reviews
                    └── masjid_events
                          └── masjid_event_images
```

---

## Tables

### Reference Tables

These are lookup/enum tables that are seeded once and rarely change.

| Table | Purpose |
|---|---|
| `countries` | MY, SG, BN, ID |
| `states` | 16 Malaysian states + future SG/BN/ID states |
| `cities` | Cities and towns, linked to state |
| `masjid_types` | masjid, surau, musolla — extensible without schema change |

---

### Core Table

#### `masjids`

The single source of truth for every prayer venue. Kept lean — only fields needed for discovery and display.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | Auto-increment |
| `name` | TEXT | Primary Malay name |
| `type_id` | TEXT FK | References `masjid_types` |
| `lat` | REAL | Latitude |
| `lng` | REAL | Longitude |
| `geohash` | TEXT | Indexed, for proximity queries |
| `city_id` | TEXT FK | References `cities` (nullable) |
| `state_id` | TEXT FK | References `states` (required) |
| `country_id` | TEXT FK | References `countries` (required) |
| `address` | TEXT | Street address (optional) |
| `description` | TEXT | Short description (optional) |
| `status` | TEXT | `active` or `deleted` (soft delete) |
| `deleted_at` | TEXT | Timestamp when deleted |
| `jumaat_available` | INTEGER | 0 or 1 — Friday prayer held here |
| `telephone` | TEXT | Contact number (optional) |
| `email` | TEXT | Contact email (optional) |
| `google_url` | TEXT | Google Maps URL (optional) |
| `source` | TEXT | Original source: `jejak_masjid`, `qiyam`, `osm`, `manual` |
| `created_at` | TEXT | ISO datetime |
| `updated_at` | TEXT | ISO datetime |

> `city_id`, `state_id`, and `country_id` are all stored directly on the row (denormalized) to avoid joins on common filter queries.

---

### Extended Tables

These are fetched on demand — typically for a masjid detail page.

#### `masjid_images`

Multiple images per masjid. One image flagged as thumbnail.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | Auto-increment |
| `masjid_id` | INTEGER FK | References `masjids` |
| `path` | TEXT | Relative path — API constructs full URL |
| `is_thumbnail` | INTEGER | 0 or 1 |
| `sort_order` | INTEGER | Display order |
| `created_at` | TEXT | ISO datetime |

#### `masjid_facilities`

Tag-based. One row per facility per masjid.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | Auto-increment |
| `masjid_id` | INTEGER FK | References `masjids` |
| `facility` | TEXT | `parking`, `wudhu`, `wheelchair`, `library`, `cafe` |

#### `masjid_contacts`

Social media and messaging links. Telephone and email are already in the core table.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | Auto-increment |
| `masjid_id` | INTEGER FK | References `masjids` |
| `type` | TEXT | `facebook`, `instagram`, `twitter`, `youtube`, `whatsapp` |
| `value` | TEXT | URL or handle |

#### `masjid_events`

Events and activities held at a masjid. Supports one-time and recurring events via the RRULE standard.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | Auto-increment |
| `masjid_id` | INTEGER FK | References `masjids` |
| `title` | TEXT | Event title (required) |
| `description` | TEXT | Full description (optional) |
| `start_at` | TEXT | ISO datetime — event start |
| `end_at` | TEXT | ISO datetime — event end (optional) |
| `status` | TEXT | `active`, `cancelled`, `completed` |
| `rrule` | TEXT | RFC 5545 recurrence rule — null means one-time event. e.g. `FREQ=WEEKLY;BYDAY=FR` for every Friday |
| `source_app` | TEXT | `jejak_masjid`, `qiyam`, `manual` |
| `source_user_id` | TEXT | User ID in the source app (optional) |
| `created_at` | TEXT | ISO datetime |
| `updated_at` | TEXT | ISO datetime |

> `rrule` follows the iCalendar RFC 5545 standard. Parse with `rrule.js` (JS/TS) or `python-dateutil` (Python).

#### `masjid_event_images`

Images attached to an event. Same pattern as `masjid_images`.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | Auto-increment |
| `event_id` | INTEGER FK | References `masjid_events` |
| `path` | TEXT | Relative path — API constructs full URL |
| `is_thumbnail` | INTEGER | 0 or 1 |
| `sort_order` | INTEGER | Display order |
| `created_at` | TEXT | ISO datetime |

#### `masjid_reviews`

User-submitted star ratings and written reviews for a masjid.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | Auto-increment |
| `masjid_id` | INTEGER FK | References `masjids` |
| `rating` | INTEGER | 0 to 5 (whole stars) |
| `message` | TEXT | Written review (optional) |
| `source_app` | TEXT | `jejak_masjid`, `qiyam`, `manual` |
| `source_user_id` | TEXT | User ID in the source app (optional) |
| `created_at` | TEXT | ISO datetime |

---

## Full SQL

```sql
-- ─────────────────────────────────────────
-- REFERENCE TABLES
-- ─────────────────────────────────────────

CREATE TABLE countries (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE  -- 'MY', 'SG', 'BN', 'ID'
);

CREATE TABLE states (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  country_id TEXT NOT NULL REFERENCES countries(id)
);
CREATE INDEX idx_states_country ON states(country_id);

CREATE TABLE cities (
  id       TEXT PRIMARY KEY,
  name     TEXT NOT NULL,
  state_id TEXT NOT NULL REFERENCES states(id)
);
CREATE INDEX idx_cities_state ON cities(state_id);

CREATE TABLE masjid_types (
  id      TEXT PRIMARY KEY,
  name    TEXT NOT NULL UNIQUE,
  name_en TEXT
);

-- ─────────────────────────────────────────
-- CORE
-- ─────────────────────────────────────────

CREATE TABLE masjids (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT NOT NULL,
  type_id          TEXT NOT NULL REFERENCES masjid_types(id),

  lat              REAL NOT NULL,
  lng              REAL NOT NULL,
  geohash          TEXT NOT NULL,

  city_id          TEXT REFERENCES cities(id),
  state_id         TEXT NOT NULL REFERENCES states(id),
  country_id       TEXT NOT NULL REFERENCES countries(id),

  address          TEXT,
  description      TEXT,

  status           TEXT NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active', 'deleted')),
  deleted_at       TEXT,

  jumaat_available INTEGER NOT NULL DEFAULT 0,
  telephone        TEXT,
  email            TEXT,
  google_url       TEXT,

  source           TEXT NOT NULL DEFAULT 'manual',

  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_masjids_geohash  ON masjids(geohash);
CREATE INDEX idx_masjids_lat_lng  ON masjids(lat, lng);
CREATE INDEX idx_masjids_city     ON masjids(city_id);
CREATE INDEX idx_masjids_state    ON masjids(state_id);
CREATE INDEX idx_masjids_country  ON masjids(country_id);
CREATE INDEX idx_masjids_status   ON masjids(status);
CREATE INDEX idx_masjids_type     ON masjids(type_id);

-- ─────────────────────────────────────────
-- EXTENDED TABLES
-- ─────────────────────────────────────────

CREATE TABLE masjid_images (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  masjid_id     INTEGER NOT NULL REFERENCES masjids(id) ON DELETE CASCADE,
  path          TEXT NOT NULL,
  is_thumbnail  INTEGER NOT NULL DEFAULT 0,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_masjid_images_masjid ON masjid_images(masjid_id);

CREATE TABLE masjid_facilities (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  masjid_id INTEGER NOT NULL REFERENCES masjids(id) ON DELETE CASCADE,
  facility  TEXT NOT NULL
);
CREATE INDEX idx_masjid_facilities_masjid ON masjid_facilities(masjid_id);

CREATE TABLE masjid_contacts (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  masjid_id INTEGER NOT NULL REFERENCES masjids(id) ON DELETE CASCADE,
  type      TEXT NOT NULL CHECK (type IN ('facebook','instagram','twitter','youtube','whatsapp')),
  value     TEXT NOT NULL
);
CREATE INDEX idx_masjid_contacts_masjid ON masjid_contacts(masjid_id);

CREATE TABLE masjid_reviews (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  masjid_id      INTEGER NOT NULL REFERENCES masjids(id) ON DELETE CASCADE,
  rating         INTEGER NOT NULL CHECK (rating >= 0 AND rating <= 5),
  message        TEXT,
  source_app     TEXT NOT NULL,
  source_user_id TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_masjid_reviews_masjid ON masjid_reviews(masjid_id);

CREATE TABLE masjid_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  masjid_id   INTEGER NOT NULL REFERENCES masjids(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  description TEXT,
  start_at    TEXT NOT NULL,
  end_at      TEXT,
  status      TEXT NOT NULL DEFAULT 'active'
              CHECK (status IN ('active', 'cancelled', 'completed')),
  rrule          TEXT,            -- RFC 5545 recurrence rule; null = one-time event
  source_app     TEXT NOT NULL,
  source_user_id TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_masjid_events_masjid ON masjid_events(masjid_id);
CREATE INDEX idx_masjid_events_start  ON masjid_events(start_at);

CREATE TABLE masjid_event_images (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id     INTEGER NOT NULL REFERENCES masjid_events(id) ON DELETE CASCADE,
  path         TEXT NOT NULL,
  is_thumbnail INTEGER NOT NULL DEFAULT 0,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_masjid_event_images_event ON masjid_event_images(event_id);

-- ─────────────────────────────────────────
-- SEED: REFERENCE DATA
-- ─────────────────────────────────────────

INSERT INTO countries VALUES ('my', 'Malaysia',  'MY');
INSERT INTO countries VALUES ('sg', 'Singapore', 'SG');
INSERT INTO countries VALUES ('bn', 'Brunei',    'BN');
INSERT INTO countries VALUES ('id', 'Indonesia', 'ID');

INSERT INTO masjid_types VALUES ('masjid',  'masjid',  'Mosque');
INSERT INTO masjid_types VALUES ('surau',   'surau',   'Prayer Room');
INSERT INTO masjid_types VALUES ('musolla', 'musolla', 'Musolla');

INSERT INTO states VALUES ('my-jhr', 'Johor',              'my');
INSERT INTO states VALUES ('my-kdh', 'Kedah',              'my');
INSERT INTO states VALUES ('my-ktn', 'Kelantan',           'my');
INSERT INTO states VALUES ('my-mlk', 'Melaka',             'my');
INSERT INTO states VALUES ('my-nsn', 'Negeri Sembilan',    'my');
INSERT INTO states VALUES ('my-phg', 'Pahang',             'my');
INSERT INTO states VALUES ('my-prk', 'Perak',              'my');
INSERT INTO states VALUES ('my-pls', 'Perlis',             'my');
INSERT INTO states VALUES ('my-png', 'Pulau Pinang',       'my');
INSERT INTO states VALUES ('my-sbh', 'Sabah',              'my');
INSERT INTO states VALUES ('my-swk', 'Sarawak',            'my');
INSERT INTO states VALUES ('my-sgr', 'Selangor',           'my');
INSERT INTO states VALUES ('my-trg', 'Terengganu',         'my');
INSERT INTO states VALUES ('my-kul', 'W.P. Kuala Lumpur',  'my');
INSERT INTO states VALUES ('my-lbn', 'W.P. Labuan',        'my');
INSERT INTO states VALUES ('my-pjy', 'W.P. Putrajaya',     'my');
```

---

## Open Questions

Please review and confirm your position on each:

| # | Question | Jejak Masjid | Qiyam |
|---|---|---|---|
| 1 | Agree on this schema as the starting point? | | |
| 2 | Any fields missing from the core table? | | |
| 3 | Should `cities` be seeded from our existing data or manually? | | |
| 4 | Should `masjid_facilities` use a fixed list or free text? | | |
| 5 | Who registers the domain for Masjid Sentral? | | |
| 6 | Who creates the Cloudflare account for the shared D1? | | |

---

## Next Steps

Once both parties agree on this schema:

1. ~~Create GitHub org `masjidsentral`~~ ✓ Done
2. Commit this SQL to `masjidsentral-db-schema` as `migrations/001_initial.sql`
3. Set up shared Cloudflare account + D1 database
4. Run deduplication pipeline on both datasets
5. Import merged data
6. Build and deploy the public API

---

*Document prepared by Jejak Masjid. Please add comments or suggested changes directly in this file or via GitHub PR.*
