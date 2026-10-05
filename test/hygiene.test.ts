import { describe, expect, test } from 'bun:test'
import { execSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadCascade } from '../src/core/cascade.js'
import { auditHygiene, loadEnvChain } from '../src/core/secrets.js'

type Opts = { policy?: string; env?: string; gitignore?: string | null; track?: boolean; keys?: string; trackKeys?: boolean; mode?: number }

async function scenario(o: Opts) {
  const d = mkdtempSync(join(tmpdir(), 'pb-hyg-'))
  execSync('git init -q', { cwd: d })
  mkdirSync(join(d, '.secrets'))
  const envPath = join(d, '.secrets', '.env')
  writeFileSync(envPath, o.env ?? 'X=1\n')
  chmodSync(envPath, o.mode ?? 0o600)
  if (o.gitignore !== null) writeFileSync(join(d, '.gitignore'), o.gitignore ?? '.secrets/\n')
  if (o.keys !== undefined) {
    writeFileSync(join(d, '.secrets', '.env.keys'), o.keys)
    chmodSync(join(d, '.secrets', '.env.keys'), 0o600)
  }
  if (o.track) execSync('git add -f .secrets/.env', { cwd: d })
  if (o.trackKeys) execSync('git add -f .secrets/.env.keys', { cwd: d })
  const policy = o.policy ? `, "policy": "${o.policy}"` : ''
  writeFileSync(
    join(d, 'connections.jsonc'),
    `{ "plugboard": 1, "extends": null, "secrets": { "files": [".secrets/.env"]${policy} } }`,
  )
  const r = await loadCascade(d)
  return { r, findings: auditHygiene(r, await loadEnvChain(r, {})) }
}

describe('enforce de higiene', () => {
  test('local + ignorado + 600 → limpo', async () => {
    const { findings } = await scenario({})
    expect(findings).toEqual([])
  })

  test('fora do .gitignore → secrets.not-ignored', async () => {
    const { findings } = await scenario({ gitignore: null })
    expect(findings.map((f) => f.code)).toEqual(['secrets.not-ignored'])
  })

  test('tracked com policy local → secrets.tracked (o caso bk-reviews-api)', async () => {
    const { findings } = await scenario({ track: true, gitignore: null })
    expect(findings.map((f) => f.code)).toEqual(['secrets.tracked'])
  })

  test('policy committed: plaintext tracked continua erro', async () => {
    const { findings } = await scenario({ policy: 'committed', track: true, gitignore: null })
    expect(findings.map((f) => f.code)).toEqual(['secrets.tracked'])
  })

  test('policy committed: CIFRADO tracked é permitido', async () => {
    const { findings } = await scenario({
      policy: 'committed',
      track: true,
      gitignore: null,
      env: 'DOTENV_PUBLIC_KEY_X="02ab"\nY=encrypted:AAA\n',
    })
    // sem .env.keys a var não decripta, mas higiene não reclama do tracked
    expect(findings.filter((f) => f.code === 'secrets.tracked')).toEqual([])
  })

  test('.env.keys tracked é erro SEMPRE, mesmo em committed', async () => {
    const { findings } = await scenario({
      policy: 'committed',
      keys: 'DOTENV_PRIVATE_KEY_X="ab12"\n',
      trackKeys: true,
      gitignore: '.secrets/.env\n',
    })
    const f = findings.find((x) => x.code === 'secrets.tracked')
    expect(f?.subject.endsWith('.env.keys')).toBe(true)
    expect(f?.message).toContain('private key')
  })

  test('legível por outros → secrets.perms com o modo no texto', async () => {
    const { findings } = await scenario({ mode: 0o644 })
    expect(findings[0]).toMatchObject({ code: 'secrets.perms', severity: 'warn' })
    expect(findings[0]!.message).toContain('644')
  })

  test('policy cascateia: filho pode endurecer o pai', async () => {
    const { r } = await scenario({ policy: 'committed' })
    expect(r.secrets.policy.value).toBe('committed')
    const clean = await scenario({})
    expect(clean.r.secrets.policy.value).toBe('local')
    expect(clean.r.secrets.policy.origin).toBe('(default)')
  })
})
