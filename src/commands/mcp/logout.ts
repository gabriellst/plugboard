import { defineCommand } from 'citty'
import { loadCascade } from '../../core/cascade.js'
import { stateDirFor } from '../../core/mcp/proxy.js'
import { ScopedOAuthStore } from '../../core/mcp/oauth-store.js'
import { guarded } from '../guard.js'

export default defineCommand({
  meta: { name: 'logout', description: 'Descarta a credencial de uma entrada MCP neste escopo' },
  args: {
    entry: { type: 'positional', required: true },
    cwd: { type: 'string' },
    all: { type: 'boolean', default: false, description: 'Descarta também o registro de client e o verifier' },
  },
  run: guarded(async ({ args }) => {
    const resolved = await loadCascade(args.cwd ?? process.cwd())
    const dir = stateDirFor(resolved, args.entry)
    const store = new ScopedOAuthStore(dir, { redirectUrl: 'http://127.0.0.1:7777/callback', clientName: 'plugboard' })
    await store.invalidateCredentials(args.all ? 'all' : 'tokens')
    console.log(`✓ credencial de "${args.entry}" descartada neste escopo${args.all ? ' (incluindo registro de client)' : ''}`)
  }),
})
