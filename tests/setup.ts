// Test setup (Workers context) — applies D1 migrations, then seeds test API keys
import { beforeAll } from 'vitest'
import { applyD1Migrations } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { inject } from 'vitest'
import { KEYS, sha256Hex } from './helpers'

beforeAll(async () => {
  const migrations = inject('D1_MIGRATIONS')
  await applyD1Migrations(env.DB, migrations)

  for (const [name, k] of Object.entries(KEYS)) {
    await env.DB
      .prepare(
        `INSERT OR IGNORE INTO api_keys (key_hash, name, app_id, scopes) VALUES (?, ?, ?, ?)`
      )
      .bind(await sha256Hex(k.token), `test-${name}`, k.app_id, k.scopes)
      .run()
  }
})
