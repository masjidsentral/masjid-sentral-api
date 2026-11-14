import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import openApiSpec from '../openapi.json' with { type: 'json' }
import { masjidsRouter } from './routes/masjids'
import { statesRouter } from './routes/states'
import { citiesRouter } from './routes/cities'
import { authMiddleware, writeGuard, type AppEnv } from './middleware/auth'
import { rateLimitMiddleware } from './middleware/rate-limit'
import { ApiError, errorBody } from './lib/errors'

const app = new Hono<AppEnv>()

// No CORS: keys are server-side only (contract R1).
// Every route needs a key except GET / and GET /openapi.json (handled inside authMiddleware).
app.use('*', authMiddleware)
app.use('*', rateLimitMiddleware)
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

// Error shape: { error, code, details? } (contract §1). No stack traces in responses.
app.onError((err, c) => {
  if (err instanceof ApiError) {
    return c.json(errorBody(err.message, err.code, err.details), err.status as 401, err.headers)
  }
  if (err instanceof HTTPException) {
    const res = err.getResponse()
    const code = err.status === 401 ? 'unauthorized' : err.status === 403 ? 'forbidden' : err.status === 404 ? 'not_found' : 'validation_failed'
    return c.json(errorBody(err.message || 'Request failed', code), err.status as 401, Object.fromEntries(res.headers))
  }
  console.error(err)
  return c.json(errorBody('Internal server error', 'internal'), 500)
})

app.notFound((c) => {
  return c.json(errorBody('Not found', 'not_found'), 404)
})

export default app
