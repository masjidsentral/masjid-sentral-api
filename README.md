# Masjid Sentral API (v1.1)

Hono Worker on Cloudflare Workers + D1. The master copy of masjids and their programmes for Jejak Masjid, Qiyam and other apps. Apps write through this API and keep a local copy updated from `GET /changes` and webhooks.

**Status:** v1.1 is built and tested on branch `feat/app-sync`. It is **not deployed**; the owner deploys (see "Owner deploy order").

## Read this first

- **`docs/INTEGRATION_CONTRACT.md`** is the public contract and the source of truth for every request and response.
- `GET /openapi.json` (public) serves `openapi.json`, which matches the contract and lists every route, including `/admin/*`.
- `SPEC_app-sync.md` is the server build spec; `PROGRESS_app-sync.md` logs what was built, the interpretations made, and the deploy checklist.

## What v1.1 does

- **Keys on every route.** Every request except `GET /` and `GET /openapi.json` needs `Authorization: Bearer <key>`, reads included. Keys carry an `app_id` and scopes (`read`, `write`, `webhook`, `admin`); `/admin/*` needs `admin`. Keys are server-side secrets, so **there is no CORS**: call Sentral from a backend, never from a browser or a mobile app.
- **Versioned writes.** Every masjid and programme has a `version`. POST/PATCH/DELETE need `Idempotency-Key`; PATCH/DELETE need `If-Match`; every write needs `X-Sentral-Actor` (an opaque app-local id, never personal data). A lost race is `409 version_conflict` with `details.current`.
- **Change feed.** Each write is logged in one atomic D1 batch (`changes`). `GET /changes?after=` is the source of truth; webhooks (`changes.available`, HMAC-signed) only wake the other app up.
- **Linking and matching.** `external-ids` links, `by-external` lookups, `GET /masjids/match` and a duplicate gate on `POST /masjids`.
- **Programmes** (`/masjids/{id}/events`, `/events/...`) and the facility catalogue (`GET /facilities`).
- **Admin.** Merge a duplicate masjid, revert a logged change, a daily duplicate scan with a review queue (`/admin/duplicates`), and webhook registration.
- **Rate limit:** 600 requests per minute per key (Workers Rate Limiting binding `RATE_LIMITER`).

## Local development and tests

```sh
pnpm install
npx vitest run          # all tests (vitest + @cloudflare/vitest-pool-workers; migrations from ../masjidsentral-db-schema are applied per run)
npx tsc --noEmit        # types
pnpm run cf-typegen     # regenerate worker-configuration.d.ts after changing wrangler.jsonc
npx wrangler dev        # local Worker with a local D1; apply migrations first (below)
```

Migrations live in the sibling repo `../masjidsentral-db-schema/migrations/` (`001` to `005`). To prepare a local D1 for `wrangler dev` (local only, never `--remote`):

```sh
npx wrangler d1 migrations apply masjidsentral --local
```

Issue a key (prints the token once and the SQL; it writes nothing):

```sh
node scripts/issue-key.mjs <app_id> <scopes>     # e.g. qiyam read,write   |   jejak_masjid read,write,webhook   |   sentral_admin admin
```

The owner runs the printed SQL against the production D1. Agents never run `wrangler deploy` or any `--remote` command; the production D1 `masjidsentral` is on its own Cloudflare account (not JM's).

## Cron triggers

| Cron | Does |
|---|---|
| `* * * * *` | Dispatches due webhook pings (up to 40 per run) and deletes idempotency keys older than 24 h |
| `0 19 * * *` (03:00 MYT) | Duplicate scan: up to 1,000 changed masjids per run, then continues next run; queues pairs with score >= 0.8 within 150 m in `duplicate_candidates` |

## Owner deploy order

Ship S1 to S4 together, never S1 alone: S1 makes every read need a key and migration 004 empties the masjid data.

1. Check the remote `d1_migrations` table lists `001` and `002` and that `api_keys` exists (if they were applied by hand, record them in `d1_migrations` first, or wrangler will re-run them).
2. Take a D1 Time Travel bookmark of `masjidsentral`.
3. Apply `003`, `004` and `005` remotely. `004` is **destructive** (it empties all masjid data; the rebuild order is in contract section 9). Apply migrations **before** deploying: the new auth reads 003's columns.
4. Issue keys with `scripts/issue-key.mjs` (one per app: `qiyam`, `jejak_masjid`, plus an admin key) and insert them **before** the deploy. Migration 003 deletes the dev key; an old key becomes read-only with no app.
5. Confirm the `RATE_LIMITER` `namespace_id` in `wrangler.jsonc` ("1001" is a placeholder) is valid for the Sentral Cloudflare account.
6. Deploy the Worker. The deploy registers both cron triggers.
7. Register each app's webhook: `POST /admin/webhooks { api_key_id, url }` with the admin key (the target key needs an `app_id` and the `webhook` scope). The secret is shown once.
8. Give Qiyam the URL and key. Qiyam's link job runs first, JM's after.

The consolidated checklist, with the interpretations made in each phase, is in `PROGRESS_app-sync.md`.

## Layout

- `src/index.ts` (app, error handlers, `fetch` + `scheduled`), `src/routes/*`, `src/middleware/*`, `src/lib/*` (`write.ts` the write pipeline, `admin.ts` merge and revert, `scan.ts` duplicate scan, `match.ts` name matching)
- `tests/*` (run one suite at a time on a small machine)
- `scripts/issue-key.mjs`, `openapi.json`, `docs/INTEGRATION_CONTRACT.md`
