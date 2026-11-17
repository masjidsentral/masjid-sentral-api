# Masjid Sentral API

Hono Worker on Cloudflare Workers + D1. It is the master copy of masjids and their programmes for Jejak Masjid and Qiyam (owner 2026-11-14).

## Read first

- `docs/INTEGRATION_CONTRACT.md`: the public API contract shared with Qiyam. It is the source of truth for every request and response.
- Open specs: `SPEC_*.md` in this folder. Progress logs: `PROGRESS_*.md`.

## Layout

- `src/index.ts` (app, error handlers), `src/routes/*`, `src/middleware/auth.ts`, `src/lib/*`, `src/types/db.ts`
- Migrations live in the sibling repo `../masjidsentral-db-schema/migrations/` (`wrangler.jsonc` `migrations_dir`, `tests/globalSetup.ts`).
- Tests: `npx vitest run` (vitest + `@cloudflare/vitest-pool-workers`; migrations are applied per test run). Types: `npx tsc --noEmit`. Regenerate bindings: `pnpm run cf-typegen`.

## Hard rules

- Never `--remote`, never `wrangler deploy`, never apply migrations without `--local`. The owner deploys and migrates. Sentral runs on its own Cloudflare account `7e72c27f3de3f130ec221a937ac22557` (owner 2026-11-17), which also holds the `masjidsentral.com` zone; never deploy it to the JM account `0283b7…`. Prod D1 = `masjidsentral-v2` (fresh for v1.1); the old `masjidsentral` D1 is a frozen backup. Wrangler for this repo uses an account-scoped `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`, not the JM `wrangler login`.
- Never edit an existing migration. Add a new numbered file.
- Every request needs an API key, reads included. Keys are server-side only, so there is no CORS.
- No personal data in the change log or logs. `X-Sentral-Actor` is an opaque app-local id.
- Workflow: no GSD (the `.planning/` folder at the workspace root is legacy). Specs are built on a `feat/*` branch, reviewed, then merged to `main` by the orchestrator.
- Do not touch `../web/` or `../masjid-sentral/` (the Next.js app has a destructive reset migration — never point it at the real D1).
