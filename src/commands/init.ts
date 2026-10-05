import { defineCommand } from 'citty'
import { initManifest } from '../core/init.js'
import { guarded } from './guard.js'

export default defineCommand({
  meta: { name: 'init', description: 'Cria um connections.jsonc neste diretório (detecta o pai automaticamente)' },
  args: {
    cwd: { type: 'string', description: 'Diretório alvo (default: atual)' },
    extends: { type: 'string', description: '"auto" (default) | "none" | caminho do pai' },
  },
  run: guarded(async ({ args }) => {
    const r = await initManifest(args.cwd ?? process.cwd(), { extends: args.extends })
    console.log(`✓ ${r.manifestPath}`)
    console.log(r.extendsValue ? `  extends: "${r.extendsValue}" (herda a cascata de cima)` : '  raiz da cascata (extends: null)')
    if (r.createdSecrets) console.log('  ✓ .secrets/.env criado (chmod 600) — confira o .gitignore antes de commitar')
  }),
})
