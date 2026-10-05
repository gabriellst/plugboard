import { existsSync } from 'node:fs'
import type { Resolved } from './cascade.js'
import type { Finding } from './findings.js'
import { mcpStateDir } from './isolate.js'
import { gitStatusOf } from './secrets.js'

/**
 * O Claude Code guarda sign-in OAuth POR ENDPOINT, não por nome de server
 * (docs: "Claude Code stores OAuth sign-ins per endpoint"). Então duas entradas
 * com nomes diferentes e a MESMA url compartilham o mesmo token: você acha que
 * tem duas contas e tem uma só — e os dois logam/deslogam juntos.
 */
export function auditMcp(resolved: Resolved): Finding[] {
  const byUrl = new Map<string, string[]>()
  for (const [name, entry] of Object.entries(resolved.mcp)) {
    const url = entry.value.url
    // com `isolate` a entrada vai pelo proxy e tem credencial própria — não colide
    if (!url || entry.value.isolate) continue
    byUrl.set(url, [...(byUrl.get(url) ?? []), name])
  }

  const findings: Finding[] = [...byUrl.entries()]
    .filter(([, names]) => names.length > 1)
    .map(([url, names]) => ({
      severity: 'error' as const,
      code: 'mcp.shared-endpoint' as const,
      subject: names.join(', '),
      message: `mesma url (${url}) — o Claude Code guarda o OAuth por ENDPOINT, então essas entradas compartilham UMA credencial. Para contas distintas: url por conta, server multi-conta, ou stdio com "isolate"`,
      usedBy: names,
    }))

  for (const [name, entry] of Object.entries(resolved.mcp)) {
    const m = entry.value
    if (!m.isolate) continue
    const dir = mcpStateDir(resolved, name)
    if (existsSync(dir) && gitStatusOf(dir) === 'exposed') {
      findings.push({
        severity: 'error',
        code: 'mcp.state-not-ignored',
        subject: dir,
        message: 'estado/credencial do MCP fora do .gitignore — adicione `.plugboard/`',
        origin: entry.origin,
      })
    }
  }

  return findings
}
