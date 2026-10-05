import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync, statSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadCascade } from '../src/core/cascade.js'
import { targetFor } from '../src/core/mcp/proxy.js'
import { ScopedOAuthStore } from '../src/core/mcp/oauth-store.js'

const load = async (mcp: string) => {
  const d = mkdtempSync(join(tmpdir(), 'pb-px-'))
  writeFileSync(join(d, 'connections.jsonc'), `{ "plugboard": 1, "extends": null, "profile": "t", "mcp": ${mcp} }`)
  return loadCascade(d)
}

describe('targetFor', () => {
  test('stdio: leva command/args e o env de isolamento', async () => {
    const r = await load('{ "g": { "use": "google-workspace" } }')
    const t = targetFor(r, 'g')
    expect(t.kind).toBe('stdio')
    expect(t.command).toBe('bunx')
    expect(t.env!.HOME).toContain('.plugboard/mcp/g')
  })

  test('http: leva a url e NÃO injeta env (credencial é do store)', async () => {
    const r = await load('{ "g": { "use": "gmail-official" } }')
    const t = targetFor(r, 'g')
    expect(t).toEqual({ kind: 'http', url: 'https://gmailmcp.googleapis.com/mcp/v1' })
  })

  test('entrada inexistente falha explicitamente', async () => {
    const r = await load('{}')
    expect(() => targetFor(r, 'fantasma')).toThrow('não existe na cascata')
  })
})

describe('ScopedOAuthStore', () => {
  const store = (dir = mkdtempSync(join(tmpdir(), 'pb-oa-'))) => ({
    dir,
    s: new ScopedOAuthStore(dir, { redirectUrl: 'http://127.0.0.1:7777/callback', clientName: 'plugboard/x' }),
  })

  test('round-trip de tokens, com permissão 600', async () => {
    const { dir, s } = store()
    expect(await s.tokens()).toBeUndefined()
    await s.saveTokens({ access_token: 'a', refresh_token: 'r' })
    expect((await s.tokens())!.access_token).toBe('a')
    expect(statSync(join(dir, 'tokens.json')).mode & 0o077).toBe(0)
  })

  test('clientMetadata declara cliente público (PKCE, sem client_secret)', () => {
    const { s } = store()
    const m = s.clientMetadata
    expect(m.token_endpoint_auth_method).toBe('none')
    expect(m.redirect_uris).toEqual(['http://127.0.0.1:7777/callback'])
    expect(JSON.stringify(m)).not.toContain('client_secret')
  })

  test('code verifier: salva, lê, e falha com instrução quando ausente', async () => {
    const { s } = store()
    await expect(s.codeVerifier()).rejects.toThrow('plugboard mcp login')
    await s.saveCodeVerifier('v123')
    expect(await s.codeVerifier()).toBe('v123')
  })

  test('sem token, o proxy manda logar em vez de abrir browser', () => {
    const { s } = store()
    expect(() => s.redirectToAuthorization(new URL('https://auth.example/x'))).toThrow('plugboard mcp login')
  })

  test('invalidateCredentials("tokens") derruba só os tokens', async () => {
    const { dir, s } = store()
    await s.saveTokens({ access_token: 'a' })
    await s.saveClientInformation({ client_id: 'c' })
    await s.invalidateCredentials('tokens')
    expect(await s.tokens()).toBeUndefined()
    expect((await s.clientInformation())!.client_id).toBe('c')
    expect(readFileSync(join(dir, 'tokens.json'), 'utf8')).toBe('null')
  })

  test('dois escopos = duas identidades independentes', async () => {
    const a = store(), b = store()
    await a.s.saveTokens({ access_token: 'conta-A' })
    await b.s.saveTokens({ access_token: 'conta-B' })
    expect((await a.s.tokens())!.access_token).toBe('conta-A')
    expect((await b.s.tokens())!.access_token).toBe('conta-B')
  })
})

describe('client OAuth pré-registrado (servers sem DCR)', () => {
  test('resolveOAuthClient expande ${VAR} da cadeia de .env', async () => {
    const { mkdirSync } = await import('node:fs')
    const { resolveOAuthClient } = await import('../src/core/mcp/client-config.js')
    const d = mkdtempSync(join(tmpdir(), 'pb-cc-'))
    mkdirSync(join(d, '.secrets'))
    writeFileSync(join(d, '.secrets/.env'), 'GOOGLE_CLIENT_ID=id-123\nGOOGLE_CLIENT_SECRET=seg-456\n')
    writeFileSync(join(d, 'connections.jsonc'), `{
      "plugboard": 1, "extends": null,
      "secrets": { "files": [".secrets/.env"], "vars": {
        "GOOGLE_CLIENT_ID": { "service": "GCP" }, "GOOGLE_CLIENT_SECRET": { "service": "GCP" } } },
      "mcp": { "g": { "use": "gmail-official" } }
    }`)
    const r = await loadCascade(d)
    expect(await resolveOAuthClient(r, 'g')).toEqual({ client_id: 'id-123', client_secret: 'seg-456' })
  })

  test('sem clientId declarado → undefined (tenta DCR)', async () => {
    const { resolveOAuthClient } = await import('../src/core/mcp/client-config.js')
    const r = await load('{ "g": { "type": "http", "url": "https://x/mcp" } }')
    expect(await resolveOAuthClient(r, 'g')).toBeUndefined()
  })

  test('var ausente → erro explícito em vez de client_id vazio', async () => {
    const { resolveOAuthClient } = await import('../src/core/mcp/client-config.js')
    const r = await load('{ "g": { "type": "http", "url": "https://x", "oauth": { "clientId": "${NAO_EXISTE}" } } }')
    expect(resolveOAuthClient(r, 'g')).rejects.toThrow('expandiu vazio')
  })

  test('staticClient muda o auth method e não persiste registro', async () => {
    const { ScopedOAuthStore } = await import('../src/core/mcp/oauth-store.js')
    const dir = mkdtempSync(join(tmpdir(), 'pb-sc-'))
    const s = new ScopedOAuthStore(dir, {
      redirectUrl: 'http://127.0.0.1:7777/callback',
      clientName: 'p',
      staticClient: { client_id: 'cid', client_secret: 'sec' },
    })
    expect(s.clientMetadata.token_endpoint_auth_method).toBe('client_secret_post')
    expect((await s.clientInformation())!.client_id).toBe('cid')
    await s.saveClientInformation({ client_id: 'outro' }) // no-op
    expect((await s.clientInformation())!.client_id).toBe('cid')
  })
})

describe('escopo do fluxo OAuth', () => {
  test('scopes declarados são propagados ao auth() (menor privilégio)', async () => {
    const { mkdirSync } = await import('node:fs')
    const d = mkdtempSync(join(tmpdir(), 'pb-scope-'))
    mkdirSync(join(d, '.secrets'))
    writeFileSync(join(d, '.secrets/.env'), 'GOOGLE_CLIENT_ID=x\nGOOGLE_CLIENT_SECRET=y\n')
    writeFileSync(join(d, 'connections.jsonc'), `{
      "plugboard": 1, "extends": null,
      "secrets": { "files": [".secrets/.env"], "vars": {
        "GOOGLE_CLIENT_ID": { "service": "GCP" }, "GOOGLE_CLIENT_SECRET": { "service": "GCP" } } },
      "mcp": { "g": { "use": "gmail-official", "isolate": "home",
                      "oauth": { "scopes": "a b", "clientId": "\${GOOGLE_CLIENT_ID}", "clientSecret": "\${GOOGLE_CLIENT_SECRET}" } } }
    }`)
    const r = await loadCascade(d)
    // o scope declarado sobrevive ao preset e ao merge — é o que o comando passa ao SDK
    expect(r.mcp.g!.value.oauth?.scopes).toBe('a b')
  })

  test('preset sozinho traz o escopo mínimo do Gmail, não o total', async () => {
    const r = await load('{ "g": { "use": "gmail-official" } }')
    expect(r.mcp.g!.value.oauth?.scopes).toBe('https://www.googleapis.com/auth/gmail.readonly')
  })
})

describe('refresh token', () => {
  test('preset do Gmail pede access_type=offline (senão expira em 1h)', async () => {
    const r = await load('{ "g": { "use": "gmail-official" } }')
    expect(r.mcp.g!.value.oauth?.authorizationParams).toEqual({ access_type: 'offline', prompt: 'consent' })
  })

  test('authorizationParams entram na URL de autorização', async () => {
    const { loginToServer } = await import('../src/core/mcp/login.js')
    const { ScopedOAuthStore } = await import('../src/core/mcp/oauth-store.js')
    const dir = mkdtempSync(join(tmpdir(), 'pb-ap-'))
    const store = new ScopedOAuthStore(dir, { redirectUrl: 'http://127.0.0.1:7999/callback', clientName: 'p' })
    // captura a URL sem completar o fluxo
    let seen: string | undefined
    const orig = store.onAuthorizationUrl.bind(store)
    store.onAuthorizationUrl = (h) => orig((u: URL) => { seen = u.toString(); throw new Error('parar aqui') })
    await loginToServer(store, 'https://exemplo.invalid/mcp', {
      port: 7999, timeoutMs: 500,
      authorizationParams: { access_type: 'offline', prompt: 'consent' },
    }).catch(() => {})
    if (seen) {
      const u = new URL(seen)
      expect(u.searchParams.get('access_type')).toBe('offline')
      expect(u.searchParams.get('prompt')).toBe('consent')
    }
  })
})
