import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadCascade } from '../src/core/cascade.js'
import { renderSkill } from '../src/core/emit/skill.js'
import { emitClaudeCode } from '../src/core/emit/write.js'

const load = async (body: string) => {
  const d = mkdtempSync(join(tmpdir(), 'pb-skill-'))
  writeFileSync(join(d, 'connections.jsonc'), `{ "plugboard": 1, "extends": null, ${body} }`)
  return { d, r: await loadCascade(d) }
}
const SKILL = join('.claude', 'skills', 'plugboard-connections', 'SKILL.md')

describe('skill gerada', () => {
  test('tem frontmatter válido com name e description', async () => {
    const { r } = await load('"cli": {}')
    const out = renderSkill(r)
    expect(out.startsWith('---\n')).toBe(true)
    const fm = out.split('---')[1]!
    expect(fm).toContain('name: plugboard-connections')
    expect(fm).toContain('description:')
  })

  test('lista os CLIs reais, com o exec certo para quem precisa de credencial', async () => {
    const { r } = await load(`"secrets": { "vars": { "K": { "service": "S" } } },
      "cli": { "bunny": { "use": "bunny", "auth": { "env": ["K"] } }, "gh": { "use": "gh" } }`)
    const out = renderSkill(r)
    expect(out).toContain('plugboard exec --as cli:bunny')
    expect(out).toContain('`gh …`')          // sem credencial: invocação direta
    expect(out).not.toContain('exec --as cli:gh')
  })

  test('mostra escopo e isolamento dos MCPs', async () => {
    const { r } = await load(`"mcp": { "g": { "use": "gmail-official", "isolate": "home",
      "oauth": { "scopes": "a b" } } }`)
    const out = renderSkill(r)
    expect(out).toContain('escopo concedido: `a b`')
    expect(out).toContain('identidade própria')
  })

  test('lista o que está bloqueado e aponta a saída', async () => {
    const { r } = await load('"permissions": { "deny": ["Bash(rm -rf:*)"] }')
    const out = renderSkill(r)
    expect(out).toContain('Bash(rm -rf:*)')
    expect(out).toContain('Bash(env)')       // guards sempre emitidos
    expect(out).toContain('plugboard exec')
  })

  test('NUNCA contém valor de segredo — só nomes', async () => {
    const { d } = await load('"cli": {}')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(join(d, '.secrets'))
    writeFileSync(join(d, '.secrets/.env'), 'K=valor-super-secreto\n')
    writeFileSync(join(d, 'connections.jsonc'),
      `{ "plugboard": 1, "extends": null, "secrets": { "files": [".secrets/.env"], "vars": { "K": { "service": "S" } } },
         "cli": { "x": { "check": "true", "auth": { "env": ["K"] } } } }`)
    const r2 = await loadCascade(d)
    const out = renderSkill(r2)
    expect(out).toContain('K')                       // o nome aparece
    expect(out).not.toContain('valor-super-secreto') // o valor nunca
  })

  test('resolve escreve a skill e o lock a governa', async () => {
    const { d, r } = await load('"cli": { "gh": { "use": "gh" } }')
    const res = await emitClaudeCode(r, d)
    expect(res.written).toContain(SKILL)
    expect(existsSync(join(d, SKILL))).toBe(true)
    expect(readFileSync(join(d, SKILL), 'utf8')).toContain('plugboard-connections')
    // idempotente
    expect((await emitClaudeCode(r, d)).unchanged).toContain(SKILL)
  })

  test('skill: false desliga a emissão', async () => {
    const { d, r } = await load('"skill": false, "cli": {}')
    const res = await emitClaudeCode(r, d)
    expect(res.written).not.toContain(SKILL)
    expect(existsSync(join(d, SKILL))).toBe(false)
  })
})
