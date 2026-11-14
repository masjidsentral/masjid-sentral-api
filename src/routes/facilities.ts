import { Hono } from 'hono'
import { requireScope, type AppEnv } from '../middleware/auth'

export const facilitiesRouter = new Hono<AppEnv>()

facilitiesRouter.use('*', requireScope('read'))

// The active facility code catalogue (provisional until the JM x Qiyam agreement, contract section 11).
facilitiesRouter.get('/', async (c) => {
  const rows = await c.env.DB
    .prepare('SELECT code, label_en, label_ms, sort_order FROM facility_catalogue WHERE active = 1 ORDER BY sort_order, code')
    .all<{ code: string; label_en: string; label_ms: string; sort_order: number }>()
  return c.json({ data: rows.results })
})
