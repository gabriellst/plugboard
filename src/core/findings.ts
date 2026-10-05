export type Severity = 'error' | 'warn'

export type FindingCode =
  | 'var.undeclared' // needs/auth referencia var que nenhum manifesto declara
  | 'var.orphan' // declarada com source "env" e nenhum cli/mcp referencia
  | 'var.missing' // declarada com source "env" e ausente na cadeia de .env
  | 'secrets.key-missing' // arquivo cifrado sem a private key correspondente
  | 'secrets.file-missing' // secrets.files aponta pra arquivo que não existe
  | 'secrets.tracked' // arquivo de segredo versionado no git
  | 'secrets.not-ignored' // não versionado, mas a um `git add .` de distância
  | 'secrets.perms' // legível por group/other
  | 'mcp.shared-endpoint' // 2+ entradas com a MESMA url → compartilham o token OAuth
  | 'mcp.state-not-ignored'

/** Contrato público do --json: `code` é API, `message` é texto livre. */
export interface Finding {
  severity: Severity
  code: FindingCode
  subject: string
  message: string
  origin?: string
  usedBy?: string[]
}
