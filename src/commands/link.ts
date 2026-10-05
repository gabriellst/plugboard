import { defineCommand } from 'citty'
import { loadCascade } from '../core/cascade.js'
import { authStatus, performTenantSelect } from '../core/auth.js'
import { EXIT } from '../core/errors.js'
import { isolationEnv } from '../core/isolate.js'
import { loadEnvChain, scopeFor } from '../core/secrets.js'
import { guarded } from './guard.js'
import { mkdirSync } from 'node:fs'

export default defineCommand({
  meta: {
    name: 'link',
    description: 'Seleciona o tenant (projeto/ambiente) de um CLI neste escopo',
  },
  args: {
    name: { type: 'positional', required: false, description: 'CLI a vincular (vazio = mostra o estado de todos)' },
    cwd: { type: 'string' },
    timeout: { type: 'string', default: '15000' },
  },
  run: guarded(async ({ args }) => {
    const resolved = await loadCascade(args.cwd ?? process.cwd())
    const resolution = await loadEnvChain(resolved)
    const envFor = (name: string) => {
      const iso = isolationEnv(resolved, name)
      if (iso.HOME) mkdirSync(iso.HOME, { recursive: true })
      return { ...scopeFor(resolved, `cli:${name}`, resolution), ...iso }
    }
    const timeoutMs = Number(args.timeout)

    if (args.name) {
      const [st] = authStatus(resolved, { only: [args.name], timeoutMs, envFor })
      if (!st) throw new Error(`cli "${args.name}" não existe na cascata`)
      if (!st.tenant) {
        console.log(`✗ "${args.name}" não declara seleção de tenant no manifesto`)
        process.exitCode = EXIT.CHECK_FAILED
        return
      }
      if (st.state !== 'ok') {
        console.log(`✗ "${args.name}" não está autenticado — rode primeiro: plugboard login ${args.name}`)
        process.exitCode = EXIT.CHECK_FAILED
        return
      }
      const entry = resolved.cli[args.name]!.value
      console.log(`→ ${entry.tenant!.select}\n`)
      const r = performTenantSelect(entry, envFor(args.name))
      console.log(r.ok ? `\n✓ ${args.name}: tenant selecionado neste escopo` : `\n✗ ${args.name}: o check de tenant ainda falha`)
      process.exitCode = r.ok ? EXIT.OK : EXIT.CHECK_FAILED
      return
    }

    const statuses = authStatus(resolved, { timeoutMs, envFor }).filter((s) => s.tenant)
    if (statuses.length === 0) {
      console.log('nenhum cli da cascata declara seleção de tenant')
      return
    }
    const w = Math.max(...statuses.map((s) => s.name.length))
    for (const s of statuses) {
      const t = s.tenant!
      const label =
        s.state !== 'ok' ? 'identidade pendente — plugboard login primeiro'
        : t.state === 'ok' ? 'vinculado'
        : t.state === 'no-check' ? 'sem check declarado'
        : `sem alvo — rode: plugboard link ${s.name}${t.expect ? `  (${t.expect})` : ''}`
      const icon = s.state !== 'ok' ? '·' : t.state === 'ok' ? '✓' : t.state === 'no-check' ? '◦' : '✗'
      console.log(`  ${icon} ${s.name.padEnd(w)}  ${label}`)
    }
    process.exitCode = statuses.some((s) => s.state === 'ok' && s.tenant!.state === 'fail') ? EXIT.CHECK_FAILED : EXIT.OK
  }),
})
