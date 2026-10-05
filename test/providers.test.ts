import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadCascade } from '../src/core/cascade.js'
import { PROVIDERS, expandProviders, UnknownProviderError } from '../src/core/providers.js'
import { InvalidManifestError } from '../src/core/errors.js'

const load = async (body: string) => {
  const d = mkdtempSync(join(tmpdir(), 'pb-prov-'))
  writeFileSync(join(d, 'connections.jsonc'), `{ "plugboard": 1, "extends": null, ${body} }`)
  return loadCascade(d)
}

describe('providers', () => {
  test('use preenche a entrada a partir do preset', async () => {
    const r = await load('"cli": { "railway": { "use": "railway" } }')
    const e = r.cli.railway!.value
    expect(e.check).toBe('railway whoami')
    expect(e.install?.brew).toBe('railway')
    expect(typeof e.auth === 'object' && e.auth.isolate).toBe('home')
  })

  test('o manifesto SEMPRE vence o preset, campo a campo', async () => {
    const r = await load('"cli": { "railway": { "use": "railway", "check": "railway status" } }')
    expect(r.cli.railway!.value.check).toBe('railway status')
    expect(r.cli.railway!.value.install?.brew).toBe('railway') // resto do preset intacto
  })

  test('mcp: google-workspace traz command/needs/isolate verificados', async () => {
    const r = await load('"mcp": { "gmail-suporte": { "use": "google-workspace" } }')
    const e = r.mcp['gmail-suporte']!.value
    expect(e.command).toBe('bunx')
    expect(e.args).toContain('@aaronsb/google-workspace-mcp')
    expect(e.needs).toEqual(['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'])
    expect(e.isolate).toBe('home')
  })

  test('duas entradas do mesmo preset → contas isoladas distintas', async () => {
    const { renderClaudeCode } = await import('../src/core/emit/claude-code.js')
    const r = await load(`"mcp": {
      "gmail-suporte": { "use": "google-workspace" },
      "gmail-pessoal": { "use": "google-workspace" }
    }`)
    const out = renderClaudeCode(r).mcpServers
    const a = (out['gmail-suporte']!.env as Record<string, string>).HOME
    const b = (out['gmail-pessoal']!.env as Record<string, string>).HOME
    expect(a).not.toBe(b)
    expect(a).toContain('gmail-suporte')
  })

  test('provider inexistente → erro de manifesto com a lista de opções', async () => {
    const err = await load('"cli": { "x": { "use": "nao-existe" } }').catch((e) => e)
    expect(err).toBeInstanceOf(InvalidManifestError)
    expect(err.detail).toContain('Disponíveis:')
    expect(err.detail).toContain('railway')
  })

  test('provider do kind errado é rejeitado', () => {
    expect(() => expandProviders({ cli: { x: { use: 'google-workspace' } } })).toThrow(UnknownProviderError)
  })

  test('null (remoção herdada) não é confundido com entrada', () => {
    expect(() => expandProviders({ mcp: { gdrive: null } })).not.toThrow()
  })

  test('todo preset verificado declara data', () => {
    for (const [name, p] of Object.entries(PROVIDERS)) {
      if (p.verified) expect(p.verified.date, name).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })
})

describe('merge preset←declarado é profundo', () => {
  test('declarar oauth.scopes não apaga clientId/authorizationParams do preset', async () => {
    const r = await load(`"mcp": { "g": { "use": "gmail-official",
      "oauth": { "scopes": "a b" } } }`)
    const o = r.mcp.g!.value.oauth!
    expect(o.scopes).toBe('a b')                                  // declarado vence
    expect(o.clientId).toBe('${GOOGLE_CLIENT_ID}')                // preset sobrevive
    expect(o.authorizationParams).toEqual({ access_type: 'offline', prompt: 'consent' })
  })

  test('array declarado substitui o do preset inteiro (não é patch)', async () => {
    const r = await load('"mcp": { "g": { "use": "google-workspace", "args": ["-y", "outro"] } }')
    expect(r.mcp.g!.value.args).toEqual(['-y', 'outro'])
  })

  test('install: sobrescrever brew mantém os outros gerenciadores', async () => {
    const r = await load('"cli": { "railway": { "use": "railway", "install": { "brew": "railway@beta" } } }')
    const i = r.cli.railway!.value.install!
    expect(i.brew).toBe('railway@beta')
    expect(i.npx).toBe('@railway/cli')
  })
})
