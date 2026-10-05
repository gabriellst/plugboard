import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadCascade } from '../src/core/cascade.js'
import { authStatus } from '../src/core/auth.js'
import { consumersOf } from '../src/core/secrets.js'

async function resolvedWith(cli: string) {
  const d = mkdtempSync(join(tmpdir(), 'pb-auth-'))
  writeFileSync(join(d, 'connections.jsonc'), `{ "plugboard": 1, "extends": null, "cli": ${cli} }`)
  return loadCascade(d)
}

describe('auth.login no manifesto', () => {
  test('schema aceita login puro, env puro, e os dois juntos', async () => {
    const r = await resolvedWith(`{
      "gh":      { "check": "true", "auth": { "login": "gh auth login" } },
      "bunny":   { "check": "true", "auth": { "env": ["BUNNY_API_KEY"] } },
      "railway": { "check": "true", "auth": { "env": ["RAILWAY_TOKEN"], "login": "railway login" } }
    }`)
    expect(Object.keys(r.cli).sort()).toEqual(['bunny', 'gh', 'railway'])
  })

  test('auth só-login não quebra o grafo de vars (env opcional)', async () => {
    const r = await resolvedWith('{ "gh": { "auth": { "login": "gh auth login" } } }')
    expect(consumersOf(r)).toEqual({})
  })

  test('authStatus: check passa → ok; falha → fail com o hint certo', async () => {
    const r = await resolvedWith(`{
      "passa": { "check": "true", "auth": { "login": "x login" } },
      "falha": { "check": "exit 1", "auth": { "login": "y login" } },
      "semcheck": { "auth": "external" }
    }`)
    const st = Object.fromEntries(authStatus(r).map((s) => [s.name, s]))
    expect(st.passa!.state).toBe('ok')
    expect(st.falha!.state).toBe('fail')
    expect(st.falha!.login).toBe('y login')
    expect(st.semcheck!.state).toBe('no-check')
  })
})

describe('checks escopados', () => {
  test('envFor injeta a credencial do projeto no check', async () => {
    const { mkdirSync } = await import('node:fs')
    const d = mkdtempSync(join(tmpdir(), 'pb-scope-'))
    mkdirSync(join(d, '.secrets'))
    writeFileSync(join(d, '.secrets/.env'), 'PROJ_TOKEN=abc\n')
    writeFileSync(join(d, 'connections.jsonc'), `{
      "plugboard": 1, "extends": null,
      "secrets": { "files": [".secrets/.env"], "vars": { "PROJ_TOKEN": { "service": "X" } } },
      "cli": { "svc": { "check": "test -n \\"$PROJ_TOKEN\\"", "auth": { "env": ["PROJ_TOKEN"] } } }
    }`)
    const r = await loadCascade(d)
    const { loadEnvChain, scopeFor } = await import('../src/core/secrets.js')
    const res = await loadEnvChain(r, {})

    // sem escopo: a var não está no ambiente → check falha
    expect(authStatus(r)[0]!.state).toBe('fail')
    // com escopo: o check prova a credencial DO PROJETO
    const scoped = authStatus(r, { envFor: (n) => scopeFor(r, `cli:${n}`, res) })
    expect(scoped[0]!.state).toBe('ok')
  })
})

describe('auth.isolate: "home" (credencial por projeto)', () => {
  async function withProfile(profile: string | null, auth: string) {
    const d = mkdtempSync(join(tmpdir(), 'pb-iso-'))
    const prof = profile ? `"profile": "${profile}",` : ''
    writeFileSync(join(d, 'connections.jsonc'),
      `{ "plugboard": 1, "extends": null, ${prof} "cli": { "railway": { "check": "true", "auth": ${auth} } } }`)
    return loadCascade(d)
  }

  test('isolate + profile → HOME aponta pro home do perfil', async () => {
    const { isolationEnv } = await import('../src/core/isolate.js')
    const r = await withProfile('bk-dash', '{ "login": "railway login", "isolate": "home" }')
    const env = isolationEnv(r, 'railway')
    expect(env.HOME).toContain('/.plugboard/profiles/bk-dash/home')
  })

  test('sem profile (raiz) → sem isolação: credencial global da máquina', async () => {
    const { isolationEnv } = await import('../src/core/isolate.js')
    const r = await withProfile(null, '{ "login": "railway login", "isolate": "home" }')
    expect(isolationEnv(r, 'railway')).toEqual({})
  })

  test('sem isolate declarado → nunca mexe no HOME', async () => {
    const { isolationEnv } = await import('../src/core/isolate.js')
    const r = await withProfile('bk-dash', '{ "login": "railway login" }')
    expect(isolationEnv(r, 'railway')).toEqual({})
  })

  test('--profile override muda o home isolado', async () => {
    const { isolationEnv } = await import('../src/core/isolate.js')
    const r = await withProfile('bk-dash', '{ "login": "railway login", "isolate": "home" }')
    expect(isolationEnv(r, 'railway', 'outra-conta').HOME).toContain('/outra-conta/home')
  })
})

describe('tenant (seleção de projeto/ambiente)', () => {
  test('identidade ok + tenant ok → os dois eixos verdes', async () => {
    const r = await resolvedWith('{ "x": { "check": "true", "tenant": { "check": "true", "select": "x link" } } }')
    const [s] = authStatus(r)
    expect(s!.state).toBe('ok')
    expect(s!.tenant!.state).toBe('ok')
  })

  test('identidade ok + tenant faltando → cli.no-tenant é distinguível', async () => {
    const r = await resolvedWith('{ "x": { "check": "true", "tenant": { "check": "exit 1", "select": "x link", "expect": "projeto" } } }')
    const [s] = authStatus(r)
    expect(s!.state).toBe('ok')
    expect(s!.tenant!.state).toBe('fail')
    expect(s!.tenant!.expect).toBe('projeto')
  })

  test('sem identidade, o tenant NÃO é checado (evita diagnóstico errado)', async () => {
    const r = await resolvedWith('{ "x": { "check": "exit 1", "tenant": { "check": "exit 1", "select": "x link" } } }')
    const [s] = authStatus(r)
    expect(s!.state).toBe('fail')
    expect(s!.tenant!.state).toBe('no-check') // não afirma nada sobre o alvo
  })

  test('entrada sem tenant declarado não ganha o eixo', async () => {
    const r = await resolvedWith('{ "x": { "check": "true" } }')
    expect(authStatus(r)[0]!.tenant).toBeUndefined()
  })

  test('provider railway traz os dois eixos separados', async () => {
    const r = await resolvedWith('{ "railway": { "use": "railway" } }')
    const e = r.cli.railway!.value
    expect(e.check).toBe('railway whoami')          // identidade
    expect(e.tenant?.check).toBe('railway status')  // alvo
    expect(e.tenant?.select).toBe('railway link')
  })
})
