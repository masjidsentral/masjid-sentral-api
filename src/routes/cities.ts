import { Hono } from 'hono'
import type { CityRow } from '../types/db'

export const citiesRouter = new Hono<{ Bindings: CloudflareBindings }>()

citiesRouter.get('/', async (c) => {
  const state = c.req.query('state')
  if (!state) return c.json({ error: 'Missing required param: state' }, 400)
  const result = await c.env.DB.prepare(
    'SELECT id, name, state_id FROM cities WHERE state_id = ?'
  ).bind(state.toLowerCase()).run<CityRow>()
  return c.json({ data: result.results })
})
