import { isAbsolute, resolve } from 'node:path'
import { BrokenCascadeError } from './errors.js'
import { findManifest, findManifestUp, loadManifest, type LoadedManifest } from './manifest.js'
import type { CliEntry, Manifest, McpEntry, VarMeta } from './schema.js'

/** Todo valor resolvido carrega de onde veio — é o que o `explain` imprime. */
export interface Sourced<T> {
  value: T
  /** Manifesto que definiu o valor final. */
  origin: string
  /** Todo manifesto que tocou nessa chave, raiz → folha. */
  touchedBy: string[]
}

export interface Resolved {
  /** Diretório da folha — onde a sessão nasce. */
  root: string
  /** A cadeia inteira, raiz → folha. */
  chain: LoadedManifest[]
  cli: Record<string, Sourced<CliEntry>>
  mcp: Record<string, Sourced<McpEntry>>
  secrets: {
    /** Absolutos, raiz → folha. O último vence var a var. */
    files: Sourced<string>[]
    vars: Record<string, Sourced<VarMeta>>
    /** Filho vence; default "local". */
    policy: Sourced<'local' | 'committed'>
  }
  permissions: { allow: Sourced<string>[]; deny: Sourced<string>[] }
  emit: Sourced<string[]>
  /** Filho vence; null = perfil default da máquina. */
  profile: Sourced<string | null>
  /** Emitir a skill do agente. Filho vence; default true. */
  skill: Sourced<boolean>
  /** Absolutos. Vem só da folha — `targets` não herda. */
  targets: string[]
}

const DEFAULT_EMIT = ['claude-code']

/** Resolve `extends` de um manifesto para o arquivo do pai, ou null se é raiz. */
function resolveParent(lm: LoadedManifest): string | null {
  const ext = lm.manifest.extends ?? 'auto'
  if (ext === null) return null

  if (ext === 'auto') {
    const parent = resolve(lm.dir, '..')
    return findManifestUp(parent)
  }

  const target = isAbsolute(ext) ? ext : resolve(lm.dir, ext)
  const found = findManifest(target)
  if (found) return found
  throw new BrokenCascadeError(
    `extends não resolve: "${ext}"`,
    `declarado em ${lm.file}\nnenhum ${'connections.jsonc'} encontrado em ${target}`,
  )
}

/** Monta a cadeia folha → raiz, detectando ciclo, e devolve raiz → folha. */
export async function buildChain(leafFile: string): Promise<LoadedManifest[]> {
  const chain: LoadedManifest[] = []
  const seen = new Set<string>()
  let current: string | null = leafFile

  while (current) {
    if (seen.has(current)) {
      throw new BrokenCascadeError(
        'ciclo na cascata',
        [...seen, current].join('\n  ↓ '),
      )
    }
    seen.add(current)

    const lm: LoadedManifest = await loadManifest(current)
    chain.push(lm)
    current = resolveParent(lm)
  }

  return chain.reverse()
}

/** Merge por chave: o filho substitui a entrada inteira; `null` remove a herdada. */
function mergeRecord<T>(
  chain: LoadedManifest[],
  pick: (m: Manifest) => Record<string, T | null>,
): Record<string, Sourced<T>> {
  const out: Record<string, Sourced<T>> = {}
  for (const lm of chain) {
    for (const [key, value] of Object.entries(pick(lm.manifest))) {
      const prev = out[key]
      if (value === null) {
        delete out[key]
        continue
      }
      out[key] = {
        value,
        origin: lm.file,
        touchedBy: prev ? [...prev.touchedBy, lm.file] : [lm.file],
      }
    }
  }
  return out
}

/** Concatena raiz → folha, preservando origem de cada item. */
function concat<T>(chain: LoadedManifest[], pick: (m: Manifest) => T[]): Sourced<T>[] {
  return chain.flatMap((lm) =>
    pick(lm.manifest).map((value) => ({ value, origin: lm.file, touchedBy: [lm.file] })),
  )
}

export function mergeChain(chain: LoadedManifest[]): Resolved {
  const leaf = chain[chain.length - 1]
  if (!leaf) throw new BrokenCascadeError('cadeia vazia')

  // skill: o filho substitui
  let skill: Sourced<boolean> = { value: true, origin: '(default)', touchedBy: [] }
  for (const lm of chain) {
    if (lm.manifest.skill !== undefined) {
      skill = { value: lm.manifest.skill, origin: lm.file, touchedBy: [...skill.touchedBy, lm.file] }
    }
  }

  // profile: o filho substitui (igual emit)
  let profile: Sourced<string | null> = { value: null, origin: '(default)', touchedBy: [] }
  for (const lm of chain) {
    if (lm.manifest.profile !== undefined) {
      profile = { value: lm.manifest.profile, origin: lm.file, touchedBy: [...profile.touchedBy, lm.file] }
    }
  }

  // policy: o filho substitui (igual emit)
  let policy: Sourced<'local' | 'committed'> = { value: 'local', origin: '(default)', touchedBy: [] }
  for (const lm of chain) {
    if (lm.manifest.secrets.policy) {
      policy = { value: lm.manifest.secrets.policy, origin: lm.file, touchedBy: [...policy.touchedBy, lm.file] }
    }
  }

  // emit: o filho substitui o valor inteiro (não concatena)
  let emit: Sourced<string[]> = { value: DEFAULT_EMIT, origin: '(default)', touchedBy: [] }
  for (const lm of chain) {
    if (lm.manifest.emit) {
      emit = { value: lm.manifest.emit, origin: lm.file, touchedBy: [...emit.touchedBy, lm.file] }
    }
  }

  return {
    root: leaf.dir,
    chain,
    cli: mergeRecord(chain, (m) => m.cli),
    mcp: mergeRecord(chain, (m) => m.mcp),
    secrets: {
      files: chain.flatMap((lm) =>
        lm.manifest.secrets.files.map((f) => ({
          value: resolve(lm.dir, f),
          origin: lm.file,
          touchedBy: [lm.file],
        })),
      ),
      vars: mergeRecord(chain, (m) => m.secrets.vars),
      policy,
    },
    permissions: {
      allow: concat(chain, (m) => m.permissions.allow),
      deny: concat(chain, (m) => m.permissions.deny),
    },
    emit,
    profile,
    skill,
    // targets não herda: só a folha
    targets: leaf.manifest.targets.map((t) => resolve(leaf.dir, t)),
  }
}

export async function loadCascade(startDir: string): Promise<Resolved> {
  // git-like: sobe a árvore até achar um manifesto (sessões nascem DENTRO dos repos-target)
  const leaf = findManifestUp(resolve(startDir))
  if (!leaf) {
    throw new BrokenCascadeError(
      `nenhum manifesto em ${startDir}`,
      'rode `plugboard init` pra criar um connections.jsonc',
    )
  }
  return mergeChain(await buildChain(leaf))
}
