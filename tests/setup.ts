// Test setup (Workers context) — applies D1 migrations before each test suite
import { beforeAll } from 'vitest'
import { applyD1Migrations } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { inject } from 'vitest'

beforeAll(async () => {
  const migrations = inject('D1_MIGRATIONS')
  await applyD1Migrations(env.DB, migrations)
})
