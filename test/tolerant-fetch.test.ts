import { describe, expect, test } from 'bun:test'
import { tolerantFetch } from '../src/core/mcp/tolerant-fetch.js'

const resp = (body: unknown, status: number, ct = 'application/json') =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': ct },
  })

describe('tolerantFetch', () => {
  const call = async (r: Response) => {
    let tolerated = false
    const f = tolerantFetch(async () => r, () => { tolerated = true })
    const out = await f('https://x/mcp')
    return { out, tolerated }
  }

  test('403 com JSON-RPC result válido → vira 200 (caso real do Gmail)', async () => {
    const { out, tolerated } = await call(resp({ jsonrpc: '2.0', id: 2, result: { tools: [] } }, 403))
    expect(out.status).toBe(200)
    expect(tolerated).toBe(true)
    expect((await out.json() as { result?: unknown }).result).toBeDefined()
  })

  test('erro JSON-RPC legítimo atravessa como 200 e o cliente trata', async () => {
    const { out } = await call(resp({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'x' } }, 404))
    expect(out.status).toBe(200)
    expect((await out.json() as { error: { code: number } }).error.code).toBe(-32601)
  })

  test('403 de AUTENTICAÇÃO real (corpo não-JSON-RPC) continua falhando', async () => {
    const { out, tolerated } = await call(resp({ error: { code: 403, message: 'PERMISSION_DENIED' } }, 403))
    expect(out.status).toBe(403)
    expect(tolerated).toBe(false)
  })

  test('corpo não-JSON não é tocado', async () => {
    const { out } = await call(resp('<html>502</html>', 502, 'text/html'))
    expect(out.status).toBe(502)
  })

  test('JSON inválido não é tocado', async () => {
    const { out } = await call(resp('{quebrado', 500))
    expect(out.status).toBe(500)
  })

  test('resposta ok passa direto, sem ler o corpo', async () => {
    const { out, tolerated } = await call(resp({ jsonrpc: '2.0', id: 1, result: {} }, 200))
    expect(out.status).toBe(200)
    expect(tolerated).toBe(false)
  })

  test('batch: só tolera se TODAS forem JSON-RPC válidas', async () => {
    const bom = await call(resp([{ jsonrpc: '2.0', id: 1, result: {} }], 403))
    expect(bom.out.status).toBe(200)
    const ruim = await call(resp([{ jsonrpc: '2.0', id: 1, result: {} }, { qualquer: 'coisa' }], 403))
    expect(ruim.out.status).toBe(403)
  })
})
