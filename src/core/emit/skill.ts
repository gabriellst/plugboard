import type { Resolved } from '../cascade.js'
import { SECRET_GUARDS } from './claude-code.js'

/**
 * Skill GERADA a partir da cascata resolvida.
 *
 * Doc estática sobre conexões envelhece e mente. Esta é derivada do manifesto,
 * então lista as conexões que realmente existem neste projeto e se regenera a
 * cada `resolve`. Ela é o par instrutivo dos deny-guards: as regras impedem o
 * caminho errado, a skill ensina o certo — um agente barrado por `deny` sem
 * saber a alternativa só tenta de novo de outro jeito.
 */
export function renderSkill(resolved: Resolved): string {
  const cliNames = Object.keys(resolved.cli).sort()
  const mcpNames = Object.keys(resolved.mcp).sort()
  const chain = resolved.chain.map((c) => c.manifest.name ?? c.dir.split('/').pop()).join(' → ')

  const lines: string[] = []
  lines.push('---')
  lines.push('name: plugboard-connections')
  lines.push(
    'description: Como alcançar os serviços externos deste projeto (CLIs autenticados, ' +
      'bancos, MCP) sem manipular credenciais. Use ao rodar qualquer comando que precise ' +
      'de credencial, ao investigar erro de autenticação, permissão ou variável de ambiente ' +
      'ausente, e antes de sugerir que alguém exporte segredo no shell.',
  )
  lines.push('---')
  lines.push('')
  lines.push('# Conexões deste projeto')
  lines.push('')
  lines.push('<!-- GERADO por `plugboard resolve` a partir de connections.jsonc. Não edite. -->')
  lines.push('')
  lines.push(`Cascata: **${chain}**`)
  lines.push('')
  lines.push('## A regra')
  lines.push('')
  lines.push('Credenciais deste projeto **não estão no seu ambiente** e não devem ser lidas de arquivo.')
  lines.push('Elas são injetadas por execução, só no processo que precisa:')
  lines.push('')
  lines.push('```bash')
  lines.push('plugboard exec --as cli:<nome> -- <comando>')
  lines.push('```')
  lines.push('')
  lines.push('Você conhece o **nome** da credencial; o valor nunca passa por você. Não tente')
  lines.push('`export VAR=…`, `cat .env` ou `env` — essas rotas são bloqueadas por política e,')
  lines.push('se funcionassem, o segredo acabaria no transcript da sessão.')
  lines.push('')

  if (cliNames.length > 0) {
    lines.push('## CLIs disponíveis')
    lines.push('')
    lines.push('| Ferramenta | Como rodar | Precisa de |')
    lines.push('|---|---|---|')
    for (const name of cliNames) {
      const e = resolved.cli[name]!.value
      const auth = typeof e.auth === 'object' ? e.auth : undefined
      const needs = [...new Set([...e.needs, ...(auth?.env ?? [])])]
      const how = needs.length > 0 ? `\`plugboard exec --as cli:${name} -- ${e.bin ?? name} …\`` : `\`${e.bin ?? name} …\``
      const req = needs.length > 0 ? needs.join(', ') : auth?.login ? 'login próprio do CLI' : '—'
      lines.push(`| \`${name}\`${e.why ? ` — ${e.why}` : ''} | ${how} | ${req} |`)
    }
    lines.push('')
  }

  if (mcpNames.length > 0) {
    lines.push('## Servidores MCP')
    lines.push('')
    for (const name of mcpNames) {
      const e = resolved.mcp[name]!.value
      const kind = e.url ? 'remoto' : 'local'
      lines.push(`- **${name}** (${kind})${e.why ? ` — ${e.why}` : ''}`)
      if (e.oauth?.scopes) lines.push(`  - escopo concedido: \`${e.oauth.scopes}\``)
      if (e.isolate) lines.push('  - identidade própria desta entrada (não compartilha conta com as outras)')
    }
    lines.push('')
    lines.push('As ferramentas desses servidores aparecem como `mcp__<servidor>__<ferramenta>`.')
    lines.push('Um servidor pode **anunciar** ferramenta que o escopo concedido não permite usar —')
    lines.push('se uma chamada falhar por permissão, é isso, não é bug de configuração.')
    lines.push('')
  }

  // os guards são injetados pelo emitter, não vêm do manifesto — a skill
  // precisa refletir o que de fato vale no settings, não só o declarado.
  const denied = [...new Set([...SECRET_GUARDS, ...resolved.permissions.deny.map((d) => d.value)])].sort()
  if (denied.length > 0) {
    lines.push('## Bloqueado por política')
    lines.push('')
    lines.push(denied.map((d) => `\`${d}\``).join(' · '))
    lines.push('')
    lines.push('Se um desses aparecer no seu caminho, a saída é o `plugboard exec` acima —')
    lines.push('não uma variação do mesmo comando.')
    lines.push('')
  }

  lines.push('## Quando algo falha')
  lines.push('')
  lines.push('| Situação | Comando |')
  lines.push('|---|---|')
  lines.push('| credencial ausente, vencida ou mal configurada | `plugboard doctor` |')
  lines.push('| "de onde veio esse valor / quem definiu isso" | `plugboard explain <cli.x\\|mcp.x\\|VAR>` |')
  lines.push('| ferramenta não instalada | `plugboard install` |')
  lines.push('| não autenticado | `plugboard login [cli]` *(interativo — peça ao usuário)* |')
  lines.push('| autenticado mas sem projeto/ambiente | `plugboard link [cli]` *(interativo)* |')
  lines.push('')
  lines.push('`doctor` sai com código ≠ 0 quando há erro e explica cada achado. Prefira rodá-lo')
  lines.push('antes de chutar a causa de uma falha de autenticação.')
  lines.push('')
  lines.push('**Nunca** contorne uma credencial ausente pedindo ao usuário que a exporte no shell')
  lines.push('ou cole no chat. O caminho é preenchê-la no `.secrets/.env` do escopo — `doctor`')
  lines.push('diz qual arquivo e, quando declarado, o console onde obtê-la.')
  lines.push('')

  return lines.join('\n')
}
