import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadCascade } from '../src/core/cascade.js'
import { planInstall } from '../src/core/install.js'

async function resolvedWith(cli: string) {
  const d = mkdtempSync(join(tmpdir(), 'pb-inst-'))
  writeFileSync(join(d, 'connections.jsonc'), `{ "plugboard": 1, "extends": null, "cli": ${cli} }`)
  return loadCascade(d)
}

describe('planInstall', () => {
  test('presente no PATH → present, sem comando', async () => {
    const r = await resolvedWith('{ "gh": { "install": { "brew": "gh" } } }')
    const [a] = planInstall(r, { platform: 'darwin', has: () => true })
    expect(a).toMatchObject({ status: 'present', name: 'gh' })
  })

  test('ausente + brew disponível → comando de install (com post encadeado)', async () => {
    const r = await resolvedWith('{ "psql": { "install": { "brew": "libpq", "post": "brew link --force libpq" } } }')
    const [a] = planInstall(r, { platform: 'darwin', has: (b) => b === 'brew' })
    expect(a!.status).toBe('install')
    expect(a!.command).toBe('brew install libpq && brew link --force libpq')
  })

  test('bin ≠ chave: presença checa o binário certo', async () => {
    const r = await resolvedWith('{ "grafana": { "bin": "grafanactl", "install": { "brew": "grafanactl" } } }')
    const seen: string[] = []
    planInstall(r, { platform: 'darwin', has: (b) => (seen.push(b), false) })
    expect(seen).toContain('grafanactl')
    expect(seen).not.toContain('grafana')
  })

  test('só bunx declarado → on-demand, nunca tenta instalar', async () => {
    const r = await resolvedWith('{ "bunny": { "install": { "bunx": "@bunny.net/cli" } } }')
    const [a] = planInstall(r, { platform: 'darwin', has: (b) => b === 'brew' })
    expect(a!.status).toBe('on-demand')
    expect(a!.reason).toContain('@bunny.net/cli')
  })

  test('plataforma sem gerenciador declarado → unavailable com dica (caso dev Windows)', async () => {
    const r = await resolvedWith('{ "railway": { "install": { "brew": "railway" } } }')
    const [a] = planInstall(r, { platform: 'win32', has: () => false })
    expect(a!.status).toBe('unavailable')
    expect(a!.reason).toContain('brew')
  })

  test('--only filtra', async () => {
    const r = await resolvedWith('{ "a": { "install": { "brew": "a" } }, "b": { "install": { "brew": "b" } } }')
    const plan = planInstall(r, { platform: 'darwin', has: () => true, only: ['b'] })
    expect(plan.map((x) => x.name)).toEqual(['b'])
  })
})
