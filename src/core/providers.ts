/**
 * Catálogo de providers: conhecimento VERIFICADO sobre ferramentas externas.
 *
 * Por que existir: declarar um Gmail multi-conta exige saber que o server oficial
 * não serve, qual fork usar, que ele respeita HOME e quais vars exige. Isso é
 * conhecimento do plugboard (testado, datado, versionado com o pacote), não config
 * do usuário. O manifesto referencia por nome; o preset preenche os campos.
 *
 * Não há "exceção de provider": há níveis de especificidade. Um CLI comum é
 * install+check+auth. Um serviço com várias implementações vira VÁRIOS providers
 * nomeados (gmail-official vs google-workspace), e escolher é decisão explícita.
 *
 * O manifesto sempre vence o preset campo a campo.
 */

export interface Provider {
  kind: 'cli' | 'mcp'
  description: string
  /** Quando/como isso foi confirmado — o que separa catálogo de chute. */
  verified?: { date: string; version?: string; notes?: string }
  /** Campos injetados na entrada (o manifesto sobrescreve). */
  entry: Record<string, unknown>
}

export const PROVIDERS: Record<string, Provider> = {
  // ── CLI ───────────────────────────────────────────────────────────────────
  gh: {
    kind: 'cli',
    description: 'GitHub CLI',
    entry: {
      install: { brew: 'gh', winget: 'GitHub.cli', scoop: 'gh', apt: 'gh' },
      check: 'gh auth status',
      auth: { login: 'gh auth login', logout: 'gh auth logout' },
    },
  },
  railway: {
    kind: 'cli',
    description: 'Railway — deploy e logs',
    verified: { date: '2026-09-11', notes: 'respeita $HOME → isolate funciona; env token vence o login global' },
    entry: {
      install: { brew: 'railway', scoop: 'railway', npx: '@railway/cli' },
      check: 'railway whoami',
      auth: { login: 'railway login', logout: 'railway logout', isolate: 'home' },
      // identidade ≠ alvo: `whoami` prova a conta, `status` prova o projeto linkado.
      // O link fica no config do CLI indexado por diretório — com isolate, por perfil.
      tenant: {
        check: 'railway status',
        select: 'railway link',
        show: 'railway status --json',
        expect: 'projeto + ambiente do Railway (railway link)',
      },
    },
  },
  bunny: {
    kind: 'cli',
    description: 'BunnyCDN',
    verified: { date: '2026-08-31', version: '@bunny.net/cli@0.15.1' },
    entry: { install: { bunx: '@bunny.net/cli' }, check: 'bunny --version' },
  },
  psql: {
    kind: 'cli',
    description: 'PostgreSQL client (libpq)',
    verified: { date: '2026-08-31', notes: 'libpq é keg-only no brew: exige o link no post' },
    entry: {
      bin: 'psql',
      install: { brew: 'libpq', post: 'brew link --force libpq', apt: 'postgresql-client', winget: 'PostgreSQL.psql' },
      check: 'psql --version',
    },
  },
  mongosh: {
    kind: 'cli',
    description: 'MongoDB Shell',
    entry: { install: { brew: 'mongosh', winget: 'MongoDB.Shell', scoop: 'mongosh' }, check: 'mongosh --version' },
  },
  grafanactl: {
    kind: 'cli',
    description: 'Grafana CLI (grafanactl)',
    verified: { date: '2026-08-31', notes: 'o binário chama grafanactl, não grafana' },
    entry: { bin: 'grafanactl', install: { brew: 'grafanactl' }, check: 'grafanactl --version' },
  },
  posthog: {
    kind: 'cli',
    description: 'PostHog CLI',
    verified: { date: '2026-08-31', version: '@posthog/cli@0.16.0' },
    entry: { install: { bunx: '@posthog/cli' }, check: 'posthog --version' },
  },

  // ── MCP ───────────────────────────────────────────────────────────────────
  'gmail-official': {
    kind: 'mcp',
    description: 'Gmail MCP oficial do Google (http) — MONO-CONTA',
    verified: {
      date: '2026-09-11',
      notes: 'sem parâmetro de conta nem endpoint por conta. Ligado direto no Claude Code o OAuth é dele (chaveado por endpoint) → duas entradas compartilham credencial; via `plugboard mcp` o token é por escopo e multi-conta funciona. NÃO suporta DCR (verificado 2026-09-12): exige OAuth client Web criado no GCP, com redirect http://127.0.0.1:7777/callback',
    },
    entry: {
      type: 'http',
      url: 'https://gmailmcp.googleapis.com/mcp/v1',
      // o Google NÃO faz DCR (verificado): exige client criado no GCP.
      oauth: {
        scopes: 'https://www.googleapis.com/auth/gmail.readonly',
        clientId: '${GOOGLE_CLIENT_ID}',
        clientSecret: '${GOOGLE_CLIENT_SECRET}',
        // sem isto o Google devolve só access_token (1h) e o proxy morre depois
        authorizationParams: { access_type: 'offline', prompt: 'consent' },
      },
      needs: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
    },
  },
  'google-workspace': {
    kind: 'mcp',
    description: 'Google Workspace MCP (stdio, multi-conta) — Gmail, Calendar, Drive, Docs',
    verified: {
      date: '2026-09-11',
      version: '@aaronsb/google-workspace-mcp@4.5.1',
      notes: 'testado: sobe sob bun (pede node>=22.12), 13 tools, usa XDG e RESPEITA $HOME — registry plantado num HOME isolado é carregado, noutro vazio reporta "no accounts configured". Logo isolate:"home" dá contas distintas por entrada. Exige OAuth client próprio no GCP',
    },
    entry: {
      command: 'bunx',
      args: ['-y', '@aaronsb/google-workspace-mcp'],
      needs: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
      isolate: 'home',
    },
  },
  postgres: {
    kind: 'mcp',
    description: 'Postgres MCP (stdio) — consulta via connection string',
    entry: { command: 'bunx', args: ['-y', '@modelcontextprotocol/server-postgres', '${DATABASE_URL}'], needs: ['DATABASE_URL'] },
  },
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Merge preset←declarado em PROFUNDIDADE para objetos simples.
 * Raso perderia o resto do bloco: quem declara `oauth: { scopes }` não pode
 * perder o `oauth.clientId` e o `oauth.authorizationParams` que o preset trouxe.
 * Arrays são substituídos inteiros (uma lista declarada é uma decisão, não um patch).
 */
function deepMerge(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(over)) {
    out[k] = isPlainObject(v) && isPlainObject(base[k]) ? deepMerge(base[k], v) : v
  }
  return out
}

export class UnknownProviderError extends Error {
  constructor(
    readonly name: string,
    readonly kind: 'cli' | 'mcp',
  ) {
    const options = Object.entries(PROVIDERS)
      .filter(([, p]) => p.kind === kind)
      .map(([k]) => k)
    super(`provider "${name}" não existe para ${kind}. Disponíveis: ${options.join(', ')}`)
  }
}

/**
 * Expande `use` no objeto RAW, antes da validação zod — assim os defaults do
 * schema se aplicam ao resultado final, e não dá pra confundir "campo omitido"
 * com "campo com valor default".
 */
export function expandProviders(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return raw
  const m = raw as Record<string, unknown>

  for (const kind of ['cli', 'mcp'] as const) {
    const section = m[kind]
    if (typeof section !== 'object' || section === null) continue
    for (const [name, value] of Object.entries(section as Record<string, unknown>)) {
      if (typeof value !== 'object' || value === null) continue // null = remoção herdada
      const entry = value as Record<string, unknown>
      const use = entry.use
      if (typeof use !== 'string') continue
      const provider = PROVIDERS[use]
      if (!provider || provider.kind !== kind) throw new UnknownProviderError(use, kind)
      // preset por baixo, declarado por cima — em profundidade para objetos
      ;(section as Record<string, unknown>)[name] = deepMerge(provider.entry, entry)
    }
  }
  return m
}
