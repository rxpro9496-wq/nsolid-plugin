import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import type { HarnessType, Logger } from '../types.js'
import type { HarnessAdapter, NativePluginStatus } from './harness-adapter.js'
import { resolveHome } from '../utils/path.js'
import { readTomlFile, writeTomlFileSync } from '../utils/config.js'
import { writeJsonFileSync } from '../utils/fs.js'
import { createConfigBackup } from '../utils/backup.js'
import { PLUGIN_BASE_NAME, PLUGIN_BASE_NAMES } from './plugin-name.js'
import {
  inspectNativeInstallation,
  marketplaceRemovalCommand,
  planClaudeNativeRemoval,
  type ClaudeScope,
  type NativeInspection,
} from './plugin-registry.js'

/**
 * Spawns a harness CLI command, resolving with the exit code. Rejects on failure
 * to spawn (e.g. binary not installed) or on timeout (the `timeout` option sends
 * SIGTERM, after which `close` fires with `code === null` and a `signal`).
 * Never rejects on a non-zero exit, so callers can decide whether to fall back.
 */
export function runHarnessCli (cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'ignore', timeout: 15000 })
    child.on('error', reject)
    child.on('close', (code, signal) => {
      // A non-null signal (e.g. SIGTERM from timeout) means the process did not
      // exit cleanly — treat it as a failure so the config-file fallback runs.
      if (signal !== null && signal !== undefined) {
        reject(new Error(`"${cmd}" terminated by ${signal}`))
        return
      }
      resolve(code ?? 0)
    })
  })
}

interface RemovalResult {
  removed: boolean
  warnings: string[]
}

/** Injectable runner so tests can force the fallback path without spawning. */
export type CliRunner = (cmd: string, args: string[]) => Promise<number>

/**
 * One exact native-plugin removal: a concrete id, plus the Claude install scope
 * it was registered under (null = legacy scope-less registration, no `--scope`).
 */
interface RemovalTarget {
  id: string
  scope: ClaudeScope | null
}

function isPlainObject (value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Build the removal targets from the preflight install records. A Claude id
 * installed in an explicitly attributable scope is removed with that exact
 * `--scope`; an ambiguous or cross-project registration refuses instead of
 * falling back to a scope-wide removal that would delete other registrations.
 */
function removalTargets (
  harness: string,
  ids: string[],
  inspection: NativeInspection
): { targets: RemovalTarget[]; problem?: string } {
  if (harness !== 'claude') return { targets: ids.map((id) => ({ id, scope: null })) }
  if (inspection.claudeInstallRecords.length === 0) {
    return { targets: ids.map((id) => ({ id, scope: null })) }
  }
  const plan = planClaudeNativeRemoval(inspection.claudeInstallRecords)
  if (plan.problem) return { targets: [], problem: plan.problem }
  const targets: RemovalTarget[] = []
  const planned = new Set<string>()
  for (const entry of plan.plans) {
    planned.add(entry.id)
    for (const scope of entry.scopes) targets.push({ id: entry.id, scope })
  }
  for (const id of ids) {
    if (!planned.has(id)) targets.push({ id, scope: null })
  }
  return { targets }
}

/**
 * Remove the nsolid native plugin for a harness. Strategy: prefer the harness's
 * own CLI (correct bookkeeping for caches/indexes) with the exact attributable
 * identity/scope, then fall back to directly editing the harness's config files
 * when the CLI is absent or didn't clear it. Returns whether the plugin is gone
 * afterwards and any non-fatal warnings.
 */
export async function removeNativePlugin (
  harness: string,
  adapter: HarnessAdapter,
  options?: { logger?: Logger; runCli?: CliRunner; inspection?: NativeInspection }
): Promise<RemovalResult> {
  const logger = options?.logger
  const runCli = options?.runCli ?? runHarnessCli
  const warnings: string[] = []
  if (!adapter.detectNativePlugin) {
    return { removed: true, warnings }
  }

  const inspection = options?.inspection ?? inspectNativeInstallation(harness as HarnessType, adapter)
  const detected = adapter.detectNativePlugin()
  if (!detected.installed && inspection.pluginIds.length === 0) {
    return { removed: true, warnings }
  }

  const ids = inspection.pluginIds.length > 0 ? inspection.pluginIds : concreteIds(detected)
  const planned = removalTargets(harness, ids, inspection)
  if (planned.problem) {
    return { removed: false, warnings: [planned.problem] }
  }
  const targets = planned.targets
  logger?.info('uninstall.nativePlugin.start', { harness, targets: targets.map((t) => `${t.id}${t.scope ? `@${t.scope}` : ''}`) })

  // 1. Delegate to the harness CLI when available.
  const delegated = await delegateToHarnessCli(harness, targets, runCli, logger).catch(() => false)

  // 2. If the CLI didn't fully clear the install (absent, failed, or exited 0
  //    but left stale state such as a manifest entry), hand-edit the config
  //    files directly to reconcile. Verification below still has the final say.
  if (!delegated || adapter.detectNativePlugin().installed) {
    await fallbackEdit(harness, adapter, targets, logger).catch((err) => {
      warnings.push(`Could not fully remove native plugin for ${harness}: ${(err as Error).message}`)
    })
  }

  // 3. Verify.
  const rechecked = adapter.detectNativePlugin()
  if (rechecked.installed) {
    warnings.push(
      `Native plugin still present for ${harness}; remove it manually via the harness CLI (e.g. ${manualHint(harness, targets)}).`
    )
    return { removed: false, warnings }
  }

  logger?.info('uninstall.nativePlugin.done', { harness })
  return { removed: true, warnings }
}

function concreteIds (detected: NativePluginStatus): string[] {
  if (detected.installedIds && detected.installedIds.length > 0) {
    return detected.installedIds
  }
  // Adapter didn't surface concrete ids — best-effort the base name.
  return [detected.label ?? PLUGIN_BASE_NAME]
}

async function delegateToHarnessCli (
  harness: string,
  targets: RemovalTarget[],
  runCli: CliRunner,
  logger?: Logger
): Promise<boolean> {
  // Antigravity keys plugins by base name, not `<name>@<marketplace>`; the
  // detected ids are already base names there. `targets` carries the exact
  // identities (skills-plugin and/or legacy) and Claude scopes for every harness.
  const effective = targets.length > 0 ? targets : [{ id: PLUGIN_BASE_NAME, scope: null }]
  let anySucceeded = false
  for (const target of effective) {
    const [cmd, ...args] = cliCommand(harness, target)
    if (!cmd) continue
    try {
      const code = await runCli(cmd, args)
      if (code === 0) {
        anySucceeded = true
        logger?.info('uninstall.nativePlugin.cli', { harness, cmd, args })
      }
    } catch {
      // Binary not installed or spawn failed — fall back below.
      return false
    }
  }
  return anySucceeded
}

function cliCommand (harness: string, target: RemovalTarget): string[] {
  switch (harness) {
    case 'claude':
      return target.scope === null
        ? ['claude', 'plugin', 'uninstall', target.id]
        : ['claude', 'plugin', 'uninstall', target.id, '--scope', target.scope]
    case 'codex':
      return ['codex', 'plugin', 'remove', target.id]
    case 'antigravity':
      return ['agy', 'plugin', 'uninstall', target.id]
    default:
      return []
  }
}

function manualHint (harness: string, targets: RemovalTarget[]): string {
  const target = targets[0] ?? { id: PLUGIN_BASE_NAME, scope: null }
  switch (harness) {
    case 'claude':
      return target.scope === null
        ? `claude plugin uninstall ${target.id}`
        : `claude plugin uninstall ${target.id} --scope ${target.scope}`
    case 'codex':
      return `codex plugin remove ${target.id}`
    case 'antigravity':
      return `agy plugin uninstall ${target.id}`
    default:
      return ''
  }
}

/**
 * Direct config-file edits as a fallback when the harness CLI is unavailable.
 * Each path backs up the file before mutating and preserves unrelated entries,
 * other plugin ids, and other Claude scopes/project paths.
 */
async function fallbackEdit (
  harness: string,
  adapter: HarnessAdapter,
  targets: RemovalTarget[],
  logger?: Logger
): Promise<void> {
  switch (harness) {
    case 'claude':
      await editClaude(adapter, targets, logger)
      break
    case 'codex':
      await editCodex(adapter, targets.map((target) => target.id), logger)
      break
    case 'antigravity':
      await editAntigravity(targets.map((target) => target.id), logger)
      break
  }
}

function removeClaudeArrayEntries (value: unknown[], targets: RemovalTarget[]): unknown[] {
  const ids = new Set(targets.map((target) => target.id))
  return value.filter((entry) => {
    if (typeof entry === 'string') return !ids.has(entry)
    if (isPlainObject(entry) && typeof entry.id === 'string') return !ids.has(entry.id)
    return true
  })
}

/**
 * Registry readers treat a 0-byte/whitespace-only harness config as valid
 * empty state (readJsonSource maps it to undefined). The fallback editors
 * must agree: an empty file has nothing to edit and must not surface as a
 * spurious "Could not fully remove native plugin" warning. Genuinely invalid
 * non-empty JSON still throws.
 */
function readJsonFileEmptyAsMissing<T> (filePath: string): T | null {
  if (!existsSync(filePath)) return null
  const raw = readFileSync(filePath, 'utf-8')
  if (raw.trim() === '') return null
  try {
    return JSON.parse(raw) as T
  } catch (err) {
    throw new Error(`Failed to parse ${filePath}: ${(err as Error).message}`, { cause: err })
  }
}

async function editClaude (adapter: HarnessAdapter, targets: RemovalTarget[], logger?: Logger): Promise<void> {
  const installedPath = resolveHome('~/.claude/plugins/installed_plugins.json')
  if (existsSync(installedPath)) {
    createConfigBackup('claude', installedPath, { reason: 'uninstall-native-plugin' })
    const data = readJsonFileEmptyAsMissing<{ version?: number; plugins?: unknown }>(installedPath)
    if (data && data.plugins !== undefined && data.plugins !== null) {
      let changed = false
      if (Array.isArray(data.plugins)) {
        const kept = removeClaudeArrayEntries(data.plugins, targets)
        if (kept.length !== data.plugins.length) {
          data.plugins = kept
          changed = true
        }
      } else if (isPlainObject(data.plugins)) {
        const plugins = data.plugins
        for (const target of targets) {
          if (!(target.id in plugins)) continue
          const value = plugins[target.id]
          if (target.scope === null || !Array.isArray(value)) {
            delete plugins[target.id]
            changed = true
            continue
          }
          // Remove only the explicitly attributable scope record; a different
          // scope or project path must survive.
          const kept = value.filter((record) => !(isPlainObject(record) && record.scope === target.scope))
          if (kept.length === 0) delete plugins[target.id]
          else plugins[target.id] = kept
          changed = true
        }
      }
      if (changed) writeJsonFileSync(installedPath, data)
    }
  }

  // Clear the enable map entries in ~/.claude.json, but only for ids with no
  // registration left: a surviving scope/path must keep its enable flag.
  const remaining = new Set(adapter.detectNativePlugin?.()?.installedIds ?? [])
  const claudeJsonPath = adapter.getMcpConfigPath()
  if (claudeJsonPath && existsSync(claudeJsonPath)) {
    createConfigBackup('claude', claudeJsonPath, { reason: 'uninstall-native-plugin' })
    const data = readJsonFileEmptyAsMissing<Record<string, unknown>>(claudeJsonPath)
    if (data?.enabledPlugins && typeof data.enabledPlugins === 'object') {
      const map = data.enabledPlugins as Record<string, unknown>
      let changed = false
      for (const target of targets) {
        if (!(target.id in map)) continue
        if (remaining.has(target.id)) continue
        delete map[target.id]
        changed = true
      }
      if (changed) writeJsonFileSync(claudeJsonPath, data)
    }
  }

  // Best-effort cache cleanup. The cache may be keyed by marketplace name.
  const cacheBase = resolveHome('~/.claude/plugins/cache')
  if (existsSync(cacheBase)) {
    for (const target of targets) {
      const at = target.id.lastIndexOf('@')
      if (at <= 0) continue
      const marketplace = target.id.slice(at + 1)
      const base = target.id.slice(0, at)
      const dir = path.join(cacheBase, marketplace, base)
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    }
  }
  logger?.info('uninstall.nativePlugin.fallback', { harness: 'claude', ids: targets.map((target) => target.id) })
}

async function editCodex (adapter: HarnessAdapter, ids: string[], logger?: Logger): Promise<void> {
  const configPath = adapter.getMcpConfigPath()
  if (!configPath || !existsSync(configPath)) return
  createConfigBackup('codex', configPath, { reason: 'uninstall-native-plugin' })
  const data = readTomlFile<Record<string, unknown>>(configPath)
  if (data?.plugins && typeof data.plugins === 'object') {
    const plugins = data.plugins as Record<string, unknown>
    let changed = false
    for (const id of ids) {
      if (id in plugins) { delete plugins[id]; changed = true }
    }
    if (changed) writeTomlFileSync(configPath, data)
  }

  // Best-effort cache cleanup: `codex plugin remove` clears the cached plugin;
  // when the CLI is unavailable the fallback should not leave it behind.
  const cacheBase = resolveHome('~/.codex/plugins/cache')
  if (existsSync(cacheBase)) {
    for (const id of ids) {
      const at = id.lastIndexOf('@')
      const base = at > 0 ? id.slice(0, at) : id
      const dir = path.join(cacheBase, base)
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    }
  }
  logger?.info('uninstall.nativePlugin.fallback', { harness: 'codex', ids })
}

async function editAntigravity (ids: string[], logger?: Logger): Promise<void> {
  const pluginsRoot = resolveHome('~/.gemini/config/plugins')
  for (const base of ids.length > 0 ? ids : [...PLUGIN_BASE_NAMES]) {
    const pluginDir = path.join(pluginsRoot, base)
    if (existsSync(pluginDir)) {
      rmSync(pluginDir, { recursive: true, force: true })
    }
  }

  const manifestPath = resolveHome('~/.gemini/config/import_manifest.json')
  if (existsSync(manifestPath)) {
    createConfigBackup('antigravity', manifestPath, { reason: 'uninstall-native-plugin' })
    const data = readJsonFileEmptyAsMissing<{ imports?: Array<{ name?: string }> }>(manifestPath)
    if (data?.imports) {
      const before = data.imports.length
      const names = new Set(ids.length > 0 ? ids : [...PLUGIN_BASE_NAMES])
      data.imports = data.imports.filter((entry) => !(entry?.name && names.has(entry.name)))
      if (data.imports.length !== before) writeJsonFileSync(manifestPath, data)
    }
  }
  logger?.info('uninstall.nativePlugin.fallback', { harness: 'antigravity', ids })
}

/**
 * Remove one marketplace registration through the harness's supported CLI and
 * verify it is actually gone afterwards. Returns `removed` plus a truthful
 * warning when the command is unsupported or verification fails. Never claims
 * success without re-inspecting the registration state.
 */
export async function removeMarketplaceRegistration (
  harness: string,
  name: string,
  scope: ClaudeScope | undefined,
  options?: { logger?: Logger; runCli?: CliRunner; adapter?: HarnessAdapter }
): Promise<{ removed: boolean; warning?: string }> {
  const logger = options?.logger
  const runCli = options?.runCli ?? runHarnessCli
  const command = marketplaceRemovalCommand(harness as 'claude' | 'codex', name, scope)
  if (!command) {
    return {
      removed: false,
      warning: `The ${harness} CLI does not expose a supported marketplace-remove command for the "${name}" registration (or its scope is unknown), so it could not be removed automatically.`,
    }
  }

  let code: number
  try {
    code = await runCli(command.cmd, command.args)
  } catch (err) {
    return {
      removed: false,
      warning: `Could not run "${command.cmd} ${command.args.join(' ')}" to remove the "${name}" marketplace: ${(err as Error).message}`,
    }
  }
  if (code !== 0) {
    return {
      removed: false,
      warning: `"${command.cmd} ${command.args.join(' ')}" exited ${code} while removing the "${name}" marketplace.`,
    }
  }

  if (options?.adapter) {
    const remaining = inspectNativeInstallation(harness as HarnessType, options.adapter)
    if (remaining.issues.length > 0) {
      return {
        removed: false,
        warning: `Could not verify the "${name}" marketplace removal: ${remaining.issues.map((issue) => issue.message).join('; ')}`,
      }
    }
    const stillThere = remaining.marketplaces.some((registration) => registration.name === name)
    if (stillThere) {
      return {
        removed: false,
        warning: `The "${name}" marketplace registration is still present after "${command.cmd} plugin marketplace remove".`,
      }
    }
  }

  logger?.info('uninstall.marketplace.removed', { harness, name, scope })
  return { removed: true }
}
