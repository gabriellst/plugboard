import { defineCommand } from 'citty'
import { guarded } from './guard.js'
import { loadCascade, type Sourced } from '../core/cascade.js'
import { consumersOf, loadEnvChain } from '../core/secrets.js'

function renderSourced(key: string, s: Sourced<unknown>): string {
  let out = `${key}\n`
  for (const f of s.touchedBy) out += `  ${f === s.origin ? '└─' : '├─'} ${f}${f === s.origin ? '  ← valor final' : '  sobrescrito'}\n`
  return `${out}  = ${JSON.stringify(s.value)}\n`
}

export default defineCommand({
  meta: { name: 'explain', description: 'De onde veio um valor na cascata (cli.x, mcp.x ou VAR)' },
  args: {
    key: { type: 'positional', description: 'cli.<nome> | mcp.<nome> | NOME_DA_VAR', required: true },
    cwd: { type: 'string' },
  },
  run: guarded(async ({ args }) => {
    const r = await loadCascade(args.cwd ?? process.cwd())
    const [kind, name] = args.key.includes('.') ? args.key.split('.', 2) : [null, args.key]

    if (kind === 'cli' || kind === 'mcp') {
      const entry = (kind === 'cli' ? r.cli : r.mcp)[name!]
      if (!entry) throw new Error(`${args.key} não existe na cascata resolvida`)
      process.stdout.write(renderSourced(args.key, entry))
      return
    }

    // VAR: metadado + consumidores + presença (NUNCA o valor)
    const meta = r.secrets.vars[name!]
    const users = consumersOf(r)[name!] ?? []
    const present = (await loadEnvChain(r)).values[name!]
    let out = `${name}\n`
    out += meta ? `  declarada em ${meta.origin}\n    ${JSON.stringify(meta.value)}\n` : '  ⚠ não declarada em secrets.vars\n'
    out += users.length > 0 ? `  usada por ${users.join(', ')}\n` : '  ⚠ nenhum cli/mcp referencia\n'
    out += present ? `  valor presente (veio de ${present.origin})\n` : '  ✗ ausente na cadeia de .env\n'
    process.stdout.write(out)
  }),
})
