export { getAdapter } from './harnesses/index.js'
export type { HarnessAdapter, McpConfig, McpServerConfig } from './harnesses/index.js'
export { loadCredentials, isExpired } from './auth/index.js'

import path from 'node:path'
import { existsSync } from 'node:fs'

import type {
  HarnessType,
  InstallOptions,
  InstallResult,
  SetupOptions,
  SetupResult,
  DoctorReport,
  BundleDescriptor,
  Credentials,
  Logger,
} from './types.js'
import { PLUGIN_OWNED_HARNESSES, NATIVE_PLUGIN_HARNESSES, EXTERNAL_MCP_HARNESSES } from './types.js'
import { validateBundle } from './validate.js'
import { ensureAuthenticated, loadCredentials, isExpired, removeCredentials } from './auth/index.js'
import { resolveMcpUrl } from './auth/mcp-url.js'
import { installSkills, installSkillsToDirectory, SkillCopyError } from './skills/skill-copier.js'
import { linkSkillsToHarness } from './skills/skill-linker.js'
import {
  readTrackingFile,
  assertTrackingFileReadable,
  addTrackedSkills,
} from './skills/skill-tracker.js'
import {
  writeMcpConfig,
  addTrackedMcps,
  listTrackedMcps,
  ensureMcpRemoteRuntime,
  inspectMcpRemoteRuntime,
  assertNoActiveExternalMcp,
  clearDisconnectedExternalMcp,
  recordExternalMcpOwnership,
} from './mcp/index.js'
import { getAdapter } from './harnesses/index.js'
import { legacyNsolidPluginIds } from './harnesses/plugin-name.js'
import { findPiPluginSkillRoots } from './harnesses/pi-plugin-detector.js'
import { readJsonFile } from './utils/config.js'
import { getSkillsDir, getAuthFilePath } from './utils/path.js'
import { createLogger, isVerboseEnabled } from './utils/logger.js'
import { createConsoleProgress, silentProgress, type ProgressReporter } from './utils/progress.js'
import { restoreConfigBackup, type BackupEntry } from './utils/backup.js'
import { toPluginError, PluginError } from './errors.js'

function formatBundleSummary (bundle: BundleDescriptor, options: { packageOwnedSkills?: boolean }): string {
  if (options.packageOwnedSkills === true) {
    return `${bundle.mcpServers.length} MCP servers; skills owned by harness package`
  }

  return `${bundle.skills.length} skills, ${bundle.mcpServers.length} MCP servers`
}

function piPackageSkillExists (skillName: string): boolean {
  return findPiPluginSkillRoots().some((skillRoot) => existsSync(path.join(skillRoot, skillName, 'SKILL.md')))
}

async function shouldShowInitialInstallProgress (
  bundle: BundleDescriptor,
  harness: HarnessType,
  logger?: Logger
): Promise<boolean> {
  const tracking = await readTrackingFile(logger)
  if (!tracking) return true

  const trackedSkills = new Set(
    tracking.skills
      .filter((skill) => skill.harnesses.includes(harness))
      .map((skill) => skill.name)
  )
  const trackedMcps = new Set(
    tracking.mcpServers
      .filter((server) => server.harness === harness)
      .map((server) => server.name)
  )

  const hasAllSkills = bundle.skills.every((skill) => trackedSkills.has(skill.name))
  const hasAllMcps = bundle.mcpServers.every((server) => trackedMcps.has(server.name))
  return !(hasAllSkills && hasAllMcps)
}

async function resolveInstallProgress (
  options: InstallOptions,
  bundle: BundleDescriptor,
  logger?: Logger
): Promise<ProgressReporter> {
  if (options.progress) return options.progress
  if (process.env.NSOLID_PLUGIN_PROGRESS === '1') return createConsoleProgress()
  return (await shouldShowInitialInstallProgress(bundle, options.harness, logger))
    ? createConsoleProgress()
    : silentProgress
}

export function resolveAccountsUrl (defaultUrl: string, logger?: Logger): string {
  const explicit = process.env.NSOLID_ACCOUNTS_URL
  let url = defaultUrl
  if (explicit) url = explicit

  if (url === defaultUrl) return url

  // Mirror the origin-only refine() in validate.ts so a bad override fails loudly,
  // not silently (an origin with a path would drop /api/v1 via new URL('/sign-in', base)).
  let u: URL
  try { u = new URL(url) } catch { throw new Error(`Invalid NSOLID_ACCOUNTS_URL override: ${url}`) }
  if ((u.pathname !== '/' && u.pathname !== '') || u.search !== '' || u.hash !== '') {
    throw new Error(`Accounts URL override must be origin-only (no path/query/hash): ${url}`)
  }
  logger?.warn('auth.accountsUrl.overridden', { from: defaultUrl, to: url })
  return url
}

/**
 * Per-harness removal guidance for a detected legacy-plugin conflict. Names the
 * EXACT detected legacy id and only that plugin's removal. It deliberately does
 * NOT suggest a broad full `nsolid-plugin uninstall`: that would also delete
 * the wanted skills-only plugin (`nsolid-skills-plugin`) and its marketplace
 * registration. For Claude no copy-pastable command is printed because the
 * preflight cannot attribute the install scope; a wrong `--scope` removal is
 * never guessed.
 */
function legacyConflictRemovalAction (harness: HarnessType, legacyId: string): string {
  const keep = 'Keep the nsolid-skills-plugin install and its marketplace: a full nsolid-plugin uninstall would delete both.'
  const repeat = 'Then re-run setup --external-mcp. Disabling it is not sufficient: this guard checks installation, not enabled state.'
  switch (harness) {
    case 'codex':
      return `Uninstall the old plugin first — remove only the legacy id: codex plugin remove ${legacyId}. ${keep} ${repeat}`
    case 'antigravity':
      return `Uninstall the old plugin first — remove only the legacy id: agy plugin uninstall ${legacyId}. ${keep} ${repeat}`
    default:
      return `Uninstall the old plugin first — remove only the legacy plugin "${legacyId}" with Claude's plugin manager, using the --scope where it is registered (this guard cannot attribute the scope, so no copy-paste command is printed). ${keep} ${repeat}`
  }
}

/**
 * Whole-command preflight for the experimental external setup path:
 * unsupported harnesses and old-native-plugin conflicts are rejected for
 * EVERY selected harness. setup() runs the same checks per harness for API
 * callers; the CLI calls this once before its loop so a conflict on a later
 * harness cannot leave earlier harnesses configured (multi-select T14).
 *
 * The MCP conflict is the LEGACY `nsolid-plugin` distribution only, selected
 * over the complete detected id list: the skills-only plugin registers no MCP
 * servers, so a skills-only native install (before or after external setup)
 * is allowed. A mixed install still conflicts and is reported on the OLD id.
 */
export function assertExternalMcpSetupPreflight (harnesses: HarnessType[]): void {
  for (const harness of harnesses) {
    if (!EXTERNAL_MCP_HARNESSES.has(harness)) {
      throw new PluginError(
        'INVALID_OPTION',
        `--external-mcp is only supported for harnesses: ${[...EXTERNAL_MCP_HARNESSES].join(', ')} (got: ${harness})`,
        {
          harness,
          action: 'Re-run without --external-mcp, or target a supported harness.',
        }
      )
    }
    const native = getAdapter(harness).detectNativePlugin?.()
    if (native?.installed !== true) continue
    const legacyIds = legacyNsolidPluginIds(native)
    if (legacyIds.length === 0) continue
    const legacyId = legacyIds[0]
    throw new PluginError(
      'INVALID_OPTION',
      `--external-mcp conflict: the old native N|Solid plugin is installed for ${harness} (${legacyId}) and registers the same MCP servers. This experimental mode must not create duplicate registrations.`,
      {
        harness,
        action: legacyConflictRemovalAction(harness, legacyId),
      }
    )
  }
}

export async function setup (options: SetupOptions): Promise<SetupResult> {
  const logger = options.logger ?? createLogger({ verbose: isVerboseEnabled(options.verbose) })
  const progress = options.progress ?? createConsoleProgress()
  const result: SetupResult = {
    success: false,
    skillsInstalled: 0,
    mcpServersConfigured: [],
    hadToAuthenticate: false,
    authSucceeded: false,
    errors: [],
  }

  logger.info('setup.start', { harness: options.harness, bundlePath: options.bundlePath })

  // Tracked ownership evidence must be readable before any side effect
  // (OAuth, config write, runtime, ownership record): a present-but-unreadable
  // or malformed file is not a fresh install, and overwriting it would
  // silently discard external-MCP records that guard destructive commands.
  await assertTrackingFileReadable(logger)

  // Flagless setup must not silently mix with an ACTIVE external MCP
  // configuration: the guard runs before ensureAuthenticated, so no browser
  // is opened, no shared credentials are refreshed, and no runtime/config is
  // touched. `setup --external-mcp` (options.externalMcp === true) is the
  // explicit refresh path and bypasses this guard.
  if (options.externalMcp !== true) {
    await assertNoActiveExternalMcp([options.harness], 'setup', logger)
  }

  // Experimental `--external-mcp` preflight: reject unsupported harnesses and
  // old-plugin coexistence conflicts BEFORE any side effects — no OAuth round
  // trip, no config writes, no runtime changes.
  if (options.externalMcp === true) {
    assertExternalMcpSetupPreflight([options.harness])
  }

  let bundle: BundleDescriptor
  try {
    const bundleData = readJsonFile<BundleDescriptor>(options.bundlePath)
    if (!bundleData) {
      result.errors.push(`Bundle not found: ${options.bundlePath}`)
      return result
    }
    bundle = validateBundle(bundleData)
    progress.header(`NodeSource setup — ${options.harness}`)
    progress.step('Reading bundle config', formatBundleSummary(bundle, options))
  } catch (err) {
    const pluginErr = toPluginError(err, 'BUNDLE_INVALID', { path: options.bundlePath, harness: options.harness })
    result.errors.push(`Bundle validation failed: ${pluginErr.message}`)
    return result
  }

  if (bundle.auth) {
    const authConfig = { ...bundle.auth, accountsUrl: resolveAccountsUrl(bundle.auth.accountsUrl, logger) }

    let existingCredentials: Credentials | null = null
    try {
      existingCredentials = loadCredentials()
    } catch {
      // Corrupt credentials file — will re-authenticate via ensureAuthenticated
    }

    const forcing = options.force === true
    if (existingCredentials) {
      progress.step(
        'Checking NodeSource login',
        forcing ? 'switching organization' : (isExpired(existingCredentials) ? 'sign-in required' : 'already signed in')
      )
      result.hadToAuthenticate = forcing || isExpired(existingCredentials)
    } else {
      progress.step('Checking NodeSource login', 'sign-in required')
      result.hadToAuthenticate = true
    }

    try {
      await ensureAuthenticated(authConfig, logger, { harness: options.harness, confirmAuth: options.confirmAuth, force: options.force, notify: options.notify, browserLauncher: options.browserLauncher })
      // Credentials are authenticated now — the active org is set (freshly
      // stored, or already valid). This is the "org switch succeeded" signal,
      // independent of the harness install/config refresh that follows.
      result.authSucceeded = true
    } catch (err) {
      const pluginErr = toPluginError(err, 'AUTH_FAILED', { harness: options.harness })
      result.errors.push(`Authentication failed: ${pluginErr.message}`)
      return result
    }
  }

  // Experimental `--external-mcp` mode (skills-only community experiment):
  // credentials are now valid (or the bundle needs no auth). Write direct HTTP
  // MCP config through the existing install() path with packageOwnedSkills:
  // true — no skill copies/links — and skip ensureMcpRemoteRuntime entirely:
  // the shared mcp-remote runtime is never inspected, installed, repaired, or
  // deleted here; a runtime provisioned for another integration stays
  // untouched, and its absence does not block this mode. The default setup
  // flow below is unchanged.
  if (options.externalMcp === true) {
    const installResult = await install({
      ...options,
      packageOwnedSkills: true,
      progress,
    })
    result.skillsInstalled = installResult.skillsInstalled
    result.mcpServersConfigured = installResult.mcpServersConfigured
    result.errors.push(...installResult.errors)
    result.success = installResult.success
    logger.info('setup.externalMcp.finish', {
      harness: options.harness,
      success: result.success,
      mcpServers: result.mcpServersConfigured.length,
    })
    return result
  }

  // Provision the shared MCP bridge runtime (mcp-remote) for every harness:
  // harness startup must never invoke npm/npx. The first run needs network;
  // once a valid runtime exists this is an offline no-op. Credentials may
  // already be stored at this point — a runtime failure must finish with
  // success:false (they remain valid for a retry of this same command).
  try {
    const runtime = await ensureMcpRemoteRuntime()
    progress.step(
      'Preparing MCP bridge runtime',
      runtime.installed ? `installed mcp-remote ${runtime.version}` : 'already ready'
    )
    logger.info('setup.mcpRuntime.ready', {
      installed: runtime.installed,
      version: runtime.version,
      root: runtime.root,
    })
  } catch (err) {
    result.errors.push(`MCP runtime setup failed: ${(err as Error).message}`)
    logger.error('setup.mcpRuntime.failed', { message: (err as Error).message })
    return result
  }

  // For CLI-only/package-owned harnesses, setup also performs the direct
  // fallback install/MCP config so that `nsolid-plugin setup` is a one-step
  // onboarding path. Package-owned harnesses can opt out of user-level skill
  // copies via packageOwnedSkills while still receiving MCP config. The
  // runtime is already ready at this point (guard above).
  if (!PLUGIN_OWNED_HARNESSES.has(options.harness)) {
    const installResult = await install({
      ...options,
      progress,
    })
    result.skillsInstalled = installResult.skillsInstalled
    result.mcpServersConfigured = installResult.mcpServersConfigured
    result.errors.push(...installResult.errors)
    result.success = installResult.success
    if (result.success) {
      progress.done(`Setup complete — credentials and MCP bridge ready for ${options.harness}`)
    }
    return result
  }

  result.success = true
  progress.done(`Setup complete — credentials and MCP bridge ready for ${options.harness} plugin MCPs`)
  return result
}

export async function install (options: InstallOptions): Promise<InstallResult> {
  const logger = options.logger ?? createLogger({ verbose: isVerboseEnabled(options.verbose) })
  let progress: ProgressReporter = silentProgress
  const result: InstallResult = {
    success: false,
    skillsInstalled: 0,
    mcpServersConfigured: [],
    hadToAuthenticate: false,
    authSucceeded: false,
    errors: [],
  }

  logger.info('install.start', { harness: options.harness, bundlePath: options.bundlePath, skillsSource: options.skillsSource })

  // Same corrupt-tracking preflight as setup(): reject before any skill copy,
  // config write, runtime or tracking mutation.
  await assertTrackingFileReadable(logger)

  // Same mode-mixing guard as setup(): a flagless install for an ACTIVE
  // external harness must reject before any skill copy, config write, or
  // tracking mutation. The internal flagged install from setup --external-mcp
  // (options.externalMcp === true) bypasses it.
  if (options.externalMcp !== true) {
    await assertNoActiveExternalMcp([options.harness], 'install', logger)
  }

  let bundle: BundleDescriptor
  try {
    const bundleData = readJsonFile<BundleDescriptor>(options.bundlePath)
    if (!bundleData) {
      result.errors.push(`Bundle not found: ${options.bundlePath}`)
      return result
    }
    bundle = validateBundle(bundleData)
    logger.debug('install.bundle.loaded', { name: bundle.name, skills: bundle.skills.length, mcpServers: bundle.mcpServers.length })
    progress = await resolveInstallProgress(options, bundle, logger)
    progress.header(`NodeSource installer — ${options.harness}`)
    progress.step('Reading bundle config', formatBundleSummary(bundle, options))
  } catch (err) {
    const pluginErr = toPluginError(err, 'BUNDLE_INVALID', { path: options.bundlePath, harness: options.harness })
    result.errors.push(`Bundle validation failed: ${pluginErr.message}`)
    return result
  }

  const adapter = getAdapter(options.harness)

  let credentials: Credentials | null = null
  if (bundle.auth) {
    try {
      credentials = loadCredentials()
    } catch {
      logger.warn('install.credentials.corrupt')
    }

    if (!credentials || isExpired(credentials)) {
      result.hadToAuthenticate = true
      progress.step('Checking NodeSource login', 'not signed in')
      progress.warn('Authentication required for MCP servers', `Run: nsolid-plugin setup --harness ${options.harness}`)
      // Install never opens a browser. Skills are still installed; MCP servers
      // are configured only after the user runs `nsolid-plugin setup`.
    } else {
      progress.step('Checking NodeSource login', 'already signed in')
    }
  }

  const canConfigureMcp = !bundle.auth || (!!credentials && !isExpired(credentials))

  let linkedSkills: typeof bundle.skills = []
  let trackedSkillsDir: string | undefined
  if (options.packageOwnedSkills === true) {
    logger.info('install.skills.packageOwned', { harness: options.harness, count: bundle.skills.length })
  } else if (options.harnessSpecificSkills === true) {
    const harnessSkillsPath = adapter.getSkillsPath()
    try {
      await installSkillsToDirectory(bundle.skills, options.skillsSource, harnessSkillsPath, logger)
      result.skillsInstalled = bundle.skills.length
      linkedSkills = bundle.skills
      trackedSkillsDir = harnessSkillsPath
      progress.step('Copying skills', `${result.skillsInstalled} → ${harnessSkillsPath}`)
      logger.info('install.skills.harnessSpecific.done', { harness: options.harness, count: result.skillsInstalled, path: harnessSkillsPath })
    } catch (err) {
      if (err instanceof SkillCopyError) {
        result.errors.push(err.message)
      } else {
        result.errors.push(`Skill installation failed: ${(err as Error).message}`)
      }
      return result
    }
  } else {
    try {
      await installSkills(bundle.skills, options.skillsSource, logger)
      result.skillsInstalled = bundle.skills.length
      progress.step('Copying skills', `${result.skillsInstalled} → ~/.agents/skills/`)
      logger.info('install.skills.done', { count: result.skillsInstalled })
    } catch (err) {
      if (err instanceof SkillCopyError) {
        result.errors.push(err.message)
      } else {
        result.errors.push(`Skill installation failed: ${(err as Error).message}`)
      }
      return result
    }

    try {
      const linkResults = await linkSkillsToHarness(options.harness, bundle.skills, logger)
      const linkedNames = new Set(linkResults.map((r) => r.skill))
      linkedSkills = bundle.skills.filter((s) => s.name && linkedNames.has(s.name))
      progress.step('Linking skills', `into ${adapter.getSkillsPath()}`)
      logger.info('install.skills.linked', { harness: options.harness, linked: linkedSkills.length })
    } catch (err) {
      const pluginErr = toPluginError(err, 'SKILL_LINK_FAILED', { harness: options.harness })
      result.errors.push(`Skill linking failed: ${pluginErr.message}`)
    }
  }

  const variables: Record<string, string> = {}
  if (credentials && canConfigureMcp) {
    variables.AUTH_TOKEN = credentials.serviceToken
    variables.AUTH_ORG_ID = credentials.organizationId
    const mcpUrl = resolveMcpUrl(credentials)
    if (!mcpUrl) {
      result.errors.push('Could not derive MCP URL from console URL pattern')
      return result
    }
    variables.MCP_URL = mcpUrl
    logger.debug('install.variables.derived', { orgId: credentials.organizationId })
  }

  const mcpConfigPath = adapter.getMcpConfigPath()

  if (adapter.supportsMcp() && bundle.mcpServers.length > 0 && canConfigureMcp) {
    try {
      await writeMcpConfig(options.harness, bundle.mcpServers, variables, {
        configPath: mcpConfigPath ?? undefined,
        logger,
      })
      result.mcpServersConfigured = bundle.mcpServers.map((s) => s.name)
      const targetConfigPath = mcpConfigPath ?? adapter.getMcpConfigPath() ?? 'MCP config'
      progress.step('Merging MCP servers', `${result.mcpServersConfigured.join(', ')} into ${targetConfigPath}\n(backup saved)`)
      logger.info('install.mcp.done', { harness: options.harness, servers: result.mcpServersConfigured })
    } catch (err) {
      const pluginErr = toPluginError(err, 'MCP_CONFIG_WRITE_FAILED', { harness: options.harness, path: mcpConfigPath ?? undefined })
      result.errors.push(`MCP configuration failed: ${pluginErr.message}`)
    }
  } else if (adapter.supportsMcp() && bundle.mcpServers.length > 0 && !canConfigureMcp) {
    progress.step('MCP servers', `skipped — run nsolid-plugin setup --harness ${options.harness} first`)
  } else if (bundle.mcpServers.length > 0) {
    result.errors.push(
      `Bundle defines ${bundle.mcpServers.length} MCP server(s) but harness "${options.harness}" does not support MCP — they were not installed`
    )
  }

  try {
    if (linkedSkills.length > 0) {
      await addTrackedSkills(linkedSkills, options.harness, logger, trackedSkillsDir)
    }

    if (mcpConfigPath && result.mcpServersConfigured.length > 0) {
      const mcpEntries = bundle.mcpServers.map((s) => ({ name: s.name, configPath: mcpConfigPath }))
      await addTrackedMcps(mcpEntries, options.harness, logger)
      if (options.externalMcp === true) {
        // Ownership evidence is mandatory in external mode: without it a
        // later disconnect cannot tell the entry apart from a user copy, and
        // a failure here must not report a safely managed install.
        await recordExternalMcpOwnership(options.harness, mcpEntries, logger)
      } else {
        // A successful flagless (legacy) install re-created these entries and
        // supersedes a disconnected external-MCP tombstone for this harness:
        // keeping it would refuse the next uninstall with "present again"
        // and leave no CLI path out. Active records never reach this point
        // (the flagless guard above already rejected them).
        await clearDisconnectedExternalMcp(options.harness, logger)
      }
    }
  } catch (err) {
    const pluginErr = toPluginError(err, 'TRACKING_UPDATE_FAILED', { harness: options.harness })
    result.errors.push(`Tracking update failed: ${pluginErr.message}`)
  }

  result.success = result.errors.length === 0
  if (result.success) {
    if (options.packageOwnedSkills === true) {
      const mcpCount = result.mcpServersConfigured.length
      progress.done(`Done — package-owned skills skipped; ${mcpCount} MCP server${mcpCount === 1 ? '' : 's'} configured for ${options.harness}`)
    } else {
      progress.done(`Done — ${result.skillsInstalled} skills installed for ${options.harness}`)
    }
  } else {
    progress.warn('Completed with errors', `${result.errors.length} issue(s)`)
  }
  logger.info('install.finish', { success: result.success, errors: result.errors.length })
  return result
}

/**
 * Dispatcher-level onboarding: satisfies the MCP bridge runtime precondition
 * (credentials-free) immediately before delegating to `install()`, so paths
 * that route OpenCode/Pi and fallback installs through `install()` cannot
 * bypass runtime provisioning. `install()` itself stays offline and
 * auth-free — the precondition remains the dispatchers' responsibility.
 */
export async function installWithRuntime (options: InstallOptions): Promise<InstallResult> {
  const logger = options.logger ?? createLogger({ verbose: isVerboseEnabled(options.verbose) })
  // Reject a corrupt tracking file before the runtime precondition can
  // create/download anything.
  await assertTrackingFileReadable(logger)
  // Reject before the runtime precondition can create/download anything: a
  // flagless dispatcher run must not mix with an ACTIVE external harness.
  if (options.externalMcp !== true) {
    await assertNoActiveExternalMcp([options.harness], 'install', logger)
  }
  try {
    await ensureMcpRemoteRuntime()
  } catch (err) {
    logger.error('install.runtimePrecondition.failed', { harness: options.harness, message: (err as Error).message })
    return {
      success: false,
      skillsInstalled: 0,
      mcpServersConfigured: [],
      hadToAuthenticate: false,
      authSucceeded: false,
      errors: [`MCP runtime setup failed: ${(err as Error).message}`],
    }
  }
  return await install(options)
}

export interface LogoutResult {
  removed: boolean
  path: string
}

/**
 * Forget the stored NodeSource login. Idempotent: returns removed=false if no
 * credentials were present. Does NOT uninstall skills or MCP config — that is
 * `uninstall()`'s job. Use `logout` when you want to clear auth only.
 */
export async function logout (): Promise<LogoutResult> {
  const path = getAuthFilePath()
  const removed = removeCredentials()
  return { removed, path }
}

export type { UninstallOptions, UninstallResult, UninstallStageResult, UninstallStageName, UninstallStageStatus, UninstallBatchResult } from './uninstall.js'

export async function restore (
  harness: HarnessType,
  options?: { backupPath?: string; verbose?: boolean; logger?: Logger }
): Promise<BackupEntry> {
  const logger = options?.logger ?? createLogger({ verbose: isVerboseEnabled(options?.verbose) })
  // Reject a corrupt tracking file before the backup restore writes anything.
  await assertTrackingFileReadable(logger)
  // Restoring a whole-file backup while an ACTIVE external record exists can
  // resurrect stale direct entries and desynchronize mode/config state, so it
  // is rejected before the file write. `restore --list` stays read-only and
  // does not reach this function.
  await assertNoActiveExternalMcp([harness], 'restore', logger)
  logger.info('restore.start', { harness, backupPath: options?.backupPath })
  const entry = restoreConfigBackup(harness, options?.backupPath)
  logger.info('restore.done', { harness, originalPath: (await entry).originalPath })
  return entry
}

function unverifiedExternalMcpReport (
  configured: string[],
  configError?: string
): NonNullable<DoctorReport['externalMcp']> {
  return {
    status: 'unverified',
    reason: 'External MCP mode: direct HTTP config is present, but doctor does not probe endpoint reachability or authentication and does not verify external package skills.',
    configured,
    checks: {
      authentication: 'unverified',
      skills: 'unverified',
      remoteReachability: 'unverified',
    },
    ...(configError !== undefined ? { configError } : {}),
  }
}

export async function doctor (
  harness: HarnessType,
  bundlePath: string,
  options?: { verbose?: boolean; logger?: Logger }
): Promise<DoctorReport> {
  const logger = options?.logger ?? createLogger({ verbose: isVerboseEnabled(options?.verbose) })
  const report: DoctorReport = {
    healthy: true,
    credentials: { status: 'missing' },
    plugin: { status: 'n/a', installed: false },
    skills: { status: 'ok', installed: [], missing: [] },
    mcpServers: { status: 'ok', reachable: [], unreachable: [] },
    errors: [],
  }

  logger.info('doctor.start', { harness, bundlePath })

  let bundle: BundleDescriptor | null = null
  try {
    const bundleData = readJsonFile<BundleDescriptor>(bundlePath)
    if (bundleData) {
      bundle = validateBundle(bundleData)
    } else {
      report.errors.push(`Bundle not found: ${bundlePath}`)
    }
  } catch {
    report.errors.push(`Failed to load bundle: ${bundlePath}`)
  }

  try {
    const creds = loadCredentials()
    if (creds) {
      if (isExpired(creds)) {
        report.credentials = { status: 'expired', message: 'Credentials have expired', organizationId: creds.organizationId }
      } else {
        report.credentials = { status: 'ok', organizationId: creds.organizationId }
      }
    }
  } catch {
    report.credentials = { status: 'missing' }
  }

  const adapter = getAdapter(harness)

  // External-MCP ownership is additive per-harness state in the shared
  // tracking file. An ACTIVE record means the direct HTTP config is owned by
  // the experimental mode, and doctor can only report that install as
  // unverified: local config presence is not reachability or authentication,
  // and skills are provided by the external package rather than tracked here.
  const tracking = await readTrackingFile(logger)
  const externalActive = tracking?.externalMcp?.[harness]?.state === 'active'

  // For plugin/package-owned harnesses the recommended install path is the
  // harness's native mechanism, not the CLI tracking file. Probe it here; when
  // present, skills and MCP servers are owned by the plugin and reported as ok.
  const isNativeHarness = NATIVE_PLUGIN_HARNESSES.has(harness)
  let nativeOwned = false
  // Only the LEGACY plugin registers MCP servers; the skills-only plugin owns
  // skills alone, so it must not imply bridge/MCP ownership (identity-role
  // regression: the broad uninstall identity must not leak into doctor).
  let nativeLegacyOwned = false
  if (isNativeHarness && adapter.detectNativePlugin) {
    const detected = adapter.detectNativePlugin()
    if (detected.installed) {
      nativeOwned = detected.enabled !== false
      nativeLegacyOwned = nativeOwned && legacyNsolidPluginIds(detected).length > 0
      report.plugin = {
        status: 'ok',
        installed: true,
        enabled: detected.enabled,
        label: detected.label,
      }
    } else {
      report.plugin = { status: 'missing', installed: false }
    }
  }

  // Shared MCP bridge (mcp-remote) runtime. Required only when this
  // harness's MCP servers are actually served through the generated wrapper
  // (native plugin installed for claude/codex/antigravity). For native-HTTP
  // transports (opencode, pi, and direct/fallback installs) the line is
  // informational: a ready proxy says nothing about remote endpoint health,
  // and a missing one does not break those configurations.
  const bridge = inspectMcpRemoteRuntime()
  const bridgeRequired = nativeLegacyOwned && PLUGIN_OWNED_HARNESSES.has(harness)
  report.bridge = {
    status: bridge.status,
    version: bridge.version,
    root: bridge.root,
    ...(bridge.proxyPath !== undefined ? { proxyPath: bridge.proxyPath } : {}),
    ...(bridge.reason !== undefined ? { reason: bridge.reason } : {}),
    required: bridgeRequired,
  }
  if (bridgeRequired && bridge.status !== 'ready') {
    report.errors.push(
      `MCP bridge runtime is ${bridge.status}${bridge.reason ? ` (${bridge.reason})` : ''}. Run: nsolid-plugin setup --harness ${harness}`
    )
  }

  if (!bundle) {
    report.skills.status = 'unknown'
    report.mcpServers.status = 'unknown'
    if (externalActive) {
      report.externalMcp = unverifiedExternalMcpReport([])
    }
  } else if (externalActive) {
    // Never populate `reachable` from config presence: these entries are
    // configured locally, not connection-tested. Structural config errors are
    // reported separately through `configError` + `errors` so they stay
    // distinguishable from the merely-unverified state.
    let configured: string[] = []
    let configError: string | undefined
    if (adapter.supportsMcp()) {
      try {
        const onDiskConfig = await adapter.readMcpConfig()
        const onDiskNames = new Set(Object.keys(onDiskConfig.mcpServers))
        configured = bundle.mcpServers.map((s) => s.name).filter((name) => onDiskNames.has(name))
      } catch (err) {
        configError = (err as Error).message
      }
    }
    report.skills.status = 'unverified'
    report.mcpServers.status = 'unverified'
    report.externalMcp = unverifiedExternalMcpReport(configured, configError)
    if (configError) {
      report.errors.push(`MCP config could not be read for ${harness}: ${configError}`)
    }
  } else if (nativeOwned) {
    // The native plugin owns skills; the LEGACY plugin also owns the MCP
    // config and bridge. The skills-only plugin provides no MCP servers, so
    // MCP ownership must not be claimed on its behalf.
    report.skills.installed = bundle.skills.map((s) => s.name)
    report.skills.missing = []
    report.skills.status = 'ok'
    if (adapter.supportsMcp() && nativeLegacyOwned) {
      report.mcpServers.reachable = bundle.mcpServers.map((s) => s.name)
      report.mcpServers.unreachable = []
      report.mcpServers.status = 'ok'
    } else if (adapter.supportsMcp() && !nativeLegacyOwned && bundle.mcpServers.length > 0) {
      // Skills-only native plugin: it registers no MCP servers itself, so the
      // harness's direct MCP config decides whether the bundle servers are
      // actually configured. Never keep the success default for a dimension
      // that was not inspected.
      let onDiskNames: Set<string> | null = null
      try {
        const onDiskConfig = await adapter.readMcpConfig()
        onDiskNames = new Set(Object.keys(onDiskConfig.mcpServers))
      } catch (err) {
        const configError = (err as Error).message
        report.mcpServers.status = 'unreachable'
        report.errors.push(`MCP config could not be read for ${harness}: ${configError}`)
      }
      if (onDiskNames !== null) {
        const configured = bundle.mcpServers.map((s) => s.name).filter((name) => onDiskNames.has(name))
        report.mcpServers.reachable = configured
        report.mcpServers.unreachable = bundle.mcpServers.map((s) => s.name).filter((name) => !onDiskNames.has(name))
        if (configured.length === 0) {
          // With ZERO bundle servers configured the remedy is actionable, not
          // merely unverified. The command must be valid for the harness: the
          // external-mcp mode exists only for EXTERNAL_MCP_HARNESSES, so any
          // other harness is pointed at the flagless setup flow instead.
          report.mcpServers.status = 'unreachable'
          const remedy = EXTERNAL_MCP_HARNESSES.has(harness)
            ? `nsolid-plugin setup --harness ${harness} --external-mcp`
            : `nsolid-plugin setup --harness ${harness}`
          report.errors.push(`No bundle MCP servers are configured for ${harness}. Run: ${remedy}`)
        } else {
          // Mirror the externalActive branch: config presence is not a
          // connection test, so configured entries stay unverified.
          report.mcpServers.status = 'unverified'
        }
      }
    }
  } else {
    const expectedMcps = bundle.mcpServers.map((s) => s.name)

    const trackedSkills = tracking
    const trackedSkillEntries = trackedSkills?.skills.filter((s) => s.harnesses.includes(harness)) ?? []
    const trackedByName = new Map(trackedSkillEntries.map((s) => [s.name, s]))
    const skillsDirForHarness = harness === 'opencode' ? adapter.getSkillsPath() : getSkillsDir()

    for (const skill of bundle.skills) {
      const tracked = trackedByName.get(skill.name)
      const inTracking = tracked !== undefined
      const diskPath = tracked?.paths?.[harness] ?? tracked?.path ?? path.join(skillsDirForHarness, skill.name)
      const onDisk = existsSync(diskPath)
      const inPiPackage = harness === 'pi' && piPackageSkillExists(skill.name)
      if (inTracking || onDisk || inPiPackage) {
        report.skills.installed.push(skill.name)
        if (!inPiPackage && inTracking && !onDisk) {
          report.errors.push(`Skill "${skill.name}" tracked but not on disk — tracking may be stale`)
        } else if (!inPiPackage && onDisk && !inTracking) {
          report.errors.push(`Skill "${skill.name}" on disk but not tracked — tracking may be stale`)
        }
      } else {
        report.skills.missing.push(skill.name)
      }
    }

    if (report.skills.missing.length > 0) {
      report.skills.status = report.skills.installed.length > 0 ? 'partial' : 'missing'
    }

    if (adapter.supportsMcp()) {
      const trackedMcps = await listTrackedMcps(harness, logger)
      const trackedMcpNames = new Set(trackedMcps.map((m) => m.name))
      let onDiskMcpNames: Set<string> = new Set()
      try {
        const onDiskConfig = await adapter.readMcpConfig()
        onDiskMcpNames = new Set(Object.keys(onDiskConfig.mcpServers))
      } catch {
        // Config file doesn't exist or is unreadable
      }

      for (const name of expectedMcps) {
        const inTracking = trackedMcpNames.has(name)
        const onDisk = onDiskMcpNames.has(name)
        if (inTracking || onDisk) {
          report.mcpServers.reachable.push(name)
          if (inTracking && !onDisk) {
            report.errors.push(`MCP "${name}" tracked but not in config — tracking may be stale`)
          } else if (onDisk && !inTracking) {
            report.errors.push(`MCP "${name}" in config but not tracked — tracking may be stale`)
          }
        } else {
          report.mcpServers.unreachable.push(name)
        }
      }

      if (report.mcpServers.unreachable.length > 0) {
        report.mcpServers.status =
          report.mcpServers.reachable.length > 0 ? 'partial' : 'unreachable'
      }
    } else {
      report.mcpServers.status = 'ok'
    }
  }

  // The Plugin line is informational — it reflects whether the *native*
  // plugin/package is installed. Health is driven by whether skills, MCP
  // servers, and credentials are actually satisfied, regardless of which path
  // (native plugin or direct CLI install) provided them. So a direct (fallback)
  // install on a plugin-owned harness can still be healthy without the native
  // plugin present.
  report.healthy =
    report.credentials.status === 'ok' &&
    report.skills.status === 'ok' &&
    report.mcpServers.status === 'ok' &&
    (report.bridge?.required !== true || report.bridge.status === 'ready') &&
    report.errors.length === 0

  // D1: an ACTIVE external MCP install can never be certified healthy without
  // live verification — local config presence says nothing about the endpoint
  // or the stored token. The report renders the scope as unverified (not
  // broken/missing) and the CLI still exits nonzero.
  if (externalActive) report.healthy = false

  logger.info('doctor.finish', { healthy: report.healthy })
  return report
}

export type { HarnessType, InstallOptions, InstallResult, SetupOptions, SetupResult, DoctorReport, BundleDescriptor, Credentials, BrowserLauncher } from './types.js'
export type { LinkResult, LinkStatus } from './skills/skill-linker.js'
export type { SkillTrackingEntry, McpTrackingEntry, TrackingData, ExternalMcpConnectionState, ExternalMcpEntryRecord, ExternalMcpHarnessRecord, PendingMarketplaceRemoval } from './skills/skill-tracker.js'
export type { BackupEntry } from './utils/backup.js'
export { disconnectExternalMcp, assertNoActiveExternalMcp } from './mcp/index.js'
export type { DisconnectExternalMcpResult, DisconnectExternalMcpOptions } from './mcp/index.js'
export { uninstall, uninstallHarnesses, preflightUninstall } from './uninstall.js'
