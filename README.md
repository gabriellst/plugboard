# plugboard

**Conexões e credenciais em cascata para agentes de código.**

Você tem vários projetos. Cada um fala com serviços diferentes — bancos, CDNs, deploy,
e-mail — com credenciais diferentes, às vezes com *contas* diferentes do mesmo serviço.
Seu agente precisa alcançar tudo isso sem que os segredos vazem e sem que o projeto A
consiga agir como o projeto B.

Config de agente não resolve isso hoje: `.mcp.json` e `.claude/settings.json` valem só no
diretório onde a sessão nasce — não herdam de pastas-pai — e segredo vira variável de
ambiente solta que todo subprocesso enxerga.

O plugboard declara tudo num manifesto por nível de diretório, resolve a cadeia pai→filho,
e **compila** o resultado para os arquivos que o agente lê.

```
bk-company/connections.jsonc          ← CLIs e políticas da organização
└── bk-reviews/connections.jsonc      ← herda, adiciona, sobrescreve
    └── software/api/                 ← a sessão nasce aqui e recebe a cascata inteira
```

## Instalação

```bash
npm i -g plugboard     # ou: bun add -g plugboard · pnpm add -g plugboard
```

Requer Node ≥ 20 (funciona sob bun também).

## Começando

```bash
cd meu-projeto
plugboard init         # cria connections.jsonc, detectando o pai na árvore
plugboard install      # instala os CLIs declarados
plugboard login        # mostra o que falta autenticar
plugboard doctor       # verifica credenciais, grafo e higiene
plugboard resolve      # materializa .mcp.json e .claude/settings.json
```

Todo comando descobre a cascata subindo a árvore, como o git acha o `.git` — funciona de
qualquer subdiretório.

## O manifesto

```jsonc
{
  "$schema": "https://unpkg.com/plugboard/schema.json",
  "plugboard": 1,
  "extends": "..",                     // "auto" (default) · caminho · null p/ raiz
  "profile": "meu-projeto",            // identidade isolada (contas separadas por projeto)

  "secrets": {
    "policy": "local",                 // valor nunca versionado; a CLI fiscaliza
    "files": [".secrets/.env"],
    "vars": {
      // metadado da credencial — NUNCA o valor
      "BUNNY_API_KEY": { "service": "BunnyCDN", "owner": "ana", "rotate": "90d" }
    }
  },

  "cli": {
    "railway": { "use": "railway" },                              // preset do catálogo
    "bunny":   { "use": "bunny", "auth": { "env": ["BUNNY_API_KEY"] } }
  },

  "mcp": {
    "postgres": { "use": "postgres", "needs": ["DATABASE_URL"] },
    "gdrive":   null                   // remove uma entrada herdada do pai
  },

  "permissions": { "allow": ["Bash(bun:*)"], "deny": [] },
  "targets": ["software/api", "software/web"]   // onde materializar
}
```

Use `.jsonc`: comentários fazem parte da documentação. `plugboard providers` lista os
presets disponíveis, cada um com o que foi verificado e quando.

### Como a cascata resolve

| Campo | Regra |
|---|---|
| `cli.*`, `mcp.*`, `secrets.vars.*` | merge por chave; o filho substitui a entrada inteira; `null` remove |
| `secrets.files` | concatena raiz→folha; o `.env` da folha vence var a var |
| `permissions.allow` | concatena |
| `permissions.deny` | concatena; o filho **nunca** remove |
| `profile`, `emit`, `secrets.policy` | o filho substitui o valor |
| `targets` | não herda — só a folha |

`plugboard explain <chave>` mostra de onde cada valor veio.

## Segredos

O manifesto é o contrato e pode ser versionado. **Os valores nunca.** Eles vivem em
`.secrets/.env` local (ou num cofre — `dotenvx` é suportado nativamente), e a CLI fiscaliza
a diferença: arquivo versionado, fora do `.gitignore` ou legível por outros vira erro no
`doctor`.

Na hora de usar, o segredo é injetado **por execução e por consumidor**:

```bash
plugboard exec --as cli:bunny -- bunny deploy ./dist
```

O processo filho recebe só o que aquela ferramenta declarou em `needs` — nunca a união de
tudo — e a variável morre com ele. O agente conhece o *nome* da credencial, nunca o valor.

Por que isso importa: o ambiente de uma sessão de agente vaza com facilidade. Um `env` num
Bash vira resultado de ferramenta, que vira transcript em disco. E servidores MCP stdio
herdam o ambiente **inteiro** do processo — um servidor de banco enxergaria sua chave de
CDN. Por isso o emitter também injeta regras `deny` para `env`, `printenv` e leitura de
`.env`/`.secrets`.

## Identidade: quem sou e onde ajo

São dois eixos, e o plugboard os trata separadamente.

**Identidade** — cada projeto pode ter sua própria conta no mesmo serviço:

```jsonc
"profile": "projeto-a"    // agente e CLIs ganham storage isolado por perfil
"cli": { "railway": { "use": "railway" } }   // o preset já declara isolate: "home"
```

```bash
plugboard login railway   # loga a conta DESTE projeto; outro projeto tem a sua
```

**Tenant** — estar logado não diz onde você age:

```bash
plugboard link railway    # seleciona projeto/ambiente neste escopo
plugboard link            # mostra os dois eixos de todos os CLIs
```

O `doctor` só checa o tenant quando a identidade está ok — senão reportaria "sem projeto"
para quem apenas precisa fazer login.

## Várias contas do mesmo serviço

Duas entradas do mesmo servidor MCP normalmente **compartilham** credencial: o Claude Code
guarda sign-in OAuth por endpoint, não por nome. Com `isolate`, o plugboard vira o cliente
OAuth e guarda o token por entrada:

```jsonc
"mcp": {
  "gmail-suporte": { "use": "gmail-official", "isolate": "home",
                     "oauth": { "scopes": "…/gmail.readonly …/gmail.compose" } },
  "gmail-pessoal": { "use": "gmail-official", "isolate": "home" }
},
"permissions": { "deny": ["mcp__gmail-pessoal__create_draft"] }
```

```bash
plugboard mcp login gmail-suporte    # browser; escolha a conta A
plugboard mcp login gmail-pessoal    # browser; escolha a conta B
```

As duas convivem, com escopos diferentes, no mesmo projeto e no mesmo endpoint oficial —
sem depender de fork da comunidade.

⚠️ Escopo OAuth **não esconde ferramenta**: servidores costumam anunciar todas as tools e
só validar o escopo na chamada. Quem impede o agente de *tentar* é a regra `deny`. As duas
camadas são complementares.

## Comandos

| | |
|---|---|
| `init` | cria o manifesto, detectando o pai |
| `resolve` | compila a cascata nos targets · `--check` para CI e hooks |
| `doctor` | credenciais, grafo e higiene · `--json` |
| `explain <chave>` | de onde o valor veio (`cli.x`, `mcp.x` ou `NOME_DA_VAR`) |
| `exec --as <consumidor> -- <cmd>` | roda com segredos escopados |
| `install` | instala os CLIs declarados |
| `login [cli]` · `link [cli]` | identidade · tenant |
| `mcp login\|logout\|proxy <entrada>` | credencial de MCP por escopo |
| `providers` | catálogo de presets |

Exit codes: `0` ok · `1` verificação falhou · `2` manifesto inválido · `3` cascata quebrada.
Nada é interativo por padrão — `resolve --check` e `doctor` servem em pre-commit e CI.

## Uso programático

```ts
import { loadCascade, auditVars, loadEnvChain } from 'plugboard'

const resolved = await loadCascade(process.cwd())
const findings = auditVars(resolved, await loadEnvChain(resolved))
```

`core/` não conhece terminal: retorna dados, não imprime, não sai do processo.

## O que o plugboard não é

**Não é cofre.** Ele compõe com `dotenvx`, `op`, `doppler` — não reimplementa criptografia.

**Não é servidor MCP.** O bridge roteia e guarda credencial; quem fala com a API do serviço
continua sendo o servidor (de preferência o oficial).

**Não substitui o CLAUDE.md.** O manifesto descreve conexões. Instrução de comportamento
para o agente continua no CLAUDE.md, que é o arquivo efetivamente carregado.

## Licença

MIT
