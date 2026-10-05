import { spawnSync } from 'node:child_process'
import type { Resolved } from './cascade.js'

export interface AuthStatus {
  name: string
  /** Identidade: quem sou. */
  state: 'ok' | 'fail' | 'no-check'
  check?: string
  /** Comando interativo de login, se declarado. */
  login?: string
  /** Vars alternativas de auth, se declaradas. */
  env?: string[]
  /** Tenant: onde ajo. `undefined` = a entrada não declara esse eixo. */
  tenant?: {
    state: 'ok' | 'fail' | 'no-check'
    select?: string
    expect?: string
  }
}

const shell = (cmd: string, opts: { interactive?: boolean; timeoutMs?: number; env?: Record<string, string> } = {}) => {
  const [bin, flag] = process.platform === 'win32' ? ['cmd', '/c'] : ['sh', '-c']
  return spawnSync(bin, [flag, cmd], {
    stdio: opts.interactive ? 'inherit' : 'ignore',
    timeout: opts.timeoutMs,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
  })
}

/**
 * Roda o `check` de cada CLI. Com `envFor`, o check roda ATRAVÉS do escopo do
 * projeto (a credencial do .env do filho é injetada) — então ele prova a
 * credencial DESTE projeto, não o login global da máquina. Onde a env var tem
 * precedência sobre o login (Railway, p.ex.), isso escopa a verificação de fato.
 */
export function authStatus(
  resolved: Resolved,
  opts: { only?: string[]; timeoutMs?: number; envFor?: (name: string) => Record<string, string> } = {},
): AuthStatus[] {
  const out: AuthStatus[] = []
  for (const [name, sourced] of Object.entries(resolved.cli)) {
    if (opts.only && !opts.only.includes(name)) continue
    const e = sourced.value
    const auth = typeof e.auth === 'object' ? e.auth : undefined
    const base = { name, check: e.check, login: auth?.login, env: auth?.env }
    if (!e.check) {
      out.push({ ...base, state: 'no-check' })
      continue
    }
    const env = opts.envFor?.(name)
    const timeoutMs = opts.timeoutMs ?? 15_000
    const ok = shell(e.check, { timeoutMs, env }).status === 0

    // tenant só é checado quando a identidade está ok — `railway status` sem login
    // falha por falta de conta, não por falta de projeto, e o diagnóstico sairia errado.
    let tenant: AuthStatus['tenant']
    if (e.tenant) {
      const t = e.tenant
      tenant = !t.check
        ? { state: 'no-check', select: t.select, expect: t.expect }
        : !ok
          ? { state: 'no-check', select: t.select, expect: t.expect }
          : { state: shell(t.check, { timeoutMs, env }).status === 0 ? 'ok' : 'fail', select: t.select, expect: t.expect }
    }
    out.push({ ...base, state: ok ? 'ok' : 'fail', ...(tenant ? { tenant } : {}) })
  }
  return out
}

/** Executa a seleção de tenant declarada (interativa: `railway link` pergunta o projeto). */
export function performTenantSelect(
  entry: { tenant?: { select?: string; check?: string } },
  env?: Record<string, string>,
): { ran: boolean; ok: boolean } {
  const cmd = entry.tenant?.select
  if (!cmd) return { ran: false, ok: false }
  shell(cmd, { interactive: true, env })
  const check = entry.tenant?.check
  return { ran: true, ok: check ? shell(check, { timeoutMs: 15_000, env }).status === 0 : true }
}

/** Executa o login interativo declarado (browser/OAuth do próprio CLI) e re-verifica. */
export function performLogin(status: AuthStatus, env?: Record<string, string>): { ran: boolean; ok: boolean } {
  if (!status.login) return { ran: false, ok: false }
  shell(status.login, { interactive: true, env })
  const ok = status.check ? shell(status.check, { timeoutMs: 15_000, env }).status === 0 : true
  return { ran: true, ok }
}
