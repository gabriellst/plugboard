import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadCascade } from '../src/core/cascade.js'
import { auditMcp } from '../src/core/audit-mcp.js'

const withMcp = async (mcp: string) => {
  const d = mkdtempSync(join(tmpdir(), 'pb-mcp-'))
  writeFileSync(join(d, 'connections.jsonc'), `{ "plugboard": 1, "extends": null, "mcp": ${mcp} }`)
  return loadCascade(d)
}

describe('auditMcp: endpoint compartilhado', () => {
  test('duas entradas com a MESMA url → erro (a armadilha das "duas contas")', async () => {
    const r = await withMcp(`{
      "gmail-work":     { "type": "http", "url": "https://gmailmcp.googleapis.com/mcp/v1" },
      "gmail-pessoal":  { "type": "http", "url": "https://gmailmcp.googleapis.com/mcp/v1" }
    }`)
    const f = auditMcp(r)
    expect(f).toHaveLength(1)
    expect(f[0]!.code).toBe('mcp.shared-endpoint')
    expect(f[0]!.usedBy).toEqual(['gmail-work', 'gmail-pessoal'])
  })

  test('urls distintas → ok', async () => {
    const r = await withMcp(`{
      "gmail-work":    { "type": "http", "url": "https://x/mcp?account=work" },
      "gmail-pessoal": { "type": "http", "url": "https://x/mcp?account=pessoal" }
    }`)
    expect(auditMcp(r)).toEqual([])
  })

  test('stdio (sem url) nunca acusa — auth é do próprio server', async () => {
    const r = await withMcp(`{
      "gmail-a": { "command": "gmail-mcp", "env": { "TOKEN_PATH": "~/.g/a.json" } },
      "gmail-b": { "command": "gmail-mcp", "env": { "TOKEN_PATH": "~/.g/b.json" } }
    }`)
    expect(auditMcp(r)).toEqual([])
  })
})

describe('isolate em MCP (duas contas no mesmo projeto)', () => {
  test('stdio + isolate "home" → HOME próprio por entrada, no .mcp.json', async () => {
    const { renderClaudeCode } = await import('../src/core/emit/claude-code.js')
    const r = await withMcp(`{
      "gmail-work":    { "command": "gmail-mcp", "isolate": "home" },
      "gmail-pessoal": { "command": "gmail-mcp", "isolate": "home" }
    }`)
    const out = renderClaudeCode(r).mcpServers
    const work = (out['gmail-work']!.env as Record<string, string>).HOME
    const pess = (out['gmail-pessoal']!.env as Record<string, string>).HOME
    expect(work).toContain('.plugboard/mcp/gmail-work')
    expect(pess).toContain('.plugboard/mcp/gmail-pessoal')
    expect(work).not.toBe(pess)
  })

  test('isolate { env } usa a var própria do server', async () => {
    const { renderClaudeCode } = await import('../src/core/emit/claude-code.js')
    const r = await withMcp('{ "g": { "command": "x", "isolate": { "env": "GOOGLE_MCP_CONFIG_DIR" } } }')
    const env = renderClaudeCode(r).mcpServers.g!.env as Record<string, string>
    expect(env.GOOGLE_MCP_CONFIG_DIR).toContain('.plugboard/mcp/g')
    expect(env.HOME).toBeUndefined()
  })

  test('isolate em http → roteia pelo proxy do plugboard', async () => {
    const { renderClaudeCode } = await import('../src/core/emit/claude-code.js')
    const r = await withMcp('{ "g": { "type": "http", "url": "https://x", "isolate": "home" } }')
    const out = renderClaudeCode(r).mcpServers.g!
    expect(out.command).toBe('plugboard')
    expect(out.args).toEqual(['mcp', 'proxy', 'g', '--root', r.root])
    expect(out.url).toBeUndefined() // o Claude Code não fala direto com o upstream
  })

  test('mesma url COM isolate nas duas → sem colisão (credencial por entrada)', async () => {
    const r = await withMcp(`{
      "a": { "type": "http", "url": "https://x/mcp", "isolate": "home" },
      "b": { "type": "http", "url": "https://x/mcp", "isolate": "home" }
    }`)
    expect(auditMcp(r)).toEqual([])
  })

  test('needs convivem com isolate: segredo fica ${VAR}, path fica absoluto', async () => {
    const { renderClaudeCode } = await import('../src/core/emit/claude-code.js')
    const r = await withMcp('{ "g": { "command": "x", "needs": ["TOK"], "isolate": "home" } }')
    const env = renderClaudeCode(r).mcpServers.g!.env as Record<string, string>
    expect(env.TOK).toBe('${TOK}')
    expect(env.HOME).toContain('.plugboard/mcp/g')
  })

  test('resolve cria o diretório de estado com mode 700', async () => {
    const { emitClaudeCode } = await import('../src/core/emit/write.js')
    const { statSync } = await import('node:fs')
    const d = mkdtempSync(join(tmpdir(), 'pb-mcpstate-'))
    writeFileSync(join(d, 'connections.jsonc'),
      '{ "plugboard": 1, "extends": null, "mcp": { "g": { "command": "x", "isolate": "home" } } }')
    const r = await loadCascade(d)
    await emitClaudeCode(r, d)
    const st = statSync(join(d, '.plugboard', 'mcp', 'g'))
    expect(st.isDirectory()).toBe(true)
    expect(st.mode & 0o077).toBe(0)
  })
})
