import type { Resolved } from '../cascade.js'
import { loadEnvChain, scopeFor } from '../secrets.js'

/** Expande `${VAR}` com a cadeia de .env do escopo — o segredo nunca mora no manifesto. */
export async function resolveOAuthClient(
  resolved: Resolved,
  entryName: string,
): Promise<{ client_id: string; client_secret?: string } | undefined> {
  const oauth = resolved.mcp[entryName]?.value.oauth
  if (!oauth?.clientId) return undefined

  const env = scopeFor(resolved, `mcp:${entryName}`, await loadEnvChain(resolved))
  const expand = (v: string) =>
    v.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => env[name] ?? process.env[name] ?? '')

  const client_id = expand(oauth.clientId)
  if (!client_id) throw new Error(`oauth.clientId de "${entryName}" expandiu vazio — confira a cadeia de .env`)
  const secret = oauth.clientSecret ? expand(oauth.clientSecret) : undefined
  return secret ? { client_id, client_secret: secret } : { client_id }
}

/** Erro do SDK quando o server não faz DCR e não demos client — vira instrução. */
export function explainDcrFailure(entryName: string, url: string): string {
  return [
    `o servidor ${new URL(url).host} não suporta registro dinâmico de client (DCR).`,
    'Crie um OAuth client (tipo "Web") no console do provedor e declare no manifesto:',
    '',
    `  "${entryName}": {`,
    '    "type": "http", "url": "…",',
    '    "oauth": { "clientId": "${OAUTH_CLIENT_ID}", "clientSecret": "${OAUTH_CLIENT_SECRET}" }',
    '  }',
    '',
    '  + as duas vars em secrets.vars e no .secrets/.env do escopo',
    '  + redirect URI autorizada no provedor: http://127.0.0.1:7777/callback',
  ].join('\n')
}
