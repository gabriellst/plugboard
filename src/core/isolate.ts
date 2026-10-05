import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Resolved } from './cascade.js'

/**
 * Env que isola o storage de credencial de um CLI por perfil.
 * Só age quando o manifesto declara `auth.isolate: "home"` E há um profile na
 * cascata (raiz sem profile = terreno neutro → credencial global da máquina).
 */
export function isolationEnv(
  resolved: Resolved,
  cliName: string,
  profile: string | null = resolved.profile.value,
): Record<string, string> {
  const entry = resolved.cli[cliName]
  if (!entry || !profile) return {}
  const auth = entry.value.auth
  if (typeof auth !== 'object' || auth.isolate !== 'home') return {}
  return { HOME: join(homedir(), '.plugboard', 'profiles', profile, 'home') }
}

/** Diretório de estado de uma entrada MCP isolada: `<raiz da cascata>/.plugboard/mcp/<nome>`. */
export function mcpStateDir(resolved: Resolved, entryName: string): string {
  return join(resolved.root, '.plugboard', 'mcp', entryName)
}

/**
 * Env que dá estado próprio a uma entrada MCP stdio. Vazio quando a entrada não
 * declara `isolate` ou quando é http/sse (lá o token é do Claude Code, por endpoint).
 */
export function mcpIsolationEnv(resolved: Resolved, entryName: string): Record<string, string> {
  const entry = resolved.mcp[entryName]
  if (!entry?.value.isolate) return {}
  const m = entry.value
  const isHttp = m.type === 'http' || m.type === 'sse' || (!m.command && !!m.url)
  if (isHttp) return {}
  const dir = mcpStateDir(resolved, entryName)
  return m.isolate === 'home' ? { HOME: dir } : { [(m.isolate as { env: string }).env]: dir }
}
