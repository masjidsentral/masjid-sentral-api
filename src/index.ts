import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import openApiSpec from '../openapi.json' with { type: 'json' }
import { masjidsRouter } from './routes/masjids'
import { statesRouter } from './routes/states'
import { citiesRouter } from './routes/cities'
import { changesRouter } from './routes/changes'
import { adminRouter } from './routes/admin'
import { eventsRouter } from './routes/events'
import { facilitiesRouter } from './routes/facilities'
import { dispatchDue, purgeIdempotency } from './lib/webhooks'
import { runDuplicateScan } from './lib/scan'
import { authMiddleware, requireScope, writeGuard, type AppEnv } from './middleware/auth'
import { rateLimitMiddleware } from './middleware/rate-limit'
import { ApiError, errorBody } from './lib/errors'

const app = new Hono<AppEnv>()

// No CORS: keys are server-side only (contract R1).
// Every route needs a key except GET / and GET /openapi.json (handled inside authMiddleware).
app.use('*', authMiddleware)
app.use('*', rateLimitMiddleware)
// Admin fails closed: every /admin route (any method) needs the admin scope.
app.use('/admin', requireScope('admin'))
app.use('/admin/*', requireScope('admin'))
app.use('*', writeGuard)

app.get('/openapi.json', (c) => {
  return c.json(openApiSpec)
})

app.get('/', (c) => {
  return c.text('Hello Hono!')
})

app.route('/masjids', masjidsRouter)
app.route('/states', statesRouter)
app.route('/cities', citiesRouter)
app.route('/changes', changesRouter)
app.route('/events', eventsRouter)
app.route('/facilities', facilitiesRouter)
app.route('/admin', adminRouter)

// Error shape: { error, code, details? } (contract §1). No stack traces in responses.
app.onError((err, c) => {
  if (err instanceof ApiError) {
    return c.json(errorBody(err.message, err.code, err.details), err.status as 401, err.headers)
  }
  if (err instanceof HTTPException) {
    if (err.status >= 500) {
      console.error(err)
      return c.json(errorBody('Internal server error', 'internal'), 500)
    }
    const code = err.status === 401 ? 'unauthorized' : err.status === 403 ? 'forbidden' : err.status === 404 ? 'not_found' : 'validation_failed'
    const headers = Object.fromEntries(err.getResponse().headers)
    delete headers['content-type']
    return c.json(errorBody(err.message || 'Request failed', code), err.status as 401, headers)
  }
  console.error(err)
  return c.json(errorBody('Internal server error', 'internal'), 500)
})

app.notFound((c) => {
  return c.json(errorBody('Not found', 'not_found'), 404)
})

export { app }

/** The daily duplicate scan (03:00 MYT). The per-minute trigger does everything else. */
export const SCAN_CRON = '0 19 * * *'

// Default export carries both handlers: HTTP and the cron triggers. `* * * * *`: webhook dispatch and the
// idempotency sweep. `0 19 * * *`: the duplicate scan.
export default {
  fetch: app.fetch,
  async scheduled(controller: ScheduledController, env: CloudflareBindings, ctx: ExecutionContext) {
    if (controller.cron === SCAN_CRON) {
      ctx.waitUntil(
        runDuplicateScan(env.DB)
          .then(stats => console.log('duplicate scan', JSON.stringify(stats)))
          .catch(err => console.error('duplicate scan failed', err)),
      )
      return
    }
    ctx.waitUntil(Promise.all([
      dispatchDue(env.DB),
      purgeIdempotency(env.DB),
    ]).then(() => undefined))
  },
} satisfies ExportedHandler<CloudflareBindings>
