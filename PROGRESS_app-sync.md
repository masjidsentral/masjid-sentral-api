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
