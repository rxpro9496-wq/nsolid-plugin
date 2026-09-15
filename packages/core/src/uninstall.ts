import path from 'node:path'
import { readdir } from 'node:fs/promises'
import type { HarnessType, Logger } from './types.js'
import { isNodeSourceMcpServerName } from './types.js'
import { getAdapter } from './harnesses/index.js'
import type { HarnessAdapter } from './harnesses/index.js'
import { removeNativePlugin, type CliRunner } from './harnesses/native-plugin-uninstaller.js'
import { removeMarketplaceRegistration } from './harnesses/native-plugin-uninstaller.js'
import {
  inspectNativeInstallation,
  marketplaceRegistrationProblem,
  planClaudeNativeRemoval,
  type ClaudeScope,
  type MarketplaceRegistration,
  type NativeInspection,
} from './harnesses/plugin-registry.js'
import { isNsolidPluginId, isNsolidMarketplace, NSOLID_MARKETPLACE } from './harnesses/plugin-name.js'
import { uninstallSkills } from './skills/skill-copier.js'
import { unlinkSkillsFromHarness } from './skills/skill-linker.js'
import {
  readTrackingFile,
  readTrackingFileStrict,
  assertTrackingFileReadable,
  removeTrackedSkills,
  setPendingMarketplaceRemovals,
  hasDurableState,
  type PendingMarketplaceRemoval,
} from './skills/skill-tracker.js'
import { removeTrackedMcps } from './mcp/mcp-tracker.js'
import { removeMcpConfig, readHarnessMcpConfig } from './mcp/mcp-config-writer.js'
import { disconnectExternalMcp, externalMcpOwnershipProblems } from './mcp/external-ownership.js'
import { getSkillsDir, resolveHome } from './utils/path.js'
import { createLogger, isVerboseEnabled } from './utils/logger.js'
import { removeCredentials } from './auth/index.js'
import { toPluginError, PluginError } from './errors.js'

/**
 * Complete selected-harness N|Solid uninstall.
 *
 * Plain and `--external-mcp` uninstall are the same operation under the owner
 * contract: remove the selected harness's skills, MCP entries, native plugin,
 * and marketplace registration, while never touching other harnesses,
 * unrelated plugins, shared credentials, or the shared MCP runtime. A harness
 * with recorded external-MCP ownership routes those entries through the safe
 * external cleanup (fingerprint-verified disconnect); tracked legacy entries
 * NOT covered by the external ownership record are still removed through the
 * tracked legacy path, because an external record never proves it covers every
 * tracked MCP entry for the harness.
 *
 * The whole selection is preflighted (read-only) before any effect: corrupt or
 * unreadable tracking/registries, edited/ambiguous owned MCP entries, a shared
 * marketplace that also feeds an unrelated plugin, an ambiguous Claude
 * marketplace scope, or an ambiguous Claude install scope abort the entire
 * command with nothing removed. Ownership is never inferred by name: a harness
 * with no tracking file refuses before effects whenever attributable
 * shared-skill or MCP content is detected.
 */

export type UninstallStageName = 'mcp' | 'skills' | 'nativePlugin' | 'marketplace'
export type UninstallStageStatus = 'removed' | 'not-present' | 'unsupported' | 'failed'

export interface UninstallStageResult {
  stage: UninstallStageName
  status: UninstallStageStatus
  detail?: string
}

export interface UninstallResult {
  errors: string[]
  credentialsPurged?: boolean
  /** True only when every stage completed (removed or genuinely not present). */
  success: boolean
  stages: UninstallStageResult[]
}

export interface UninstallOptions {
  bundlePath?: string
  verbose?: boolean
  logger?: Logger
  keepCredentials?: boolean
  /**
   * Retained for CLI compatibility. Under the owner contract both plain and
   * `--external-mcp` uninstall perform the same complete cleanup; the flag no
   * longer selects a narrower disconnect-only behavior.
   */
  externalMcp?: boolean
  /** Injectable harness-CLI runner for tests; defaults to spawning the real CLI. */
  runCli?: CliRunner
}

export interface UninstallBatchResult {
  success: boolean
  results: UninstallResult[]
}

function stage (
  name: UninstallStageName,
  status: UninstallStageStatus,
  detail?: string
): UninstallStageResult {
  return detail ? { stage: name, status, detail } : { stage: name, status }
}

/**
 * List `ns-*` entries in one skills directory, if it exists. Symlinks are
 * matched by NAME only (readdir reports lstat-like dirents, so a live link to a
 * directory is not `isDirectory()`): a live or dangling `ns-*` link is
 * attributable content whose owner cannot be proven, and its target must never
 * be followed. Only the entry name leaves this function.
 */
async function nsSkillCandidates (dir: string): Promise<{ names: string[], error?: string }> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return {
      names: entries
        .filter((entry) => (entry.isDirectory() || entry.isSymbolicLink()) && entry.name.startsWith('ns-'))
        .map((entry) => entry.name),
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { names: [] }
    return { names: [], error: `Cannot inspect the skills directory ${dir}: ${(err as Error).message}` }
  }
}

/** Known NodeSource MCP server names already present in a harness config. */
async function configuredNsolidMcps (adapter: HarnessAdapter): Promise<{ names: string[], error?: string }> {
  try {
    const config = await adapter.readMcpConfig()
    return { names: Object.keys(config.mcpServers).filter(isNodeSourceMcpServerName) }
  } catch (err) {
    return { names: [], error: `Cannot read the ${adapter.name} MCP config to attribute existing servers: ${(err as Error).message}` }
  }
}

/**
 * Whole-selection read-only preflight. Throws before any mutation when
 * ownership cannot be proven, a registry source is unreadable/malformed, a
 * marketplace is shared with an unrelated plugin, a Claude marketplace scope
 * or install scope is ambiguous, or a harness with no tracking file has
 * attributable shared-skill/MCP content that cannot be attributed.
 *
 * Returns the per-harness native inspection snapshots so execution (and the
 * Antigravity manual-marketplace stage) runs from the same immutable evidence
 * that was evaluated here instead of re-reading state it may itself erase.
 */
export async function preflightUninstall (
  harnesses: HarnessType[],
  logger?: Logger
): Promise<Map<HarnessType, NativeInspection>> {
  await assertTrackingFileReadable(logger)
  const tracking = await readTrackingFileStrict(logger)
  const problems: string[] = []
  const inspections = new Map<HarnessType, NativeInspection>()

  for (const harness of harnesses) {
    const adapter = getAdapter(harness)
    const record = tracking?.externalMcp?.[harness]
    if (record) problems.push(...externalMcpOwnershipProblems(harness, record))

    // Validate every legacy target using the same path and schema as execution.
    for (const configPath of legacyMcpRemovalPlan(harness, adapter, tracking).keys()) {
      try {
        readHarnessMcpConfig(harness, configPath)
      } catch (err) {
        problems.push(`Cannot read ${configPath} to verify ${harness}: ${(err as Error).message}`)
      }
    }

    const inspection = inspectNativeInstallation(harness, adapter)
    inspections.set(harness, inspection)

    for (const issue of inspection.issues) {
      problems.push(issue.message)
    }

    // Validate the FINAL removal set: the fresh inspection PLUS any durable
    // pending removal replayed on retry. A pending record whose evidence was
    // already erased still authorizes a marketplace command, so it must pass the
    // same unrelated-consumer and scope checks as freshly inspected records.
    const combined = marketplaceRegistrations(inspection, tracking?.pendingMarketplaceRemovals?.[harness])
    for (const registration of combined) {
      if (!isNsolidMarketplace(registration.name)) {
        problems.push(
          `The recorded pending marketplace removal "${registration.name}" (${harness}) is not one of the nsolid ` +
          'marketplaces; running a marketplace command for it would target an unrelated registration.'
        )
        continue
      }
      const installed = inspection.installedPluginsByMarketplace.get(registration.name) ?? []
      const unrelated = installed.filter((id) => !isNsolidPluginId(id))
      if (unrelated.length > 0) {
        problems.push(
          `Marketplace "${registration.name}" (${harness}) also feeds unrelated plugin(s): ${unrelated.join(', ')}. ` +
          'Removing that registration would break them, so the whole cleanup is refused.'
        )
      }
    }

    if (harness === 'claude') {
      const scopes = new Set(
        combined
          .map((registration) => registration.scope)
          .filter((scope): scope is NonNullable<typeof scope> => scope !== undefined)
      )
      if (scopes.size > 1) {
        problems.push(
          `Claude marketplace registration for nsolid is declared in multiple scopes (${[...scopes].join(', ')}); ` +
          'removing one would leave the others, and removing all would affect registrations outside the selection.'
        )
      }
      for (const registration of combined) {
        if (registration.scope === undefined) {
          problems.push(
            `The Claude marketplace removal for "${registration.name}" has no resolved scope, so no scoped ` +
            'removal command can be issued for it.'
          )
          continue
        }
        // Every eventual target must resolve to the settings file this run
        // would edit: a pending record from another project must refuse instead
        // of replaying its scoped command here, and missing provenance is never
        // filled from the current directory.
        const provenanceProblem = marketplaceRegistrationProblem(registration)
        if (provenanceProblem) problems.push(provenanceProblem)
      }
      if (inspection.pluginIds.length > 0) {
        const plan = planClaudeNativeRemoval(inspection.claudeInstallRecords)
        if (plan.problem) problems.push(plan.problem)
      }
    }
  }

  // No tracking file means no attributable ownership at all. Any shared-skill
  // or MCP content that looks like ours is then ambiguous: refuse before
  // effects rather than sweeping shared directories by name.
  if (tracking === null) {
    const skillDirs = new Set<string>([path.resolve(getSkillsDir())])
    for (const harness of harnesses) skillDirs.add(path.resolve(getAdapter(harness).getSkillsPath()))
    for (const dir of skillDirs) {
      const candidates = await nsSkillCandidates(dir)
      if (candidates.error) problems.push(candidates.error)
      if (candidates.names.length > 0) {
        const shown = candidates.names.slice(0, 5).join(', ')
        const more = candidates.names.length > 5 ? ` (+${candidates.names.length - 5} more)` : ''
        problems.push(
          `The skills directory ${dir} contains "ns-*" entries (${shown}${more}) but no tracking file was found, ` +
          'so their ownership cannot be attributed. Refusing to guess which skills belong to the selection.'
        )
      }
    }
    for (const harness of harnesses) {
      const adapter = getAdapter(harness)
      if (!adapter.supportsMcp()) continue
      const configured = await configuredNsolidMcps(adapter)
      if (configured.error) problems.push(configured.error)
      if (configured.names.length > 0) {
        problems.push(
          `The ${harness} MCP config already lists NodeSource server(s) ${configured.names.join(', ')} but no tracking file was found, ` +
          'so their ownership cannot be attributed. Refusing to sweep them by name.'
        )
      }
    }
  }

  if (problems.length > 0) {
    throw new PluginError(
      'UNINSTALL_PREFLIGHT_FAILED',
      `Uninstall refused before any change:\n- ${problems.join('\n- ')}`,
      {
        // Each finding names the harness/config it came from. A multi-harness
        // preflight refuses atomically for the whole selection, and naming
        // harnesses[0] would misattribute the refusal (an Antigravity finding
        // was reported as "Harness: claude"); only a single-harness run can
        // truthfully name one harness.
        ...(harnesses.length === 1 ? { harness: harnesses[0] } : {}),
        action: 'Inspect the reported harness config/marketplace state and resolve the ambiguity, then retry. Nothing was removed.',
      }
    )
  }

  return inspections
}

/** Resolve recorded paths identically for preflight and removal. */
function mcpEntryTargetPath (configPath: string | undefined, adapter: HarnessAdapter): string {
  const fallback = adapter.getMcpConfigPath()
  const raw = configPath && configPath.trim().length > 0 ? configPath : fallback
  return raw ? path.resolve(resolveHome(raw)) : ''
}

/** Harness is implied by the caller; same-name entries in different files differ. */
function mcpEntryIdentity (name: string, configPath: string | undefined, adapter: HarnessAdapter): string {
  return `${name}\u0000${mcpEntryTargetPath(configPath, adapter)}`
}

/** Exclude external identities so legacy removal can never bypass their fingerprints. */
function legacyMcpRemovalPlan (
  harness: HarnessType,
  adapter: HarnessAdapter,
  tracking: Awaited<ReturnType<typeof readTrackingFile>>
): Map<string, string[]> {
  const record = tracking?.externalMcp?.[harness]
  const externalIdentity = new Set(
    (record?.entries ?? []).map((entry) => mcpEntryIdentity(entry.name, entry.configPath, adapter))
  )
  const byPath = new Map<string, string[]>()
  for (const entry of tracking?.mcpServers ?? []) {
    if (entry.harness !== harness || externalIdentity.has(mcpEntryIdentity(entry.name, entry.configPath, adapter))) continue
    const configPath = mcpEntryTargetPath(entry.configPath, adapter)
    byPath.set(configPath, [...(byPath.get(configPath) ?? []), entry.name])
  }
  return byPath
}

/** Remove both ownership sets; keep failed obligations recorded for an honest retry. */
async function removeOwnedMcps (
  harness: HarnessType,
  adapter: HarnessAdapter,
  tracking: Awaited<ReturnType<typeof readTrackingFile>>,
  logger: Logger
): Promise<UninstallStageResult> {
  const byPath = legacyMcpRemovalPlan(harness, adapter, tracking)
  const legacyNames = [...byPath.values()].flat()
  const problems: string[] = []
  const done: string[] = []
  let failed = false

  if (tracking?.externalMcp?.[harness]) {
    const result = await disconnectExternalMcp([harness], { logger })
    if (!result.success) {
      failed = true
      problems.push(...result.errors)
    } else if (result.disconnected.includes(harness)) {
      done.push('external MCP entries disconnected')
    }
    // alreadyDisconnected (verified tombstone): nothing to do or report.
  }

  if (legacyNames.length > 0) {
    try {
      for (const [configPath, serverNames] of byPath) {
        await removeMcpConfig(harness, serverNames, { configPath: configPath || undefined, logger })
      }
      await removeTrackedMcps(legacyNames, harness, logger)
      done.push(`${legacyNames.length} tracked MCP entry(ies)`)
      logger.info('uninstall.mcp.done', { harness, count: legacyNames.length })
    } catch (err) {
      failed = true
      const pluginErr = toPluginError(err, 'MCP_CONFIG_WRITE_FAILED', { harness })
      problems.push(`MCP removal failed: ${pluginErr.message}`)
    }
  }

  if (failed) {
    const doneText = done.length > 0 ? `Already removed: ${done.join('; ')}.` : ''
    return stage('mcp', 'failed', [doneText, ...problems].filter(Boolean).join(' '))
  }
  if (done.length === 0) {
    return stage('mcp', 'not-present')
  }
  return stage('mcp', 'removed', done.join('; '))
}

async function removeOwnedSkills (
  harness: HarnessType,
  tracking: Awaited<ReturnType<typeof readTrackingFile>>,
  logger: Logger
): Promise<UninstallStageResult> {
  const harnessSkills = tracking?.skills.filter((entry) => entry.harnesses.includes(harness)) ?? []
  if (harnessSkills.length === 0) {
    return stage('skills', 'not-present')
  }

  const skillRefs = harnessSkills.map((entry) => ({ name: entry.name, path: entry.path, description: '' }))
  // The tracking snapshot is refreshed between harnesses, so a skill still
  // listed for exactly this harness has no remaining owner and its shared
  // contents can be deleted. A skill shared with another owner keeps
  // `harnesses.length > 1` and is preserved.
  const orphaned = harnessSkills
    .filter((entry) => entry.harnesses.length === 1)
    .map((entry) => ({ name: entry.name, path: entry.path, description: '' }))
  try {
    await unlinkSkillsFromHarness(harness, skillRefs, logger)
    // Delete the orphaned shared content BEFORE dropping the tracking entry:
    // the tracking file is the durable ownership proof, so a failed deletion
    // must leave the skill attributed to this harness for the retry. The
    // reverse order lost ownership and let a retry report "not-present" while
    // the content was still on disk. A tracking-write failure after a
    // successful deletion keeps the obligation recorded for the next run.
    if (orphaned.length > 0) await uninstallSkills(orphaned, logger)
    await removeTrackedSkills(skillRefs, harness, logger)
    logger.info('uninstall.skills.done', { harness, count: harnessSkills.length })
    return stage('skills', 'removed', `${harnessSkills.length} tracked skill(s)`)
  } catch (err) {
    const pluginErr = toPluginError(err, 'SKILL_LINK_FAILED', { harness })
    return stage('skills', 'failed', `Skill removal failed: ${pluginErr.message}`)
  }
}

async function removeNativePluginStage (
  harness: HarnessType,
  adapter: HarnessAdapter,
  options: UninstallOptions,
  logger: Logger,
  inspection: NativeInspection
): Promise<UninstallStageResult> {
  if (!adapter.detectNativePlugin) return stage('nativePlugin', 'not-present')
  if (inspection.pluginIds.length === 0) return stage('nativePlugin', 'not-present')

  try {
    const result = await removeNativePlugin(harness, adapter, {
      logger,
      inspection,
      ...(options.runCli ? { runCli: options.runCli } : {}),
    })
    if (!result.removed) {
      return stage(
        'nativePlugin',
        'failed',
        `Native plugin ${inspection.pluginIds.join(', ')} is still installed after cleanup. ${result.warnings.join(' ')}`.trim()
      )
    }
    if (result.warnings.length > 0) {
      return stage('nativePlugin', 'removed', result.warnings.join(' '))
    }
    return stage('nativePlugin', 'removed', inspection.pluginIds.join(', '))
  } catch (err) {
    return stage('nativePlugin', 'failed', `Native plugin removal failed: ${(err as Error).message}`)
  }
}

function registrationKey (registration: MarketplaceRegistration): string {
  // The settings path is part of the identity: a durable pending obligation for
  // one project must never be collapsed into a same-name/scope fresh
  // registration from another project, which would drop its provenance.
  return `${registration.name}\u0000${registration.scope ?? ''}\u0000${registration.settingsPath ?? ''}`
}

/**
 * Combine the preflight marketplace snapshot with any durable pending manual
 * removals. The snapshot is authoritative for the current run; the pending
 * records keep an unremovable registration actionable across retries even
 * after native-plugin removal erased its on-disk evidence.
 */
function marketplaceRegistrations (
  inspection: NativeInspection,
  pending: PendingMarketplaceRemoval[] | undefined
): MarketplaceRegistration[] {
  const registrations: MarketplaceRegistration[] = []
  const seen = new Set<string>()
  const add = (registration: MarketplaceRegistration): void => {
    const key = registrationKey(registration)
    if (seen.has(key)) return
    seen.add(key)
    registrations.push(registration)
  }

  if (inspection.marketplaceUnknown) {
    if (inspection.marketplaces.length > 0) for (const registration of inspection.marketplaces) add(registration)
    else add({ name: NSOLID_MARKETPLACE })
  } else {
    for (const registration of inspection.marketplaces) add(registration)
  }
  for (const record of pending ?? []) {
    add({
      name: record.name,
      ...(record.scope ? { scope: record.scope as ClaudeScope } : {}),
      ...(record.settingsPath ? { settingsPath: record.settingsPath } : {}),
    })
  }
  return registrations
}

async function removeMarketplaceStage (
  harness: HarnessType,
  adapter: HarnessAdapter,
  options: UninstallOptions,
  logger: Logger,
  inspection: NativeInspection,
  tracking: Awaited<ReturnType<typeof readTrackingFile>>
): Promise<UninstallStageResult> {
  const registrations = marketplaceRegistrations(inspection, tracking?.pendingMarketplaceRemovals?.[harness])
  if (registrations.length === 0) return stage('marketplace', 'not-present')

  // The preflight already rejects non-nsolid registrations, but this is the last
  // point before a harness command runs: never turn a malformed/durable name
  // into marketplace-remove authority.
  const unsupported = registrations.filter((registration) => !isNsolidMarketplace(registration.name))
  if (unsupported.length > 0) {
    return stage(
      'marketplace',
      'failed',
      `Refusing to run a marketplace command for non-nsolid registration(s): ${unsupported.map((registration) => registration.name).join(', ')}`
    )
  }

  // Path attribution is the last gate before a harness command runs: preflight
  // already refused a misattributed selection, but the stage re-proves that a
  // project/local command would edit the settings file this run resolves.
  const unprovable = registrations
    .map((registration) => marketplaceRegistrationProblem(registration))
    .filter((problem): problem is string => problem !== null)
  if (unprovable.length > 0) {
    return stage('marketplace', 'failed', unprovable.join(' '))
  }

  const toPending = (registration: MarketplaceRegistration, reason: string): PendingMarketplaceRemoval => ({
    name: registration.name,
    ...(registration.scope ? { scope: registration.scope } : {}),
    ...(registration.settingsPath && registration.scope !== 'user' ? { settingsPath: registration.settingsPath } : {}),
    reason,
    recordedAt: new Date().toISOString(),
  })

  const failures: string[] = []
  const pending: PendingMarketplaceRemoval[] = []
  let removedAny = false

  for (const registration of registrations) {
    if (!inspection.supportsMarketplaceRemove) {
      const reason = `The ${harness} CLI has no supported marketplace-remove command; marketplace "${registration.name}" must be removed manually.`
      failures.push(reason)
      pending.push(toPending(registration, reason))
      continue
    }

    const result = await removeMarketplaceRegistration(harness, registration.name, registration.scope, {
      logger,
      adapter,
      ...(options.runCli ? { runCli: options.runCli } : {}),
    })
    if (result.removed) {
      removedAny = true
      continue
    }
    const reason = result.warning ?? `Marketplace "${registration.name}" could not be removed.`
    failures.push(reason)
    pending.push(toPending(registration, reason))
  }

  // Durable evidence for retries: a registration we could not remove stays
  // recorded so a later run keeps reporting the manual stage instead of
  // treating the erased evidence as verified absence.
  try {
    await setPendingMarketplaceRemovals(harness, pending, logger)
  } catch (err) {
    failures.push(`Could not record the pending marketplace state for ${harness}: ${(err as Error).message}`)
  }

  if (failures.length > 0) {
    return stage('marketplace', inspection.supportsMarketplaceRemove ? 'failed' : 'unsupported', failures.join(' '))
  }
  return stage('marketplace', removedAny ? 'removed' : 'not-present')
}

async function uninstallOne (
  harness: HarnessType,
  options: UninstallOptions,
  tracking: Awaited<ReturnType<typeof readTrackingFile>>,
  logger: Logger,
  inspection: NativeInspection
): Promise<UninstallResult> {
  const adapter = getAdapter(harness)
  const errors: string[] = []
  const stages: UninstallStageResult[] = []
  const external = tracking?.externalMcp?.[harness]

  logger.info('uninstall.start', { harness, external: external?.state ?? 'none' })

  if (tracking) {
    stages.push(await removeOwnedMcps(harness, adapter, tracking, logger))
    stages.push(await removeOwnedSkills(harness, tracking, logger))
  } else {
    // No tracking file: nothing is attributable. Any nsolid-looking shared
    // content was already refused by the preflight; here the selected harness
    // simply has no tracked skills/MCPs to remove. Never sweep by name.
    stages.push(stage('mcp', 'not-present', 'no tracked MCP ownership'))
    stages.push(stage('skills', 'not-present', 'no tracked skill ownership'))
  }

  stages.push(await removeNativePluginStage(harness, adapter, options, logger, inspection))
  stages.push(await removeMarketplaceStage(harness, adapter, options, logger, inspection, tracking))

  for (const result of stages) {
    if (result.status === 'failed' || result.status === 'unsupported') {
      errors.push(result.detail ?? `${result.stage} ${result.status}`)
    }
  }

  logger.info('uninstall.finish', { harness, errors: errors.length, stages: stages.map((s) => `${s.stage}:${s.status}`) })
  return { errors, success: errors.length === 0, stages, credentialsPurged: false }
}

/**
 * Run the complete cleanup for every selected harness. The whole selection is
 * preflighted first; only then are harnesses mutated. The tracking snapshot is
 * refreshed between harnesses so a skill shared by several selected harnesses
 * is recognized as orphaned once its last selected owner is unlinked. Shared
 * credentials are purged at most once, and only when the legacy conditions
 * still hold (no tracked installs or durable records remain anywhere).
 */
export async function uninstallHarnesses (
  harnesses: HarnessType[],
  options?: UninstallOptions
): Promise<UninstallBatchResult> {
  const logger = options?.logger ?? createLogger({ verbose: isVerboseEnabled(options?.verbose) })

  const inspections = await preflightUninstall(harnesses, logger)

  // Re-read after preflight so every stage sees the same evidence.
  let tracking = await readTrackingFileStrict(logger)
  const trackingAtStart = tracking
  const results: UninstallResult[] = []
  for (const harness of harnesses) {
    const inspection = inspections.get(harness) ?? inspectNativeInstallation(harness, getAdapter(harness))
    results.push(await uninstallOne(harness, options ?? {}, tracking, logger, inspection))
    // Refresh: a skill shared by multiple selected harnesses must lose its
    // intermediate ownership count before the next harness evaluates orphans.
    // A re-read failure is reported against the completed harness and never
    // aborts the remaining per-stage reporting.
    try {
      tracking = await readTrackingFileStrict(logger)
    } catch (err) {
      const previous = results[results.length - 1]
      previous.errors.push(`Could not re-read tracking after ${harness}: ${(err as Error).message}`)
      previous.success = false
      tracking = null
    }
  }

  // Credentials: only the legacy tracked branch purges on the last harness.
  // The no-tracking branch never purges, and any durable state (external MCP
  // active/tombstone, pending manual marketplace) means a config copy may
  // still carry the token, so the owner contract forbids deleting shared auth
  // merely because the last selected plugin was removed.
  let credentialsPurged = false
  const failures = results.some((result) => !result.success)
  if (!failures && options?.keepCredentials !== true && trackingAtStart !== null) {
    const remaining = await readTrackingFile(logger)
    const isEmpty = !remaining || (remaining.skills.length === 0 && remaining.mcpServers.length === 0)
    if (isEmpty && !hasDurableState(remaining)) {
      try {
        if (removeCredentials()) {
          credentialsPurged = true
          logger.info('uninstall.credentials.purged', { reason: 'last-harness-legacy' })
        }
      } catch (err) {
        results[results.length - 1]?.errors.push(`Could not remove credentials: ${(err as Error).message}`)
      }
    }
  }

  if (credentialsPurged) {
    for (const result of results) result.credentialsPurged = true
  }

  const success = results.every((result) => result.success)
  return { success, results }
}

/** Single-harness wrapper over {@link uninstallHarnesses}. */
export async function uninstall (
  harness: HarnessType,
  options?: UninstallOptions
): Promise<UninstallResult> {
  const batch = await uninstallHarnesses([harness], options)
  return batch.results[0]
}
