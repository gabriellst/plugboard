import { existsSync } from 'node:fs'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { findManifest, findManifestUp } from './manifest.js'
import { PlugboardError, EXIT } from './errors.js'

export interface InitResult {
  manifestPath: string
  extendsValue: string | null
  createdSecrets: boolean
}

/** Cria um connections.jsonc no diretório, detectando o pai subindo a árvore. */
export async function initManifest(dir: string, opts: { extends?: string } = {}): Promise<InitResult> {
  const target = resolve(dir)
  if (findManifest(target)) {
    throw new PlugboardError(`já existe um manifesto em ${target}`, EXIT.CHECK_FAILED)
  }

  let extendsValue: string | null
  if (opts.extends === 'none') extendsValue = null
  else if (opts.extends && opts.extends !== 'auto') extendsValue = opts.extends
  else {
    const parent = findManifestUp(dirname(target))
    extendsValue = parent ? relative(target, dirname(parent)) || '..' : null
  }

  const name = basename(target)
  const lines = [
    '{',
    '  "plugboard": 1,',
    `  "name": "${name}",`,
    `  "extends": ${extendsValue === null ? 'null' : `"${extendsValue}"`},${extendsValue === null ? '' : '   // detectado subindo a árvore'}`,
    '',
    '  "secrets": { "files": [".secrets/.env"] },',
    '',
    '  // "cli":  { "gh": { "install": { "brew": "gh" }, "check": "gh auth status", "auth": { "login": "gh auth login" } } },',
    '  // "mcp":  { "meu-server": { "command": "bunx", "args": ["…"], "needs": ["MINHA_VAR"] } },',
    '  "permissions": { "allow": [], "deny": [] }',
    '}',
    '',
  ]
  const manifestPath = join(target, 'connections.jsonc')
  await writeFile(manifestPath, lines.join('\n'))

  let createdSecrets = false
  const secretsDir = join(target, '.secrets')
  const envPath = join(secretsDir, '.env')
  if (!existsSync(envPath)) {
    await mkdir(secretsDir, { recursive: true })
    await writeFile(envPath, '# valores locais deste nível — NUNCA versionar\n')
    await chmod(envPath, 0o600)
    createdSecrets = true
  }

  return { manifestPath, extendsValue, createdSecrets }
}
