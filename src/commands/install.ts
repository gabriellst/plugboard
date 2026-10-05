import { spawnSync } from 'node:child_process'
import { defineCommand } from 'citty'
import { loadCascade } from '../core/cascade.js'
import { EXIT } from '../core/errors.js'
import { planInstall, runInstall } from '../core/install.js'
import { guarded } from './guard.js'

const has = (bin: string) =>
  spawnSync(process.platform === 'win32' ? 'where' : 'sh', process.platform === 'win32' ? [bin] : ['-c', `command -v ${bin}`], {
    stdio: 'ignore',
  }).status === 0

const ICON = { present: '✓', install: '↻', 'on-demand': '◦', unavailable: '✗' } as const

export default defineCommand({
  meta: { name: 'install', description: 'Instala os CLIs declarados na cascata' },
  args: {
    cwd: { type: 'string', description: 'Onde a cascata começa' },
    'dry-run': { type: 'boolean', default: false, description: 'Só mostra o plano' },
    only: { type: 'string', description: 'Filtra por nome (separado por vírgula)' },
    json: { type: 'boolean', default: false },
  },
  run: guarded(async ({ args }) => {
    const resolved = await loadCascade(args.cwd ?? process.cwd())
    const plan = planInstall(resolved, {
      platform: process.platform,
      has,
      only: args.only?.split(',').map((s) => s.trim()),
    })
    const results = runInstall(plan, { dryRun: args['dry-run'] })

    if (args.json) {
      console.log(JSON.stringify(results, null, 2))
    } else {
      const w = Math.max(0, ...results.map((r) => r.name.length))
      for (const r of results) {
        const note =
          r.status === 'present' ? 'já instalado'
          : r.status === 'install' ? `${r.command}${r.ok === false ? '  ✗ FALHOU' : r.ok ? '  ✓' : ''}`
          : r.reason
        console.log(`  ${ICON[r.status]} ${r.name.padEnd(w)}  ${note}`)
      }
    }
    const failed = results.some((r) => r.ok === false || r.status === 'unavailable')
    process.exitCode = failed ? EXIT.CHECK_FAILED : EXIT.OK
  }),
})
