# plugboard — Spec v0.1

> Cascading connections & credentials for AI coding agents.
> Status: core + emitter + CLI implementados — 50 testes, smoke e2e · 2026-08-31

## 1. Tese

Config de agente hoje não cascateia: no Claude Code, `.mcp.json` e `.claude/settings.json`
valem só no diretório da sessão, e segredo vira env var solta. O plugboard introduz um
manifesto declarativo por nível de diretório (`connections.jsonc`), resolve a cadeia
pai→filho com procedência, e **compila** o resultado para os arquivos que o agente lê.

O que ninguém mais faz (e é o produto): **cascata por diretório + grafo de credenciais
verificável + emit por agente**. O que já existe e a gente compõe em vez de reimplementar:
cofres (dotenvx/1Password/doppler), OAuth de MCP (Claude Code), perfis (`CLAUDE_CONFIG_DIR`).

## 2. Modelo

```
bk-company/connections.jsonc            ← raiz (extends: null)
└── bk-reviews/connections.jsonc        ← extends: ".."
    └── software/bk-reviews/…           ← extends: "../.." (folha = onde a sessão nasce)
```

- **Manifesto** = contrato commitado. **Valores de segredo** = estado local. **CLI** fiscaliza o vão.
- Todo valor resolvido carrega `origin` (quem definiu por último) e `touchedBy` (cadeia
  completa) — é o que alimenta `plugboard explain`.

### Regras de merge (o filho tem mais poder)

| Campo | Regra |
|---|---|
| `cli.*`, `mcp.*`, `secrets.vars.*` | merge por chave; filho **substitui a entrada inteira**; `null` remove a herdada |
| `secrets.files` | concatena raiz→folha; o `.env` da folha vence var a var |
| `permissions.allow` | concatena |
| `permissions.deny` | concatena; **filho nunca remove** (deny vence allow no harness) |
| `emit`, `profile`, `secrets.policy` | filho substitui o valor inteiro |
| `targets` | **não herda** — só a folha |
| `extends` | `".."`/caminho = explícito · `"auto"` (default) = sobe a árvore · `null` = raiz |

## 3. Manifesto (`connections.jsonc`)

JSONC (comentários são parte da documentação). Schema zod em `src/core/schema.ts` é a
fonte única — gera `schema.json` (draft-07, io:"input") pro editor e valida em runtime.
`strictObject`: chave desconhecida é erro apontado, nunca ignorada.

```jsonc
{
  "$schema": "https://unpkg.com/plugboard/schema.json",
  "plugboard": 1,
  "extends": "..",
  "profile": "bk",                      // identidade → CLAUDE_CONFIG_DIR isolado
  "emit": ["claude-code"],

  "secrets": {
    "policy": "local",                  // "local" (default) | "committed" (cifrado pode commitar)
    "files": [".secrets/.env"],         // cadeia; dotenvx-cifrado suportado, decripta em memória
    "vars": {
      // o que era CREDENTIALS.md: metadado, NUNCA o valor
      "BUNNY_API_KEY": { "service": "BunnyCDN", "owner": "gabriel", "rotate": "90d",
                         "lastRotated": "2026-05-19", "console": "https://dash.bunny.net/…" },
      "GH_TOKEN":      { "service": "GitHub", "source": "keychain" }   // auth externa: isenta de missing/orphan
    }
  },

  "cli": {
    "bunny": { "install": { "bunx": "@bunny.net/cli" }, "check": "bunny account info",
               "auth": { "env": ["BUNNY_API_KEY"] } },
    "gh":    { "install": { "brew": "gh" }, "check": "gh auth status", "auth": "external" }
  },

  "mcp": {
    "postgres-ro": { "command": "bunx", "args": ["-y", "…server-postgres", "${REVIEWS_DB_RO_URL}"],
                     "needs": ["REVIEWS_DB_RO_URL"], "why": "consulta ad-hoc; read-only de propósito" },
    "gmail-support": { "type": "http", "url": "https://…/gmail",
                       "oauth": { "scopes": "…/gmail.readonly …/gmail.send" } },
    "gdrive": null                      // remove o herdado do pai
  },

  "permissions": { "allow": ["Bash(bun:*)"], "deny": [] },
  "targets": ["software/bk-reviews"]    // onde materializar (toda pasta onde nasce sessão)
}
```

`why` de uma linha = campo (grepável, entra no `--json`); mais que isso = comentário JSONC;
procedimento multi-passo = arquivo referenciado por `runbook`. Instrução de comportamento
pro agente NÃO vai no manifesto — vai no CLAUDE.md (único que é carregado e obedecido).

## 4. Segredos

### Política (cascateável, fiscalizada)

| Situação | `"local"` | `"committed"` |
|---|---|---|
| plaintext tracked no git | ❌ `secrets.tracked` | ❌ |
| **cifrado** tracked | ❌ | ✅ |
| fora do `.gitignore` | ❌ `secrets.not-ignored` | ❌ |
| `.env.keys` tracked | ❌ sempre | ❌ sempre |
| legível por group/other | ⚠️ `secrets.perms` | ⚠️ |

### Modelo de ameaça (por que o desenho é assim)

1. Env do processo do agente vaza fácil: `env`/`printenv` num Bash → tool result →
   transcript em disco (`~/.claude/projects/**/*.jsonl`) → API. Rotação é o único remédio.
2. **MCP stdio herda o ambiente INTEIRO** do processo (verificado na doc) — todo server
   stdio enxerga toda var da sessão. `headersHelper` (HTTP) tem scrubbing; stdio não tem nada.
3. Logo, níveis do pior→melhor: valor em arquivo commitado < env de sessão < injeção
   por execução (`exec`) < `headersHelper` < keychain/OAuth (nada nosso pra guardar).

### Consequências implementadas

- `plugboard exec -- <cmd>` é a interface primária (padrão `op run`/`doppler run`):
  resolve, injeta **só no filho**, morre com ele. O agente conhece o nome, nunca o valor.
- `scopeFor(consumer)`: `agent` recebe **só** o que os `mcp.*.needs` exigem (mínimo pra
  expansão `${VAR}` do `.mcp.json`); `cli:x` só o dela. **Nunca a união.**
- dotenvx opcional (policy `committed` ou quem quiser cifra local): decripta em memória
  via `parse()`, private key achada pelo CONTEÚDO (`DOTENV_PUBLIC_KEY_X` → `DOTENV_PRIVATE_KEY_X`
  no `.env.keys` ao lado ou no ambiente), import lazy.
- Emitter injeta **deny-guards** no settings: `Bash(env)`, `Bash(printenv)`, `Bash(printenv:*)`,
  `Bash(set)`, `Read(**/.env)`, `Read(**/.env.keys)`, `Read(**/.env.local)`, `Read(**/.secrets/**)`.
  Deny vale antes do trust e vence allow — é a única camada que é enforcement de verdade.

## 5. Identidade e tenant

São **dois eixos independentes**, e confundi-los produz diagnóstico errado:
`auth` responde **quem sou** (`railway whoami`), `tenant` responde **onde ajo**
(`railway status` — projeto/ambiente linkado). Estar logado não diz nada sobre o alvo.

| Forma de selecionar tenant | Exemplos | Como declarar |
|---|---|---|
| **estado persistido** (comando grava) | `railway link`, `gcloud config set project`, `kubectl use-context`, `vercel link`, `supabase link` | `tenant: { check, select, show?, expect? }` + `plugboard link <cli>` |
| **env var por invocação** (sem estado) | `AWS_PROFILE`, `RAILWAY_PROJECT_ID`, `CLOUDSDK_CORE_PROJECT`, `VERCEL_PROJECT_ID` | já coberto: `needs` + `.env` do escopo; o `exec` injeta |

Regras implementadas:
- O tenant só é checado **quando a identidade está ok**. `railway status` sem login falha
  por falta de conta, não de projeto — checar assim reportaria "sem projeto" a quem só
  precisa logar.
- `select` aceita `${VAR}` da cadeia (`railway link -p ${RAILWAY_PROJECT}`), então o alvo
  pode ser declarado por escopo em vez de escolhido à mão.
- Com `auth.isolate: "home"`, o estado do link vai junto no home do perfil — identidade
  **e** alvo ficam isolados por projeto, sem esforço extra.
- `plugboard link` sem argumento mostra o estado dos dois eixos; com nome, roda o `select`.

## 5b. Identidade (mecanismos)

| Necessidade | Mecanismo |
|---|---|
| escopo do que um server pode | `oauth.scopes` por entrada (fixa os escopos do fluxo OAuth 2.1; RFC 6749) |
| projetos com contas diferentes | `profile` → `exec` seta `CLAUDE_CONFIG_DIR`; keychain isolado por sha256(dir) |
| duas contas no MESMO projeto, **simultâneas** | ✅ via **stdio + `mcp.<nome>.isolate`** (implementado): cada entrada ganha estado próprio em `<raiz>/.plugboard/mcp/<nome>/` (mode 700), injetado como `HOME=<dir>` ou `{env:"VAR"}=<dir>` — cada uma faz seu próprio OAuth, contas distintas convivem. ❌ **não** com o mesmo endpoint HTTP: o Claude Code guarda sign-in **por endpoint**, não por nome — duas entradas com a mesma url compartilham UMA credencial (doctor: `mcp.shared-endpoint`; `isolate` em http avisa `mcp.isolate-ineffective`) |
| duas contas no mesmo projeto, **alternando** | dois `profile`s + `exec --profile X -- claude` |
| conta read-only de verdade | `deny` de tools por identidade: `mcp__gmail-pessoal__send_email` |
| CLI com login OAuth global (`railway login`) escopado por projeto | **`auth.isolate: "home"`** (implementado): CLIs que guardam credencial sob $HOME (verificado: Railway) ganham HOME por perfil (`~/.plugboard/profiles/<p>/home`) em `login`/`exec --as cli:x` — um login POR PROJETO, contas distintas de fato. Alternativa por env (project token) segue válida onde a var vence o login |
| invocação avulsa como outra identidade | `plugboard exec --profile X -- …` |

Token OAuth de MCP: vive no keychain do Claude Code, refresh automático, `claude mcp login/logout`.
Nada no manifesto além de `url` + `oauth.scopes` (`needs: []`). O Gmail MCP **oficial do Google** é mono-conta (sem parâmetro
de conta nem endpoint por conta) — multi-conta simultânea exige um server stdio da comunidade.
Verificado em 2026-09-11: `@aaronsb/google-workspace-mcp@4.5.1` (stdio, XDG) **respeita `HOME`** —
com registry plantado num HOME isolado ele o carrega; noutro vazio reporta "no accounts configured".
Logo `isolate: "home"` dá a ele contas distintas por entrada. Roda sob bun apesar de pedir node ≥22.12.

## 6. Providers (catálogo)

`use: "<nome>"` em `cli.*`/`mcp.*` preenche a entrada a partir de um preset embutido;
**o manifesto sempre vence, campo a campo**. Expandido no RAW, antes da validação zod —
assim os defaults do schema se aplicam ao resultado e "campo omitido" nunca é confundido
com "campo com valor default". `use` sobrevive no valor resolvido, então `explain` rastreia.

Por que existir: declarar Gmail multi-conta exige saber que o server oficial não serve,
qual fork usar, que ele respeita `HOME` e quais vars exige. Isso é conhecimento do plugboard
(testado, datado, versionado com o pacote), não config do usuário.

**Não há "exceção de provider": há níveis de especificidade.** Um CLI comum é
install+check+auth (`railway`). Um serviço com várias implementações vira VÁRIOS providers
nomeados (`gmail-official` mono-conta vs `google-workspace` multi-conta), e escolher entre
eles é decisão explícita do manifesto — não um caso especial no código.

Todo preset carrega `verified: { date, version?, notes? }` — o que separa catálogo de chute.
Provider inexistente ou de kind errado é `InvalidManifestError` com a lista de opções.
`plugboard providers [--kind cli|mcp] [--json]` lista o catálogo.

Roadmap: providers definidos pelo usuário (`providers: {}` no manifesto ou arquivo externo)
e aviso quando a versão instalada divergir da `verified.version`.

## 7. Bridge MCP (`mcp-proxy`) — a rota generalista

**O problema que ele resolve.** Hoje, multi-conta depende de o server externo colaborar
(respeitar `HOME`, ter parâmetro de conta). Isso amarra o plugboard a forks específicos.
A inversão: **o plugboard vira o cliente MCP e o dono da credencial**; o agente fala com o
plugboard. Aí a identidade passa a ser do escopo da pasta, com QUALQUER server — inclusive
o oficial do Google, que é mono-conta pelo lado do Claude Code.

```
Claude Code ──stdio──► plugboard mcp-proxy <entrada> ──stdio/http──► server real
                       (credencial de .plugboard/mcp/<entrada>/)
```

**Repasse cru.** O proxy encaminha mensagens JSON-RPC sem interpretar método — tudo
atravessa fielmente, inclusive capabilities/notificações que o protocolo ganhar depois.
O proxy não precisa saber o que é `tools/call`.

**OAuth nós NÃO implementamos.** O SDK oficial faz discovery, PKCE, troca e refresh, e
expõe `OAuthClientProvider` como interface de **storage plugável**. `ScopedOAuthStore`
implementa esse contrato apontando pro diretório da entrada (arquivos 0600, `mkdir` 0700),
cliente **público** (`token_endpoint_auth_method: "none"` — PKCE é a proteção). Consistente
com a tese: compomos, não reinventamos criptografia nem fluxo de auth.

**Estado:** repasse stdio↔stdio **verificado ponta a ponta** (2026-09-12) contra
`@aaronsb/google-workspace-mcp@4.5.1`: `initialize` + `notifications/initialized` +
`tools/list` (13 tools) atravessam o proxy. Storage escopado coberto por teste.
`plugboard mcp login|logout|proxy <entrada>` implementados: `login` sobe callback em
127.0.0.1, valida `state` (CSRF), abre o browser e grava o token no escopo; `logout`
invalida. **Servers sem DCR** (o do Google é um — verificado 2026-09-12) exigem client
pré-registrado: `oauth.clientId`/`clientSecret` no manifesto aceitam `${VAR}` expandido da
cadeia de .env (segredo nunca no manifesto); sem isso o erro do SDK vira instrução acionável.
**`scope` é obrigatório passar ao `auth()`**: sem ele o SDK pede tudo que o servidor anuncia
no discovery — no Gmail isso vira `mail.google.com` (acesso total) em vez do `gmail.readonly`
declarado. Verificado e corrigido em 2026-09-12.
**VALIDADO ponta a ponta em 2026-09-12** contra o Gmail MCP oficial do Google com OAuth
client real: login por browser → token escopado em `.plugboard/mcp/gmail-suporte/` (0600) →
proxy → `initialize` + `tools/list` com **as 23 tools reais do Gmail**. Sem fork.

Dois achados do servidor do Google, ambos contornados:
1. **Status HTTP não-conforme**: `tools/list` responde **403 com corpo JSON-RPC válido**
   (result com as 23 tools, sem `error`); `initialize` responde 200. O spec manda 200 para
   toda resposta JSON-RPC, e o SDK descarta corpo de resposta não-ok. `tolerantFetch`
   reescreve para 200 **só** quando o corpo é JSON-RPC 2.0 bem formado — 403 de autenticação
   real (corpo do provedor) continua falhando, e `error` JSON-RPC é repassado ao cliente.
2. **`mcp-protocol-version` ausente**: o transport só o envia após `setProtocolVersion()`,
   normalmente chamado pelo `Client` do SDK. No repasse cru o proxy captura a versão da
   resposta do `initialize` e chama — é a única mensagem que o proxy inspeciona.

3. **`refresh_token` só com params extras**: o Google exige `access_type=offline` +
   `prompt=consent` na URL de autorização — fora do OAuth 2.1 padrão, então o SDK não passa.
   Declarável em `oauth.authorizationParams` (o preset `gmail-official` já traz).

**DUAS CONTAS CONVIVENDO — provado em 2026-09-12** no mesmo projeto, mesmo endpoint oficial:
`gmail-suporte` (escopo `gmail.compose`+`readonly`) e `gmail-pessoal` (só `readonly`),
tokens distintos, ambos com `refresh_token`, arquivos 0600 em diretórios separados, os dois
proxies respondendo 23 tools. É o caso que o Claude Code sozinho não permite.

⚠️ **`oauth.scopes` não esconde tools**: o servidor do Google anuncia as 23 tools mesmo
para um token `readonly` e só valida escopo na chamada. Quem impede o agente de *tentar* é
o `deny` por tool no settings — as duas camadas são necessárias, não redundantes.

**Quando usar o quê:** `isolate` (env/HOME) é mais simples e não põe processo no caminho —
prefira quando o server colabora. O proxy é a saída universal: serve http-OAuth e qualquer
server que não colabore, ao custo de um processo a mais no caminho crítico.

## 8. Emitters

`emit: ["claude-code"]` (default). Cada emitter é `render(Resolved) → arquivos` (puro) +
writer com lock. Materializa em **cada target** (`.mcp.json` não é lido de diretório pai —
por isso targets existem).

### claude-code

- **`.mcp.json`**: entradas de `mcp` com `${VAR}` **literal** (nunca o valor — quem expande
  é o Claude Code no boot); stdio ganha `env: {VAR: "${VAR}"}` automático a partir de `needs`.
- **`.claude/settings.json`**: `permissions.allow/deny` (manifesto + guards) e
  `enabledMcpjsonServers` com os servers emitidos.
- **Reconciliação**: entradas/regras não gerenciadas pelo plugboard são preservadas;
  remover do manifesto remove do arquivo (o lock lembra o que era nosso).
- **Estado isolado de MCP**: entradas com `isolate` recebem no `env` o caminho absoluto de
  `<raiz da cascata>/.plugboard/mcp/<nome>/` (path não é segredo → literal, não `${VAR}`). Fica na
  RAIZ da cascata, não no target, então os N repos de um projeto compartilham a mesma conta.
  `resolve` cria com mode 700; o doctor exige `.plugboard/` no `.gitignore` (`mcp.state-not-ignored`).
- **`.claude/skills/plugboard-connections/SKILL.md`** — skill GERADA da cascata resolvida
  (desligável com `"skill": false`). Doc estática sobre conexões envelhece e mente; esta
  deriva do manifesto e se regenera a cada `resolve`. É o par instrutivo dos deny-guards:
  as regras impedem o caminho errado, a skill ensina o certo — um agente barrado por `deny`
  sem saber a alternativa apenas tenta outra variação do mesmo comando. Lista os CLIs com a
  invocação correta (`exec --as` só para quem tem credencial), os MCPs com escopo e
  isolamento, o que está bloqueado, e o roteiro de diagnóstico. **Nunca contém valor de
  segredo — só nomes** (coberto por teste).
- **Lock** (`.plugboard.lock.json` no target): sha256 do que foi escrito + listas gerenciadas.
  Arquivo editado à mão ≠ lock → `resolve` **recusa** e pede `--force`. Sem lock e arquivo
  existe → primeiro run adota (tudo vira não-gerenciado, merge por cima).

## 9. CLI

citty puro (lazy `() => import()` por subcomando — cold start), `core/` é a API programática.
Zero prompt (roda em CI/pre-commit). `process.exitCode`, nunca `process.exit()`.

| Comando | Faz | Flags principais |
|---|---|---|
| `init` | cria manifesto, detecta `extends` | `--extends` |
| `resolve [target]` | compila cascata → emitters | `--dry-run` `--check` (CI/hook) `--force` |
| `doctor` | auditVars + auditHygiene + estado | `--only` `--json` `--fix` |
| `explain <chave>` | de onde veio (cli.x, mcp.x ou VAR) | |
| `list` | view humana (substitui CONNECTIONS.md) | `--json` |
| `exec -- <cmd>` | injeção escopada por execução | `--as agent\|cli:x` `--profile X` |
| `install` | instala CLIs da cadeia | `--dry-run` `--only` |
| `env` | env resolvido pra pipe | recusa TTY sem `--unsafe` |

Exit codes: `0` ok · `1` verificação falhou · `2` manifesto inválido · `3` cascata quebrada.

**`FindingCode` é API pública** (union fechado; mudar um code é breaking): `var.undeclared`,
`var.orphan`, `var.missing`, `secrets.key-missing`, `secrets.file-missing`, `secrets.tracked`,
`secrets.not-ignored`, `secrets.perms` (+ futuros `cli.*`, `mcp.*`, `rotation.*`, `emit.stale`).

## 10. Decisões registradas

- **JSONC** via `jsonc-parser` (não o loader do bun — Node-compat). Comentário é documentação.
- **zod 4**: tipos + validação + `toJSONSchema` (draft-07, `io:"input"`) de uma fonte. `prefault({})`
  em objeto aninhado (`.default({})` não aplica defaults internos).
- **Sem abstração de comando** (avaliado estilo tRPC e descartado): `core/` é a API; comando
  citty é fino e acoplado à CLI de propósito. tRPC vira opção se nascer 2º transporte real.
- **citty** > commander: lazy subcommands. Validação já é do zod, a lib só roteia.
- **tsdown** (`outExtensions` → `.js`; default `.mjs` quebrava o `exports`). `publint` + attw no publish.
- **Não ser cofre**: compor com dotenvx/`op`/etc. via esquemas. `.env` local chmod 600 é o default.
- **Local-only por política** (decisão BK): nada de valor no git em forma nenhuma; CLI fiscaliza;
  credencial por dev > segredo de time.
- **npm**: nome alvo `plugboard` (livre em 2026-08-31); bin `plugboard`; ESM-only; Node ≥20.
- **Bin polyglot sh/js** (pós-build): `#!/bin/sh` + `':' /*; exec node||bun */` — máquina só-bun
  executa o binário do PATH sem node. Pós-build porque o rolldown normaliza a linha no fonte.

## 11. Status

| Peça | Estado |
|---|---|
| schema, manifest, cascade (procedência, ciclo, null-remove) | ✅ 15 testes |
| secrets: cadeia+dotenvx, scopeFor, auditVars, auditHygiene | ✅ 23 testes |
| profile, oauth.scopes, policy no schema/merge | ✅ |
| emit/claude-code + lock (adoção, reconciliação, anti-clobber) | ✅ 10 testes |
| CLI: `init` `resolve` `doctor` `explain` `exec` `install` `login` `providers` | ✅ smoke e2e |
| Providers (catálogo verificado + `use`) | ✅ 8 testes |
| Bridge MCP: repasse stdio + `ScopedOAuthStore` | ✅ 9 testes + e2e |
| Tenant (`tenant.check/select`, `plugboard link`) | ✅ 5 testes |
| README + skill gerada | ✅ 7 testes |
| `mcp login` (callback local do OAuth) | 🔨 próximo |
| init, list, install, env, `doctor --leaks`, headersHelper emit, esquemas de cofre (`op://`…) | ⬜ roadmap |

## 12. Referências

Claude Code: [settings](https://code.claude.com/docs/en/settings) · [mcp](https://code.claude.com/docs/en/mcp) (stdio herda env; `oauth.scopes`; headersHelper) · [memory](https://code.claude.com/docs/en/memory) · issue [#23642](https://github.com/anthropics/claude-code/issues/23642) (op:// em env — aberto).
Padrões: `op run`/`doppler run`/`sops exec-env` (wrapper por execução) · OWASP: LLM nunca vê o valor · MCP auth = OAuth 2.1+PKCE.
Perfis: keychain `Claude Code-credentials-<sha256(configDir)[0:8]>`.
