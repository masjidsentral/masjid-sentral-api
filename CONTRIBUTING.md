# Contributing to Masjid Sentral API

## Local Development Setup

1. Install dependencies:
   ```bash
   pnpm install
   ```

2. Apply D1 migrations (including the `api_keys` table) to your local database:
   ```bash
   wrangler d1 migrations apply masjidsentral --local
   ```
   Run this from the `api/` directory. This applies all migrations in
   `masjidsentral-db-schema/migrations/` including `002_api_keys.sql`,
   which creates the `api_keys` table and seeds the development test key.

3. Start the local dev server:
   ```bash
   pnpm run dev
   ```

## Test API Key

A development test key is seeded by `002_api_keys.sql` for local development
and automated tests. **Do not use this key in production.**

| Property | Value |
|----------|-------|
| Raw token | `test-api-key-dev` |
| Authorization header | `Authorization: Bearer test-api-key-dev` |

Example request with the test key:

```bash
curl -X POST http://localhost:8787/masjids \
  -H "Authorization: Bearer test-api-key-dev" \
  -H "Content-Type: application/json" \
  -d '{"name": "My Masjid", "type_id": "masjid", "state_id": "my-kul", "country_id": "my", "lat": 3.147, "lng": 101.698, "address": "1 Jalan Test", "source": "manual"}'
```

## API Key Storage

The D1 `api_keys` table stores only the **SHA-256 hash** of the raw token —
never the raw token itself. The hash for `test-api-key-dev` is:

```
08d55f7f36724e61a51e389109146c688f6d69f38658e861508b857a236d53b8
```

To provision a production key, generate a secure random token, compute its
SHA-256 hash, and insert it directly into D1:

```bash
wrangler d1 execute masjidsentral --command \
  "INSERT INTO api_keys (key_hash, name, is_active) VALUES ('<sha256-hash>', '<key-name>', 1)"
```
