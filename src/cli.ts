#!/usr/bin/env node
import { defineCommand, runMain } from 'citty'
import { EXIT, PlugboardError } from './core/errors.js'

const main = defineCommand({
  meta: { name: 'plugboard', version: '0.0.0', description: 'Cascading connections & credentials for AI coding agents' },
  subCommands: {
    init: () => import('./commands/init.js').then((m) => m.default),
    resolve: () => import('./commands/resolve.js').then((m) => m.default),
    doctor: () => import('./commands/doctor.js').then((m) => m.default),
    explain: () => import('./commands/explain.js').then((m) => m.default),
    exec: () => import('./commands/exec.js').then((m) => m.default),
    install: () => import('./commands/install.js').then((m) => m.default),
    login: () => import('./commands/login.js').then((m) => m.default),
    link: () => import('./commands/link.js').then((m) => m.default),
    providers: () => import('./commands/providers.js').then((m) => m.default),
    mcp: () => import('./commands/mcp/index.js').then((m) => m.default),
  },
})

runMain(main).catch((e: unknown) => {
  if (e instanceof PlugboardError) {
    console.error(`✗ ${e.message}${e.detail ? `\n${e.detail}` : ''}`)
    process.exitCode = e.exit
  } else {
    console.error(`✗ ${e instanceof Error ? e.message : String(e)}`)
    process.exitCode = EXIT.CHECK_FAILED
  }
})
