import { defineCommand } from 'citty'
import { loadCascade } from '../../core/cascade.js'
import { pipeStdio, targetFor, stateDirFor } from '../../core/mcp/proxy.js'
import { guarded } from '../guard.js'

export default defineCommand({
  meta: {
    name: 'proxy',
    description: 'Bridge MCP: injeta a credencial do escopo desta pasta e repassa ao server real',
  },
  args: {
    entry: { type: 'positional', required: true, description: 'Nome da entrada mcp na cascata' },
    root: { type: 'string', description: 'Raiz da cascata (default: cwd)' },
  },
  run: guarded(async ({ args }) => {
    const resolved = await loadCascade(args.root ?? process.cwd())
    const target = targetFor(resolved, args.entry)

    if (target.kind === 'stdio') {
      const code = await pipeStdio(target, { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr })
      process.exitCode = code
      return
    }

    // http: o SDK cuida de discovery/PKCE/refresh; nós damos o storage escopado.
    // import dinâmico — quem não usa proxy não paga o custo do SDK no boot.
    const [{ ScopedOAuthStore }, { StreamableHTTPClientTransport }, { StdioServerTransport }] = await Promise.all([
      import('../../core/mcp/oauth-store.js'),
      import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
      import('@modelcontextprotocol/sdk/server/stdio.js'),
    ])

    const { resolveOAuthClient } = await import('../../core/mcp/client-config.js')
    const staticClient = await resolveOAuthClient(resolved, args.entry)
    const store = new ScopedOAuthStore(stateDirFor(resolved, args.entry), {
      redirectUrl: 'http://127.0.0.1:7777/callback',
      clientName: `plugboard/${args.entry}`,
      ...(staticClient ? { staticClient } : {}),
    })

    const { tolerantFetch } = await import('../../core/mcp/tolerant-fetch.js')
    const upstream = new StreamableHTTPClientTransport(new URL(target.url!), {
      authProvider: store as never,
      fetch: tolerantFetch(undefined, ({ status }) =>
        process.stderr.write(`[plugboard] servidor devolveu HTTP ${status} com JSON-RPC válido — tratado como 200\n`),
      ) as never,
    })
    const local = new StdioServerTransport()

    // repasse cru nos dois sentidos: nada de interpretar método.
    // ÚNICA exceção: capturar a versão negociada na resposta do initialize. O
    // transport HTTP precisa dela para mandar `mcp-protocol-version` nas
    // requisições seguintes — sem isso o servidor recusa com 403. Normalmente
    // quem chama setProtocolVersion é o Client do SDK, que aqui não existe.
    upstream.onmessage = (m) => {
      const version = (m as { result?: { protocolVersion?: string } })?.result?.protocolVersion
      if (version) upstream.setProtocolVersion(version)
      local.send(m)
    }
    local.onmessage = (m) => upstream.send(m)
    upstream.onerror = (e) => process.stderr.write(`[plugboard] upstream: ${e.message}\n`)

    await upstream.start()
    await local.start()
  }),
})
