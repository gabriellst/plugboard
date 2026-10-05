/**
 * Alguns servidores MCP devolvem status HTTP de erro COM uma resposta JSON-RPC
 * válida no corpo. Verificado em 2026-09-12: `gmailmcp.googleapis.com` responde
 * `tools/list` com **HTTP 403** e um corpo `{"jsonrpc":"2.0","id":…,"result":
 * {"tools":[… 23 tools …]}}` — sem campo `error`. O `initialize` do mesmo servidor
 * devolve 200. O spec do Streamable HTTP manda 200 para toda resposta JSON-RPC
 * (erros de aplicação vão no corpo), e o SDK corretamente descarta o corpo de
 * respostas não-ok — então a resposta válida se perde.
 *
 * Este wrapper reescreve o status para 200 SOMENTE quando o corpo é uma resposta
 * JSON-RPC 2.0 bem formada. Não afrouxa segurança: um 403 de autenticação real
 * traz corpo de erro do provedor (não JSON-RPC) e continua falhando; e um
 * `error` JSON-RPC legítimo é repassado ao cliente, que o trata normalmente.
 */
type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>

export function tolerantFetch(
  base: FetchLike = fetch as FetchLike,
  onTolerate?: (info: { status: number; url: string }) => void,
): FetchLike {
  const isJsonRpcResponse = (m: unknown): boolean =>
    typeof m === 'object' &&
    m !== null &&
    (m as { jsonrpc?: string }).jsonrpc === '2.0' &&
    ('result' in (m as object) || 'error' in (m as object))

  return async (input, init) => {
    const res = await base(input, init)
    if (res.ok) return res

    const contentType = res.headers.get('content-type') ?? ''
    if (!contentType.includes('application/json')) return res

    let text: string
    try {
      text = await res.clone().text()
    } catch {
      return res
    }

    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      return res
    }

    const valid = Array.isArray(body) ? body.length > 0 && body.every(isJsonRpcResponse) : isJsonRpcResponse(body)
    if (!valid) return res

    onTolerate?.({ status: res.status, url: String(input) })
    return new Response(text, { status: 200, statusText: 'OK', headers: res.headers })
  }
}
