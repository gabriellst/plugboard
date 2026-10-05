import { defineCommand } from 'citty'
import { loadCascade } from '../../core/cascade.js'
import { EXIT } from '../../core/errors.js'
import { targetFor, stateDirFor } from '../../core/mcp/proxy.js'
import { ScopedOAuthStore } from '../../core/mcp/oauth-store.js'
import { loginToServer } from '../../core/mcp/login.js'
import { resolveOAuthClient, explainDcrFailure } from '../../core/mcp/client-config.js'
import { guarded } from '../guard.js'

export default defineCommand({
  meta: { name: 'login', description: 'Autentica uma entrada MCP no escopo desta pasta (OAuth por browser)' },
  args: {
    entry: { type: 'positional', required: true, description: 'Nome da entrada mcp' },
    cwd: { type: 'string' },
    port: { type: 'string', default: '7777', description: 'Porta do callback local' },
    timeout: { type: 'string', default: '300000', description: 'Espera pelo callback (ms)' },
  },
  run: guarded(async ({ args }) => {
    const resolved = await loadCascade(args.cwd ?? process.cwd())
    const target = targetFor(resolved, args.entry)
    if (target.kind !== 'http') {
      console.log(`✗ "${args.entry}" é stdio — a auth é do próprio server, não há login OAuth aqui.`)
      console.log('  (rode as tools do server; com `isolate` cada entrada já tem estado próprio)')
      process.exitCode = EXIT.CHECK_FAILED
      return
    }

    const port = Number(args.port)
    const dir = stateDirFor(resolved, args.entry)
    const staticClient = await resolveOAuthClient(resolved, args.entry)
    const store = new ScopedOAuthStore(dir, {
      redirectUrl: `http://127.0.0.1:${port}/callback`,
      clientName: `plugboard/${args.entry}`,
      ...(staticClient ? { staticClient } : {}),
    })

    const oauth = resolved.mcp[args.entry]?.value.oauth
    const scope = oauth?.scopes
    console.log(`entrada : ${args.entry}  →  ${target.url}`)
    console.log(`escopos : ${scope ?? '(não declarado — o servidor decide; pode ser acesso total)'}`)
    console.log(`escopo  : ${dir.replace(process.env.HOME ?? '~', '~')}\n`)

    let r: Awaited<ReturnType<typeof loginToServer>>
    try {
      r = await loginToServer(store, target.url!, {
        port,
        timeoutMs: Number(args.timeout),
        log: (s) => process.stdout.write(s),
        ...(scope ? { scope } : {}),
        ...(oauth?.authorizationParams ? { authorizationParams: oauth.authorizationParams } : {}),
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (!staticClient && /registration_endpoint|does not support dynamic|registration/i.test(msg)) {
        console.error(`✗ ${explainDcrFailure(args.entry, target.url!)}`)
        process.exitCode = EXIT.CHECK_FAILED
        return
      }
      throw e
    }
    console.log(r.status === 'already' ? '✓ já autenticado neste escopo' : `\n✓ autenticado — token salvo no escopo de "${args.entry}"`)
  }),
})
