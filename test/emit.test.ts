import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadCascade } from '../src/core/cascade.js'
import { renderClaudeCode, SECRET_GUARDS } from '../src/core/emit/claude-code.js'
import { emitClaudeCode } from '../src/core/emit/write.js'

const LEAF = new URL('./fixtures/bk/bk-reviews/software/bk-reviews', import.meta.url).pathname
const tmp = () => mkdtempSync(join(tmpdir(), 'pb-emit-'))
const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8'))

describe('render (puro)', () => {
  test('stdio: needs viram env ${VAR} literal — nunca o valor', async () => {
    const r = await loadCascade(LEAF)
    const out = renderClaudeCode(r)
    expect(out.mcpServers['postgres-ro']!.env).toEqual({ REVIEWS_DB_RO_URL: '${REVIEWS_DB_RO_URL}' })
    expect(JSON.stringify(out)).not.toContain('postgres://ro:pass')
  })

  test('guards de segredo sempre presentes + denies do manifesto', async () => {
    const r = await loadCascade(LEAF)
    const { deny } = renderClaudeCode(r).settings.permissions
    for (const g of SECRET_GUARDS) expect(deny).toContain(g)
    expect(deny).toContain('Bash(rm -rf:*)') // veio do manifesto da org
  })

  test('allow do manifesto, ordenado e sem duplicata; servers habilitados', async () => {
    const r = await loadCascade(LEAF)
    const s = renderClaudeCode(r).settings
    expect(s.permissions.allow).toEqual(['Bash(bun:*)', 'Bash(bunx biome:*)', 'Bash(gh:*)'])
    expect(s.enabledMcpjsonServers).toEqual(['postgres-ro'])
  })
})

describe('writer (lock + reconciliação)', () => {
  test('primeiro run escreve .mcp.json, settings e lock', async () => {
    const r = await loadCascade(LEAF)
    const t = tmp()
    const res = await emitClaudeCode(r, t)
    expect(res.written.sort()).toEqual([
      '.claude/settings.json',
      '.claude/skills/plugboard-connections/SKILL.md',
      '.mcp.json',
    ])
    expect(readJson(join(t, '.mcp.json')).mcpServers['postgres-ro']).toBeDefined()
    expect(existsSync(join(t, '.plugboard.lock.json'))).toBe(true)
  })

  test('idempotente: segundo run não muda nada', async () => {
    const r = await loadCascade(LEAF)
    const t = tmp()
    await emitClaudeCode(r, t)
    const res = await emitClaudeCode(r, t)
    expect(res.written).toEqual([])
    expect(res.unchanged.sort()).toEqual([
      '.claude/settings.json',
      '.claude/skills/plugboard-connections/SKILL.md',
      '.mcp.json',
    ])
  })

  test('primeiro run ADOTA arquivo pré-existente: server do usuário sobrevive', async () => {
    const r = await loadCascade(LEAF)
    const t = tmp()
    writeFileSync(join(t, '.mcp.json'), JSON.stringify({ mcpServers: { pencil: { type: 'http', url: 'https://x' } } }))
    await emitClaudeCode(r, t)
    const out = readJson(join(t, '.mcp.json')).mcpServers
    expect(out.pencil).toEqual({ type: 'http', url: 'https://x' })
    expect(out['postgres-ro']).toBeDefined()
  })

  test('settings existente: allow manual do usuário é preservado', async () => {
    const r = await loadCascade(LEAF)
    const t = tmp()
    mkdirSync(join(t, '.claude'))
    writeFileSync(join(t, '.claude/settings.json'), JSON.stringify({ model: 'opus', permissions: { allow: ['WebSearch'] } }))
    await emitClaudeCode(r, t)
    const s = readJson(join(t, '.claude/settings.json'))
    expect(s.model).toBe('opus')
    expect(s.permissions.allow).toContain('WebSearch')
    expect(s.permissions.allow).toContain('Bash(bun:*)')
  })

  test('edição à mão de arquivo gerenciado → conflito, exige --force', async () => {
    const r = await loadCascade(LEAF)
    const t = tmp()
    await emitClaudeCode(r, t)
    writeFileSync(join(t, '.mcp.json'), '{ "mcpServers": {} }\n') // mão grande
    const err = await emitClaudeCode(r, t).catch((e) => e)
    expect(err.exit).toBe(1)
    expect(err.message).toContain('.mcp.json')
    // com --force passa
    const res = await emitClaudeCode(r, t, { force: true })
    expect(res.written).toContain('.mcp.json')
  })

  test('remover do manifesto remove do arquivo (reconciliação de listas)', async () => {
    const t = tmp()
    writeFileSync(join(t, 'connections.jsonc'),
      '{ "plugboard": 1, "extends": null, "permissions": { "allow": ["Bash(gh:*)"] } }')
    const r1 = await loadCascade(t)
    await emitClaudeCode(r1, t)
    expect(readJson(join(t, '.claude/settings.json')).permissions.allow).toContain('Bash(gh:*)')

    writeFileSync(join(t, 'connections.jsonc'), '{ "plugboard": 1, "extends": null }')
    const r2 = await loadCascade(t)
    await emitClaudeCode(r2, t)
    expect(readJson(join(t, '.claude/settings.json')).permissions.allow).not.toContain('Bash(gh:*)')
  })

  test('dry-run: reporta e não escreve', async () => {
    const r = await loadCascade(LEAF)
    const t = tmp()
    const res = await emitClaudeCode(r, t, { dryRun: true })
    expect(res.written.length).toBe(3)
    expect(existsSync(join(t, '.mcp.json'))).toBe(false)
    expect(existsSync(join(t, '.plugboard.lock.json'))).toBe(false)
  })

  test('oauth.scopes e http passam pro .mcp.json', async () => {
    const t = tmp()
    writeFileSync(join(t, 'connections.jsonc'),
      '{ "plugboard": 1, "extends": null, "mcp": { "gmail": { "type": "http", "url": "https://g", "oauth": { "scopes": "a b" } } } }')
    const r = await loadCascade(t)
    await emitClaudeCode(r, t)
    expect(readJson(join(t, '.mcp.json')).mcpServers.gmail).toEqual({ type: 'http', url: 'https://g', oauth: { scopes: 'a b' } })
  })
})
