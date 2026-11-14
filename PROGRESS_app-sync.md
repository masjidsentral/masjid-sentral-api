# Progress: App Sync (SPEC_app-sync.md)

## S1 — Access control (2026-11-14, branch `feat/app-sync`, not merged/pushed/deployed)

Commits
- `masjidsentral-db-schema`: f09ab4b `feat(sync): 003 api_keys app_id/scopes/revoked_at, drop dev key`
- `api`: e1d4ca8 (source: auth, scopes, actor guard, error shape, rate limit, CORS removed), 1a38a69 (tests), plus this progress file in a follow-up commit

Built
- Migration `003_api_key_scopes.sql`: `app_id`, `scopes` (default `read`), `revoked_at`; deletes the dev key seeded by 002.
- `src/middleware/auth.ts`: runs on every route except `GET /` and `GET /openapi.json`; loads active (`is_active = 1`), unrevoked key; sets `c.set('key', { id, app_id, scopes })`; `requireScope(scope)`; `writeGuard` (global) for every POST/PATCH/PUT/DELETE outside `/admin/*`: needs `write` scope, key `app_id`, and `X-Sentral-Actor` 1–128 chars (422 otherwise). `getActor(c)` helper for S2.
- `src/lib/errors.ts`: `{ error, code, details? }`, `ApiError`. `app.onError` / `notFound` / every route error use it.
- `src/middleware/rate-limit.ts`: `createRateLimit(getLimiter)` (stubbable) keyed `key:<id>`; Workers Rate Limiting binding `RATE_LIMITER` (`ratelimits`, limit 600, period 60) in `wrangler.jsonc`; types regenerated. 429 `rate_limited` + `Retry-After: 60`.
- Global `cors()` removed.
- Tests: `tests/helpers.ts` (tokens), `tests/setup.ts` seeds keys (read; jm read,write; qiyam read,write; webhook; admin) after migrations; `tests/auth.test.ts` new; existing tests send keys.

Interpretations / deviations
1. Existing validation errors were HTTP 400; the contract's error table has no 400, so they are now 422 `validation_failed` (existing tests updated). Missing masjid is 404 `not_found`.
2. `writeGuard` is global and path-based (fail-safe) rather than per-route. `/admin/*` is exempt (admin routes use `requireScope('admin')`, S4). A non-admin-scoped key does not imply other scopes (admin key alone cannot write masjids).
3. Key without `app_id` on a write: 403 `forbidden` (spec did not give a status).
4. Rate limit runs after auth, so unauthenticated requests do not consume it. `Retry-After` is fixed at 60 s since the binding exposes only `success`. The `period` can only be 10 or 60, so 600/60 s as in the contract. `namespace_id` "1001" is a placeholder; the owner may need a unique id per account.
5. `Idempotency-Key`/`If-Match` enforcement is S2 (write pipeline) and not in `writeGuard`.
6. The auth rate-limit stub is tested via a small Hono app (the real binding is only smoke-tested); the 500 test breaks `env.DB` and calls the real app.
7. `npx tsc --noEmit` does not work out of the box: `typescript` is not in `api/package.json`. I ran tsc 5.7.2 from the bun cache (`node ~/.bun/install/cache/typescript@5.7.2@@@1/bin/tsc --noEmit`): clean. Suggest adding `typescript` as a devDependency (not done, avoids lockfile churn).
8. `openapi.json` still describes v1.0 (public reads, CORS); updated in S4 per spec. `README.md` also still says reads need no auth.

Deferred: everything in S2–S4.

### S1 review fixes (2026-11-14)

- `/admin` and `/admin/*` fail closed with `requireScope('admin')` (any method). `writeGuard` checks the actor on admin writes too; only the `write`-scope and `app_id` checks are skipped there.
- Actor: trimmed; empty-after-trim or any control character gives 422. The validated actor is stored on the context; `getActor()` throws if none (500 `internal`).
- Error mapping: HTTPException >= 500 is `internal`; `content-type` is no longer copied from the original response.
- Rate limit: warns once if the binding is missing. The vitest miniflare config raises the limiter to 1,000,000/min so suites cannot hit a random 429. The real app is tested with an injected denying stub: 429 after auth (no key still 401) and before `writeGuard`.
- Tokens must match `ms_live_` + 43 base64url chars or get 401 with no D1 query (test keys use `tok()`).
- Tests: `tests/auth-hardening.test.ts` (no-key matrix over routes and methods incl. HEAD/OPTIONS, admin 403s, actor edge cases, unchanged row counts, rate limit on the real app, issue-key script).
- `scripts/issue-key.mjs <app_id> <scopes>` (+ `--self-test`): prints the token once and the INSERT SQL; writes nothing.
- `typescript` added as a devDependency (pnpm), so `npx tsc --noEmit` works.
- Control-character actors: the fetch layer may refuse to send them; the test tolerates that.

### Deploy notes

- Apply migration 003 before deploying the Worker.
- Insert real keys first (`scripts/issue-key.mjs`), or every request returns 401.
- S1 must not ship to prod alone: reads now need keys, so existing keyless consumers break.
- `web/` dev portal still documents keyless reads (owner, out of scope).
- Confirm the `RATE_LIMITER` `namespace_id` ("1001" is a placeholder) is valid for the Sentral Cloudflare account.

## S2 — Schema, versions, change log, webhooks (2026-11-14, branch `feat/app-sync`, not merged/pushed/deployed)

Commits
- `masjidsentral-db-schema`: 19038ee `feat(sync): 004 app sync schema ...`
- `api`: e2ae750 (pipeline, entities, /changes, webhooks, admin webhooks, v1.0 handlers on the new schema, cron), plus a tests + progress commit after it.

Built
- `004_app_sync.sql` (DESTRUCTIVE header at top): drops/recreates the masjid tables; new `masjids` (version, updated_by_app, merged_into, status active|deleted|merged, no `source`), `masjid_images.url`, `masjid_facilities(code, available)`, `masjid_contacts` (8 types, unique per type), `masjid_events` (v1.1 shape, `masjid_event_images` dropped), `masjid_external_ids`, `event_external_ids`, `facility_catalogue` (provisional seed, 30 rows: JM's 29 codes + retired `OKU_FRIENDLY` inactive), `changes`, `idempotency_keys`, `webhook_subscriptions`, `webhook_deliveries`. Timestamp defaults are now ISO `...Z`. 001-003 untouched.
- `src/lib/write.ts`: `beginWrite()` (Idempotency-Key 422, If-Match 422 for PATCH/DELETE, request hash = SHA-256 of method + path + query + body, replay / 409 `idempotency_mismatch`) and `commitWrite()` / `runCommit()` (atomic batch, below). Replays carry `Idempotent-Replay: true`. Expired rows (>24 h) free their key.
- `src/lib/entities.ts` (contract §4.1 entity + loader), `src/lib/webhooks.ts` (HMAC signing/verify, dispatch with lease + backoff, idempotency sweep), `src/routes/changes.ts` (`GET /changes`, `/changes/latest`; needs `read`), `src/routes/admin.ts` (`POST/GET/DELETE /admin/webhooks`), cron `* * * * *` in `wrangler.jsonc`, `scheduled` exported next to `fetch` (default export is now `{ fetch, scheduled }`; the Hono app is the named export `app`, tests updated).
- v1.0 handlers (`list`, `nearby`, `detail`, `POST`, `PATCH`) adapted to the new schema; POST/PATCH go through the pipeline.

Atomicity (spec 3.2.3)
- Cloudflare docs: a D1 `batch()` is one SQL transaction, statements run sequentially and non-concurrently, any failure rolls the whole batch back.
- Order in the batch: (1) guarded `UPDATE ... WHERE id = ? AND version = ?`; (2) `INSERT INTO changes ... SELECT ... WHERE changes() = 1`; (3) `INSERT INTO idempotency_keys ... SELECT ... WHERE changes() = 1`; (4) child rows and (5) the webhook enqueue, each guarded by `EXISTS (idempotency row of this request)`.
- Why not `changes()` for everything (the spec's suggestion): a child statement can legitimately affect 0 rows (e.g. replacing an empty image list), which would break a changes() chain. After step 3 the idempotency row (a row written only by a winner) is the guard, so it is exact.
- `meta.changes` of statement 1 tells the handler the outcome (0 = lost: 409 with `details.current`, nothing persisted, no idempotency row).
- Create: the id is unknown in JS, so `changes`/idempotency JSON use `json_set(?, '$.id', last_insert_rowid())`; children use the id of the `changes` row just inserted (via `sqlite_sequence`).
- Proof: `tests/sync-write.test.ts`: HTTP race (`Promise.all` of two PATCHes: one 200, one 409 with `details.current`, one `changes` row, loser's idempotency row absent, loser's images not persisted); a deterministic test that commits a stale spec straight through `runCommit` (bypassing the handler's early check) and shows no change row, idempotency row, child rows or webhook delivery from the loser; a `changes()`-inside-batch semantics test; a rollback test (idempotency PK collision rolls back the entity write). Two requests sharing one Idempotency-Key are answered from the winner's stored response.

Interpretations / deviations
1. Webhook enqueue is inside the same batch (atomic with the write) instead of "after commit"; dispatch still runs after, via `waitUntil`. Own-app exclusion compares the subscription key's `app_id` with the writer's.
2. Only 200/201 successes are stored for idempotency (409/422 never). The request hash includes the query string.
3. `GET /masjids/:id` now returns exactly the contract entity (so `changes.data` equals GET). Dropped from v1.0: `reviews`, `events`, `avg_rating`, `review_count`, per-image `thumbnail_url`/`full_url`. List `thumbnail_url` is now the stored image URL. List/nearby rows keep integer `jumaat_available` (S3 reshapes). Merged id -> 301, deleted -> 200 tombstone (spec 4.8, done now since it is one branch).
4. POST needs `Idempotency-Key`; `source` is gone (ignored if sent). POST/PATCH accept `images` (https URLs, full replace) so child writes have a real consumer. `contacts`, `facilities`, `external_id` on POST/PATCH are ignored until S3. type/state/country/city ids are validated (422).
5. A PATCH that changes nothing still bumps the version (contract: +1 per accepted write); `changed_fields` lists only fields whose value actually changed. PATCH on a non-active masjid is 404.
6. `facility_catalogue`: JM's 0089 migration is the only `INSERT INTO facility` in `develop` (production drifted; earlier codes were seeded elsewhere), so the seed is 0089's 29 codes + `OKU_FRIENDLY` (inactive, documented as legacy there). JM's four flag-gated codes (KOLAH, ZAKAT_COUNTER, WIFI, COMMUNITY_KITCHEN) are active here. Malay labels are my draft translations: owner/Qiyam to review.
7. `/admin/webhooks`: the target key must be active, have an `app_id` and the `webhook` scope (else 422). `DELETE` removes the subscription and its delivery row (204). Added `GET /admin/webhooks` (never shows secrets). The secret (`whsec_` + 64 hex) is stored in plaintext in D1 (HMAC needs it).
8. No `410 cursor_expired`: nothing is pruned in v1.1, so it cannot occur yet.
9. The spec's `INSERT ... WHERE changes() = 1` suggestion is only safe for the first two follow-ups; see Atomicity.
10. `../masjidsentral-db-schema/migrations/002_api_keys.sql` shows as untracked in that repo (pre-existing, I did not touch it). Owner may want to commit it.

Deferred: all of S3, S4 (events/external-id endpoints, merge, revert, scans, openapi v1.1, README), `loadEvent` for event conflicts (event handlers pass `loadCurrent` in S3).

Deploy notes
- Apply 004 after 003 and **before** deploying the Worker (take a Time Travel bookmark first; 004 empties all masjid data). Deploy registers the per-minute cron trigger.
- Webhook registration after deploy: `POST /admin/webhooks { api_key_id, url }` with the admin key (the target key needs the `webhook` scope and an `app_id`).
- Webhook dispatch runs on the free plan within 50 outbound fetches per run (limit 50 rows) plus a handful of D1 calls.

## S2 review fixes (2026-11-14, branch `feat/app-sync`, not merged/pushed/deployed)

Commits: `masjidsentral-db-schema` 594c123 (`002_api_keys.sql` tracked, byte-identical, H2) and the 004 amend commit; `api`: `fix(sync)` pipeline, `fix(sync)` webhooks + feed, this note.

- **H1 abort guard.** Replaced the `EXISTS(idempotency row)` guard. After each guarded UPDATE the batch runs `INSERT INTO batch_guard (ok) SELECT CASE WHEN changes() = 1 THEN 1 ELSE 0 END`; `batch_guard` (004) is `ok INTEGER PRIMARY KEY, CONSTRAINT version_guard CHECK (ok = 1)` WITHOUT ROWID, then `DELETE FROM batch_guard`. A lost guard raises `CHECK constraint failed: version_guard`, D1 rolls the batch back, `runCommitMany` maps it to `{ ok: false }` (`isVersionGuardError`). Children, change rows, idempotency row and the enqueue are now unconditional (templates no longer use `{{G}}`; `{{ID}}` still works). Proven in `sync-write.test.ts` ("raises inside a D1 batch...": an earlier UPDATE in the same batch is rolled back too). Create has no guard.
- **Shared-key test.** Winner A (masjid X) commits; loser B has the same key, a different request and a stale version on masjid Y: B persists nothing (no images, no version bump, no change row, no delivery). Response: B's retry check finds A's row with a different request hash, so `409 idempotency_mismatch` (a same-request retry would be replayed instead).
- **M3.** `runCommitMany(ctx, specs[])`: per spec entity write + guard + change row (+ children); one idempotency row (response = first spec's entity), one enqueue at the end. `runCommit` = one-spec case. Test: second guard losing rolls back the first entity. Merge (S4) should list the survivor first.
- **M1.** `lookupIdempotent` re-check on guard loss (as before) and new shared `replayOnConflict(ctx, fn)`: any 404 or `version_conflict` from the handler's early checks re-checks idempotency and replays (same hash) or answers `idempotency_mismatch`. PATCH wraps its body in it; S3 handlers should do the same after `beginWrite`.
- **M2.** Enqueue conflict keeps `attempts`/`next_attempt_at`/`last_error` for rows `pending` with `attempts > 0`, only advancing `latest_seq`; delivered, dropped and never-attempted rows reset (dropped endpoints revive on the next change). Also changed: a failed send now counts even if a newer change arrived mid-flight (previously the `latest_seq` match discarded it, so steady writes could prevent dropping); successes still only apply to an unchanged `latest_seq`. Test walks 1 to 6 attempts under continuous writes.
- **L1** `replaceAll` for templates. **L2** `/changes` splices stored `after_json` and `changed_fields` text (no parse/stringify); max `limit` stays 500, contract unchanged. **L3** `BATCH_LIMIT` 40. **L4** enqueue and dispatch join `api_keys` (`is_active = 1 AND revoked_at IS NULL`). **L6** `UNIQUE (api_key_id, url)` in 004; duplicate registration is `409 already_exists` (secret never re-shown; delete and re-register to rotate). Webhook secret encryption: not done (optional).
- Contract note for the orchestrator: new error code `already_exists` (409) on `POST /admin/webhooks` (admin endpoint, not in the Qiyam contract).

Tests: 194 passing (`npx vitest run`), `npx tsc --noEmit` clean.

Deploy note: before applying 003/004, the owner must check the remote `d1_migrations` list shows 001 and 002 applied. 002 is now committed in the schema repo. If prod never recorded 002, it must run first (it is unchanged on disk). 004 now also creates `batch_guard` and the webhook UNIQUE; it is still destructive (Time Travel bookmark first).

## S3 — Contract endpoints (2026-11-14, branch `feat/app-sync`, not merged/pushed/deployed)

Commits (`api` only; no schema change, 004 untouched): `feat(sync): S3 endpoints ...` (source), `feat(sync): S3 tests ...`, this note. Tests: 270 passing (`npx vitest run`), `npx tsc --noEmit` clean.

Built
- `src/lib/match.ts`: normalisation, Jaro-Winkler (TS), score, `findCandidates` (geohash ranges + haversine, 1 km, best 50 scored). `src/lib/constants.ts` (categories, contact types), `src/lib/page.ts` (limit/cursor/instant parsing), `geohashRanges`/`haversineM` in `geo.ts` (range scans `geohash >= p AND < p~` use the plain index; cell size picked so the 9-cell ring always covers the radius).
- Masjids: list (filters `state city type name|q jumaat updated_since`, `limit` <= 100, opaque `cursor`, `{ data, next_cursor }`, full contract entities, active only), nearby (metres, max 20,000, nearest first, `distance_m`, limit/cursor), `match`, `by-external`, POST (gate, `external_id`, contacts/facilities/images), PATCH (partial contacts by type, facilities by code, null deletes, unknown code 422), `PUT /masjids/:id/external-ids/:app_id`, `DELETE`.
- Programmes (`src/routes/events.ts`): `GET /events?masjid_ids=`, `/events/:id`, `/events/by-external/...`, `GET|POST /masjids/:id/events`, `PATCH`/`DELETE /events/:id`; `loadEvent`/`hydrateEvents` in `entities.ts` (event 409s return `details.current`).
- `GET /facilities`. All GET routes in these routers need the `read` scope.
- Every new mutating handler: `beginWrite` then `replayOnConflict`, writes via `commitWrite`. List endpoints batch-load children with `json_each(?)` (4 queries per page, not per masjid; also stays under D1's 100-bind limit).
- Pipeline additions (`write.ts`): `WriteSpec.changeExtra` (keys recorded in `changes.after_json` only; used for `"forced": true`) and `beginWrite({ idempotencyOptional })` (PUT).

New error codes
- `possible_duplicate` (409, `details.candidates[]`), `already_linked` (409; `details.masjid_id`, `app_id`, `external_id`; for programmes `details.event_id`). No other new codes. `already_exists` stays admin-only (S2).

Interpretations / deviations (orchestrator: review for the contract)
1. **Spec fixture 2 needs the Winkler threshold.** Surau Al-Ikhlas vs Surau An-Nur (30 m): `alikhlas` vs `annur` has Jaro 0.442; with the prefix boost always applied the score is 0.631 (> 0.6, fixture fails). I apply the boost only when Jaro > 0.7 (Winkler's original rule), giving 0.591. Fixture 1 scores 0.988.
2. **Response shapes the contract leaves open:** list/nearby/events lists are `{ "data": [...], "next_cursor": string|null }` (full contract entities; nearby rows add `distance_m`); match is `{ "candidates": [ { id, name, type_id, lat, lng, address, external_ids, score, distance_m } ] }` (same objects as `details.candidates`); facilities is `{ "data": [ { code, label_en, label_ms, sort_order } ] }`. Please write these into the contract. Old `meta {total,page,per_page}` and `?page=` are gone (v1.0 shape; existing tests updated).
3. `PUT .../external-ids` does not require `Idempotency-Key` (contract R4 lists only POST/PATCH/DELETE) nor `If-Match`; a missing key gets a private random one, and the handler is naturally idempotent (same id = 200 no-op, no version bump). On a version race it reloads and retries up to 3 times. `Idempotency-Key` is honoured if sent.
4. `forced: true` is written to `changes.after_json` whenever `?force=true` is sent (not only when a duplicate existed, since a forced request skips the candidate query). The 201 response and stored idempotent response do not contain it; `/changes` `data` does (R10 makes it harmless).
5. Gate order on POST: validation, `already_linked`, then `possible_duplicate`. Gate uses all candidates within 1 km (best 50 by score), not only the top 5; `details.candidates` lists up to 5 qualifying ones.
6. Retired (inactive) catalogue codes (`OKU_FRIENDLY`) cannot be set (422 like unknown) but can be cleared with `available: null`.
7. `by-external` returns the entity in any status (deleted tombstone, merged row as is). A deleted masjid keeps its external ids, so re-POSTing the same `external_id` is `already_linked`. Revive/relink after delete is not specified (S4 revert?).
8. DELETE on a non-active masjid/programme is 404 (like PATCH). Programmes: PATCH `status: deleted` is 422 (use DELETE), PATCH on a deleted programme is 404, `GET /events/:id` returns the tombstone. A programme POST to a missing, deleted or merged masjid is 404 (`details.merged_into` when merged). `GET /masjids/:id/events` of a merged masjid is 301 to the survivor, of a deleted/missing one 404. `/events?masjid_ids=` hides programmes of non-active masjids.
9. Dates: `start_at`/`end_at`/`from`/`to`/`updated_since` must be ISO 8601 UTC ending in `Z` (real calendar instants; offsets are 422), normalised to second precision. `GET` events default window: now .. now + 90 days; ordered by `start_at, id`; `limit` default 50, max 100. List default `limit` 20, nearby default radius 5,000 m.
10. `contacts`/`facilities` listing the same key twice in one request is 422. POST accepts `contacts`, `facilities`, `images`, `external_id`; a `null` entry on POST is ignored.
11. A PATCH still bumps the version when nothing changed (S2 rule). `GET` list entities carry `images` etc. in full, so a 100-row page is heavier than v1.0's slim rows; `limit` default 20 keeps typical calls small.
12. Test helper `createMasjid` now sends `?force=true` by default (the gate would reject the repeated fixture); pass `{ force: false }` to exercise the gate. One S2 test asserts `after_json == GET`, so it creates at a distinct spot without force.

Contract §10 checks shown at server level in `tests/s3-masjids.test.ts` / `tests/events.test.ts`: 2, 3, 7, 8, 9, 11 (plus programme 409/idempotency/race).

Not done / for S4: admin routes, merge (so check 10), revert, duplicate scan, `openapi.json` v1.1 (still v1.0; `openapi.test.ts` unchanged), README.

## S3 review fixes (2026-11-14, branch `feat/app-sync`, not merged/pushed/deployed)

Commits: schema repo `da433bd` (004 gains `batch_precondition`, amended in place, not applied anywhere); `api`: `fix(sync)` search window + matching, `fix(sync)` pre-guards / linking / cascade / relink / timestamps / low fixes, this note. Tests: 308 passing (`npx vitest run`), `npx tsc --noEmit` clean. New tests: `tests/s3-review.test.ts`, additions in `tests/match.test.ts`.

What a client can see (for the contract)
1. **Nearby / match cost.** Same results. Candidate search now uses a lat/lng box plus at most 16 geohash cells (finest precision 1-8 chars), forced onto `idx_masjids_geohash` (without stats SQLite chose the status index and scanned every active masjid). No response change.
2. **Pre-guards.** Programme POST / PATCH / DELETE / link on a masjid that is not active: 404 `not_found` (`details.merged_into` when the masjid is merged), also when the status changes between the handler's reads and the commit. New table `batch_precondition` (constraint `precondition_guard`) in 004; a lost version race is still 409 `version_conflict`. `PATCH`/`DELETE` of a programme on a non-active masjid used to succeed: now 404.
3. **New endpoint** `PUT /events/{id}/external-ids/{app_id}` body `{ "external_id": "..." }`: own app only (else 403), one id per app per programme, same id = 200 no-op, `Idempotency-Key` optional, no `If-Match`; 200 with the programme (version +1) and an `event` `update` change with `changed_fields: ["external_ids"]`. Id held by an active programme (or another id already linked): 409 `already_linked` (`details.event_id`); missing/deleted programme or non-active masjid: 404.
4. **Masjid DELETE cascades.** In one batch: the masjid (`status: deleted`) and every non-deleted programme (`status: deleted`, version +1, one `event` `delete` change each, `masjid_id` set). Response is still the masjid. More than **200** non-deleted programmes: 422 `validation_failed` with `details.reason: "too_many_events"` (and `max_events: 200`), nothing deleted. A programme created after the handler's listing aborts the batch: 409 `version_conflict` (retry).
5. **Relink after delete.** Deleted masjids/programmes keep their external ids. POST `external_id` or PUT link whose `(app_id, external_id)` is held by a **deleted** masjid/programme moves the link in one batch: the tombstone gets version +1 and an `update` change (`changed_fields: ["external_ids"]`, `origin_app` = the caller) and loses the id; the target gets it (change rows in that order). Held by an active or merged one: 409 `already_linked`. `GET .../by-external/...` returns the holder whatever its status (masjid: a merged holder is followed to its survivor with 200; a deleted one is the tombstone).
6. **Matching.** Normalisation expands kg/kpg, tmn, jln, bdr, bt, seri->sri, sg, bkt, tg; leading words now include mosque, musholla, mushola, langgar; both article forms (`alhidayah`, `hidayah`) are compared, max taken. A differing number token (digits, roman ii-ix) or single-letter token between the two names caps name similarity at 0.8 (also when only one name has one). `GET /masjids/match` accepts optional `type_id`; every candidate (in `/masjids/match` and in `details.candidates` of `possible_duplicate`) has `same_type`: `true`/`false` when `type_id` was given, **`null` when it was not** (contract says boolean: I chose null over a misleading false). **POST gate** now fires only for score >= 0.9, distance <= 50 m **and** same `type_id`.
7. **Timestamps** (`start_at`, `end_at`, `from`, `to`, `updated_since`): RFC 3339 with `Z` or an offset (`+08:00`); stored/returned as UTC `Z`, second precision. Invalid (bad date, hour > 23, offset > 23:59, no zone) 422. In a query string an unescaped `+` arrives as a space and is read as `+`.
8. **Low.** HEAD needs the `read` scope like GET (403 otherwise). `timezone` is canonicalised (`asia/kuala_lumpur` -> `Asia/Kuala_Lumpur`). `/masjids/nearby` cursor is now keyset on `(distance, id)` (opaque; a cursor from the previous offset format is 422); stable under inserts. PATCH `changed_fields` includes `geohash` when the geohash changed (lat/lng edits). PUT/PATCH/DELETE on a merged masjid: 404 with `details.merged_into` (deleted or missing: 404 without details).

Internal: `WriteSpec` gained `preGuards`, `onPreconditionLost`, `respond`; `commitWrite` accepts a spec array; `runCommit*` results carry `reason: 'version' | 'precondition'`; `src/lib/specs.ts` holds link/tombstone/delete spec builders. Events list active-masjid filter is a correlated EXISTS; `hydrateMasjids` groups children with a Map.

New match scores (distance in brackets, score = 0.7 sim + 0.3 dist):
| Pair | sim | score |
|---|---|---|
| Surau Al-Ikhlas / Masjid Al-Ikhlas (30 m) | 1.000 | 0.982 (gate skipped: different type) |
| Surau Al-Hidayah Blok A / Blok B (40 m) | 0.800 | 0.836 |
| Surau Taman Desa Fasa 1 / Fasa 2 (40 m) | 0.800 | 0.836 |
| Kg Baru / Kampung Baru (40 m) | 1.000 | 0.976 |
| Tmn Melati / Taman Melati (40 m) | 1.000 | 0.976 |
| Taman Melati / Taman Melawati (40 m) | 0.971 | 0.956 (still >= 0.9: a person confirms with force) |
| MASJID JAMEK SULTAN ABDUL SAMAD / Masjid Jamek Kuala Lumpur (40 m) | 0.829 | 0.857 (review band) |
| MASJID AL-HIDAYAH / Masjid Al Hidayah (20 m) | 1.000 | 0.988 |
| Surau Al-Ikhlas / Surau An-Nur (30 m) | 0.442 | 0.591 |

## S4 — Admin, scan, openapi v1.1, README (2026-11-14, branch `feat/app-sync`, not merged/pushed/deployed)

Commits
- `masjidsentral-db-schema`: 1e6d309 `feat(sync): 005 duplicate_candidates and scan_state` (additive; 001-004 untouched).
- `api`: f8d19b7 (source: merge, revert, scan, queue, cron), e79b8c3 (tests), 3c0e1e3 (openapi v1.1, README, route-coverage test), plus this note.
- Tests: 343 passing (`npx vitest run`), `npx tsc --noEmit` clean. New: `tests/s4-admin.test.ts` (17), `tests/s4-scan.test.ts` (11), 7 added to `tests/openapi.test.ts`.

Built
- `src/lib/admin.ts`: `buildMergeSpecs`, `buildRevertSpecs`, `adminCtx`. `src/lib/scan.ts`: `runDuplicateScan`. `src/routes/admin.ts`: `POST /admin/masjids/:id/merge`, `POST /admin/changes/:seq/revert`, `GET /admin/duplicates`, `POST /admin/duplicates/:id/dismiss`, `POST /admin/duplicates/:id/merge`.
- `match.ts`: `candidateStatement` / `scoreRows` split out of `findCandidates` (same behaviour); `specs.ts`: `loadLiveEvents` and `masjidDeleteSpecs` (DELETE /masjids/:id now uses it; revert-of-create reuses it).
- Cron `0 19 * * *` added next to `* * * * *`; `scheduled` dispatches on `controller.cron` (scan on the daily one, webhook dispatch + idempotency sweep otherwise).
- `openapi.json` v1.1.0 (25 paths, 32 operations, generated once then committed as plain JSON), bearer auth on all but `/` and `/openapi.json`, Error schema with all 11 codes. `tests/openapi.test.ts` fails if a registered route is undocumented (or a documented one is not registered), checks security, operationIds, path params, `$ref`s, error codes, and that the Masjid schema lists exactly the fields the server returns.
- `README.md` rewritten (v1.1 summary, keys, no CORS, contract location, dev/test commands, crons, owner deploy order; says not deployed).

Merge semantics (`POST /admin/masjids/:id/merge { into, reason? }`; the path masjid is removed)
- One `runCommitMany` batch, survivor first: (1) survivor `update` (`changed_fields: ["external_ids"]`, version +1); (2) loser `merge` (`status: merged`, `merged_into`, its `masjid_external_ids` rows re-pointed to the survivor, version +1) = the idempotent response; (3) one `event` `update` per non-deleted programme (`masjid_id` -> survivor, version +1, change `masjid_id` = survivor). Deleted programmes stay on the loser.
- Pre-guards (inside the batch): both masjids active and different; no programme appeared on the loser since it was listed. A lost guard re-reads: not active -> 422 `not_active` (`details.masjid_id`, `status`), otherwise 409 `version_conflict`. Stale versions of survivor/loser/events lose the version guard -> 409 (nothing persists; tested).
- `into == id` 422 (`same_masjid`); missing masjid 404; > 200 live programmes 422 `too_many_events`. `Idempotency-Key` is optional on admin writes (auto key if absent), replays honoured when sent.
- The loser's `merge` change `after_json` = merged entity (`external_ids: []`) plus `merged_into`, `moved_external_ids`, optional `reason`. The survivor and event changes carry `via_merge: <loser id>` (change log only; a client sees it in `/changes` `data`, R10 makes it harmless). `by-external` of any moved id returns the survivor directly (200); `GET /masjids/<loser>` is 301.
- Queue rows resolved in the same batch: the pair's pending row -> `merged`; every other pending row involving the loser -> `dismissed` (chosen over re-pointing: the survivor's version bump moves its `updated_at`, so the next scan looks at it again and re-queues any real remaining duplicate). Applies to the plain merge too.

Revert semantics (`POST /admin/changes/:seq/revert`, no body, no If-Match)
- Applies `before_json` as a new write, version = current + 1, `actor: "revert:<seq>"`, `origin_app: "sentral_admin"`. Full restore: all scalar columns (geohash included), contacts / facilities / images replaced when they differ, external-id rows deleted when `before_json` lacks them and re-added when it has them (checked first: an id now held by another entity -> 409 `already_linked`, nothing changes). `changed_fields` = fields that actually differ. Programmes: all columns plus link rows.
- Revert of a **create** = soft delete (op `delete`, with the programme cascade for a masjid, 200-programme cap applies). Revert of a **delete** = update back to `before_json` (status active), only if the entity is currently deleted (else 422 `not_deleted`); cascade-deleted programmes stay deleted (revert each). Revert of an update on a deleted entity: 422 `entity_deleted` (revert the delete first). Already-deleted create revert: 422 `already_deleted`.
- Refused 422: `merge` changes and every change carrying `via_merge` (`merge_not_revertable`), merged masjids (`entity_merged`, `details.merged_into`), a programme whose masjid is not active (`masjid_not_active`, checked in-batch), damaged `before_json` (`bad_before_json`). Unknown seq 404. A write between read and commit loses the version guard -> 409.
- A revert of a revert works (re-adds what the first removed).

Duplicate scan (`src/lib/scan.ts`)
- Cursor `(updated_at, id)` in `scan_state` (migration 005; one row). Each run: active masjids past the cursor, oldest first, `LIMIT 1000` (index `idx_masjids_updated_at`); one bounded 150 m search (`candidateStatement`: lat/lng box + <= 16 geohash cells, `INDEXED BY idx_masjids_geohash`) per masjid, 100 searches per `db.batch`; `scoreRows`; pairs with score >= 0.8 and distance <= 150 m inserted `INSERT OR IGNORE` as `pending` (`masjid_a < masjid_b`, `UNIQUE`). Non-active masjids are excluded by the search (so skipped on both sides). A dismissed or merged pair is never re-queued (its row stays).
- Not caught up (1,000 reached): cursor = last masjid scanned, the next run continues. Caught up: cursor parks at now minus 5 minutes (never backwards) so a masjid written in the cursor's second, or during the run, is rescanned next time; the overlap is harmless (INSERT OR IGNORE).
- **Cost, measured (local D1, 1,020 active masjids, 1,000 scanned, 20 twin pairs)**: 14 D1 round trips (state, select, 10 search batches, 1 insert batch, cursor), 10,878 rows read (about 11 per masjid), 20 pairs found and inserted, 116 ms wall time including the local D1 simulation. Free plan: 14 of 50 subrequests; roughly 11k rows/day against the 5M/day read allowance. CPU is not separately measurable here (10 ms free-plan CPU is a real risk for 1,000 Jaro-Winkler scorings plus JSON decode; if the first prod run is CPU-limited the cursor does not advance, so lower `SCAN_MAX_MASJIDS` in `src/lib/scan.ts` and redeploy). The cron handler catches and logs scan errors, so it never blocks webhook dispatch (separate trigger).
- Queue: `GET /admin/duplicates?status=pending|merged|dismissed|all&limit&cursor` -> `{ data, next_cursor }`, keyset on id ascending, each row `{ id, status, score, distance_m, same_type, masjid_a, masjid_b (id, name, type_id, lat, lng, address, status, external_ids), created_at, resolved_at }`. `dismiss`: pending -> dismissed; twice = 200; a merged row 422 `not_pending`. `POST /admin/duplicates/:id/merge { into }`: `into` must be `masjid_a` or `masjid_b` (else 422), pending only, then the same merge write; response = the removed masjid.

Interpretations / things for the orchestrator
1. **Contract edits needed (I did not touch the contract):** (a) section 6.4: say the survivor may hold two ids from one app and `by-external` for either returns the survivor; the merge `data` also has `moved_external_ids` (and `reason` when given); `data.external_ids` of the removed masjid is empty. (b) section 8: a revert of a create arrives as op `delete`, of a delete as `update`; merges cannot be reverted in v1.1. (c) Optional: `/changes` `data` of merge-made changes carries an extra `via_merge` key (covered by R10).
2. Admin writes record `origin_app: "sentral_admin"`; the admin key's own `app_id` is ignored. Revert replaces the actor header with `revert:<seq>`, so the admin's own actor id is not recorded there (the seq identifies the reverted change).
3. Merge/revert accept `Idempotency-Key` but do not require it (admin tool ergonomics). Dismiss is a plain row update (no pipeline, no change log: the queue is not part of the feed).
4. Programme `masjid_id` changes in a merge are `update` changes with `changed_fields: ["masjid_id"]`.
5. `scan_state` holds the cursor as (`last_updated_at`, `last_id`) plus `last_run_at` (extra column vs the spec's "one-row table").
6. No endpoint triggers a scan on demand; the daily cron only. To test locally call `runDuplicateScan(env.DB)`.
7. The `ms_live_` admin test key has `app_id: sentral_admin`; a production admin key may have a null `app_id`; both work (`beginWrite` falls back to `sentral_admin`).

### Consolidated owner deploy checklist (S1-S4)

1. Ship S1-S4 together, never S1 alone (reads need keys from S1; 004 empties masjid data).
2. Check remote `d1_migrations`: `001` and `002` recorded and `api_keys` present (record them by hand first if they were applied outside wrangler).
3. D1 Time Travel bookmark of `masjidsentral` (004 is destructive).
4. Apply migrations `003`, `004`, `005` remotely **before** deploying (new auth reads 003's columns; the daily cron reads 005's tables).
5. Issue keys with `scripts/issue-key.mjs <app_id> <scopes>` and insert them **before** the deploy: `qiyam` (read,write), `jejak_masjid` (read,write), an admin key (admin), and a `webhook`-scoped key per receiving app (it needs an `app_id`; may be the app's own key with `read,write,webhook`).
6. Rate-limit namespace: set a valid unique `namespace_id` for `RATE_LIMITER` in `wrangler.jsonc` ("1001" is a placeholder), 600 per 60 s.
7. Deploy the Worker; it registers two crons: `* * * * *` (webhook dispatch, idempotency sweep) and `0 19 * * *` (duplicate scan, 03:00 MYT). Check both appear in the dashboard.
8. Register webhooks with the admin key: `POST /admin/webhooks { api_key_id, url }` for Qiyam and JM (https only; secret shown once; duplicate registration is 409 `already_exists`).
9. Hand Qiyam the URL and key; Qiyam's link job first, JM's after. Watch the first `0 19 * * *` run in the logs (`duplicate scan {...}` JSON line); if it is CPU-limited, lower `SCAN_MAX_MASJIDS`.
10. `web/` dev portal still documents keyless reads (owner, out of scope).
