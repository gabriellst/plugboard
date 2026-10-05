import { readFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Resolved } from './cascade.js'
import type { Finding } from './findings.js'

export interface EnvValue {
  value: string
  /** Arquivo .env de onde o valor final veio. */
  origin: string
}

export interface EnvFileStatus {
  path: string
  origin: string // manifesto que declarou o arquivo
  exists: boolean
  encrypted: boolean
  keyMissing: boolean
}

export interface SecretsResolution {
  /** Merge da cadeia, raiz → folha; folha vence var a var. */
  values: Record<string, EnvValue>
  files: EnvFileStatus[]
}

/**
 * Um arquivo cifrado pelo dotenvx carrega `DOTENV_PUBLIC_KEY<sufixo>` no corpo.
 * A private key correspondente chama `DOTENV_PRIVATE_KEY<sufixo>` — procurada
 * no `.env.keys` ao lado do arquivo e no process.env. Derivar do CONTEÚDO
 * (não do nome do arquivo) é o que torna o caminho robusto a renomes.
 */
function findPrivateKey(envPath: string, text: string, processEnv: NodeJS.ProcessEnv): string | null {
  const m = text.match(/^DOTENV_PUBLIC_KEY(\w*)=/m)
  if (!m) return null
  const keyName = `DOTENV_PRIVATE_KEY${m[1]}`

  const fromProcess = processEnv[keyName]
  if (fromProcess) return fromProcess

  const keysPath = join(dirname(envPath), '.env.keys')
  if (!existsSync(keysPath)) return null
  // .env.keys é do próprio dotenvx: linhas KEY="hex"
  const re = new RegExp(`^${keyName}="?([A-Fa-f0-9]+)"?`, 'm')
  try {
    return readFileSync(keysPath, 'utf8').match(re)?.[1] ?? null
  } catch {
    return null
  }
}

/** Carrega e decripta a cadeia de secrets.files. Nunca escreve em process.env. */
export async function loadEnvChain(
  resolved: Resolved,
  processEnv: NodeJS.ProcessEnv = process.env,
): Promise<SecretsResolution> {
  const values: Record<string, EnvValue> = {}
  const files: EnvFileStatus[] = []

  for (const file of resolved.secrets.files) {
    const status: EnvFileStatus = {
      path: file.value,
      origin: file.origin,
      exists: existsSync(file.value),
      encrypted: false,
      keyMissing: false,
    }
    files.push(status)
    if (!status.exists) continue

    const text = await readFile(file.value, 'utf8')
    status.encrypted = /^\w+=encrypted:/m.test(text) || /^DOTENV_PUBLIC_KEY/m.test(text)

    let privateKey: string | undefined
    if (status.encrypted) {
      const found = findPrivateKey(file.value, text, processEnv)
      if (!found) {
        status.keyMissing = true
        continue // sem a chave não dá pra ler NADA do arquivo — melhor falha explícita no doctor
      }
      privateKey = found
    }

    // lazy: só paga o import do dotenvx quando há arquivo pra ler
    const { parse } = await import('@dotenvx/dotenvx')
    const parsed = parse(text, privateKey ? { privateKey } : undefined) as Record<string, string>

    for (const [k, v] of Object.entries(parsed)) {
      if (k.startsWith('DOTENV_PUBLIC_KEY')) continue // metadado do dotenvx, não é segredo
      values[k] = { value: v, origin: file.value }
    }
  }

  return { values, files }
}

/** Grafo reverso: var → quem a referencia (cli:x, mcp:y). */
export function consumersOf(resolved: Resolved): Record<string, string[]> {
  const map: Record<string, string[]> = {}
  const add = (v: string, consumer: string) => {
    ;(map[v] ??= []).push(consumer)
  }
  for (const [name, cli] of Object.entries(resolved.cli)) {
    for (const v of cli.value.needs) add(v, `cli:${name}`)
    if (typeof cli.value.auth === 'object') for (const v of cli.value.auth.env ?? []) add(v, `cli:${name}`)
  }
  for (const [name, mcp] of Object.entries(resolved.mcp)) {
    for (const v of mcp.value.needs) add(v, `mcp:${name}`)
  }
  return map
}

/**
 * Escopo por consumidor — nunca a união de tudo.
 * - `agent`: só o que os MCP exigem (é o mínimo que o env da sessão precisa
 *   ter pra expansão ${VAR} do .mcp.json; CLIs recebem o delas via `exec`).
 * - `cli:<nome>` / `mcp:<nome>`: só o declarado daquele consumidor.
 */
export function scopeFor(
  resolved: Resolved,
  consumer: 'agent' | `cli:${string}` | `mcp:${string}`,
  resolution: SecretsResolution,
): Record<string, string> {
  let wanted: string[]
  if (consumer === 'agent') {
    wanted = Object.values(resolved.mcp).flatMap((m) => m.value.needs)
  } else {
    const [kind, name] = consumer.split(':', 2) as ['cli' | 'mcp', string]
    const entry = kind === 'cli' ? resolved.cli[name] : resolved.mcp[name]
    if (!entry) return {}
    wanted = [...entry.value.needs]
    if (kind === 'cli') {
      const auth = resolved.cli[name]!.value.auth
      if (typeof auth === 'object') wanted.push(...(auth.env ?? []))
    }
  }
  const out: Record<string, string> = {}
  for (const v of new Set(wanted)) {
    const hit = resolution.values[v]
    if (hit) out[v] = hit.value
  }
  return out
}

/** As checagens de grafo do doctor. Pura: recebe estado, devolve findings. */
export function auditVars(resolved: Resolved, resolution: SecretsResolution): Finding[] {
  const findings: Finding[] = []
  const consumers = consumersOf(resolved)
  const declared = resolved.secrets.vars

  for (const [v, users] of Object.entries(consumers)) {
    if (!declared[v]) {
      findings.push({
        severity: 'error',
        code: 'var.undeclared',
        subject: v,
        message: `referenciada por ${users.join(', ')} mas nenhum manifesto a declara em secrets.vars`,
        usedBy: users,
      })
    }
  }

  for (const [v, meta] of Object.entries(declared)) {
    // vars keychain/external documentam auth que vive fora — não exigem env nem uso via needs
    if (meta.value.source !== 'env') continue
    const users = consumers[v]
    if (!users) {
      findings.push({
        severity: 'warn',
        code: 'var.orphan',
        subject: v,
        message: 'declarada mas nenhum cli/mcp a referencia — remover ou ligar via needs',
        origin: meta.origin,
      })
    }
    if (!resolution.values[v]) {
      findings.push({
        severity: 'error',
        code: 'var.missing',
        subject: v,
        message: 'ausente na cadeia de .env',
        origin: meta.origin,
        usedBy: users,
      })
    }
  }

  for (const f of resolution.files) {
    if (!f.exists) {
      findings.push({
        severity: 'warn',
        code: 'secrets.file-missing',
        subject: f.path,
        message: 'declarado em secrets.files mas não existe',
        origin: f.origin,
      })
    } else if (f.keyMissing) {
      findings.push({
        severity: 'error',
        code: 'secrets.key-missing',
        subject: f.path,
        message: 'arquivo cifrado sem a private key (.env.keys ao lado, ou DOTENV_PRIVATE_KEY* no ambiente)',
        origin: f.origin,
      })
    }
  }

  return findings
}

// ─── Higiene: o enforce que substitui a necessidade de commitar ─────────────

import { spawnSync } from 'node:child_process'
import { statSync } from 'node:fs'

function git(cwd: string, ...args: string[]): number {
  return spawnSync('git', args, { cwd, stdio: 'ignore' }).status ?? 128
}

/** null = fora de repo git (nada a fiscalizar). */
export function gitStatusOf(file: string): 'tracked' | 'ignored' | 'exposed' | null {
  const cwd = dirname(file)
  if (git(cwd, 'rev-parse', '--is-inside-work-tree') !== 0) return null
  if (git(cwd, 'ls-files', '--error-unmatch', file) === 0) return 'tracked'
  if (git(cwd, 'check-ignore', '-q', file) === 0) return 'ignored'
  return 'exposed' // não versionado, mas a um `git add .` de distância
}

/**
 * Fiscaliza os arquivos de segredo contra a política da cascata.
 * - policy "local": NENHUM arquivo de valor pode estar tracked; não-ignorado é erro.
 * - policy "committed": arquivo cifrado tracked é ok; plaintext tracked é erro.
 * - `.env.keys` (private keys do dotenvx): tracked é erro SEMPRE, em qualquer política.
 * - permissões: legível por group/other → warn.
 */
export function auditHygiene(resolved: Resolved, resolution: SecretsResolution): Finding[] {
  const findings: Finding[] = []
  const policy = resolved.secrets.policy.value

  const inspect = (path: string, origin: string, opts: { encrypted: boolean; isKeyFile: boolean }) => {
    if (!existsSync(path)) return

    const status = gitStatusOf(path)
    if (status === 'tracked') {
      const allowed = !opts.isKeyFile && policy === 'committed' && opts.encrypted
      if (!allowed) {
        findings.push({
          severity: 'error',
          code: 'secrets.tracked',
          subject: path,
          message: opts.isKeyFile
            ? 'private key versionada no git — rotacionar e remover do histórico'
            : policy === 'committed'
              ? 'plaintext versionado — cifre com dotenvx antes de commitar'
              : 'versionado no git com policy "local" — remover do índice e do histórico',
          origin,
        })
      }
    } else if (status === 'exposed') {
      findings.push({
        severity: 'error',
        code: 'secrets.not-ignored',
        subject: path,
        message: 'não está no .gitignore — a um `git add .` do vazamento',
        origin,
      })
    }

    const mode = statSync(path).mode
    if ((mode & 0o044) !== 0) {
      findings.push({
        severity: 'warn',
        code: 'secrets.perms',
        subject: path,
        message: `legível por group/other (${(mode & 0o777).toString(8)}) — rode chmod 600`,
        origin,
      })
    }
  }

  for (const f of resolution.files) {
    inspect(f.path, f.origin, { encrypted: f.encrypted, isKeyFile: false })
    inspect(join(dirname(f.path), '.env.keys'), f.origin, { encrypted: false, isKeyFile: true })
  }

  return findings
}
