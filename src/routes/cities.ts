import { Hono } from 'hono'
import type { AppEnv } from '../middleware/auth'
import { errorBody } from '../lib/errors'
import type { CityRow } from '../types/db'

export const citiesRouter = new Hono<AppEnv>()

citiesRouter.get('/', async (c) => {
  const state = c.req.query('state')
  if (!state) return c.json(errorBody('Missing required param: state', 'validation_failed'), 422)
  const result = await c.env.DB.prepare(
    'SELECT id, name, state_id FROM cities WHERE state_id = ?'
  ).bind(state.toLowerCase()).run<CityRow>()
  return c.json({ data: result.results })
})
