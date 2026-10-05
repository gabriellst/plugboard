import { defineCommand } from 'citty'
import { guarded } from './guard.js'
import { loadCascade } from '../core/cascade.js'
import { emitClaudeCode, type EmitResult } from '../core/emit/write.js'
import { EXIT } from '../core/errors.js'
import { chainLine, renderEmit } from '../report.js'

export default defineCommand({
  meta: { name: 'resolve', description: 'Compila a cascata e materializa nos targets' },
  args: {
    cwd: { type: 'string', description: 'Onde a cascata começa' },
    target: { type: 'string', description: 'Materializa só neste target' },
    'dry-run': { type: 'boolean', default: false, description: 'Mostra sem escrever' },
    check: { type: 'boolean', default: false, description: 'Exit 1 se o disco difere do gerado (CI/hook)' },
    force: { type: 'boolean', default: false, description: 'Sobrescreve arquivo editado à mão' },
    json: { type: 'boolean', default: false },
  },
  run: guarded(async ({ args }) => {
    const resolved = await loadCascade(args.cwd ?? process.cwd())
    const targets = args.target ? [args.target] : resolved.targets.length > 0 ? resolved.targets : [resolved.root]
    const dryRun = args['dry-run'] || args.check

    const skipped = resolved.emit.value.filter((e) => e !== 'claude-code')
    const results: EmitResult[] = []
    for (const t of targets) results.push(await emitClaudeCode(resolved, t, { force: args.force, dryRun }))

    if (args.json) console.log(JSON.stringify({ results }, null, 2))
    else {
      process.stdout.write(chainLine(resolved) + renderEmit(results, dryRun))
      for (const s of skipped) process.stdout.write(`  ⚠ emitter "${s}" ainda não implementado\n`)
    }
    process.exitCode = args.check && results.some((r) => r.written.length > 0) ? EXIT.CHECK_FAILED : EXIT.OK
  }),
})
