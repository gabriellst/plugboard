import { z } from 'zod'

/** Como instalar um CLI. Cada chave é um gerenciador; o resolver escolhe pela plataforma. */
export const InstallSpec = z.object({
  brew: z.string().optional(),
  /** Comando pós-install (ex.: keg-only do brew exige `brew link --force libpq`). */
  post: z.string().optional(),
  winget: z.string().optional(),
  scoop: z.string().optional(),
  apt: z.string().optional(),
  npx: z.string().optional(),
  bunx: z.string().optional(),
})

/**
 * Como o CLI se autentica:
 * - `"external"`: mora fora e não há o que fazer (ex.: docker desktop)
 * - `env`: vars que a credencial exige (injetadas pelo `exec`)
 * - `login`: comando INTERATIVO de OAuth/browser (ex.: `railway login`) — o token
 *   fica no storage do próprio CLI. `logout` opcional. Pode combinar env + login
 *   (Railway: token por projeto no CI, login interativo na máquina).
 */
export const AuthSpec = z.union([
  z.literal('external'),
  z.object({
    env: z.array(z.string()).min(1).optional(),
    login: z.string().optional(),
    logout: z.string().optional(),
    /**
     * "home": o CLI guarda a credencial sob $HOME (verificado: Railway). Com um
     * `profile` na cascata, login/exec apontam HOME pra
     * ~/.plugboard/profiles/<profile>/home → credencial POR PROJETO de verdade.
     */
    isolate: z.literal('home').optional(),
  }),
])

/**
 * Seleção de TENANT — o segundo eixo da auth, separado da identidade.
 * `auth` responde "quem sou"; `tenant`, "onde eu ajo" (projeto/ambiente/conta).
 *
 * Duas formas no mercado, ambas suportadas:
 * - **estado persistido** (`railway link`, `gcloud config set project`,
 *   `kubectl use-context`): um comando grava o alvo. Declare `select` + `check`.
 * - **env var por invocação** (`AWS_PROFILE`, `RAILWAY_PROJECT_ID`): sem estado —
 *   declare em `needs` e ponha no .env do escopo; o `exec` injeta e nada mais é preciso.
 */
export const TenantSpec = z.object({
  /** Prova que há alvo selecionado (ex.: `railway status`). Sem isto o doctor não checa. */
  check: z.string().optional(),
  /** Torna verdadeiro. Aceita ${VAR} da cadeia de .env (ex.: `railway link -p ${RAILWAY_PROJECT}`). */
  select: z.string().optional(),
  /** Rótulo humano do alvo atual, pro doctor/list mostrarem. */
  show: z.string().optional(),
  /** Descrição do alvo esperado, quando não dá pra derivar. */
  expect: z.string().optional(),
})

export const CliEntry = z.object({
  /** Preset do catálogo (`plugboard providers`). Campos declarados aqui vencem o preset. */
  use: z.string().optional(),
  install: InstallSpec.optional(),
  /** Nome do binário no PATH quando difere da chave (ex.: chave "grafana", bin "grafanactl"). */
  bin: z.string().optional(),
  check: z.string().optional().meta({ description: 'Comando que prova que o CLI está autenticado' }),
  auth: AuthSpec.optional(),
  tenant: TenantSpec.optional(),
  needs: z.array(z.string()).default([]),
  why: z.string().optional(),
})

export const McpEntry = z.object({
  /** Preset do catálogo (`plugboard providers`). Campos declarados aqui vencem o preset. */
  use: z.string().optional(),
  type: z.enum(['stdio', 'http', 'sse']).optional(),
  command: z.string().optional(),
  args: z.array(z.string()).default([]),
  url: z.string().optional(),
  env: z.record(z.string(), z.string()).default({}),
  headers: z.record(z.string(), z.string()).default({}),
  needs: z.array(z.string()).default([]).meta({ description: 'Vars que este server exige' }),
  /** Server remoto com OAuth 2.1: nada em env/headers — o token vive no keychain do Claude Code. */
  oauth: z
    .object({
      scopes: z.string().optional().meta({ description: 'Escopos fixados (RFC 6749, separados por espaço) — menor privilégio' }),
      /** Client pré-registrado, para servers sem DCR (o do Google é um). Aceita ${VAR}. */
      clientId: z.string().optional(),
      /** Idem. Use ${VAR} — o valor sai da cadeia de .env, nunca do manifesto. */
      clientSecret: z.string().optional(),
      /**
       * Parâmetros extras na URL de autorização. Fora do OAuth 2.1 padrão, mas
       * alguns provedores exigem: o Google só devolve refresh_token com
       * `access_type=offline` + `prompt=consent`.
       */
      authorizationParams: z.record(z.string(), z.string()).optional(),
    })
    .optional(),
  /**
   * Estado/credencial PRÓPRIOS desta entrada, em `.plugboard/mcp/<nome>/` na raiz
   * da cascata. Permite duas contas do MESMO serviço no mesmo projeto.
   * Só vale para **stdio**: o server gerencia a própria auth. Em http/sse o token
   * é do Claude Code e fica chaveado por endpoint — isolar o env não muda nada.
   * - "home": injeta HOME=<dir> (genérico; serve a qualquer server que grave em ~/…)
   * - { env: "VAR" }: injeta VAR=<dir> (cirúrgico, quando o server tem var própria)
   */
  isolate: z.union([z.literal('home'), z.object({ env: z.string().min(1) })]).optional(),
  health: z.string().optional(),
  why: z.string().optional(),
})

/** O que era o CREDENTIALS.md. Metadado da credencial — nunca o valor. */
export const VarMeta = z.object({
  service: z.string(),
  source: z.enum(['env', 'keychain', 'file', 'external']).default('env'),
  owner: z.string().optional(),
  rotate: z.string().optional().meta({ description: '"90d" | "auto" | "manual"' }),
  lastRotated: z.string().optional().meta({ description: 'ISO date' }),
  console: z.string().optional(),
  runbook: z.string().optional(),
  access: z.string().optional(),
  why: z.string().optional(),
})

export const Permissions = z.object({
  allow: z.array(z.string()).default([]),
  deny: z.array(z.string()).default([]),
})

export const Secrets = z.object({
  files: z.array(z.string()).default([]),
  vars: z.record(z.string(), VarMeta.nullable()).default({}),
  /** "local": valor nunca versionado, nem cifrado (default). "committed": cifrado pode ser commitado. */
  policy: z.enum(['local', 'committed']).optional(),
})

export const Manifest = z.strictObject({
  $schema: z.string().optional(),
  plugboard: z.literal(1).meta({ description: 'Versão do formato' }),
  name: z.string().optional(),
  extends: z
    .union([z.string(), z.literal('auto'), z.null()])
    .optional()
    .meta({ description: 'Caminho do manifesto pai, "auto" pra subir a árvore, ou null pra raiz' }),
  emit: z.array(z.string()).optional().meta({ description: 'Emitters. Default: ["claude-code"]' }),
  /** Perfil de identidade: vira CLAUDE_CONFIG_DIR isolado no exec — logins OAuth separados por projeto. */
  profile: z.string().optional(),
  /** Emitir a skill que ensina o agente a usar estas conexões (default: true). */
  skill: z.boolean().optional(),
  targets: z.array(z.string()).default([]).meta({ description: 'Onde materializar. Não herda.' }),
  secrets: Secrets.prefault({}),
  cli: z.record(z.string(), CliEntry.nullable()).default({}),
  mcp: z.record(z.string(), McpEntry.nullable()).default({}),
  permissions: Permissions.prefault({}),
})

export type Manifest = z.infer<typeof Manifest>
export type CliEntry = z.infer<typeof CliEntry>
export type McpEntry = z.infer<typeof McpEntry>
export type VarMeta = z.infer<typeof VarMeta>
