import { spawnSync } from 'node:child_process'
import type { Resolved } from './cascade.js'

export type Manager = 'brew' | 'apt' | 'winget' | 'scoop'
const NATIVE: Record<string, Manager[]> = {
  darwin: ['brew'],
  linux: ['apt', 'brew'],
  win32: ['winget', 'scoop'],
}
const ON_DEMAND = ['bunx', 'npx'] as const

export interface InstallAction {
  name: string
  bin: string
  status: 'present' | 'install' | 'on-demand' | 'unavailable'
  /** Comando completo a executar (status "install"). */
  command?: string
  reason?: string
}

/** Puro: decide o que fazer por CLI. `has` e `platform` injetados = testável sem SO. */
export function planInstall(
  resolved: Resolved,
  opts: { platform: string; has: (bin: string) => boolean; only?: string[] },
): InstallAction[] {
  const actions: InstallAction[] = []

  for (const [name, sourced] of Object.entries(resolved.cli)) {
    if (opts.only && !opts.only.includes(name)) continue
    const e = sourced.value
    const bin = e.bin ?? name

    if (opts.has(bin)) {
      actions.push({ name, bin, status: 'present' })
      continue
    }

    const inst = e.install
    if (!inst) {
      actions.push({ name, bin, status: 'unavailable', reason: 'sem install declarado no manifesto' })
      continue
    }

    // bunx/npx rodam sob demanda — não há binário local a instalar
    const onDemand = ON_DEMAND.find((m) => inst[m])
    const manager = (NATIVE[opts.platform] ?? []).find((m) => inst[m] && opts.has(m))
    if (manager) {
      const cmds: Record<Manager, string> = {
        brew: `brew install ${inst.brew}`,
        apt: `sudo apt-get install -y ${inst.apt}`,
        winget: `winget install ${inst.winget}`,
        scoop: `scoop install ${inst.scoop}`,
      }
      const command = inst.post ? `${cmds[manager]} && ${inst.post}` : cmds[manager]
      actions.push({ name, bin, status: 'install', command })
    } else if (onDemand) {
      actions.push({ name, bin, status: 'on-demand', reason: `roda via ${onDemand} ${inst[onDemand]} — nada a instalar` })
    } else {
      const declared = Object.keys(inst).filter((k) => k !== 'post')
      actions.push({
        name,
        bin,
        status: 'unavailable',
        reason: `nenhum gerenciador disponível nesta plataforma (declarado: ${declared.join(', ') || 'nenhum'})`,
      })
    }
  }
  return actions
}

export interface InstallOutcome extends InstallAction {
  ok?: boolean
}

export function runInstall(actions: InstallAction[], opts: { dryRun?: boolean } = {}): InstallOutcome[] {
  return actions.map((a) => {
    if (a.status !== 'install' || opts.dryRun) return a
    const shell = process.platform === 'win32' ? ['cmd', '/c'] : ['sh', '-c']
    const r = spawnSync(shell[0]!, [shell[1]!, a.command!], { stdio: 'inherit' })
    return { ...a, ok: r.status === 0 }
  })
}
