# SPEC: App Sync (Masjid Sentral API v1.1)

Owner decisions 2026-11-14. Server-side build that makes
`docs/INTEGRATION_CONTRACT.md` real. **The contract is the source of truth for
every public request and response.** This spec adds the server internals. If
the two disagree on anything a client can see, stop and ask; do not guess.

## 0. Context for the implementing agent

- Masjid Sentral is the master copy of masjids and their programmes for two
  apps, Jejak Masjid (JM) and Qiyam. Each app writes through this API and keeps
  a local copy updated from `GET /changes` and webhooks.
- Repos (both local, both on `main`):
  - `~/Documents/masjid-sentral/api/` — Hono Worker (`src/index.ts`, `src/routes/*`, `src/middleware/auth.ts`, `src/lib/*`, `src/types/db.ts`), tests in `tests/` (vitest + `@cloudflare/vitest-pool-workers`), `openapi.json`.
  - `~/Documents/masjid-sentral/masjidsentral-db-schema/` — raw SQL migrations in `migrations/` (`001_initial.sql`, `002_api_keys.sql`). `api/wrangler.jsonc` (`migrations_dir`) and `api/tests/globalSetup.ts` read migrations from here.
- Read `api/CLAUDE.md` first, then the contract, then this file.
- Branch: create `feat/app-sync` from `main` in **both** repos. Commit there. Do not merge, push or deploy.
- Plan constraint: the Worker may run on the Workers free plan (10 ms CPU per request). Keep handlers to indexed queries and small loops.

## 1. Build phases (one review gate after each)

| Phase | Scope | Section |
|---|---|---|
| S1 | Keys, scopes, actor, auth on every route, error shape, rate limit, dev-key removal | §2 |
| S2 | New schema (fresh rebuild), versioning, idempotency, change log, `/changes`, webhooks | §3 |
| S3 | Masjid and programme endpoints from the contract, linking, matching, duplicate gate, facilities catalogue | §4 |
| S4 | Admin: merge, revert, duplicate scan and queue, key-issue script; `openapi.json` v1.1 | §5 |

Each phase ends with: all tests green (`npx vitest run` in `api/`), `npx tsc --noEmit` clean, and a short `PROGRESS_app-sync.md` entry in `api/` (what was built, commits, anything deferred).

## 2. S1 — Access control

1. **Migration `003_api_key_scopes.sql`** (db-schema repo):
   - `ALTER TABLE api_keys ADD COLUMN app_id TEXT;`
   - `ALTER TABLE api_keys ADD COLUMN scopes TEXT NOT NULL DEFAULT 'read';` (comma list from `read`, `write`, `webhook`, `admin`)
   - `ALTER TABLE api_keys ADD COLUMN revoked_at TEXT;`
   - `DELETE FROM api_keys WHERE key_hash = '08d55f7f36724e61a51e389109146c688f6d69f38658e861508b857a236d53b8';` (the dev key seeded by 002 must not work anywhere real).
   - Do not edit 001 or 002. They may already be applied to production.
2. **Tests seed their own keys** in `tests/setup.ts` after migrations are applied: one key per scope set (`read`; `read,write` as app `jejak_masjid`; `read,write` as app `qiyam`; `read,write,webhook`; `admin`). Export the raw tokens from a test helper.
3. **Auth middleware** (`src/middleware/auth.ts`): runs on every route except `GET /` and `GET /openapi.json`. It hashes the bearer token (existing SHA-256 code), loads the active, unrevoked key, and sets `c.set('key', { id, app_id, scopes })`. Missing or bad token → 401 `unauthorized`. Add `requireScope(scope)` → 403 `forbidden`. Writes need `write`. Every write needs an `app_id` on the key and an `X-Sentral-Actor` header (1–128 chars, else 422).
4. **Error shape** everywhere: `{ error, code, details? }` (contract §1). Update `app.onError`, `app.notFound` and every existing `c.json({ error })`.
5. **CORS:** remove the global `cors()`. Keys are server-side only (contract R1).
6. **Rate limit:** 600 requests per minute per key id. Use the Workers Rate Limiting binding (check the current Cloudflare docs for the `ratelimits` wrangler config). Over the limit → 429 `rate_limited` with `Retry-After`. If the binding isn't usable in tests, inject it so tests can stub it.
7. Existing read endpoints keep working, now behind a key. Update the existing tests to send a key.

## 3. S2 — Schema, versions, change log, webhooks

### 3.1 Migration `004_app_sync.sql` (fresh rebuild)

Owner decision: Sentral's masjid data is rebuilt from empty (Qiyam's link job first, then JM's). This migration therefore **drops and recreates** `masjids`, `masjid_images`, `masjid_facilities`, `masjid_contacts`, `masjid_reviews`, `masjid_events` and `masjid_event_images`. Keep `countries`, `states`, `cities`, `masjid_types` and `api_keys`. Put this warning at the top of the file:

```
-- DESTRUCTIVE: empties all masjid data (owner-approved fresh rebuild 2026-11-14).
-- Owner only: take a D1 Time Travel bookmark before applying remotely.
```

New shapes (add `NOT NULL` and `CHECK` constraints as the contract implies):

- `masjids`: every column of 001, plus `version INTEGER NOT NULL DEFAULT 1`, `updated_by_app TEXT`, `merged_into INTEGER REFERENCES masjids(id)`. `status` CHECK becomes `('active','deleted','merged')`. Drop `source`; provenance now lives in `masjid_external_ids` and `changes`. Keep the indexes from 001 (geohash, state, city, type, status) and add `idx_masjids_updated_at`.
- `masjid_contacts.type` CHECK: `facebook, instagram, twitter, youtube, whatsapp, tiktok, threads, website`. Add `UNIQUE(masjid_id, type)`.
- `masjid_facilities(masjid_id, code REFERENCES facility_catalogue(code), available INTEGER NOT NULL CHECK (available IN (0,1)), PRIMARY KEY(masjid_id, code))`.
- `masjid_images(id, masjid_id, url TEXT NOT NULL, is_thumbnail, sort_order, created_at)`: a full HTTPS URL (contract §4.1), not a Cloudflare Images id.
- `masjid_events`: `id, version, masjid_id, title, description, category, speaker, start_at, end_at, timezone DEFAULT 'Asia/Kuala_Lumpur', rrule, status CHECK ('active','cancelled','completed','deleted'), poster_url, registration_url, source_app, updated_by_app, created_at, updated_at`. Indexes on `(masjid_id, start_at)` and `updated_at`. `masjid_event_images` is dropped and not recreated; `poster_url` replaces it.
- `masjid_reviews`: recreate as in 001 (no endpoints in this spec).
- `masjid_external_ids(app_id, external_id, masjid_id, created_at, PRIMARY KEY(app_id, external_id))` plus an index on `(masjid_id, app_id)`. No unique on `(masjid_id, app_id)`: a merge can leave two links from one app on a survivor. One-to-one linking is enforced in the handler (§4.2).
- `event_external_ids`: same shape, keyed to `event_id`.
- `facility_catalogue(code PRIMARY KEY, label_en, label_ms, sort_order, active)`. Seed it provisionally with JM's 29 codes and labels from JM's `develop` branch: `git -C ~/Documents/project-masjid/project-masjid-backend-cf show develop:drizzle/migrations/0089_facility_info.sql` (the working tree is on another branch, so read it via `git show`; read-only, never check out or edit that repo). Include the catalogue codes seeded by earlier JM migrations too (find them with `git grep -n "INSERT INTO facility" develop -- drizzle/migrations`). Mark it in a comment as provisional pending the JM × Qiyam agreement.
- `changes(seq INTEGER PRIMARY KEY AUTOINCREMENT, entity TEXT, entity_id INTEGER, masjid_id INTEGER, op TEXT CHECK (op IN ('create','update','delete','merge')), version INTEGER, origin_app TEXT, actor TEXT, changed_fields TEXT /*JSON*/, before_json TEXT, after_json TEXT, occurred_at TEXT)`. This table is both the feed and the audit log. No pruning in v1.1.
- `idempotency_keys(api_key_id, key, request_hash, response_status, response_json, created_at, PRIMARY KEY(api_key_id, key))`.
- `webhook_subscriptions(id, api_key_id, url, secret, active, created_at)`; `webhook_deliveries(subscription_id PRIMARY KEY, latest_seq, attempts, next_attempt_at, status CHECK ('pending','delivered','dropped'), last_error, updated_at)`. One row per subscription: a new change updates `latest_seq` and resets the row to pending, which coalesces pings.

### 3.2 Write pipeline (shared helper, used by every write in S3/S4)

`src/lib/write.ts` exposes one function that every mutating handler goes through:

1. **Idempotency.** Look up `(key.id, Idempotency-Key)`. Missing header → 422. Found with the same `request_hash` (SHA-256 of method + path + body) → replay the stored response. Found with a different hash → 409 `idempotency_mismatch`.
2. **Version check.** PATCH and DELETE require `If-Match`. Missing → 428 (code `validation_failed`). Mismatch → 409 `version_conflict` with `details.current` set to the full current entity.
3. **Atomic commit.** One `DB.batch([...])` must hold: the entity write (`UPDATE … SET …, version = version + 1, updated_by_app = ?, updated_at = ? WHERE id = ? AND version = ?`), the child-row writes, the `changes` insert, and the idempotency insert. If the guarded UPDATE matched 0 rows (a concurrent write won), nothing else may persist. One way: write the follow-up inserts as `INSERT … SELECT … WHERE changes() = 1` straight after the guarded UPDATE, then check `meta.changes` and return 409 if it is 0. Prove this with a test that races two PATCHes from the same base version.
4. `changes.after_json` is the full entity exactly as `GET` returns it (contract §4). `before_json` is the previous full entity (null on create).
5. **After commit:** upsert `webhook_deliveries` (pending, `latest_seq` = new seq) for every active subscription whose key `app_id` ≠ the writer's `app_id`. Then `c.executionCtx.waitUntil(dispatch())`.

### 3.3 Feed and webhooks

- `GET /changes?after&limit` and `GET /changes/latest`, exactly as in contract §6. `data` = `after_json`.
- **Dispatch** (`src/lib/webhooks.ts`): POST `{ "type": "changes.available", "latest_seq": n }`. Headers: `X-Sentral-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, t + "." + body)>` and `X-Sentral-Delivery`. 5 s timeout. A 2xx marks the row delivered. Anything else: `attempts + 1`, set `next_attempt_at` from the backoff 1 m, 5 m, 30 m, 2 h, 6 h, then `dropped`.
- **Cron trigger `* * * * *`** in `wrangler.jsonc`, with a `scheduled` handler that dispatches due pending rows (limit 50 per run) and deletes `idempotency_keys` older than 24 h.
- Webhook registration is admin-only: `POST /admin/webhooks { api_key_id, url }` returns the `whsec_…` secret once; `DELETE /admin/webhooks/:id`. Accept only `https://` URLs.

## 4. S3 — Contract endpoints

Implement every **NEW** endpoint and field in contract §5, plus the existing ones in their v1.1 shape. Rules the contract leaves to the server:

1. **Name normalisation** (`src/lib/match.ts`): lowercase, strip diacritics and punctuation, collapse spaces, and remove the leading words `masjid`, `surau`, `musolla`, `musalla` and `mini`. Treat `al ` / `al-` / `ar-` / `an-` etc. as part of the next word (`al-hidayah` → `alhidayah`).
2. **`GET /masjids/match?lat&lng&name`:** candidates = active masjids within 1 km (geohash prefix + haversine; reuse `src/lib/geo.ts`).
   - `name_sim` = Jaro-Winkler on the normalised names. Implement it in TypeScript; do not add the `natural` package.
   - `dist_score = max(0, 1 - distance_m / 500)`.
   - `score = round(0.7 * name_sim + 0.3 * dist_score, 3)`.
   - Return the top 5 by score, with `score`, `distance_m` and a summary (id, name, type_id, lat, lng, address, external_ids).
3. **Duplicate gate on `POST /masjids`:** if any candidate has `score ≥ 0.9` and `distance_m ≤ 50` → 409 `possible_duplicate` with `details.candidates`. `?force=true` skips the gate and is recorded in `changes.after_json` as `"forced": true`.
4. **`external_id` on POST** inserts into `masjid_external_ids` in the same batch. An existing `(app_id, external_id)` → 409 `already_linked` with `details.masjid_id`.
5. **`PUT /masjids/:id/external-ids/:app_id`:** `:app_id` must equal the key's `app_id` (else 403). If the masjid already has a different external id from this app → 409 `already_linked` (one-to-one; contract §9). Same id → 200 no-op. A link is an `update` change with `changed_fields: ["external_ids"]` and bumps the version.
6. **PATCH partial semantics:** `contacts` upsert by `type`; `{type, value: null}` deletes it. `facilities` upsert by `code`; `available: null` deletes it. Unknown code → 422. `images` replace the full list when present. `lat`/`lng` recompute `geohash` at precision 9 and are stored unrounded. `type_id`/`state_id`/`city_id` must exist (422).
7. **Programmes:** validate `category` against the contract list (§4.2, a constant in `src/lib/constants.ts`), `timezone` as an IANA name (`Intl.DateTimeFormat` throws on bad zones), `rrule` as starting with `FREQ=`, `end_at ≥ start_at`, and `poster_url`/`registration_url` as `https://`.
   - `GET /masjids/:id/events?from&to` returns rows with `status` in (`active`, `cancelled`) where (`rrule IS NOT NULL` or `COALESCE(end_at, start_at) >= from`) and `start_at < to`. `from` defaults to now and `to` to now + 90 days. No server-side expansion.
   - Creating an event emits `entity: "event"` with `masjid_id` set. It does not bump the masjid version.
8. **`GET /masjids/:id`** for a `merged` masjid → 301 with `Location: /masjids/<merged_into>`. A `deleted` masjid → 200 with the tombstone. List and search return `active` only.
9. `GET /facilities` returns the active catalogue.

## 5. S4 — Admin and rebuild support

All routes under `/admin/*` require the `admin` scope. Admin writes use the write pipeline with `origin_app: "sentral_admin"`.

1. **`POST /admin/masjids/:id/merge { "into": <id>, "reason" }`**, in one batch:
   - Loser: `status = merged`, `merged_into` set, version bumped.
   - Move the loser's `masjid_external_ids` and events to the survivor. Each event gets an `update` change with the new `masjid_id`.
   - Emit a `merge` change on the loser (contract §6.4) whose `after_json` includes `merged_into` and `moved_external_ids`.
   - Bump the survivor's version with an `update` change listing `external_ids`.
   - Refuse to merge into a non-active masjid or into itself.
2. **`POST /admin/changes/:seq/revert`:** applies `before_json` of that change as a new `update` (or a re-create for a delete) through the pipeline, with `actor: "revert:<seq>"`. Refuse merge reverts in v1.1 (422).
3. **Duplicate scan.** Table `duplicate_candidates(id, masjid_a, masjid_b, score, distance_m, status CHECK ('pending','merged','dismissed'), created_at, UNIQUE(masjid_a, masjid_b))` with `masjid_a < masjid_b`; put it in migration `005_duplicates.sql`.
   - A daily cron at `0 19 * * *` (03:00 MYT) scans masjids changed since the last scan (keep the cursor in a one-row `scan_state` table). Pairs with `score ≥ 0.8` and `distance_m ≤ 150` go in as pending.
   - Keep each run under 1,000 masjids and continue on the next run.
   - Endpoints: `GET /admin/duplicates?status=pending`, `POST /admin/duplicates/:id/dismiss`, and `POST /admin/duplicates/:id/merge { into }` (calls the merge above and marks the row merged).
4. **Key issue script** `api/scripts/issue-key.mjs <app_id> <scopes>`: prints a random 32-byte token (`ms_live_…`) and the `INSERT INTO api_keys` SQL with its SHA-256 hash. It never writes anywhere itself. The owner runs the SQL.
5. **`openapi.json`** brought to v1.1 to match the contract. `openapi.test.ts` checks that every route in `src/routes` appears in it.

## 6. Tests (minimum; add more as needed)

Every contract §10 check that the server can show, plus:
- **S1:** no key → 401; revoked key → 401; read key on POST → 403; missing actor → 422; error shape on 404/500; the dev key is rejected.
- **S2:** an idempotent replay returns an identical body; the same key with a different body → 409; the PATCH race (one 200, one 409, exactly one `changes` row); a failed version check writes no change row; a webhook is not queued for the writer's own app; signature verification round-trip; backoff schedule; feed pagination and ordering.
- **S3:** match scoring (fixtures: `MASJID AL-HIDAYAH` vs `Masjid Al Hidayah` 20 m apart → ≥ 0.9; `Surau Al-Ikhlas` vs `Surau An-Nur` 30 m → < 0.6); duplicate gate and force; one-to-one link; partial PATCH for contacts and facilities; bad category/timezone → 422; merged → 301.
- **S4:** merge moves links and events and emits the right changes; revert; the scan inserts each pair once; a non-admin key → 403 on `/admin/*`.

## 7. Hard rules

- Never run anything with `--remote`, never `wrangler deploy`, never `wrangler d1 migrations apply` without `--local`. The owner applies migrations and deploys. Sentral's production D1 is on a different Cloudflare account from JM.
- Never edit migrations 001/002. New schema = new numbered files.
- No personal data in `changes` or logs beyond the opaque actor (contract R8).
- Do not touch the `web/` or `masjid-sentral/` (Next.js) folders, or any JM repo.
- Commit per logical step on `feat/app-sync` in each repo, with messages like `feat(sync): …`.

## 8. Owner tasks after review (not for agents)

1. Bookmark the Sentral D1 (Time Travel), then apply 003–005 remotely.
2. Deploy the Worker. Issue keys for `qiyam` and `jejak_masjid` (and an admin key) with `scripts/issue-key.mjs`. Register both webhooks.
3. Give Qiyam the staging/prod URL and key. Qiyam's link job runs first; JM's after.
