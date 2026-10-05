import { defineCommand } from 'citty'
import { loadCascade } from '../core/cascade.js'
import { loadEnvChain, scopeFor } from '../core/secrets.js'
import { isolationEnv } from '../core/isolate.js'
import { mkdirSync } from 'node:fs'
import { authStatus, performLogin } from '../core/auth.js'
import { EXIT } from '../core/errors.js'
import { guarded } from './guard.js'

export default defineCommand({
  meta: { name: 'login', description: 'Estado de autenticação dos CLIs; com <nome>, roda o login interativo' },
  args: {
    name: { type: 'positional', required: false, description: 'CLI pra logar (vazio = só mostra o estado de todos)' },
    cwd: { type: 'string' },
    timeout: { type: 'string', default: '15000', description: 'Timeout dos checks (ms)' },
    json: { type: 'boolean', default: false },
  },
  run: guarded(async ({ args }) => {
    const resolved = await loadCascade(args.cwd ?? process.cwd())
    const timeoutMs = Number(args.timeout)
    // checks rodam com a credencial DO PROJETO injetada (escopo por consumidor)
    const resolution = await loadEnvChain(resolved)
    const envFor = (name: string) => {
      const iso = isolationEnv(resolved, name)
      if (iso.HOME) mkdirSync(iso.HOME, { recursive: true })
      return { ...scopeFor(resolved, `cli:${name}`, resolution), ...iso }
    }

    if (args.name) {
      const [st] = authStatus(resolved, { only: [args.name], timeoutMs, envFor })
      if (!st) throw new Error(`cli "${args.name}" não existe na cascata`)
      if (st.state === 'ok') {
        console.log(`✓ ${st.name} já autenticado (${st.check})`)
        return
      }
      if (!st.login) {
        console.log(`✗ ${st.name} não tem "auth.login" declarado no manifesto`)
        if (st.env?.length) console.log(`  auth por env: preencha ${st.env.join(', ')} no .secrets/.env`)
        process.exitCode = EXIT.CHECK_FAILED
        return
      }
      const iso = isolationEnv(resolved, args.name)
      if (iso.HOME) console.log(`  (credencial isolada do perfil "${resolved.profile.value}" — vale só pra este projeto)`)
      console.log(`→ rodando: ${st.login}\n`)
      const r = performLogin(st, envFor(args.name))
      console.log(r.ok ? `\n✓ ${st.name} autenticado` : `\n✗ ${st.name}: o check ainda falha após o login`)
      process.exitCode = r.ok ? EXIT.OK : EXIT.CHECK_FAILED
      return
    }

    const statuses = authStatus(resolved, { timeoutMs, envFor })
    if (args.json) {
      console.log(JSON.stringify(statuses, null, 2))
    } else {
      const w = Math.max(0, ...statuses.map((s) => s.name.length))
      for (const s of statuses) {
        const tenantHint =
          !s.tenant ? ''
          : s.tenant.state === 'ok' ? '  · tenant vinculado'
          : s.tenant.state === 'fail' ? `  · SEM tenant (plugboard link ${s.name})`
          : ''
        const hint =
          s.state === 'ok' ? `autenticado${tenantHint}`
          : s.state === 'no-check' ? 'sem "check" declarado — estado desconhecido'
          : s.login ? `rode: plugboard login ${s.name}`
          : s.env?.length ? `preencha ${s.env.join(', ')} no .secrets/.env`
          : 'auth externa — ver docs do serviço'
        console.log(`  ${s.state === 'ok' ? '✓' : s.state === 'fail' ? '✗' : '◦'} ${s.name.padEnd(w)}  ${hint}`)
      }
    }
    process.exitCode = statuses.some((s) => s.state === 'fail') ? EXIT.CHECK_FAILED : EXIT.OK
  }),
})
