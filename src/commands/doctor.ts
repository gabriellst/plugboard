import { defineCommand } from 'citty'
import { guarded } from './guard.js'
import { loadCascade } from '../core/cascade.js'
import { auditHygiene, auditVars, loadEnvChain } from '../core/secrets.js'
import { auditMcp } from '../core/audit-mcp.js'
import { EXIT } from '../core/errors.js'
import { renderFindings } from '../report.js'

export default defineCommand({
  meta: { name: 'doctor', description: 'Verifica credenciais, grafo e higiene' },
  args: {
    cwd: { type: 'string', description: 'Onde a cascata começa' },
    json: { type: 'boolean', default: false },
  },
  run: guarded(async ({ args }) => {
    const resolved = await loadCascade(args.cwd ?? process.cwd())
    const resolution = await loadEnvChain(resolved)
    const findings = [...auditVars(resolved, resolution), ...auditHygiene(resolved, resolution), ...auditMcp(resolved)]

    if (args.json) {
      console.log(JSON.stringify({ chain: resolved.chain.map((c) => c.file), findings }, null, 2))
    } else {
      process.stdout.write(renderFindings(resolved, findings))
    }
    process.exitCode = findings.some((f) => f.severity === 'error') ? EXIT.CHECK_FAILED : EXIT.OK
  }),
})
