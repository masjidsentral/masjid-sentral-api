import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { cors } from 'hono/cors'
import openApiSpec from '../openapi.json' with { type: 'json' }
import { masjidsRouter } from './routes/masjids'
import { statesRouter } from './routes/states'
import { citiesRouter } from './routes/cities'

const app = new Hono<{ Bindings: CloudflareBindings }>()

// D-03 / CORS-01: global CORS — all read endpoints are public, browser consumers need this
app.use('*', cors())

app.get('/openapi.json', (c) => {
  return c.json(openApiSpec)
})

app.get('/', (c) => {
  return c.text('Hello Hono!')
})

app.route('/masjids', masjidsRouter)
app.route('/states', statesRouter)
app.route('/cities', citiesRouter)

// D-13: log real error, return generic 500 message (no stack traces in responses)
// HTTPException (e.g. bearerAuth 401) is passed through as-is — not treated as a 500
app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return err.getResponse()
  }
  console.error(err)
  return c.json({ error: 'Internal server error' }, 500)
})

// D-12: 404 error contract
app.notFound((c) => {
  return c.json({ error: 'Not found' }, 404)
})

export default app
