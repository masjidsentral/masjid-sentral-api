// Global setup (Node.js context) — reads D1 migrations once and provides them to tests
import path from 'path'
import { readD1Migrations } from '@cloudflare/vitest-pool-workers'
import type { D1Migration } from '@cloudflare/vitest-pool-workers'

declare module 'vitest' {
  export interface ProvidedContext {
    D1_MIGRATIONS: D1Migration[]
  }
}

export async function setup({ provide }: { provide: <K extends keyof import('vitest').ProvidedContext>(key: K, value: import('vitest').ProvidedContext[K]) => void }) {
  const migrationsPath = path.resolve(__dirname, '../../masjidsentral-db-schema/migrations')
  const migrations = await readD1Migrations(migrationsPath)
  provide('D1_MIGRATIONS', migrations)
}
