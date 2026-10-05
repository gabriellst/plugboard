import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { defineCommand } from 'citty'
import { guarded } from './guard.js'
import { loadCascade } from '../core/cascade.js'
import { loadEnvChain, scopeFor } from '../core/secrets.js'
import { isolationEnv } from '../core/isolate.js'

export default defineCommand({
  meta: { name: 'exec', description: 'Roda um comando com segredos escopados injetados SÓ nele' },
  args: {
    cwd: { type: 'string' },
    as: { type: 'string', default: 'agent', description: 'agent | cli:<nome> | mcp:<nome>' },
    profile: { type: 'string', description: 'Sobrepõe o profile da cascata (CLAUDE_CONFIG_DIR isolado)' },
  },
  run: guarded(async ({ args }) => {
    const sep = process.argv.indexOf('--')
    const cmd = sep >= 0 ? process.argv.slice(sep + 1) : []
    if (cmd.length === 0) throw new Error('uso: plugboard exec [--as agent|cli:x] -- <comando…>')

    const resolved = await loadCascade(args.cwd ?? process.cwd())
    const scoped = scopeFor(resolved, args.as as never, await loadEnvChain(resolved))

    const profile = args.profile ?? resolved.profile.value
    const iso = args.as.startsWith('cli:') ? isolationEnv(resolved, args.as.slice(4), profile) : {}
    if (iso.HOME) mkdirSync(iso.HOME, { recursive: true })
    const env: NodeJS.ProcessEnv = { ...process.env, ...scoped, ...iso }
    if (profile) {
      env.CLAUDE_CONFIG_DIR = join(homedir(), '.plugboard', 'profiles', profile)
      mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true })
    }

    const r = spawnSync(cmd[0]!, cmd.slice(1), { env, stdio: 'inherit' })
    process.exitCode = r.status ?? 1
  }),
})
