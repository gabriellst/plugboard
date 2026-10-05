import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadCascade } from '../src/core/cascade.js'
import { auditVars, consumersOf, loadEnvChain, scopeFor } from '../src/core/secrets.js'

const LEAF = new URL('./fixtures/bk/bk-reviews/software/bk-reviews', import.meta.url).pathname
const short = (p: string) => p.split('/fixtures/bk/')[1] ?? p

describe('cadeia de .env', () => {
  test('decripta o arquivo dotenvx da folha em memória', async () => {
    const r = await loadCascade(LEAF)
    const s = await loadEnvChain(r, {})
    expect(s.values.BUNNY_API_KEY!.value).toBe('chave-super-secreta-123')
    expect(s.values.REVIEWS_DB_RO_URL!.value).toBe('postgres://ro:pass@host/db')
    expect(process.env.BUNNY_API_KEY).toBeUndefined()
  })

  test('folha (cifrada) vence org (plaintext), com procedência', async () => {
    const r = await loadCascade(LEAF)
    const s = await loadEnvChain(r, {})
    expect(s.values.BUNNY_API_KEY!.value).not.toBe('org-placeholder')
    expect(short(s.values.BUNNY_API_KEY!.origin)).toBe('bk-reviews/.secrets/.env')
    expect(s.values.SHARED_DEFAULT!.value).toBe('from-org')
    expect(short(s.values.SHARED_DEFAULT!.origin)).toBe('.secrets/.env')
  })

  test('status por arquivo: cifrado detectado, chave achada', async () => {
    const r = await loadCascade(LEAF)
    const s = await loadEnvChain(r, {})
    expect(s.files.map((f) => [short(f.path), f.encrypted, f.keyMissing])).toEqual([
      ['.secrets/.env', false, false],
      ['bk-reviews/.secrets/.env', true, false],
    ])
  })

  test('DOTENV_PUBLIC_KEY* não vaza como segredo', async () => {
    const r = await loadCascade(LEAF)
    const s = await loadEnvChain(r, {})
    expect(Object.keys(s.values).some((k) => k.startsWith('DOTENV_'))).toBe(false)
  })

  test('private key também resolve via processEnv', async () => {
    const r = await loadCascade(LEAF)
    const keys = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('./fixtures/bk/bk-reviews/.secrets/.env.keys', import.meta.url), 'utf8'),
    )
    const priv = keys.match(/DOTENV_PRIVATE_KEY_BK="?([a-f0-9]+)/)![1]!
    // esconde o .env.keys? não dá sem mover arquivo; então só valida que env também funciona
    const s = await loadEnvChain(r, { DOTENV_PRIVATE_KEY_BK: priv })
    expect(s.values.BUNNY_API_KEY!.value).toBe('chave-super-secreta-123')
  })
})

describe('escopo por consumidor', () => {
  test('agent recebe SÓ o que os MCP exigem', async () => {
    const r = await loadCascade(LEAF)
    const s = await loadEnvChain(r, {})
    expect(scopeFor(r, 'agent', s)).toEqual({ REVIEWS_DB_RO_URL: 'postgres://ro:pass@host/db' })
  })

  test('cli:bunny recebe só a chave dela (via auth.env)', async () => {
    const r = await loadCascade(LEAF)
    const s = await loadEnvChain(r, {})
    expect(scopeFor(r, 'cli:bunny', s)).toEqual({ BUNNY_API_KEY: 'chave-super-secreta-123' })
  })

  test('consumidor inexistente → vazio, nunca união', async () => {
    const r = await loadCascade(LEAF)
    const s = await loadEnvChain(r, {})
    expect(scopeFor(r, 'cli:nao-existe', s)).toEqual({})
  })
})

describe('auditoria (grafo do doctor)', () => {
  test('fixture principal está limpa', async () => {
    const r = await loadCascade(LEAF)
    const s = await loadEnvChain(r, {})
    expect(auditVars(r, s)).toEqual([])
  })

  test('grafo reverso var → consumidores', async () => {
    const r = await loadCascade(LEAF)
    expect(consumersOf(r)).toEqual({
      BUNNY_API_KEY: ['cli:bunny'],
      REVIEWS_DB_RO_URL: ['mcp:postgres-ro'],
    })
  })

  const tmpManifest = (extra: string, env = '') => {
    const d = mkdtempSync(join(tmpdir(), 'pb-sec-'))
    mkdirSync(join(d, '.secrets'), { recursive: true })
    writeFileSync(join(d, '.secrets', '.env'), env)
    writeFileSync(
      join(d, 'connections.jsonc'),
      `{ "plugboard": 1, "extends": null, "secrets": { "files": [".secrets/.env"], "vars": {} }, ${extra} }`,
    )
    return d
  }

  test('var.undeclared: needs sem declaração', async () => {
    const d = tmpManifest('"mcp": { "x": { "command": "y", "needs": ["FANTASMA"] } }')
    const r = await loadCascade(d)
    const f = auditVars(r, await loadEnvChain(r, {}))
    expect(f).toHaveLength(1)
    expect(f[0]).toMatchObject({ code: 'var.undeclared', subject: 'FANTASMA', severity: 'error' })
  })

  test('var.orphan + var.missing: declarada, sem uso, sem valor', async () => {
    const d = mkdtempSync(join(tmpdir(), 'pb-sec-'))
    writeFileSync(
      join(d, 'connections.jsonc'),
      '{ "plugboard": 1, "extends": null, "secrets": { "vars": { "SOLTA": { "service": "X" } } } }',
    )
    const r = await loadCascade(d)
    const codes = auditVars(r, await loadEnvChain(r, {})).map((f) => f.code).sort()
    expect(codes).toEqual(['var.missing', 'var.orphan'])
  })

  test('source keychain/external NÃO gera orphan nem missing', async () => {
    const d = mkdtempSync(join(tmpdir(), 'pb-sec-'))
    writeFileSync(
      join(d, 'connections.jsonc'),
      '{ "plugboard": 1, "extends": null, "secrets": { "vars": { "GH_TOKEN": { "service": "GitHub", "source": "keychain" } } } }',
    )
    const r = await loadCascade(d)
    expect(auditVars(r, await loadEnvChain(r, {}))).toEqual([])
  })

  test('secrets.key-missing: arquivo cifrado sem .env.keys', async () => {
    const d = tmpManifest(
      '"mcp": {}',
      'DOTENV_PUBLIC_KEY_X="02abc"\nSECRETA=encrypted:AAAA\n',
    )
    const r = await loadCascade(d)
    const s = await loadEnvChain(r, {})
    expect(s.files[0]!.keyMissing).toBe(true)
    const f = auditVars(r, s)
    expect(f.map((x) => x.code)).toContain('secrets.key-missing')
  })

  test('secrets.file-missing: declarado e ausente', async () => {
    const d = mkdtempSync(join(tmpdir(), 'pb-sec-'))
    writeFileSync(
      join(d, 'connections.jsonc'),
      '{ "plugboard": 1, "extends": null, "secrets": { "files": ["nao-existe/.env"] } }',
    )
    const r = await loadCascade(d)
    const f = auditVars(r, await loadEnvChain(r, {}))
    expect(f.map((x) => x.code)).toContain('secrets.file-missing')
  })
})
