import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { HarnessType } from '../types.js'
import type { HarnessAdapter } from './harness-adapter.js'
import { readTomlFile } from '../utils/config.js'
import { isCanonicalAbsolutePath, resolveHome } from '../utils/path.js'
import {
  isNsolidMarketplace,
  isNsolidPluginId,
  NSOLID_MARKETPLACE,
  PLUGIN_BASE_NAMES,
} from './plugin-name.js'

/**
 * Read-only inspection of the N|Solid native plugin + marketplace registration
 * for one harness. Kept separate from the mutating uninstaller so the whole
 * uninstall can be preflighted across every selected harness before any
 * removal, and so ambiguity (unknown marketplace scope/source, a shared
 * marketplace feeding another plugin, a cross-scope or multi-project Claude
 * install) is provable evidence rather than a guess.
 *
 * "Missing" is deliberately distinct from "unreadable/invalid shape": a file
 * that does not exist is valid legacy state (nothing to remove), while a file
 * that exists but cannot be read or parsed is a structured
 * {@link RegistryInspectionIssue} that refuses the whole selection before
 * effects. Failing open on those would hide installed-plugin consumers and
 * authorize a marketplace removal the user did not ask for.
 */

/** Claude Code settings scope for a plugin install or marketplace declaration. */
export type ClaudeScope = 'user' | 'project' | 'local'

/** Backward-compatible alias retained for existing callers. */
export type ClaudeMarketplaceScope = ClaudeScope

const CLAUDE_SCOPES: ReadonlySet<string> = new Set(['user', 'project', 'local'])

/** True when `value` is one of Claude Code's explicit install scopes. */
export function isClaudeScope (value: unknown): value is ClaudeScope {
  return typeof value === 'string' && CLAUDE_SCOPES.has(value)
}

/** Claude marketplace/install scopes in the documented inspection order. */
const CLAUDE_SCOPE_ORDER: readonly ClaudeScope[] = ['user', 'project', 'local']

/**
 * The absolute settings file Claude Code reads for one marketplace/install
 * scope. `project` and `local` resolve inside `projectDir` exactly like the
 * {@link claudeRegistry} lookup; `user` resolves from the home directory and is
 * therefore independent of any project working directory. Provenance is checked
 * against this single function so the lookup and the validation cannot drift.
 */
export function claudeScopeSettingsPath (scope: ClaudeScope, projectDir: string = process.cwd()): string {
  switch (scope) {
    case 'user': return resolveHome('~/.claude/settings.json')
    case 'project': return path.resolve(projectDir, '.claude/settings.json')
    case 'local': return path.resolve(projectDir, '.claude/settings.local.json')
  }
}

/** One Claude `installed_plugins.json` registration for a single plugin id. */
export interface ClaudePluginInstallRecord {
  id: string
  /** Explicit settings scope, or null for a scope-less (legacy) registration. */
  scope: ClaudeScope | null
  /** Project path Claude records for a project/local install, when present. */
  projectPath?: string
  /**
   * True when the registry lists the id but its registration cannot be
   * attributed to a scope (empty array, non-object record, malformed map
   * value). Removal must refuse rather than guess.
   */
  ambiguous: boolean
}

export interface MarketplaceRegistration {
  name: string
  /** Claude-only: the settings scope that declares the marketplace. */
  scope?: ClaudeScope
  /**
   * Claude project/local only: the absolute settings file that declared this
   * registration. Provenance for a retry that must not be resolved against the
   * current working directory; absent for user-scope and non-Claude
   * registrations, which are not tied to a project.
   */
  settingsPath?: string
  source?: string
}

export type RegistryIssueKind = 'unreadable' | 'invalid-shape'

/** A registry source that exists but cannot be trusted as ownership evidence. */
export interface RegistryInspectionIssue {
  /** Human-readable source label, e.g. `installed_plugins.json`. */
  source: string
  path: string
  kind: RegistryIssueKind
  message: string
}

export interface NativeInspection {
  /** Concrete nsolid plugin ids recorded by the harness (may be empty). */
  pluginIds: string[]
  /**
   * Per-scope Claude install records for the nsolid plugin ids. Empty for
   * harnesses that do not record install scopes (Codex, Antigravity).
   */
  claudeInstallRecords: ClaudePluginInstallRecord[]
  /** Every plugin id the harness has installed, used for the shared-source check. */
  installedPluginIds: string[]
  /** Marketplace registrations attributable to nsolid, in deterministic order. */
  marketplaces: MarketplaceRegistration[]
  /** True when the harness exposes a supported CLI command to remove a marketplace. */
  supportsMarketplaceRemove: boolean
  /**
   * True when a marketplace-registration state may exist but cannot be
   * inspected with certainty (for example Antigravity, whose CLI has no
   * marketplace-remove command and no documented registration file). Callers
   * must not assume "not present".
   */
  marketplaceUnknown: boolean
  marketplaceUnknownReason?: string
  /** Installed plugin ids per marketplace name, for the shared-source check. */
  installedPluginsByMarketplace: Map<string, string[]>
  /**
   * Existing-but-unusable registry sources. Any entry must refuse the whole
   * selection before effects: corrupt state can hide consumers or scopes.
   */
  issues: RegistryInspectionIssue[]
}

// --- low-level source readers (missing vs unreadable/invalid) ---

type SourceRead = { value: unknown } | { issue: RegistryInspectionIssue } | null

function makeIssue (
  source: string,
  filePath: string,
  kind: RegistryIssueKind,
  message: string
): RegistryInspectionIssue {
  return { source, path: filePath, kind, message }
}

/** Reads a JSON file; null means missing, an issue means present-but-unusable. */
function readJsonSource (filePath: string, source: string): SourceRead {
  if (!existsSync(filePath)) return null
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf8')
  } catch (err) {
    return { issue: makeIssue(source, filePath, 'unreadable', `${source} at ${filePath} could not be read: ${(err as Error).message}`) }
  }
  if (raw.trim().length === 0) return { value: undefined }
  try {
    return { value: JSON.parse(raw) }
  } catch (err) {
    return { issue: makeIssue(source, filePath, 'invalid-shape', `${source} at ${filePath} is not valid JSON: ${(err as Error).message}`) }
  }
}

/** Reads a TOML file; null means missing, an issue means present-but-unusable. */
function readTomlSource (filePath: string, source: string): SourceRead {
  if (!existsSync(filePath)) return null
  try {
    return { value: readTomlFile<Record<string, unknown>>(filePath) }
  } catch (err) {
    return { issue: makeIssue(source, filePath, 'invalid-shape', `${source} at ${filePath} could not be parsed: ${(err as Error).message}`) }
  }
}

function isPlainObject (value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

// --- Claude ---

interface ClaudeRegistry {
  installedRecords: ClaudePluginInstallRecord[]
  registrations: MarketplaceRegistration[]
  issues: RegistryInspectionIssue[]
}

/**
 * Parse one Claude registration record. An ABSENT `scope` is the documented
 * legacy (scope-less) registration. A PRESENT but unsupported `scope` — any
 * string outside the supported set, or a number/null/container — is malformed
 * state, not a legacy install: defaulting it to the scope-less removal would
 * issue a removal the registry does not authorize, so it is reported as an
 * unusable source instead. Returns the record or a human-readable problem.
 */
function claudePluginRecord (id: string, raw: unknown): ClaudePluginInstallRecord | string {
  if (!isPlainObject(raw)) return `installed_plugins.json has a non-object registration for "${id}"`
  const scope = raw.scope
  if (scope !== undefined && !isClaudeScope(scope)) {
    return `installed_plugins.json has an unsupported "scope" value for "${id}"`
  }
  const projectPath = raw.projectPath
  if (projectPath !== undefined && typeof projectPath !== 'string') {
    return `installed_plugins.json has an unsupported "projectPath" value for "${id}"`
  }
  return {
    id,
    scope: scope === undefined ? null : scope,
    ...(typeof projectPath === 'string' && projectPath.length > 0 ? { projectPath } : {}),
    ambiguous: false,
  }
}

/**
 * Parse `installed_plugins.json`. Tolerates the documented schemas (v2 map,
 * legacy id array, bare map of ids) but reports structured issues for any
 * unsupported present shape instead of silently dropping it: a dropped entry
 * is a consumer the marketplace-removal check can no longer see, which would
 * authorize removing a source another plugin depends on.
 */
function parseClaudeInstalledPlugins (
  value: unknown,
  filePath: string
): { records: ClaudePluginInstallRecord[], issues: RegistryInspectionIssue[] } {
  const source = 'installed_plugins.json'
  const invalidShape = (message: string): RegistryInspectionIssue => makeIssue(source, filePath, 'invalid-shape', message)

  // A missing field or an empty file (value === undefined) is valid empty legacy
  // state. A present `null` is deliberately not supported here: unlike the
  // Antigravity import manifest (whose real CLI writes {"imports": null}), the
  // real Claude CLI's observed empty state is the v2 empty map
  // ({"version": 2, "plugins": {}}), which this parser accepts; null stays
  // refused until real evidence shows the CLI producing it.
  if (value === undefined) return { records: [], issues: [] }

  const fromIdArray = (
    entries: unknown[],
    where: string
  ): { records: ClaudePluginInstallRecord[], issues: RegistryInspectionIssue[] } => {
    const records: ClaudePluginInstallRecord[] = []
    const issues: RegistryInspectionIssue[] = []
    for (const entry of entries) {
      if (typeof entry === 'string') {
        records.push({ id: entry, scope: null, ambiguous: false })
        continue
      }
      if (isPlainObject(entry) && typeof entry.id === 'string') {
        const parsed = claudePluginRecord(entry.id, entry)
        if (typeof parsed === 'string') issues.push(invalidShape(parsed))
        else records.push(parsed)
        continue
      }
      issues.push(invalidShape(`${source} at ${filePath} has an unsupported ${where} entry`))
    }
    return { records, issues }
  }

  if (Array.isArray(value)) return fromIdArray(value, 'top-level')
  if (!isPlainObject(value)) {
    return { records: [], issues: [invalidShape(`${source} at ${filePath} does not contain a JSON object or array`)] }
  }

  const plugins = value.plugins
  if (plugins === undefined) return { records: [], issues: [] }
  if (Array.isArray(plugins)) return fromIdArray(plugins, '"plugins"')
  if (!isPlainObject(plugins)) {
    return { records: [], issues: [invalidShape(`${source} at ${filePath} has a "plugins" field that is neither an array nor an object`)] }
  }

  const records: ClaudePluginInstallRecord[] = []
  const issues: RegistryInspectionIssue[] = []
  for (const [id, rawRecords] of Object.entries(plugins)) {
    if (!Array.isArray(rawRecords)) {
      issues.push(invalidShape(`${source} at ${filePath} has an unsupported registration for "${id}" (expected an array of records)`))
      continue
    }
    if (rawRecords.length === 0) {
      records.push({ id, scope: null, ambiguous: true })
      continue
    }
    for (const raw of rawRecords) {
      // A bare string is only meaningful in the legacy id-array schema; the v2
      // map value holds registration records.
      if (typeof raw === 'string') {
        issues.push(invalidShape(`${source} at ${filePath} has an unsupported string registration for "${id}"`))
        continue
      }
      const parsed = claudePluginRecord(id, raw)
      if (typeof parsed === 'string') issues.push(invalidShape(parsed))
      else records.push(parsed)
    }
  }
  return { records, issues }
}

function claudeRegistry (): ClaudeRegistry {
  const issues: RegistryInspectionIssue[] = []
  const installedPath = resolveHome('~/.claude/plugins/installed_plugins.json')
  const installed = readJsonSource(installedPath, 'installed_plugins.json')
  let installedRecords: ClaudePluginInstallRecord[] = []
  if (installed && 'issue' in installed) {
    issues.push(installed.issue)
  } else if (installed) {
    const parsed = parseClaudeInstalledPlugins(installed.value, installedPath)
    installedRecords = parsed.records
    issues.push(...parsed.issues)
  }

  const registrations: MarketplaceRegistration[] = []
  for (const scope of CLAUDE_SCOPE_ORDER) {
    const settingsPath = claudeScopeSettingsPath(scope)
    const source = `Claude marketplace settings (${scope})`
    const read = readJsonSource(settingsPath, source)
    if (read === null) continue
    if ('issue' in read) {
      issues.push(read.issue)
      continue
    }
    if (read.value === undefined || read.value === null) continue
    if (!isPlainObject(read.value)) {
      issues.push(makeIssue(source, settingsPath, 'invalid-shape', `${source} at ${settingsPath} is not a JSON object`))
      continue
    }
    const extra = read.value.extraKnownMarketplaces
    if (extra === undefined || extra === null) continue
    if (!isPlainObject(extra)) {
      issues.push(makeIssue(source, settingsPath, 'invalid-shape', `${source} at ${settingsPath} has an "extraKnownMarketplaces" field that is not an object`))
      continue
    }
    for (const name of Object.keys(extra)) {
      if (isNsolidMarketplace(name)) {
        // Project/local provenance stays attached to the file that declared the
        // registration; a user registration has no project to point at.
        registrations.push({
          name,
          scope,
          ...(scope === 'user' ? {} : { settingsPath }),
        })
      }
    }
  }

  return { installedRecords, registrations, issues }
}

// --- Codex ---

interface CodexRegistry {
  installedIds: string[]
  registrations: MarketplaceRegistration[]
  issues: RegistryInspectionIssue[]
}

function codexRegistry (adapter: HarnessAdapter): CodexRegistry {
  const issues: RegistryInspectionIssue[] = []
  const filePath = adapter.getMcpConfigPath() ?? ''
  const read = readTomlSource(filePath, 'Codex config.toml')
  if (read === null) return { installedIds: [], registrations: [], issues }
  if ('issue' in read) return { installedIds: [], registrations: [], issues: [read.issue] }
  if (!isPlainObject(read.value)) {
    return {
      installedIds: [],
      registrations: [],
      issues: [makeIssue('Codex config.toml', filePath, 'invalid-shape', `Codex config.toml at ${filePath} is not a TOML table`)],
    }
  }

  let installedIds: string[] = []
  const plugins = read.value.plugins
  if (plugins !== undefined && plugins !== null) {
    if (!isPlainObject(plugins)) {
      issues.push(makeIssue('Codex plugins table', filePath, 'invalid-shape', `Codex config.toml at ${filePath} has a [plugins] table that is not a table`))
    } else {
      installedIds = Object.keys(plugins)
    }
  }

  const registrations: MarketplaceRegistration[] = []
  const marketplaces = read.value.marketplaces
  if (marketplaces !== undefined && marketplaces !== null) {
    if (!isPlainObject(marketplaces)) {
      issues.push(makeIssue('Codex marketplaces table', filePath, 'invalid-shape', `Codex config.toml at ${filePath} has a [marketplaces] table that is not a table`))
    } else {
      for (const name of Object.keys(marketplaces)) {
        if (isNsolidMarketplace(name)) registrations.push({ name })
      }
    }
  }

  return { installedIds, registrations, issues }
}

// --- Antigravity ---

interface AntigravityEvidence {
  found: boolean
  /** The exact on-disk identity that matched (link name or import name). */
  name?: string
  reason?: string
  issues: RegistryInspectionIssue[]
}

function isNsolidMarketplaceIdentity (name: string): boolean {
  return isNsolidMarketplace(name) || (PLUGIN_BASE_NAMES as readonly string[]).includes(name)
}

/**
 * Antigravity exposes `agy plugin install|uninstall` but no marketplace-remove
 * command, and a direct local install does not register a marketplace. Any
 * marketplace evidence therefore cannot be removed through a supported
 * command; report it as unknown/unsupported rather than pretending it is gone.
 *
 * Identities are matched EXACTLY: the canonical `nodesource`, the legacy
 * experimental `nsolid-skills`, and the plugin base names. A substring match
 * would treat an unrelated `nodesource-tools` link as ours.
 *
 * Every applicable source is inspected even after one signal proves existence:
 * a corrupt or unreadable import manifest can hide another marketplace consumer,
 * so the inspection accumulates issues instead of short-circuiting on the first
 * positive match. Link entries are matched by name only — the link target is
 * never read, followed, or deleted.
 */
function antigravityEvidence (): AntigravityEvidence {
  const issues: RegistryInspectionIssue[] = []
  const pluginsRoot = resolveHome('~/.gemini/config/plugins')
  const linkDir = path.join(pluginsRoot, 'marketplaces')
  let name: string | undefined
  let reason: string | undefined

  if (existsSync(linkDir)) {
    try {
      const matched = readdirSync(linkDir).filter((entry) => isNsolidMarketplaceIdentity(entry))
      if (matched.length > 0) {
        name = matched[0]
        reason = `Antigravity marketplace link(s) ${matched.map((entry) => `"${entry}"`).join(', ')} under ${linkDir} reference nsolid`
      }
    } catch (err) {
      issues.push(makeIssue('Antigravity marketplace links', linkDir, 'unreadable', `Antigravity marketplace link directory ${linkDir} could not be read: ${(err as Error).message}`))
    }
  }

  const manifestPath = resolveHome('~/.gemini/config/import_manifest.json')
  const read = readJsonSource(manifestPath, 'Antigravity import manifest')
  if (read && 'issue' in read) {
    issues.push(read.issue)
  } else if (read && read.value !== undefined) {
    if (!isPlainObject(read.value)) {
      issues.push(makeIssue('Antigravity import manifest', manifestPath, 'invalid-shape', `Antigravity import manifest at ${manifestPath} is not a JSON object`))
    } else {
      const imports = read.value.imports
      // The real Antigravity CLI rewrites the manifest as {"imports": null} once
      // its last import is removed (observed with `agy plugin uninstall`). Null
      // is a recognized empty state — like a missing field — not a corrupt
      // manifest; any other non-array shape can still hide entries and refuses.
      if (imports !== undefined && imports !== null && !Array.isArray(imports)) {
        issues.push(makeIssue('Antigravity import manifest', manifestPath, 'invalid-shape', `Antigravity import manifest at ${manifestPath} has an "imports" field that is not an array`))
      } else if (Array.isArray(imports)) {
        for (const entry of imports) {
          if (!isPlainObject(entry)) continue
          const entryName = typeof entry.name === 'string' ? entry.name : undefined
          if (!entryName || !(PLUGIN_BASE_NAMES as readonly string[]).includes(entryName)) continue
          const marketplaceField = entry.marketplace ?? entry.marketplaceName ?? entry.marketplaceUrl
          if (typeof marketplaceField === 'string' && marketplaceField.length > 0) {
            name ??= entryName
            reason ??= `Antigravity import manifest records marketplace "${marketplaceField}" for ${entryName}`
          } else if (entry.sourceType === 'marketplace') {
            name ??= entryName
            reason ??= `Antigravity import manifest records a marketplace-sourced import for ${entryName}`
          }
        }
      }
    }
  }

  return { found: name !== undefined, name, reason, issues }
}

// --- inspection ---

function installedPluginsByMarketplace (ids: string[]): Map<string, string[]> {
  const map = new Map<string, string[]>()
  for (const id of ids) {
    const at = id.lastIndexOf('@')
    if (at <= 0) continue
    const marketplace = id.slice(at + 1)
    map.set(marketplace, [...(map.get(marketplace) ?? []), id])
  }
  return map
}

/**
 * Inspect the native plugin ids and marketplace registration for a harness.
 * Read-only; never mutates. `supportsMarketplaceRemove` reflects the installed
 * harness CLIs: Claude and Codex expose `plugin marketplace remove`, while
 * Antigravity's help does not.
 */
export function inspectNativeInstallation (harness: HarnessType, adapter: HarnessAdapter): NativeInspection {
  if (harness === 'claude') {
    const registry = claudeRegistry()
    const nsolidRecords = registry.installedRecords.filter((record) => isNsolidPluginId(record.id))
    return {
      pluginIds: [...new Set(nsolidRecords.map((record) => record.id))],
      claudeInstallRecords: nsolidRecords,
      installedPluginIds: [...new Set(registry.installedRecords.map((record) => record.id))],
      marketplaces: registry.registrations,
      supportsMarketplaceRemove: true,
      marketplaceUnknown: false,
      installedPluginsByMarketplace: installedPluginsByMarketplace(registry.installedRecords.map((record) => record.id)),
      issues: registry.issues,
    }
  }

  if (harness === 'codex') {
    const registry = codexRegistry(adapter)
    return {
      pluginIds: registry.installedIds.filter(isNsolidPluginId),
      claudeInstallRecords: [],
      installedPluginIds: registry.installedIds,
      marketplaces: registry.registrations,
      supportsMarketplaceRemove: true,
      marketplaceUnknown: false,
      installedPluginsByMarketplace: installedPluginsByMarketplace(registry.installedIds),
      issues: registry.issues,
    }
  }

  // Antigravity (and any future harness without a marketplace-remove command).
  const detected = adapter.detectNativePlugin?.()?.installedIds ?? []
  const evidence = harness === 'antigravity' ? antigravityEvidence() : { found: false, issues: [] }
  return {
    pluginIds: detected,
    claudeInstallRecords: [],
    installedPluginIds: detected,
    marketplaces: evidence.found
      ? [{ name: evidence.name && isNsolidMarketplace(evidence.name) ? evidence.name : NSOLID_MARKETPLACE }]
      : [],
    supportsMarketplaceRemove: false,
    marketplaceUnknown: evidence.found,
    ...(evidence.reason ? { marketplaceUnknownReason: evidence.reason } : {}),
    installedPluginsByMarketplace: new Map(),
    issues: evidence.issues,
  }
}

// --- Claude install-scope planning ---

export interface ClaudeNativeRemovalPlan {
  id: string
  /** Scopes to remove; a single `null` means the legacy scope-less registration. */
  scopes: Array<ClaudeScope | null>
}

export interface ClaudeRemovalPlanResult {
  plans: ClaudeNativeRemovalPlan[]
  /** Set when the install state cannot be attributed safely; removal must refuse. */
  problem?: string
}

function normalizePathForCompare (value: string): string {
  return path.resolve(value)
}

/**
 * Decide, from the preflight install records, exactly which Claude
 * scopes/project paths may be removed. Anything not explicitly attributable
 * (scope-less multi-record sets, unresolvable scopes, multiple project paths,
 * a project install recorded for a different working directory) refuses the
 * whole selection instead of falling back to a scope-wide removal.
 */
export function planClaudeNativeRemoval (
  records: ClaudePluginInstallRecord[],
  cwd: string = process.cwd()
): ClaudeRemovalPlanResult {
  const byId = new Map<string, ClaudePluginInstallRecord[]>()
  for (const record of records) {
    byId.set(record.id, [...(byId.get(record.id) ?? []), record])
  }

  const plans: ClaudeNativeRemovalPlan[] = []
  for (const [id, recs] of byId) {
    if (recs.some((record) => record.ambiguous)) {
      return { plans: [], problem: `The Claude install record for "${id}" has no recognizable scope, so its registration cannot be attributed safely` }
    }

    const scopeLess = recs.filter((record) => record.scope === null)
    const explicit = recs.filter((record): record is ClaudePluginInstallRecord & { scope: ClaudeScope } => record.scope !== null)

    if (scopeLess.length > 0 && explicit.length > 0) {
      return { plans: [], problem: `The Claude install registry mixes scoped and scope-less registrations for "${id}"` }
    }
    if (scopeLess.length > 1 || (scopeLess.length === 1 && recs.length > 1)) {
      return { plans: [], problem: `The Claude install registry lists multiple scope-less registrations for "${id}"` }
    }
    if (scopeLess.length === 1) {
      plans.push({ id, scopes: [null] })
      continue
    }

    const scopes = [...new Set(explicit.map((record) => record.scope))]
    const projectRecords = explicit.filter((record) => record.scope === 'project' || record.scope === 'local')
    const projectPaths = [...new Set(projectRecords.map((record) => record.projectPath).filter((p): p is string => !!p))]
    if (projectPaths.length > 1) {
      return { plans: [], problem: `The Claude plugin "${id}" is registered in multiple project paths (${projectPaths.join(', ')})` }
    }
    if (projectPaths.length === 1 && normalizePathForCompare(projectPaths[0]) !== normalizePathForCompare(cwd)) {
      return { plans: [], problem: `The Claude plugin "${id}" is registered for project ${projectPaths[0]} but this command runs from ${cwd}` }
    }
    plans.push({ id, scopes })
  }
  return { plans }
}

export interface MarketplaceRemovalCommand {
  cmd: string
  args: string[]
}

/**
 * The supported CLI command to remove one marketplace registration, or null
 * when the harness has no supported removal command. Claude passes an explicit
 * `--scope` because omitting it removes the declaration from every scope; a
 * Claude registration with no resolved scope therefore returns null (refuse)
 * instead of a scope-wide removal.
 */
export function marketplaceRemovalCommand (
  harness: HarnessType,
  name: string,
  scope?: ClaudeScope
): MarketplaceRemovalCommand | null {
  switch (harness) {
    case 'claude':
      return scope
        ? { cmd: 'claude', args: ['plugin', 'marketplace', 'remove', name, '--scope', scope] }
        : null
    case 'codex':
      return { cmd: 'codex', args: ['plugin', 'marketplace', 'remove', name] }
    default:
      return null
  }
}

/**
 * Why a marketplace registration cannot be removed safely from `projectDir`,
 * or null when it can. A Claude project/local registration authorizes a scoped
 * CLI command whose target the CLI resolves from the CURRENT working directory,
 * so the target is only proven when the registration carries an absolute
 * canonical (lexically normalized) settings path equal to the one the config
 * lookup would read here. Missing provenance is never filled from the current
 * directory, a relative path is never resolved against it, a malformed absolute
 * path (trailing separator, `.`/`..` segment, redundant separator, NUL byte) is
 * rejected lexically before any normalization so it cannot resolve into an
 * accidental match, and a mismatch refuses rather than relocating the command.
 * A user-scope registration is home-scoped and must carry no project settings
 * path; a scope-less registration (Codex, legacy) has no path to check.
 */
export function marketplaceRegistrationProblem (
  registration: MarketplaceRegistration,
  projectDir: string = process.cwd()
): string | null {
  const scope = registration.scope
  if (scope === undefined) return null
  if (scope === 'user') {
    if (registration.settingsPath !== undefined) {
      return `The user-scope marketplace registration "${registration.name}" carries the project settings path ` +
        `${registration.settingsPath}; a user-scope removal must not be attributed to a project.`
    }
    return null
  }
  const provenance = registration.settingsPath
  if (typeof provenance !== 'string' || provenance.length === 0) {
    return `The ${scope}-scope marketplace registration "${registration.name}" has no recorded settings path, ` +
      'so the project it belongs to cannot be proven.'
  }
  if (!path.isAbsolute(provenance)) {
    return `The ${scope}-scope marketplace registration "${registration.name}" records the relative settings path ` +
      `"${provenance}"; refusing to resolve it against the current project.`
  }
  if (!isCanonicalAbsolutePath(provenance)) {
    return `The ${scope}-scope marketplace registration "${registration.name}" records the malformed settings path ` +
      `"${provenance}"; an absolute canonical settings-file path is required.`
  }
  const expected = claudeScopeSettingsPath(scope, projectDir)
  if (provenance !== expected) {
    return `The ${scope}-scope marketplace registration "${registration.name}" belongs to ${provenance}, ` +
      `but this command runs from ${expected}.`
  }
  return null
}
