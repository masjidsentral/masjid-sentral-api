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
