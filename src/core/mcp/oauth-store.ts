import { existsSync } from 'node:fs'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Storage de credencial OAuth ESCOPADO por entrada da cascata.
 *
 * Implementa o contrato `OAuthClientProvider` do SDK oficial — o SDK faz
 * discovery, PKCE, troca e refresh; nós só decidimos ONDE o token mora.
 * É a inversão que resolve o limite do Claude Code: lá o sign-in é chaveado
 * por endpoint (global), aqui é por `<raiz da cascata>/.plugboard/mcp/<entrada>/`.
 * Duas entradas do MESMO endpoint viram duas contas.
 */
export class ScopedOAuthStore {
  constructor(
    private readonly dir: string,
    private readonly opts: {
      redirectUrl: string
      clientName: string
      /** Só o comando de login passa isto (abre o browser). No proxy fica ausente
       *  de propósito: um server MCP não pode sequestrar o terminal do usuário. */
      onRedirect?: (url: URL) => void | Promise<void>
      /** Client pré-registrado — servers sem DCR (Google) exigem isto. */
      staticClient?: { client_id: string; client_secret?: string }
    },
  ) {}

  private redirectHandler?: (url: URL) => void | Promise<void>

  /** O comando de login registra aqui quem abre o browser. O proxy nunca registra. */
  onAuthorizationUrl(handler: (url: URL) => void | Promise<void>) {
    this.redirectHandler = handler
  }

  private file(name: string) {
    return join(this.dir, `${name}.json`)
  }

  private async read<T>(name: string): Promise<T | undefined> {
    const p = this.file(name)
    if (!existsSync(p)) return undefined
    try {
      const parsed = JSON.parse(await readFile(p, 'utf8'))
      return (parsed ?? undefined) as T | undefined
    } catch {
      return undefined
    }
  }

  private async write(name: string, data: unknown): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    const p = this.file(name)
    await writeFile(p, JSON.stringify(data, null, 2))
    await chmod(p, 0o600) // credencial: nunca legível por outros
  }

  get redirectUrl() {
    return this.opts.redirectUrl
  }

  get clientMetadata() {
    return {
      client_name: this.opts.clientName,
      redirect_uris: [this.opts.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: this.opts.staticClient?.client_secret ? 'client_secret_post' : 'none',
    }
  }

  clientInformation() {
    if (this.opts.staticClient) return Promise.resolve(this.opts.staticClient as Record<string, unknown>)
    return this.read<Record<string, unknown>>('client')
  }
  saveClientInformation(info: unknown) {
    if (this.opts.staticClient) return Promise.resolve() // nada a persistir: veio do manifesto
    return this.write('client', info)
  }

  tokens() {
    return this.read<Record<string, unknown>>('tokens')
  }
  saveTokens(tokens: unknown) {
    return this.write('tokens', tokens)
  }

  saveCodeVerifier(verifier: string) {
    return this.write('verifier', { verifier })
  }
  async codeVerifier(): Promise<string> {
    const v = await this.read<{ verifier: string }>('verifier')
    if (!v?.verifier) throw new Error('code verifier ausente — rode `plugboard mcp login <entrada>` de novo')
    return v.verifier
  }

  /** No proxy não há browser: o login é um comando separado, interativo. */
  redirectToAuthorization(url: URL): void | Promise<void> {
    const handler = this.redirectHandler ?? this.opts.onRedirect
    if (handler) return handler(url)
    throw new Error(
      `entrada não autenticada. Rode:\n  plugboard mcp login <entrada>\n\n(url do fluxo: ${url.toString().slice(0, 80)}…)`,
    )
  }

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery') {
    const names = scope === 'all' ? ['client', 'tokens', 'verifier', 'discovery'] : [scope]
    for (const n of names) {
      if (existsSync(this.file(n))) await writeFile(this.file(n), 'null')
    }
  }
}
