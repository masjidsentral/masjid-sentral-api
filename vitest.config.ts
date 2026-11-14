import { defineConfig } from 'vitest/config'
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      // Raise the limiter so suites can never hit a random 429 (429 behaviour is tested with stubs).
      miniflare: { ratelimits: { RATE_LIMITER: { simple: { limit: 1000000, period: 60 } } } },
    }),
  ],
  test: {
    globalSetup: ['./tests/globalSetup.ts'],
    setupFiles: ['./tests/setup.ts'],
  },
})
