import path from 'node:path'
import { existsSync, unlinkSync } from 'node:fs'
import { HARNESS_VALUES, type HarnessType, type Logger, type SkillRef } from '../types.js'
import { isNsolidMarketplace } from '../harnesses/plugin-name.js'
import { isClaudeScope } from '../harnesses/plugin-registry.js'
import { getSkillsDir, getTrackingFilePath, isCanonicalAbsolutePath } from '../utils/path.js'
import { readJsonFile } from '../utils/config.js'
import { writeJsonFile, ensureDir } from '../utils/fs.js'
import { formatPluginError, toPluginError, PluginError } from '../errors.js'

export interface SkillTrackingEntry {
  name: string;
  path: string;
  paths?: Record<string, string>;
  installedAt: string;
  harnesses: string[];
}

export interface McpTrackingEntry {
  name: string;
  configPath: string;
  harness: string;
  configuredAt: string;
}

export type ExternalMcpConnectionState = 'active' | 'disconnected'

/**
 * Ownership evidence for one direct HTTP MCP entry written by the
 * experimental `--external-mcp` setup mode. Non-secret: `fingerprint` is a
 * SHA-256 over the normalized {url, headers} pair, so the state file never
 * holds a second plaintext copy of a service token.
 */
export interface ExternalMcpEntryRecord {
  name: string;
  configPath: string;
  fingerprint: string;
  recordedAt: string;
}

/**
 * Additive per-harness external-MCP lifecycle state, keyed by harness inside
 * {@link TrackingData.externalMcp}. `active` means direct MCP entries are
 * owned by the experimental mode and legacy (flagless) commands must not mix
 * with them; `disconnected` is a tombstone after an explicit
 * `uninstall --external-mcp`, retained (with its entry records) so the
 * cleanup stays idempotent and shared-credential purges stay conservative.
 */
export interface ExternalMcpHarnessRecord {
  state: ExternalMcpConnectionState;
  updatedAt: string;
  disconnectedAt?: string;
  entries: ExternalMcpEntryRecord[];
}

/**
 * A marketplace registration the uninstall could not remove automatically
 * (for example Antigravity exposes no marketplace-remove command). Kept so a
 * retried uninstall keeps reporting the actionable manual stage instead of
 * reinterpreting erased evidence as verified absence.
 */
export interface PendingMarketplaceRemoval {
  name: string;
  scope?: string;
  /**
   * Claude project/local only: the absolute settings file that declared the
   * registration when the removal failed. Persisted so a retry can prove it is
   * about to edit the same project settings file; never inferred from the
   * retry's working directory.
   */
  settingsPath?: string;
  reason: string;
  recordedAt: string;
}

export interface TrackingData {
  version: string;
  installedAt: string;
  harness: string;
  skills: SkillTrackingEntry[];
  mcpServers: McpTrackingEntry[];
  externalMcp?: Partial<Record<HarnessType, ExternalMcpHarnessRecord>>;
  /**
   * Additive: marketplace registrations that could not be removed through a
   * supported command. Retained so repeated `uninstall` runs keep reporting the
   * remaining manual stage instead of pretending the erased evidence proves
   * absence.
   */
  pendingMarketplaceRemovals?: Partial<Record<HarnessType, PendingMarketplaceRemoval[]>>;
}

/**
 * True when the tracking data holds at least one external-MCP harness record
 * (active OR disconnected tombstone). Used by the empty-file unlink
 * conditions and by shared-credential purge predicates: such a record proves
 * a harness may still consume the credentials from its own config copy, so
 * "no tracked skills/MCPs left" is not sufficient evidence to purge.
 */
export function hasExternalMcpState (tracking: TrackingData | null): boolean {
  return !!tracking?.externalMcp && Object.keys(tracking.externalMcp).length > 0
}

/** True when the tracking data holds a pending manual marketplace removal. */
export function hasPendingMarketplaceRemovals (tracking: TrackingData | null): boolean {
  return !!tracking?.pendingMarketplaceRemovals && Object.keys(tracking.pendingMarketplaceRemovals).length > 0
}

/**
 * True when any durable ownership/lifecycle record exists (external-MCP state
 * or a pending manual marketplace removal). Such a record must keep the
 * tracking file alive through empty-file unlink conditions and must block the
 * "last harness removed" shared-credential purge.
 */
export function hasDurableState (tracking: TrackingData | null): boolean {
  return hasExternalMcpState(tracking) || hasPendingMarketplaceRemovals(tracking)
}

export async function readTrackingFile (logger?: Logger): Promise<TrackingData | null> {
  try {
    return readJsonFile<TrackingData>(getTrackingFilePath())
  } catch (err) {
    logger?.warn('tracking.read.failed', { error: (err as Error).message })
    return null
  }
}

/**
 * Shape check for one parsed tracking file. Returns a human-readable reason, or
 * null when the data is usable. The legacy schema (skills/mcpServers arrays,
 * no externalMcp) is valid; every optional durable block is validated
 * INDEPENDENTLY, because each one guards destructive behavior:
 * a malformed external-MCP record would slip past the ACTIVE-external guards,
 * and a malformed pending marketplace removal is replayed as a marketplace
 * command on the next retry.
 */
function trackingDataProblem (value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return 'the file does not contain a JSON object'
  }
  const data = value as Record<string, unknown>
  if (!Array.isArray(data.skills)) return 'the "skills" field is not an array'
  if (!Array.isArray(data.mcpServers)) return 'the "mcpServers" field is not an array'
  const externalProblem = externalMcpProblem(data.externalMcp)
  if (externalProblem) return externalProblem
  return pendingMarketplaceRemovalsProblem(data.pendingMarketplaceRemovals)
}

/** Shape check for the additive external-MCP ownership map. */
function externalMcpProblem (value: unknown): string | null {
  if (value === undefined) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return 'the "externalMcp" field is not an object'
  }
  for (const [harness, record] of Object.entries(value as Record<string, unknown>)) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      return `the externalMcp record for "${harness}" is not an object`
    }
    const rec = record as Record<string, unknown>
    if (rec.state !== 'active' && rec.state !== 'disconnected') {
      return `the externalMcp record for "${harness}" has an invalid state`
    }
    if (!Array.isArray(rec.entries)) {
      return `the externalMcp record for "${harness}" has no entries array`
    }
    for (const entry of rec.entries) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return `the externalMcp record for "${harness}" contains an invalid entry`
      }
      const e = entry as Record<string, unknown>
      if (typeof e.name !== 'string' || typeof e.configPath !== 'string' || typeof e.fingerprint !== 'string') {
        return `the externalMcp record for "${harness}" contains an entry without name/configPath/fingerprint`
      }
    }
  }
  return null
}

/**
 * Shape check for one durable pending marketplace removal. Only the exact
 * marketplace identities the nsolid distribution has used are accepted, scoped
 * to the harness that owns them: the record authorizes a marketplace-remove
 * command on a retry, so a corrupted value must never become command authority.
 * A Claude project/local record must also carry an absolute canonical settings
 * path (no trailing separator, `.`/`..` segment, redundant separator or NUL
 * byte), and no other record may carry one, so the retry can prove which
 * project settings file the command targets instead of inheriting the current
 * directory.
 */
function pendingMarketplaceRemovalProblem (harness: string, record: unknown): string | null {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return 'contains a non-object entry'
  const r = record as Record<string, unknown>
  if (typeof r.name !== 'string') return 'contains an entry without a string name'
  if (!isNsolidMarketplace(r.name)) {
    return `names "${r.name}", which is not one of the nsolid marketplaces`
  }
  if (r.scope !== undefined) {
    if (harness !== 'claude') return `contains a scope for the non-Claude harness "${harness}"`
    if (!isClaudeScope(r.scope)) return `contains an unsupported scope for "${r.name}"`
  } else if (harness === 'claude') {
    return `has no Claude scope for "${r.name}"`
  }
  const projectScoped = r.scope === 'project' || r.scope === 'local'
  const settingsPath = r.settingsPath
  if (projectScoped) {
    // The record authorizes a scoped marketplace command whose target the CLI
    // resolves from the working directory, so the originating settings file must
    // be proven. A missing or relative path can never be filled from the cwd.
    if (typeof settingsPath !== 'string' || settingsPath.length === 0) {
      return `contains a ${r.scope as string}-scope entry without a settings path`
    }
    if (!path.isAbsolute(settingsPath)) {
      return `contains a ${r.scope as string}-scope entry with a relative settings path`
    }
    if (!isCanonicalAbsolutePath(settingsPath)) {
      return `contains a ${r.scope as string}-scope entry with a malformed settings path`
    }
  } else if (settingsPath !== undefined) {
    return `contains a settings path without a project/local scope for "${r.name}"`
  }
  if (typeof r.reason !== 'string' || r.reason.length === 0) return 'contains an entry without a reason'
  if (typeof r.recordedAt !== 'string') return 'contains an entry without a recordedAt timestamp'
  return null
}

/** Shape check for the durable pending-marketplace map, validated for every harness. */
function pendingMarketplaceRemovalsProblem (value: unknown): string | null {
  if (value === undefined) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return 'the "pendingMarketplaceRemovals" field is not an object'
  }
  for (const [harness, records] of Object.entries(value as Record<string, unknown>)) {
    if (!(HARNESS_VALUES as readonly string[]).includes(harness)) {
      return `the "pendingMarketplaceRemovals" field names an unsupported harness "${harness}"`
    }
    if (!Array.isArray(records)) {
      return `the "pendingMarketplaceRemovals" record for "${harness}" is not an array`
    }
    for (const record of records) {
      const problem = pendingMarketplaceRemovalProblem(harness, record)
      if (problem) return `the "pendingMarketplaceRemovals" record for "${harness}" ${problem}`
    }
  }
  return null
}

/**
 * Strict read for commands that mutate state. Unlike {@link readTrackingFile}
 * (kept lenient so doctor, `restore --list`, and `logout` stay useful), a
 * present-but-unreadable or malformed file throws `TRACKING_CORRUPT` instead
 * of reading as absent: rebuilding it would silently discard the external-MCP
 * ownership evidence that guards destructive commands. A missing file is
 * still valid legacy state and returns null.
 */
export async function readTrackingFileStrict (logger?: Logger): Promise<TrackingData | null> {
  const filePath = getTrackingFilePath()
  if (!existsSync(filePath)) return null

  let parsed: unknown
  try {
    parsed = readJsonFile<unknown>(filePath)
  } catch (err) {
    logger?.warn('tracking.read.corrupt', { path: filePath, error: (err as Error).message })
    throw new PluginError(
      'TRACKING_CORRUPT',
      `Tracking file ${filePath} exists but could not be parsed: ${(err as Error).message}`,
      {
        path: filePath,
        action: `Repair or remove ${filePath} manually. The CLI will not rebuild ownership evidence it cannot read; a fresh install recreates the file.`,
      }
    )
  }

  const problem = trackingDataProblem(parsed)
  if (problem) {
    logger?.warn('tracking.read.malformed', { path: filePath, problem })
    throw new PluginError(
      'TRACKING_CORRUPT',
      `Tracking file ${filePath} is malformed: ${problem}.`,
      {
        path: filePath,
        action: `Repair or remove ${filePath} manually. The CLI will not rebuild ownership evidence it cannot read; a fresh install recreates the file.`,
      }
    )
  }

  return parsed as TrackingData
}

/**
 * Mutation preflight: reject a present-but-unreadable or malformed tracking
 * file before a command performs any side effect (auth, config, runtime,
 * ownership). Missing tracking is valid legacy state and passes.
 */
export async function assertTrackingFileReadable (logger?: Logger): Promise<void> {
  await readTrackingFileStrict(logger)
}

export async function writeTrackingFile (data: TrackingData, logger?: Logger): Promise<void> {
  const filePath = getTrackingFilePath()
  ensureDir(path.dirname(filePath))
  try {
    await writeJsonFile(filePath, data)
    logger?.debug('tracking.write', { skills: data.skills.length, mcpServers: data.mcpServers.length })
  } catch (err) {
    const pluginErr = toPluginError(err, 'TRACKING_UPDATE_FAILED', { path: filePath })
    throw new Error(formatPluginError(pluginErr), { cause: pluginErr })
  }
}

export async function addTrackedSkills (
  skills: SkillRef[],
  harness: HarnessType,
  logger?: Logger,
  skillsDir = getSkillsDir()
): Promise<void> {
  const tracking = (await readTrackingFile(logger)) ?? createEmptyTracking(harness)
  const now = new Date().toISOString()

  for (const skill of skills) {
    const normalizedPath = path.resolve(path.join(skillsDir, skill.name))
    const existing = tracking.skills.find((s) => s.name === skill.name)

    if (existing) {
      const previousHarnesses = existing.harnesses
      const previousPaths = { ...(existing.paths ?? {}) }
      for (const trackedHarness of previousHarnesses) {
        previousPaths[trackedHarness] ??= existing.path
      }
      const harnessSet = new Set(previousHarnesses)
      harnessSet.add(harness)
      existing.harnesses = [...harnessSet]
      existing.paths = { ...previousPaths, [harness]: normalizedPath }
      if (previousHarnesses.length === 1 && previousHarnesses[0] === harness) {
        existing.path = normalizedPath
      }
    } else {
      tracking.skills.push({
        name: skill.name,
        path: normalizedPath,
        paths: { [harness]: normalizedPath },
        installedAt: now,
        harnesses: [harness],
      })
    }
  }

  await writeTrackingFile(tracking, logger)
}

export async function removeTrackedSkills (
  skills: SkillRef[],
  harness?: HarnessType,
  logger?: Logger
): Promise<void> {
  const tracking = await readTrackingFile(logger)
  if (!tracking) return

  for (const skill of skills) {
    const entry = tracking.skills.find((s) => s.name === skill.name)
    if (!entry) continue

    if (harness) {
      entry.harnesses = entry.harnesses.filter((h) => h !== harness)
      if (entry.paths) delete entry.paths[harness]
      if (entry.harnesses.length === 0) {
        tracking.skills = tracking.skills.filter((s) => s.name !== skill.name)
      } else {
        entry.path = entry.paths?.[entry.harnesses[0]] ?? entry.path
      }
    } else {
      tracking.skills = tracking.skills.filter((s) => s.name !== skill.name)
    }
  }

  if (tracking.skills.length === 0 && tracking.mcpServers.length === 0 && !hasDurableState(tracking)) {
    const filePath = getTrackingFilePath()
    if (existsSync(filePath)) {
      try {
        unlinkSync(filePath)
        logger?.debug('tracking.delete', { reason: 'empty' })
      } catch (err) {
        const pluginErr = toPluginError(err, 'TRACKING_UPDATE_FAILED', { path: filePath })
        throw new Error(formatPluginError(pluginErr), { cause: pluginErr })
      }
    }
  } else {
    await writeTrackingFile(tracking, logger)
  }
}

/**
 * Persist (or clear) the pending manual marketplace removals for a harness.
 * Written after a stage runs so a retried uninstall keeps reporting the
 * actionable failure once the original on-disk evidence has been erased.
 */
export async function setPendingMarketplaceRemovals (
  harness: HarnessType,
  records: PendingMarketplaceRemoval[],
  logger?: Logger
): Promise<void> {
  const tracking = (await readTrackingFileStrict(logger)) ?? createEmptyTracking(harness)
  if (records.length === 0) {
    if (tracking.pendingMarketplaceRemovals) {
      delete tracking.pendingMarketplaceRemovals[harness]
      if (Object.keys(tracking.pendingMarketplaceRemovals).length === 0) delete tracking.pendingMarketplaceRemovals
    }
  } else {
    tracking.pendingMarketplaceRemovals = {
      ...(tracking.pendingMarketplaceRemovals ?? {}),
      [harness]: records,
    }
  }

  if (tracking.skills.length === 0 && tracking.mcpServers.length === 0 && !hasDurableState(tracking)) {
    const filePath = getTrackingFilePath()
    if (existsSync(filePath)) unlinkSync(filePath)
    return
  }
  await writeTrackingFile(tracking, logger)
}

export async function listTrackedSkills (): Promise<SkillTrackingEntry[]> {
  const tracking = await readTrackingFile()
  return tracking?.skills ?? []
}

function createEmptyTracking (harness: HarnessType): TrackingData {
  return {
    version: '1.0.0',
    installedAt: new Date().toISOString(),
    harness,
    skills: [],
    mcpServers: [],
  }
}
