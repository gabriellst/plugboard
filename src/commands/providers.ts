import { defineCommand } from 'citty'
import { PROVIDERS } from '../core/providers.js'
import { guarded } from './guard.js'

export default defineCommand({
  meta: { name: 'providers', description: 'Lista os presets disponíveis para `use`' },
  args: {
    kind: { type: 'string', description: 'cli | mcp' },
    json: { type: 'boolean', default: false },
  },
  run: guarded(async ({ args }) => {
    const entries = Object.entries(PROVIDERS).filter(([, p]) => !args.kind || p.kind === args.kind)
    if (args.json) {
      console.log(JSON.stringify(Object.fromEntries(entries), null, 2))
      return
    }
    for (const kind of ['cli', 'mcp'] as const) {
      const of = entries.filter(([, p]) => p.kind === kind)
      if (of.length === 0) continue
      console.log(`\n${kind.toUpperCase()}`)
      const w = Math.max(...of.map(([k]) => k.length))
      for (const [name, p] of of) {
        console.log(`  ${name.padEnd(w)}  ${p.description}`)
        if (p.verified) {
          const v = [p.verified.version, `verificado ${p.verified.date}`].filter(Boolean).join(' · ')
          console.log(`  ${' '.repeat(w)}  ✓ ${v}`)
          if (p.verified.notes) console.log(`  ${' '.repeat(w)}    ${p.verified.notes}`)
        }
      }
    }
    console.log('')
  }),
})
