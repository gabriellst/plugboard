import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { Resolved } from '../cascade.js'
import { mcpIsolationEnv, mcpStateDir } from '../isolate.js'

/**
 * Bridge MCP: o Claude Code fala com o plugboard; o plugboard fala com o server real.
 *
 * O repasse é de mensagens JSON-RPC CRUAS, sem interpretar método — assim tudo
 * atravessa fielmente, inclusive capabilities e notificações que o protocolo
 * ganhar depois. O proxy não precisa saber o que é `tools/call`.
 *
 * O ganho não é técnico, é de identidade: quem guarda a credencial passa a ser
 * o plugboard, no escopo da pasta — e não o Claude Code, que chaveia por endpoint.
 */
export interface ProxyTarget {
  kind: 'stdio' | 'http'
  /** stdio */
  command?: string
  args?: string[]
  env?: Record<string, string>
  /** http */
  url?: string
}

/** Traduz uma entrada resolvida no alvo concreto do proxy. */
export function targetFor(resolved: Resolved, entryName: string): ProxyTarget {
  const entry = resolved.mcp[entryName]
  if (!entry) throw new Error(`entrada mcp "${entryName}" não existe na cascata`)
  const m = entry.value
  const isHttp = m.type === 'http' || m.type === 'sse' || (!m.command && !!m.url)

  if (isHttp) {
    if (!m.url) throw new Error(`entrada "${entryName}" é http mas não tem url`)
    return { kind: 'http', url: m.url }
  }
  if (!m.command) throw new Error(`entrada "${entryName}" não tem command nem url`)
  return {
    kind: 'stdio',
    command: m.command,
    args: m.args,
    env: { ...m.env, ...mcpIsolationEnv(resolved, entryName) },
  }
}

export const stateDirFor = mcpStateDir

/**
 * Pipe bidirecional stdio↔stdio. Uma linha = uma mensagem JSON-RPC
 * (framing do transporte stdio do MCP).
 */
export function pipeStdio(
  target: ProxyTarget,
  io: { stdin: NodeJS.ReadableStream; stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream },
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(target.command!, target.args ?? [], {
      env: { ...process.env, ...target.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    child.on('error', reject)

    // cliente → upstream
    createInterface({ input: io.stdin }).on('line', (line) => {
      if (line.trim()) child.stdin.write(`${line}\n`)
    })
    // upstream → cliente
    createInterface({ input: child.stdout }).on('line', (line) => {
      if (line.trim()) io.stdout.write(`${line}\n`)
    })
    // stderr do upstream é diagnóstico, nunca protocolo
    child.stderr.pipe(io.stderr)

    child.on('close', (code) => resolve(code ?? 0))
  })
}
