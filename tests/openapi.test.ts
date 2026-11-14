import { describe, it, expect } from 'vitest'
import { SELF } from 'cloudflare:test'

describe('GET /openapi.json', () => {
  it('returns 200 with application/json content-type', async () => {
    const response = await SELF.fetch('http://example.com/openapi.json')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')
  })

  it('is public: needs no API key and emits no CORS header', async () => {
    const response = await SELF.fetch('http://example.com/openapi.json')
    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('parsed body has openapi === "3.1.0"', async () => {
    const response = await SELF.fetch('http://example.com/openapi.json')
    const body = await response.json() as { openapi: string }
    expect(body.openapi).toBe('3.1.0')
  })
})

// ─── v1.1: the document matches the routes (S4) ──────────────────────────────

import { app } from '../src/index'
import spec from '../openapi.json'

type Op = { operationId?: string; security?: unknown[]; responses?: Record<string, unknown>; parameters?: Array<{ name: string; in: string }> }
const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const
const PUBLIC = new Set(['GET /', 'GET /openapi.json'])

/** Registered routes as `METHOD /path/{param}` (middleware entries and HEAD/OPTIONS excluded). */
function registered(): string[] {
  const out = new Set<string>()
  for (const r of app.routes) {
    if (r.method === 'ALL') continue
    out.add(`${r.method} ${r.path.replace(/:([A-Za-z_]+)/g, '{$1}')}`)
  }
  return [...out].sort()
}
function documented(): string[] {
  const out: string[] = []
  for (const [path, item] of Object.entries(spec.paths as Record<string, Record<string, Op>>)) {
    for (const m of METHODS) if (item[m]) out.push(`${m.toUpperCase()} ${path}`)
  }
  return out.sort()
}

describe('openapi.json v1.1', () => {
  it('is version 1.1.x', () => {
    expect((spec as { info: { version: string } }).info.version).toMatch(/^1\.1\./)
  })

  it('documents every registered route (public and admin), and nothing that is not registered', () => {
    const routes = registered()
    expect(routes.length).toBeGreaterThan(25)
    const docs = documented()
    expect(routes.filter(r => !docs.includes(r))).toEqual([])
    expect(docs.filter(d => !routes.includes(d))).toEqual([])
  })

  it('puts bearer auth on every operation except GET / and GET /openapi.json', () => {
    const root = (spec as { security?: unknown[] }).security
    expect(root).toEqual([{ bearerAuth: [] }])
    expect((spec.components.securitySchemes as Record<string, { scheme: string }>).bearerAuth.scheme).toBe('bearer')
    for (const [path, item] of Object.entries(spec.paths as Record<string, Record<string, Op>>)) {
      for (const m of METHODS) {
        const op = item[m]
        if (!op) continue
        const key = `${m.toUpperCase()} ${path}`
        if (PUBLIC.has(key)) expect(op.security, key).toEqual([])
        else expect(op.security, key).toBeUndefined() // inherits the root requirement
      }
    }
  })

  it('every operation has a unique operationId, path params declared, and an error response with the Error schema', () => {
    const ids = new Set<string>()
    for (const [path, item] of Object.entries(spec.paths as Record<string, Record<string, Op>>)) {
      for (const m of METHODS) {
        const op = item[m]
        if (!op) continue
        const key = `${m.toUpperCase()} ${path}`
        expect(op.operationId, key).toBeTruthy()
        expect(ids.has(op.operationId!), `duplicate operationId ${op.operationId}`).toBe(false)
        ids.add(op.operationId!)
        for (const p of path.match(/\{(\w+)\}/g) ?? []) {
          expect(op.parameters?.some(x => x.in === 'path' && x.name === p.slice(1, -1)), `${key} declares ${p}`).toBe(true)
        }
        if (!PUBLIC.has(key)) expect(JSON.stringify(op.responses), key).toContain('#/components/schemas/Error')
      }
    }
  })

  it('has the error schema with every code the server emits', () => {
    const codes = (spec.components.schemas.Error.properties.code as { enum: string[] }).enum
    expect(codes.sort()).toEqual([
      'already_exists', 'already_linked', 'forbidden', 'idempotency_mismatch', 'internal', 'not_found',
      'possible_duplicate', 'rate_limited', 'stale_revert', 'unauthorized', 'validation_failed', 'version_conflict',
    ])
  })

  it('documents 422 on every read route that validates its query, and the admin scan route', () => {
    const paths = spec.paths as Record<string, Record<string, Op>>
    for (const p of ['/masjids', '/masjids/nearby', '/masjids/match', '/events', '/masjids/{id}/events', '/changes', '/cities', '/admin/duplicates']) {
      expect(Object.keys(paths[p].get!.responses!), p).toContain('422')
    }
    expect(paths['/masjids/{id}/events'].get!.responses).toHaveProperty('301')
    expect(paths['/admin/scan'].get).toBeTruthy()
    expect(Object.keys(spec.components.schemas.ChangeDataExtras.properties).sort()).toEqual(['forced', 'merged_into', 'moved_external_ids', 'via_merge'])
  })

  it('admin merge, revert and dismiss document a required Idempotency-Key', () => {
    const paths = spec.paths as Record<string, Record<string, { parameters: Array<{ name: string; required: boolean }> }>>
    for (const p of ['/admin/masjids/{id}/merge', '/admin/changes/{seq}/revert', '/admin/duplicates/{id}/dismiss', '/admin/duplicates/{id}/merge']) {
      expect(paths[p].post.parameters.find(x => x.name === 'Idempotency-Key')?.required, p).toBe(true)
    }
  })

  it('every $ref resolves', () => {
    const text = JSON.stringify(spec)
    const refs = new Set([...text.matchAll(/"#\/components\/schemas\/(\w+)"/g)].map(m => m[1]))
    for (const r of refs) expect(spec.components.schemas, r).toHaveProperty(r)
  })

  it('the entity schemas carry every field the server returns', async () => {
    const { createMasjid } = await import('./helpers')
    const m = await createMasjid() as Record<string, unknown>
    const props = Object.keys(spec.components.schemas.Masjid.properties)
    expect(props.sort()).toEqual(Object.keys(m).sort())
  })
})
