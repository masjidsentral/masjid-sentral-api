#!/usr/bin/env node
// Issue an API key: node scripts/issue-key.mjs <app_id> <scopes> [--self-test]
// Prints the raw token ONCE and the INSERT SQL (with the token's SHA-256). Never writes anywhere
// itself; the owner runs the SQL against D1.

const VALID_SCOPES = ['read', 'write', 'webhook', 'admin']

export async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
}

export function generateToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  const b64url = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `ms_live_${b64url}`
}

export function parseScopes(raw) {
  const scopes = raw.split(',').map(s => s.trim()).filter(Boolean)
  if (scopes.length === 0) throw new Error('at least one scope is required')
  for (const s of scopes) {
    if (!VALID_SCOPES.includes(s)) throw new Error(`invalid scope '${s}' (valid: ${VALID_SCOPES.join(', ')})`)
  }
  return [...new Set(scopes)]
}

export async function issueKey(appId, scopesRaw) {
  if (!/^[a-z][a-z0-9_]{1,63}$/.test(appId ?? '')) {
    throw new Error('app_id must be lowercase letters, digits and underscores (2-64 chars)')
  }
  const scopes = parseScopes(scopesRaw ?? '')
  const token = generateToken()
  const hash = await sha256Hex(token)
  const name = `${appId} (${scopes.join(',')})`
  const sql =
    `INSERT INTO api_keys (key_hash, name, app_id, scopes, is_active) ` +
    `VALUES ('${hash}', '${name}', '${appId}', '${scopes.join(',')}', 1);`
  return { token, hash, sql }
}

async function main() {
  const args = process.argv.slice(2)
  if (args[0] === '--self-test') {
    const { token, hash, sql } = await issueKey('selftest', 'read,write')
    if (hash !== (await sha256Hex(token))) throw new Error('self-test: hash mismatch')
    if (!/^ms_live_[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('self-test: bad token format')
    if (!sql.includes(hash)) throw new Error('self-test: SQL lacks hash')
    console.log('self-test ok')
    return
  }
  if (args.length !== 2) {
    console.error('usage: node scripts/issue-key.mjs <app_id> <scopes>   (scopes: read,write,webhook,admin)')
    process.exit(2)
  }
  const { token, sql } = await issueKey(args[0], args[1])
  console.log(`API key (shown once, store it as a secret):\n${token}\n\nRun against D1:\n${sql}`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error(`error: ${e.message}`); process.exit(1) })
}
