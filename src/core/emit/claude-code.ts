import type { Resolved } from '../cascade.js'
import { mcpIsolationEnv } from '../isolate.js'

/**
 * Deny-guards de higiene de segredo, sempre emitidos.
 * `deny` vale antes do trust e vence `allow` — é enforcement, não convenção.
 * `Bash(env)`/`Bash(set)` são exatos (a forma nua que despeja tudo);
 * `env VAR=x cmd` legítimo não é bloqueado.
 */
export const SECRET_GUARDS = [
  'Bash(env)',
  'Bash(printenv)',
  'Bash(printenv:*)',
  'Bash(set)',
  'Read(**/.env)',
  'Read(**/.env.keys)',
  'Read(**/.env.local)',
  'Read(**/.secrets/**)',
] as const

export interface ClaudeCodeRender {
  /** Conteúdo de .mcp.json — entradas gerenciadas apenas. */
  mcpServers: Record<string, Record<string, unknown>>
  /** Fragmento gerenciado de .claude/settings.json. */
  settings: {
    permissions: { allow: string[]; deny: string[] }
    enabledMcpjsonServers: string[]
  }
}

/** Puro: Resolved → o que o claude-code deve enxergar. NUNCA contém valor de segredo. */
export function renderClaudeCode(resolved: Resolved): ClaudeCodeRender {
  const mcpServers: Record<string, Record<string, unknown>> = {}

  for (const [name, entry] of Object.entries(resolved.mcp)) {
    const m = entry.value
    const out: Record<string, unknown> = {}

    const isHttp = m.type === 'http' || m.type === 'sse' || (!m.command && m.url)

    // http + isolate → o Claude Code fala com o plugboard, que guarda a credencial
    // no escopo da entrada. É o que permite duas contas no MESMO endpoint (lá o
    // sign-in é chaveado por endpoint; aqui, por entrada).
    if (isHttp && m.isolate) {
      mcpServers[name] = {
        command: 'plugboard',
        args: ['mcp', 'proxy', name, '--root', resolved.root],
      }
      continue
    }

    if (m.type) out.type = m.type
    else if (isHttp) out.type = 'http'

    if (m.command) out.command = m.command
    if (m.args.length > 0) out.args = m.args
    if (m.url) out.url = m.url
    if (Object.keys(m.headers).length > 0) out.headers = m.headers
    if (m.oauth?.scopes) out.oauth = { scopes: m.oauth.scopes }

    // stdio: needs viram env {VAR: "${VAR}"} — literal; quem expande é o Claude Code.
    // O env de isolamento carrega um PATH (não é segredo) → vai literal e absoluto.
    if (!isHttp) {
      const env: Record<string, string> = { ...m.env, ...mcpIsolationEnv(resolved, name) }
      for (const v of m.needs) env[v] ??= `\${${v}}`
      if (Object.keys(env).length > 0) out.env = env
    } else if (Object.keys(m.env).length > 0) {
      out.env = m.env
    }

    mcpServers[name] = out
  }

  const deny = [...new Set([...SECRET_GUARDS, ...resolved.permissions.deny.map((d) => d.value)])].sort()
  const allow = [...new Set(resolved.permissions.allow.map((a) => a.value))].sort()

  return {
    mcpServers,
    settings: {
      permissions: { allow, deny },
      enabledMcpjsonServers: Object.keys(mcpServers).sort(),
    },
  }
}
