import type { Resolved } from './core/cascade.js'
import type { Finding } from './core/findings.js'
import type { EmitResult } from './core/emit/write.js'

const ICON = { error: '✗', warn: '⚠' } as const

export const chainLine = (r: Resolved) =>
  `cadeia  ${r.chain.map((c) => c.manifest.name ?? c.dir.split('/').pop()).join(' → ')}\n`

export function renderFindings(r: Resolved, findings: Finding[]): string {
  let out = chainLine(r)
  if (findings.length === 0) return `${out}\n  ✓ tudo em ordem\n`
  const w = Math.max(...findings.map((f) => f.subject.length))
  for (const f of [...findings].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1))) {
    out += `\n  ${ICON[f.severity]} ${f.subject.padEnd(w)}  ${f.message}`
    if (f.usedBy?.length) out += `\n    ${' '.repeat(w)}  usado por ${f.usedBy.join(', ')}`
  }
  const e = findings.filter((f) => f.severity === 'error').length
  return `${out}\n\n  ${e} erro(s) · ${findings.length - e} aviso(s)\n`
}

export function renderEmit(results: EmitResult[], dryRun: boolean): string {
  let out = ''
  for (const r of results) {
    out += `${r.target}\n`
    for (const f of r.written) out += `  ${dryRun ? '↻ escreveria' : '✓ escrito   '} ${f}\n`
    for (const f of r.unchanged) out += `  = inalterado ${f}\n`
  }
  return out
}
