import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Resolved } from '../cascade.js'
import { PlugboardError, EXIT } from '../errors.js'
import { renderClaudeCode } from './claude-code.js'
import { mcpIsolationEnv, mcpStateDir } from '../isolate.js'
import { renderSkill } from './skill.js'

const LOCK_NAME = '.plugboard.lock.json'

interface Lock {
  files: Record<string, string> // path relativo → sha256 do que escrevemos
  managed: {
    mcpServers: string[]
    allow: string[]
    deny: string[]
    enabledMcpjsonServers: string[]
  }
}

const EMPTY_LOCK: Lock = {
  files: {},
  managed: { mcpServers: [], allow: [], deny: [], enabledMcpjsonServers: [] },
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex')

async function readJson<T>(path: string, fallback: T): Promise<T> {
  if (!existsSync(path)) return fallback
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch {
    return fallback
  }
}

/** union(existente − gerenciadoAntes, gerenciadoAgora): remover do manifesto remove do arquivo; o que é do usuário fica. */
function reconcileList(existing: string[], before: string[], now: string[]): string[] {
  const beforeSet = new Set(before)
  const user = existing.filter((x) => !beforeSet.has(x))
  return [...new Set([...user, ...now])].sort()
}

export interface EmitResult {
  target: string
  written: string[]
  unchanged: string[]
  conflicts: string[]
}

/**
 * Materializa o render do claude-code em um target, com lock anti-clobber:
 * arquivo divergente do hash do lock = editado à mão → conflito (exige --force).
 * Sem lock e arquivo existente → primeiro run adota: conteúdo vira "do usuário".
 */
export async function emitClaudeCode(
  resolved: Resolved,
  target: string,
  opts: { force?: boolean; dryRun?: boolean } = {},
): Promise<EmitResult> {
  const render = renderClaudeCode(resolved)

  // cria o diretório de estado de cada entrada MCP isolada (uma conta por entrada)
  if (!opts.dryRun) {
    for (const name of Object.keys(resolved.mcp)) {
      if (Object.keys(mcpIsolationEnv(resolved, name)).length > 0) {
        await mkdir(mcpStateDir(resolved, name), { recursive: true, mode: 0o700 })
      }
    }
  }
  const lockPath = join(target, LOCK_NAME)
  const lock = await readJson<Lock>(lockPath, EMPTY_LOCK)

  const result: EmitResult = { target, written: [], unchanged: [], conflicts: [] }
  const nextLock: Lock = {
    files: {},
    managed: {
      mcpServers: Object.keys(render.mcpServers).sort(),
      allow: render.settings.permissions.allow,
      deny: render.settings.permissions.deny,
      enabledMcpjsonServers: render.settings.enabledMcpjsonServers,
    },
  }

  const plan: { rel: string; content: string }[] = []

  // ── .mcp.json ─────────────────────────────────────────────────────────────
  {
    const rel = '.mcp.json'
    const path = join(target, rel)
    const existing = await readJson<{ mcpServers?: Record<string, unknown>; [k: string]: unknown }>(path, {})
    const managedBefore = new Set(lock.managed.mcpServers)
    const userServers = Object.fromEntries(
      Object.entries(existing.mcpServers ?? {}).filter(([name]) => !managedBefore.has(name)),
    )
    const content = `${JSON.stringify(
      { ...existing, mcpServers: { ...userServers, ...render.mcpServers } },
      null,
      2,
    )}\n`
    plan.push({ rel, content })
  }

  // ── .claude/settings.json ─────────────────────────────────────────────────
  {
    const rel = join('.claude', 'settings.json')
    const path = join(target, rel)
    const existing = await readJson<Record<string, any>>(path, {})
    const perms = existing.permissions ?? {}
    const content = `${JSON.stringify(
      {
        ...existing,
        permissions: {
          ...perms,
          allow: reconcileList(perms.allow ?? [], lock.managed.allow, render.settings.permissions.allow),
          deny: reconcileList(perms.deny ?? [], lock.managed.deny, render.settings.permissions.deny),
        },
        enabledMcpjsonServers: reconcileList(
          existing.enabledMcpjsonServers ?? [],
          lock.managed.enabledMcpjsonServers,
          render.settings.enabledMcpjsonServers,
        ),
      },
      null,
      2,
    )}\n`
    plan.push({ rel, content })
  }

  // ── .claude/skills/plugboard-connections/SKILL.md ─────────────────────────
  if (resolved.skill.value) {
    plan.push({ rel: join('.claude', 'skills', 'plugboard-connections', 'SKILL.md'), content: renderSkill(resolved) })
  }

  // ── aplica com anti-clobber ───────────────────────────────────────────────
  for (const { rel, content } of plan) {
    const path = join(target, rel)
    const lockedHash = lock.files[rel]
    const onDisk = existsSync(path) ? await readFile(path, 'utf8') : null

    if (onDisk !== null && lockedHash && sha(onDisk) !== lockedHash && !opts.force) {
      result.conflicts.push(rel)
      continue
    }
    if (onDisk === content) {
      result.unchanged.push(rel)
      nextLock.files[rel] = sha(content)
      continue
    }
    if (!opts.dryRun) {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, content)
    }
    result.written.push(rel)
    nextLock.files[rel] = sha(content)
  }

  if (result.conflicts.length > 0 && !opts.force) {
    throw new PlugboardError(
      `arquivo(s) editado(s) à mão em ${target}: ${result.conflicts.join(', ')}`,
      EXIT.CHECK_FAILED,
      'o plugboard não sobrescreve trabalho manual — incorpore a mudança no manifesto ou rode com --force',
    )
  }

  if (!opts.dryRun) await writeFile(lockPath, `${JSON.stringify(nextLock, null, 2)}\n`)
  return result
}
