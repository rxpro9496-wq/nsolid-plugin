import { createHash } from 'node:crypto'
import path from 'node:path'
import type { HarnessType, Logger } from '../types.js'
import { EXTERNAL_MCP_HARNESSES } from '../types.js'
import { PluginError } from '../errors.js'
import { getTrackingFilePath, resolveHome } from '../utils/path.js'
import { readExistingConfig, removeMcpConfig } from './mcp-config-writer.js'
import {
  readTrackingFileStrict,
  writeTrackingFile,
} from '../skills/skill-tracker.js'
import type {
  ExternalMcpEntryRecord,
  ExternalMcpHarnessRecord,
  TrackingData,
} from '../skills/skill-tracker.js'

/**
 * Ownership evidence for the experimental `--external-mcp` mode.
 *
 * The tracking arrays keep the external MCP entries themselves (so legacy
 * consumers still see them); the additive `TrackingData.externalMcp` map
 * records, per harness, whether the direct HTTP MCP entries are owned by the
 * external mode, plus a non-secret semantic fingerprint per recorded entry.
 * The fingerprint is what `uninstall --external-mcp` compares against the
 * on-disk config before deleting anything: a user edit or an ambiguous state
 * aborts the whole command instead of name-sweeping.
 */

/** Normalized semantic view of one MCP entry, used for ownership fingerprints. */
export interface NormalizedExternalMcpEntry {
  url: string;
  /** Lowercased header name/value pairs, sorted by name. */
  headers: Array<[string, string]>;
  /**
   * Every other meaningful entry field, key-sorted, with the url/header alias
   * spellings removed. Keeping them in the hash means a user edit to a field
   * such as `enabled`, `command`, `env`, or an extra auth option changes the
   * fingerprint and aborts the whole disconnect preflight instead of letting
   * the recorded entry be removed.
   */
  fields: Array<[string, unknown]>;
}

const URL_ALIASES = new Set(['url', 'serverUrl'])
const HEADER_ALIASES = new Set(['headers', 'http_headers'])

/** Recursively key-sorts an entry value so object key order never changes the fingerprint. */
function canonicalizeValue (value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeValue)
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(source).sort()) sorted[key] = canonicalizeValue(source[key])
    return sorted
  }
  return value
}

/**
 * Normalize an MCP entry from any harness config into the semantic pair that
 * identifies it: endpoint URL, header map, and every other meaningful field.
 * Harness-specific spellings are collapsed (`serverUrl` for Antigravity;
 * `headers`/`http_headers` for the Codex schema migration) so a fingerprint
 * recorded before the Codex adapter fix still matches the entry written
 * afterwards. Header names are lowercased and object keys are sorted, so
 * casing and key order are not user edits.
 */
export function normalizeExternalMcpEntry (raw: unknown): NormalizedExternalMcpEntry | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const entry = raw as Record<string, unknown>
  const url = typeof entry.url === 'string'
    ? entry.url
    : (typeof entry.serverUrl === 'string' ? entry.serverUrl : null)
  if (!url) return null

  const headers: Array<[string, string]> = []
  const rawHeaders = entry.headers ?? entry.http_headers
  if (rawHeaders && typeof rawHeaders === 'object' && !Array.isArray(rawHeaders)) {
    for (const [name, value] of Object.entries(rawHeaders as Record<string, unknown>)) {
      if (typeof value !== 'string') continue
      headers.push([name.toLowerCase(), value])
    }
  }
  headers.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))

  const fields: Array<[string, unknown]> = []
  for (const key of Object.keys(entry).sort()) {
    if (URL_ALIASES.has(key) || HEADER_ALIASES.has(key)) continue
    fields.push([key, canonicalizeValue(entry[key])])
  }

  return { url, headers, fields }
}

/**
 * SHA-256 over the normalized entry. Non-secret: header values (tokens) are
 * hashed, never stored, so the tracking file is not a second credential copy.
 * Returns null when the entry has no URL (not a NodeSource-owned HTTP entry).
 */
export function fingerprintExternalMcpEntry (raw: unknown): string | null {
  const normalized = normalizeExternalMcpEntry(raw)
  if (!normalized) return null
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex')
}

function formatFromPath (configPath: string): 'json' | 'toml' | 'jsonc' {
  if (configPath.endsWith('.toml')) return 'toml'
  if (configPath.endsWith('.jsonc')) return 'jsonc'
  return 'json'
}

/**
 * Read one MCP entry from a harness config file after harness-format
 * normalization. Throws when the file exists but cannot be parsed — callers
 * treat that as "cannot verify ownership", never as "entry absent".
 */
export function readOnDiskMcpEntry (configPath: string, name: string): Record<string, unknown> | null {
  const config = readExistingConfig(configPath, formatFromPath(configPath))
  if (!Object.hasOwn(config.mcpServers, name)) return null
  const entry = config.mcpServers[name] as unknown
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`MCP entry "${name}" is present in ${configPath} but is not an object`)
  }
  return entry as Record<string, unknown>
}

/** Fingerprint of the on-disk entry, or null when absent/URL-less. */
export function fingerprintOnDiskEntry (configPath: string, name: string): string | null {
  return fingerprintExternalMcpEntry(readOnDiskMcpEntry(configPath, name))
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

function unmanagedOwnershipError (harness: HarnessType, configPath: string, message: string): PluginError {
  return new PluginError('EXTERNAL_MCP_UNMANAGED', message, {
    harness,
    path: configPath,
    action: `Re-run: nsolid-plugin setup --harness ${harness} --external-mcp`,
  })
}

/**
 * Record (or refresh) external ownership for the entries just written to a
 * harness config. Fingerprints are read back from disk so they describe the
 * exact serialized form the harness will consume. Throws when the entry
 * cannot be read back: setup must then report failure rather than claim a
 * safely managed external install.
 *
 * writeMcpConfig MERGES: a prior entry of the same harness that is not in the
 * new write-set survives in the harness config. The record therefore covers
 * the new write-set PLUS every verified survivor. Survivors outside the
 * write-set are renewed only by CONTINUITY with the prior record: their
 * current on-disk fingerprint must still match `prior.fingerprint`. On any
 * discrepancy (edited content, a URL-less entry, an unreadable file) the
 * refresh throws BEFORE `writeTrackingFile`, so the previous ownership
 * evidence survives intact and nothing partial is persisted. A survivor that
 * is genuinely gone from disk is dropped (ghost). Survivor reconciliation
 * runs only against an ACTIVE prior record: a disconnected tombstone is
 * user-superseded evidence, never renewal authorization, so entries reapplied
 * after a disconnect stay outside CLI ownership. Without survivor
 * reconciliation a shrunken re-setup would leave unrecorded servers (and
 * their auth headers) configured behind a false "removed everything" success.
 */
export async function recordExternalMcpOwnership (
  harness: HarnessType,
  entries: { name: string; configPath: string }[],
  logger?: Logger
): Promise<void> {
  if (entries.length === 0) {
    throw new PluginError(
      'EXTERNAL_MCP_UNMANAGED',
      `Cannot record external MCP ownership for ${harness}: no MCP entries were configured.`,
      { harness }
    )
  }

  const tracking = (await readTrackingFileStrict(logger)) ?? createEmptyTracking(harness)
  const priorRecord = tracking.externalMcp?.[harness]
  // Survivor reconciliation renews ownership only from an ACTIVE record: a
  // disconnected tombstone is user-superseded evidence, never renewal
  // authorization, so entries reapplied after a disconnect are not carried
  // into a fresh record even when their content still matches.
  const priorEntries = priorRecord?.state === 'active' ? priorRecord.entries : []
  // Identity is name + config file: an entry written to another file does not
  // overwrite the prior record's entry, so it stays a survivor candidate.
  const writeSet = new Set(
    entries.map((entry) => `${entry.name}\u0000${path.resolve(resolveHome(entry.configPath))}`)
  )

  const recordedAt = new Date().toISOString()
  const records: ExternalMcpEntryRecord[] = []
  for (const entry of entries) {
    const resolvedPath = path.resolve(resolveHome(entry.configPath))
    const fingerprint = fingerprintOnDiskEntry(resolvedPath, entry.name)
    if (!fingerprint) {
      throw unmanagedOwnershipError(
        harness,
        resolvedPath,
        `Configured entry "${entry.name}" could not be read back from ${resolvedPath}, so external MCP ownership cannot be recorded.`
      )
    }
    records.push({ name: entry.name, configPath: resolvedPath, fingerprint, recordedAt })
  }

  for (const prior of priorEntries) {
    if (writeSet.has(`${prior.name}\u0000${prior.configPath}`)) continue
    let onDisk: Record<string, unknown> | null
    try {
      onDisk = readOnDiskMcpEntry(prior.configPath, prior.name)
    } catch (err) {
      throw unmanagedOwnershipError(
        harness,
        prior.configPath,
        `Prior recorded entry "${prior.name}" could not be read back from ${prior.configPath}, so external MCP ownership cannot be recorded: ${(err as Error).message}`
      )
    }
    // Ghost: the prior entry is genuinely gone from the config, so it must not
    // be carried into the fresh record.
    if (!onDisk) continue
    const fingerprint = fingerprintExternalMcpEntry(onDisk)
    // Presence that no longer admits a fingerprint (e.g. the entry lost its
    // URL) is NOT real absence: ownership cannot be verified, so refuse
    // instead of silently dropping the prior evidence as if the server had
    // been removed (or re-adopting it as freshly owned).
    if (!fingerprint) {
      throw unmanagedOwnershipError(
        harness,
        prior.configPath,
        `Prior recorded entry "${prior.name}" is still present in ${prior.configPath} but no longer admits an ownership fingerprint (it has no URL), so its ownership cannot be verified.`
      )
    }
    // Continuity gate: a survivor outside the write-set keeps its ownership
    // only when its current on-disk value still matches the fingerprint
    // recorded when it was owned. Otherwise this refresh must not silently
    // adopt a user-edited entry as freshly owned (a later uninstall would
    // delete the user's edit).
    if (fingerprint !== prior.fingerprint) {
      throw unmanagedOwnershipError(
        harness,
        prior.configPath,
        `Prior recorded entry "${prior.name}" in ${prior.configPath} changed since ownership was recorded, and it is not part of this setup's write-set, so its ownership cannot be renewed.`
      )
    }
    // Untouched survivor: conserved with its re-confirmed prior fingerprint.
    records.push({ name: prior.name, configPath: prior.configPath, fingerprint: prior.fingerprint, recordedAt })
  }

  tracking.externalMcp = {
    ...(tracking.externalMcp ?? {}),
    [harness]: { state: 'active', updatedAt: recordedAt, entries: records },
  }
  await writeTrackingFile(tracking, logger)
  logger?.info('externalMcp.ownership.recorded', { harness, entries: records.length })
}

/**
 * Reject a flagless (legacy) command targeting a harness with an ACTIVE
 * external MCP configuration, before any auth/runtime/config side effect.
 * Disconnected tombstones do not block legacy transitions.
 */
export async function assertNoActiveExternalMcp (
  harnesses: HarnessType[],
  operation: string,
  logger?: Logger
): Promise<void> {
  const tracking = await readTrackingFileStrict(logger)
  const active = harnesses.filter((harness) => tracking?.externalMcp?.[harness]?.state === 'active')
  if (active.length === 0) return

  const first = active[0]
  throw new PluginError(
    'EXTERNAL_MCP_ACTIVE',
    `${operation} cannot run for a harness with an ACTIVE external MCP configuration: ${active.join(', ')}. ` +
      'The experimental --external-mcp mode owns the direct MCP entries for that harness, and a flagless run would mix the legacy and external modes.',
    {
      harness: first,
      action: `Disconnect first: nsolid-plugin uninstall --external-mcp --harness ${first}. To refresh instead: nsolid-plugin setup --harness ${first} --external-mcp.`,
    }
  )
}

/**
 * A successful flagless (legacy) setup for a harness supersedes a disconnected
 * external-MCP tombstone for the same harness: the legacy transition owns the
 * re-created entries now, and a retained tombstone would dead-end the next
 * full uninstall ("present again" refusal) with no CLI path out. Reads the
 * tracking file strictly and deletes ONLY the record whose state is exactly
 * `disconnected`; ACTIVE records never reach this path because
 * {@link assertNoActiveExternalMcp} refuses flagless commands first.
 *
 * Throws when the tracking file is unreadable so the caller reports the
 * failure instead of silently leaving the dead-end tombstone in place.
 */
export async function clearDisconnectedExternalMcp (
  harness: HarnessType,
  logger?: Logger
): Promise<void> {
  const tracking = await readTrackingFileStrict(logger)
  const record = tracking?.externalMcp?.[harness]
  if (!tracking || !record || record.state !== 'disconnected') return
  delete tracking.externalMcp![harness]
  await writeTrackingFile(tracking, logger)
  logger?.info('externalMcp.tombstone.cleared', { harness })
}

export interface DisconnectExternalMcpOptions {
  logger?: Logger;
}

export interface DisconnectExternalMcpResult {
  success: boolean;
  /** Harnesses whose recorded external entries were removed and tombstoned. */
  disconnected: HarnessType[];
  /** Harnesses already disconnected (idempotent re-run) — nothing to remove. */
  alreadyDisconnected: HarnessType[];
  errors: string[];
}

/**
 * Read-only ownership preflight shared by full uninstall and explicit
 * disconnect. The callers own their surrounding tracking-file and operation
 * errors; this function only checks the selected record against disk.
 */
export function externalMcpOwnershipProblems (
  harness: HarnessType,
  record: ExternalMcpHarnessRecord
): string[] {
  const problems: string[] = []
  if (record.state === 'active' && record.entries.length === 0) {
    return [`External MCP record for ${harness} has no entries to disconnect`]
  }

  for (const entry of record.entries) {
    let onDisk: Record<string, unknown> | null
    try {
      onDisk = readOnDiskMcpEntry(entry.configPath, entry.name)
    } catch (err) {
      problems.push(`Cannot read ${entry.configPath} to verify ${harness}: ${(err as Error).message}`)
      continue
    }

    if (record.state === 'disconnected') {
      if (onDisk) {
        problems.push(
          `${harness} is already disconnected, but recorded entry "${entry.name}" is present again in ${entry.configPath}`
        )
      }
      continue
    }

    if (!onDisk) {
      problems.push(`Recorded entry "${entry.name}" is missing from ${entry.configPath} (${harness})`)
    } else if (fingerprintExternalMcpEntry(onDisk) !== entry.fingerprint) {
      problems.push(
        `Recorded entry "${entry.name}" in ${entry.configPath} (${harness}) no longer matches the ownership evidence (edited or replaced)`
      )
    }
  }
  return problems
}

type DisconnectPlan =
  | { kind: 'disconnect'; harness: HarnessType; record: ExternalMcpHarnessRecord }
  | { kind: 'already'; harness: HarnessType }

async function finalizeDisconnect (
  harness: HarnessType,
  names: string[],
  logger?: Logger
): Promise<void> {
  const tracking = await readTrackingFileStrict(logger)
  const record = tracking?.externalMcp?.[harness]
  if (!tracking || !record) {
    throw new Error(`external MCP ownership record for ${harness} disappeared during disconnect`)
  }
  const now = new Date().toISOString()
  // Prune tracked mirrors by full identity (name + resolved config path):
  // a same-name row registered against a different config file is a distinct
  // obligation — pruning it here would erase the legacy phase's retry
  // evidence and could later turn its failure into a false success.
  const ownedIdentities = new Set(
    record.entries.map((entry) => `${entry.name}\u0000${entry.configPath}`)
  )
  tracking.mcpServers = tracking.mcpServers.filter((entry) => {
    if (entry.harness !== harness) return true
    if (entry.configPath === undefined) return true // identity unprovable: keep the evidence
    const resolved = path.resolve(resolveHome(entry.configPath))
    return !ownedIdentities.has(`${entry.name}\u0000${resolved}`)
  })
  tracking.externalMcp![harness] = {
    ...record,
    state: 'disconnected',
    updatedAt: now,
    disconnectedAt: now,
  }
  await writeTrackingFile(tracking, logger)
  logger?.info('externalMcp.disconnected', { harness, entries: names.length })
}

/**
 * Explicit `uninstall --external-mcp` disconnect.
 *
 * Whole-command preflight: every recorded entry of every selected harness is
 * verified against its on-disk fingerprint BEFORE any mutation. Any mismatch,
 * missing entry, missing/corrupt tracking, or harness without an ownership
 * record aborts with zero config/tracking mutations. Only verified entries
 * are removed (by name, within their recorded config file); the tombstone is
 * retained so re-running is idempotent and shared-credential purges stay
 * conservative. Never touches skills, native plugins, the shared runtime, or
 * credentials.
 */
export async function disconnectExternalMcp (
  harnesses: HarnessType[],
  options?: DisconnectExternalMcpOptions
): Promise<DisconnectExternalMcpResult> {
  const logger = options?.logger
  const errors: string[] = []
  const disconnected: HarnessType[] = []
  const alreadyDisconnected: HarnessType[] = []

  const unsupported = harnesses.filter((harness) => !EXTERNAL_MCP_HARNESSES.has(harness))
  if (unsupported.length > 0) {
    throw new PluginError(
      'INVALID_OPTION',
      `--external-mcp is only supported for harnesses: ${[...EXTERNAL_MCP_HARNESSES].join(', ')} (unsupported: ${unsupported.join(', ')})`,
      { harness: unsupported[0] }
    )
  }

  let tracking: TrackingData | null
  try {
    tracking = await readTrackingFileStrict(logger)
  } catch (err) {
    // Present-but-unreadable or malformed ownership evidence: refuse to touch
    // anything, exactly like the missing-file case below.
    return {
      success: false,
      disconnected,
      alreadyDisconnected,
      errors: [
        `Cannot verify external MCP ownership for ${harnesses.join(', ')}: ${(err as Error).message} Nothing was removed. ` +
        'Refresh ownership with: nsolid-plugin setup --harness <harness> --external-mcp',
      ],
    }
  }
  if (!tracking) {
    const trackingPath = getTrackingFilePath()
    return {
      success: false,
      disconnected,
      alreadyDisconnected,
      errors: [
        `Cannot verify external MCP ownership for ${harnesses.join(', ')}: no tracking file was found at ${trackingPath}. Nothing was removed. ` +
        'Refresh ownership with: nsolid-plugin setup --harness <harness> --external-mcp',
      ],
    }
  }

  const plans: DisconnectPlan[] = []
  for (const harness of harnesses) {
    const record = tracking.externalMcp?.[harness]
    if (!record) {
      errors.push(
        `No external MCP ownership record for ${harness}. ` +
        `Refresh ownership first: nsolid-plugin setup --harness ${harness} --external-mcp`
      )
      continue
    }

    const ownershipProblems = externalMcpOwnershipProblems(harness, record)
    if (ownershipProblems.length > 0) {
      errors.push(...ownershipProblems.map((problem) =>
        `${problem}. Nothing was removed. Refresh ownership before retrying: nsolid-plugin setup --harness ${harness} --external-mcp`
      ))
      continue
    }
    plans.push(record.state === 'disconnected'
      ? { kind: 'already', harness }
      : { kind: 'disconnect', harness, record })
  }

  if (errors.length > 0) {
    return { success: false, disconnected, alreadyDisconnected, errors }
  }

  for (const plan of plans) {
    if (plan.kind === 'already') {
      alreadyDisconnected.push(plan.harness)
      continue
    }

    const { harness, record } = plan
    const names = record.entries.map((entry) => entry.name)
    const byPath = new Map<string, string[]>()
    for (const entry of record.entries) {
      byPath.set(entry.configPath, [...(byPath.get(entry.configPath) ?? []), entry.name])
    }

    let removedAny = false
    try {
      for (const [configPath, serverNames] of byPath) {
        await removeMcpConfig(harness, serverNames, { configPath, logger })
        removedAny = true
      }
    } catch (err) {
      errors.push(
        removedAny
          ? `Removing external MCP entries for ${harness} partially completed before failing: ${(err as Error).message}. ` +
            `Re-run setup --harness ${harness} --external-mcp to refresh ownership before retrying.`
          : `Removing external MCP entries for ${harness} failed: ${(err as Error).message}. ` +
            'Nothing was removed; the ownership record is still active.'
      )
      continue
    }

    try {
      await finalizeDisconnect(harness, names, logger)
    } catch (err) {
      errors.push(
        `MCP entries were removed for ${harness}, but updating the ownership record failed: ${(err as Error).message}. ` +
        `Re-run setup --harness ${harness} --external-mcp to refresh ownership, then disconnect again.`
      )
      break
    }
    disconnected.push(harness)
  }

  logger?.info('externalMcp.disconnect.finish', {
    disconnected: disconnected.length,
    alreadyDisconnected: alreadyDisconnected.length,
    errors: errors.length,
  })

  return {
    success: errors.length === 0,
    disconnected,
    alreadyDisconnected,
    errors,
  }
}
