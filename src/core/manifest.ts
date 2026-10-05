import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parse as parseJsonc, parseTree, type Node, type ParseError, printParseErrorCode } from 'jsonc-parser'
import { InvalidManifestError } from './errors.js'
import { Manifest } from './schema.js'
import { expandProviders, UnknownProviderError } from './providers.js'

export const MANIFEST_NAMES = ['connections.jsonc', 'connections.json'] as const

export interface LoadedManifest {
  /** Caminho absoluto do arquivo. É a identidade do nível na cascata. */
  file: string
  /** Diretório do arquivo — base pra resolver todo caminho relativo dele. */
  dir: string
  manifest: Manifest
}

/** Acha o manifesto de um diretório, sem subir. */
export function findManifest(dir: string): string | null {
  for (const name of MANIFEST_NAMES) {
    const p = join(dir, name)
    if (existsSync(p)) return p
  }
  return null
}

/** Sobe a árvore até achar um manifesto. Usado por `extends: "auto"` e por `init`. */
export function findManifestUp(fromDir: string, stopAt?: string): string | null {
  let dir = resolve(fromDir)
  while (true) {
    const found = findManifest(dir)
    if (found) return found
    const parent = dirname(dir)
    if (parent === dir || (stopAt && dir === resolve(stopAt))) return null
    dir = parent
  }
}

/**
 * Chave repetida num objeto: o parser mantém a ÚLTIMA e descarta a anterior, sem erro.
 * É silencioso e caro (um `"x": null` some porque existe um `"x": {…}` embaixo), então
 * o plugboard trata como manifesto inválido em vez de deixar passar.
 */
function findDuplicateKeys(node: Node | undefined, path: string[] = [], out: string[] = []): string[] {
  if (!node) return out
  if (node.type === 'object') {
    const seen = new Set<string>()
    for (const prop of node.children ?? []) {
      const key = prop.children?.[0]?.value as string | undefined
      if (typeof key === 'string') {
        if (seen.has(key)) out.push([...path, key].join('.'))
        seen.add(key)
      }
      findDuplicateKeys(prop.children?.[1], key ? [...path, key] : path, out)
    }
  } else if (node.type === 'array') {
    for (const child of node.children ?? []) findDuplicateKeys(child, path, out)
  }
  return out
}

export async function loadManifest(file: string): Promise<LoadedManifest> {
  const text = await readFile(file, 'utf8')

  const errors: ParseError[] = []
  const raw = parseJsonc(text, errors, { allowTrailingComma: true, disallowComments: false })

  if (errors.length > 0) {
    const detail = errors
      .map((e) => `  offset ${e.offset}: ${printParseErrorCode(e.error)}`)
      .join('\n')
    throw new InvalidManifestError(file, `JSONC malformado:\n${detail}`)
  }

  const dupes = findDuplicateKeys(parseTree(text, [], { allowTrailingComma: true }))
  if (dupes.length > 0) {
    throw new InvalidManifestError(
      file,
      dupes.map((d) => `  chave duplicada: "${d}" — a última vence e a anterior é descartada em silêncio`).join('\n'),
    )
  }

  let expanded: unknown
  try {
    expanded = expandProviders(raw)
  } catch (e) {
    if (e instanceof UnknownProviderError) throw new InvalidManifestError(file, `  ${e.message}`)
    throw e
  }

  const parsed = Manifest.safeParse(expanded)
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(raiz)'}: ${i.message}`)
      .join('\n')
    throw new InvalidManifestError(file, detail)
  }

  return { file, dir: dirname(file), manifest: parsed.data }
}
