import { defineCommand } from 'citty'

export default defineCommand({
  meta: { name: 'mcp', description: 'Bridge MCP: credencial por escopo de pasta' },
  subCommands: {
    login: () => import('./login.js').then((m) => m.default),
    logout: () => import('./logout.js').then((m) => m.default),
    proxy: () => import('./proxy.js').then((m) => m.default),
  },
})
