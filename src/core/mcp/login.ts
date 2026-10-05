import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import type { AddressInfo } from 'node:net'
import type { ScopedOAuthStore } from './oauth-store.js'

/** Abre a URL no browser do SO. Falha em silêncio: a URL é sempre impressa também. */
function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
  try {
    spawn(cmd, [url], { stdio: 'ignore', detached: true }).unref()
  } catch {
    /* o usuário cola a URL na mão */
  }
}

/** Sobe um servidor efêmero em 127.0.0.1 e resolve com o `code` do callback. */
function awaitCallback(opts: {
  port: number
  expectedState?: string
  timeoutMs: number
}): { url: string; code: Promise<string>; close: () => void } {
  let resolveCode!: (c: string) => void
  let rejectCode!: (e: Error) => void
  const code = new Promise<string>((res, rej) => {
    resolveCode = res
    rejectCode = rej
  })

  const server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', `http://127.0.0.1:${opts.port}`)
    if (!u.pathname.startsWith('/callback')) {
      res.writeHead(404).end()
      return
    }
    const err = u.searchParams.get('error')
    const got = u.searchParams.get('code')
    const state = u.searchParams.get('state')

    // CSRF: o state de volta tem que ser o que mandamos
    if (opts.expectedState && state !== opts.expectedState) {
      res.writeHead(400, { 'content-type': 'text/plain' }).end('state invalido')
      rejectCode(new Error('state divergente no callback — fluxo abortado'))
      return
    }
    res.writeHead(err ? 400 : 200, { 'content-type': 'text/html; charset=utf-8' }).end(
      `<!doctype html><meta charset=utf-8><body style="font:16px system-ui;padding:3rem">
       <h2>${err ? '❌ Falhou' : '✅ Autenticado'}</h2>
       <p>${err ? err : 'Pode fechar esta aba e voltar ao terminal.'}</p>`,
    )
    if (err) rejectCode(new Error(`autorização negada: ${err}`))
    else if (got) resolveCode(got)
    else rejectCode(new Error('callback sem code'))
  })

  server.listen(opts.port, '127.0.0.1')
  const timer = setTimeout(() => rejectCode(new Error('tempo esgotado esperando o callback')), opts.timeoutMs)
  const close = () => {
    clearTimeout(timer)
    server.close()
  }
  const addr = () => (server.address() as AddressInfo | null)?.port ?? opts.port
  return { url: `http://127.0.0.1:${addr()}/callback`, code, close }
}

export interface LoginResult {
  status: 'authorized' | 'already'
  authorizationUrl?: string
}

/**
 * Fluxo OAuth 2.1 completo — orquestrado pelo SDK (`auth()`), com o token indo
 * pro store ESCOPADO da entrada. É isto que permite duas contas no mesmo endpoint:
 * o Claude Code nunca vê esse fluxo, então a chave por endpoint dele não se aplica.
 */
export async function loginToServer(
  store: ScopedOAuthStore,
  serverUrl: string,
  opts: {
    port: number
    timeoutMs?: number
    log?: (s: string) => void
    scope?: string
    /** Params extras exigidos pelo provedor (ex.: access_type=offline do Google). */
    authorizationParams?: Record<string, string>
  } = { port: 7777 },
): Promise<LoginResult> {
  const { auth } = await import('@modelcontextprotocol/sdk/client/auth.js')
  const log = opts.log ?? (() => {})

  const cb = awaitCallback({ port: opts.port, timeoutMs: opts.timeoutMs ?? 300_000 })
  let authorizationUrl: string | undefined
  try {
    // uma passada só: com token válido o SDK devolve AUTHORIZED sem abrir nada;
    // sem token ele chama o handler, que abre o browser.
    store.onAuthorizationUrl((url: URL) => {
      for (const [k, v] of Object.entries(opts.authorizationParams ?? {})) url.searchParams.set(k, v)
      authorizationUrl = url.toString()
      log(`→ abrindo o browser — conclua o login lá\n\n  ${authorizationUrl}\n\n`)
      openBrowser(authorizationUrl)
    })

    // sem `scope` o SDK pede TUDO que o servidor anuncia no discovery — no Gmail
    // isso vira acesso total à caixa. Passar o scope declarado é o menor privilégio.
    const scoped = opts.scope ? { scope: opts.scope } : {}
    const first = await auth(store as never, { serverUrl, ...scoped })
    if (first === 'AUTHORIZED') return { status: 'already' }

    log('aguardando o callback em 127.0.0.1…\n')
    const code = await cb.code
    const result = await auth(store as never, { serverUrl, authorizationCode: code, ...scoped })
    if (result !== 'AUTHORIZED') throw new Error(`fluxo terminou em estado inesperado: ${result}`)
    return { status: 'authorized', authorizationUrl }
  } finally {
    cb.close()
  }
}
