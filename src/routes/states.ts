import { Hono } from 'hono'
import type { AppEnv } from '../middleware/auth'
import { errorBody } from '../lib/errors'
import type { StateRow } from '../types/db'

export const statesRouter = new Hono<AppEnv>()

statesRouter.get('/', async (c) => {
  const country = c.req.query('country')
  const result = country
    ? await c.env.DB.prepare(
        'SELECT id, name, country_id FROM states WHERE country_id = ?'
      ).bind(country.toLowerCase()).run<StateRow>()
    : await c.env.DB.prepare(
        'SELECT id, name, country_id FROM states'
      ).run<StateRow>()
  return c.json({ data: result.results })
})
