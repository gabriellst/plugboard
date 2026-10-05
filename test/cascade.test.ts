import { describe, expect, test } from 'bun:test'
import { basename } from 'node:path'
import { loadCascade } from '../src/core/cascade.js'
import { InvalidManifestError, BrokenCascadeError } from '../src/core/errors.js'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const LEAF = new URL('./fixtures/bk/bk-reviews/software/bk-reviews', import.meta.url).pathname
const short = (p: string) => p.split('/fixtures/bk/')[1] ?? basename(p)

describe('cascata', () => {
  test('monta a cadeia raiz → folha', async () => {
    const r = await loadCascade(LEAF)
    expect(r.chain.map((c) => c.manifest.name)).toEqual([
      'bk-company',
      'bk-reviews',
      'bk-reviews-monorepo',
    ])
  })

  test('filho sobrescreve entrada do pai e guarda a procedência', async () => {
    const r = await loadCascade(LEAF)
    expect(r.cli.bunny!.value.check).toBe('bunny account info')
    expect(short(r.cli.bunny!.origin)).toBe('bk-reviews/software/bk-reviews/connections.jsonc')
    expect(r.cli.bunny!.touchedBy.map(short)).toEqual([
      'bk-reviews/connections.jsonc',
      'bk-reviews/software/bk-reviews/connections.jsonc',
    ])
  })

  test('entrada só do pai é herdada intacta', async () => {
    const r = await loadCascade(LEAF)
    expect(r.cli.gh!.value.check).toBe('gh auth status')
    expect(short(r.cli.gh!.origin)).toBe('connections.jsonc')
  })

  test('null remove entrada herdada', async () => {
    const r = await loadCascade(LEAF)
    expect(r.mcp.gdrive).toBeUndefined()
    expect(r.mcp['postgres-ro']).toBeDefined()
  })

  test('permissions concatenam na ordem raiz → folha', async () => {
    const r = await loadCascade(LEAF)
    expect(r.permissions.allow.map((a) => a.value)).toEqual([
      'Bash(gh:*)',
      'Bash(bun:*)',
      'Bash(bunx biome:*)',
    ])
    expect(r.permissions.deny.map((d) => d.value)).toEqual(['Bash(rm -rf:*)'])
  })

  test('secrets.files concatenam, absolutos, raiz → folha', async () => {
    const r = await loadCascade(LEAF)
    expect(r.secrets.files.map((f) => short(f.value))).toEqual([
      '.secrets/.env',
      'bk-reviews/.secrets/.env',
    ])
  })

  test('vars mergeiam por chave em toda a cadeia', async () => {
    const r = await loadCascade(LEAF)
    expect(Object.keys(r.secrets.vars).sort()).toEqual([
      'BUNNY_API_KEY',
      'GH_TOKEN',
      'REVIEWS_DB_RO_URL',
    ])
    expect(r.secrets.vars.GH_TOKEN!.value.source).toBe('keychain')
  })

  test('targets vêm só da folha e não herdam', async () => {
    const r = await loadCascade(LEAF)
    expect(r.targets).toEqual([])
  })

  test('emit: filho substitui, com default quando ninguém declara', async () => {
    const r = await loadCascade(LEAF)
    expect(r.emit.value).toEqual(['claude-code'])
    expect(short(r.emit.origin)).toBe('bk-reviews/connections.jsonc')
  })
})

describe('erros', () => {
  test('manifesto inválido → InvalidManifestError com path do campo', async () => {
    const d = mkdtempSync(join(tmpdir(), 'pb-'))
    writeFileSync(join(d, 'connections.jsonc'), '{ "plugboard": 1, "cli": { "gh": { "needs": "nao-array" } } }')
    const err = await loadCascade(d).catch((e) => e)
    expect(err).toBeInstanceOf(InvalidManifestError)
    expect(err.exit).toBe(2)
    expect(err.detail).toContain('cli.gh.needs')
  })

  test('chave desconhecida é rejeitada (strict)', async () => {
    const d = mkdtempSync(join(tmpdir(), 'pb-'))
    writeFileSync(join(d, 'connections.jsonc'), '{ "plugboard": 1, "mcps": {} }')
    const err = await loadCascade(d).catch((e) => e)
    expect(err).toBeInstanceOf(InvalidManifestError)
  })

  test('extends que não resolve → BrokenCascadeError', async () => {
    const d = mkdtempSync(join(tmpdir(), 'pb-'))
    writeFileSync(join(d, 'connections.jsonc'), '{ "plugboard": 1, "extends": "./nao-existe" }')
    const err = await loadCascade(d).catch((e) => e)
    expect(err).toBeInstanceOf(BrokenCascadeError)
    expect(err.exit).toBe(3)
  })

  test('JSONC malformado aponta o offset', async () => {
    const d = mkdtempSync(join(tmpdir(), 'pb-'))
    writeFileSync(join(d, 'connections.jsonc'), '{ "plugboard": 1, }{{')
    const err = await loadCascade(d).catch((e) => e)
    expect(err).toBeInstanceOf(InvalidManifestError)
    expect(err.detail).toContain('offset')
  })
})

describe('mcp oauth', () => {
  test('oauth.scopes atravessa parse e merge; filho pode estreitar', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const org = mkdtempSync(join(tmpdir(), 'pb-oauth-'))
    writeFileSync(join(org, 'connections.jsonc'),
      '{ "plugboard": 1, "extends": null, "mcp": { "gmail": { "type": "http", "url": "https://mcp.example/gmail", "oauth": { "scopes": "https://www.googleapis.com/auth/gmail.readonly" } } } }')
    const child = join(org, 'proj'); (await import('node:fs')).mkdirSync(child)
    writeFileSync(join(child, 'connections.jsonc'),
      '{ "plugboard": 1, "extends": "..", "mcp": { "gmail": { "type": "http", "url": "https://mcp.example/gmail", "oauth": { "scopes": "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send" } } } }')
    const r = await loadCascade(child)
    expect(r.mcp.gmail!.value.oauth?.scopes).toContain('gmail.send')
    expect(r.mcp.gmail!.touchedBy).toHaveLength(2)
    // e não precisa de NENHUMA var: needs vazio, nada no env
    expect(r.mcp.gmail!.value.needs).toEqual([])
  })
})

describe('profile (identidade por projeto)', () => {
  test('org define, filho pode trocar — cada um vira um CLAUDE_CONFIG_DIR', async () => {
    const { mkdtempSync, writeFileSync, mkdirSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const org = mkdtempSync(join(tmpdir(), 'pb-prof-'))
    writeFileSync(join(org, 'connections.jsonc'), '{ "plugboard": 1, "extends": null, "profile": "bk" }')
    const a = join(org, 'reviews'); mkdirSync(a)
    writeFileSync(join(a, 'connections.jsonc'), '{ "plugboard": 1, "extends": ".." }')
    const b = join(org, 'dash'); mkdirSync(b)
    writeFileSync(join(b, 'connections.jsonc'), '{ "plugboard": 1, "extends": "..", "profile": "bk-dash-gmail2" }')

    expect((await loadCascade(a)).profile.value).toBe('bk')            // herda da org
    expect((await loadCascade(b)).profile.value).toBe('bk-dash-gmail2') // identidade própria
    expect((await loadCascade(org)).profile.origin).toContain('connections.jsonc')
  })

  test('sem profile em ninguém → null (perfil default da máquina)', async () => {
    const r = await loadCascade(new URL('./fixtures/bk/bk-reviews', import.meta.url).pathname)
    expect(r.profile.value).toBeNull()
  })
})

describe('descoberta git-like', () => {
  test('cwd dentro de um subdiretório sem manifesto acha o do nível acima', async () => {
    const { mkdirSync } = await import('node:fs')
    const deep = new URL('./fixtures/bk/bk-reviews/software/bk-reviews/src', import.meta.url).pathname
    mkdirSync(deep, { recursive: true })
    const r = await loadCascade(deep)
    expect(r.chain.map((c) => c.manifest.name)).toEqual(['bk-company', 'bk-reviews', 'bk-reviews-monorepo'])
  })
})

describe('init', () => {
  test('sem pai → raiz; com pai acima → extends relativo; recusa duplicado', async () => {
    const { mkdtempSync, mkdirSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { initManifest } = await import('../src/core/init.js')

    const root = mkdtempSync(join(tmpdir(), 'pb-init-'))
    const r1 = await initManifest(root)
    expect(r1.extendsValue).toBeNull()
    expect((await loadCascade(root)).chain).toHaveLength(1)

    const sub = join(root, 'a', 'b')
    mkdirSync(sub, { recursive: true })
    const r2 = await initManifest(sub)
    expect(r2.extendsValue).toBe('../..')
    expect((await loadCascade(sub)).chain).toHaveLength(2)

    const err = await initManifest(root).catch((e) => e)
    expect(err.message).toContain('já existe')
  })
})

describe('chave duplicada', () => {
  test('é erro de manifesto, não silêncio (o null que some)', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const d = mkdtempSync(join(tmpdir(), 'pb-dup-'))
    writeFileSync(join(d, 'connections.jsonc'),
      '{ "plugboard": 1, "extends": null, "mcp": { "g": null, "g": { "command": "x" } } }')
    const err = await loadCascade(d).catch((e) => e)
    expect(err).toBeInstanceOf(InvalidManifestError)
    expect(err.detail).toContain('chave duplicada: "mcp.g"')
  })
})
