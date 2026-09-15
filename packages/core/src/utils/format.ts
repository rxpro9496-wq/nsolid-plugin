import type { DoctorReport, HarnessType } from '../types.js'
import { NATIVE_PLUGIN_HARNESSES } from '../types.js'

export const C = {
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
}

/** Native install command shown when the plugin is missing for a harness. */
function nativeInstallHint (harness: HarnessType): string {
  switch (harness) {
    case 'claude':
      return 'claude plugin marketplace add NodeSource/nsolid-plugin && claude plugin install nsolid-plugin@nodesource'
    case 'codex':
      return 'codex plugin marketplace add NodeSource/nsolid-plugin && codex plugin add nsolid-plugin@nodesource'
    case 'antigravity':
      return 'agy plugin install https://github.com/NodeSource/nsolid-plugin.git'
    case 'pi':
      return 'pi install npm:nsolid-pi-plugin'
    default:
      return ''
  }
}

export function supportsColor (stream: { isTTY?: boolean } = process.stdout): boolean {
  if (process.env.NO_COLOR !== undefined) return false
  if (process.env.FORCE_COLOR === '0') return false
  if (process.env.FORCE_COLOR !== undefined) return true
  return stream.isTTY === true
}

function credLine (creds: DoctorReport['credentials'], color: boolean): string {
  // No hint on the 'ok' branch — telling a user to authenticate when creds are
  // valid is misleading. Hints only attach to missing/expired (actionable) states.
  const orgSuffix = creds.organizationId ? ` (org: ${creds.organizationId})` : ''
  if (creds.status === 'ok') return line('Credentials', `✓ ok${orgSuffix}`, C.green, '', color)
  if (creds.status === 'expired') return line('Credentials', `✗ expired${orgSuffix}`, C.red, 'Re-run installation to re-authenticate', color)
  return line('Credentials', '✗ missing', C.red, 'Run installation to authenticate', color)
}

function pluginLine (p: DoctorReport['plugin'], harness: HarnessType, color: boolean): string | null {
  // Non-native harnesses (e.g. opencode) have no plugin model — no line shown.
  if (!NATIVE_PLUGIN_HARNESSES.has(harness)) return null
  if (p.status === 'ok') {
    const label = p.label ? ` (${p.label})` : ''
    if (p.enabled === false) {
      return line('Plugin', `⚠ disabled${label}`, C.yellow, 'Enable the plugin in your harness', color)
    }
    return line('Plugin', `✓ installed${label}`, C.green, '', color)
  }
  return line('Plugin', '✗ not installed', C.red, nativeInstallHint(harness), color)
}

function skillsLine (s: DoctorReport['skills'], color: boolean): string {
  if (s.status === 'ok') return line('Skills', `✓ ok (${s.installed.length} installed)`, C.green, '', color)
  if (s.status === 'partial') return line('Skills', `⚠ partial (${s.installed.length} installed, ${s.missing.length} missing)`, C.yellow, 'Re-run installation to restore skills', color)
  if (s.status === 'missing') return line('Skills', `✗ missing (${s.missing.length} missing)`, C.red, 'Re-run installation to restore skills', color)
  if (s.status === 'unverified') return line('Skills', '? unverified', C.dim, 'external MCP mode: not checked here', color)
  return line('Skills', '? unknown', C.dim, '', color)
}

function mcpLine (m: DoctorReport['mcpServers'], color: boolean, configured: string[] = []): string {
  if (m.status === 'ok') return line('MCP servers', `✓ ok (${m.reachable.length} reachable)`, C.green, '', color)
  if (m.status === 'partial') return line('MCP servers', `⚠ partial (${m.reachable.length} reachable, ${m.unreachable.length} unreachable)`, C.yellow, 'Check network connectivity or MCP server status', color)
  if (m.status === 'unreachable') return line('MCP servers', `✗ unreachable (${m.unreachable.length} unreachable)`, C.red, 'Check network connectivity or MCP server status', color)
  if (m.status === 'unverified') {
    // Inspected names stay "configured, not probed" — never a health or
    // connectivity claim. "(none found)" is only honest when the mode's
    // inspected list is genuinely empty.
    const detail = configured.length > 0 ? `configured, not probed (${configured.join(', ')})` : 'configured, not probed (none found)'
    // Skills-only/native inspection can also find bundle servers that are NOT
    // in the harness config; name them so the text agrees with the JSON
    // without mixing configured and unconfigured servers into one list.
    // External mode never populates `unreachable`, so this cannot fire there.
    const notConfigured = m.unreachable.length > 0 ? `; not configured: ${m.unreachable.join(', ')}` : ''
    return line('MCP servers', `? ${detail}${notConfigured}`, C.dim, '', color)
  }
  return line('MCP servers', '? unknown', C.dim, '', color)
}

function externalMcpLine (e: NonNullable<DoctorReport['externalMcp']>, color: boolean): string {
  const detail = e.configError
    ? `config error: ${e.configError}`
    : 'direct config found; reachability and authentication were not probed'
  return line('External MCP', '? unverified', C.dim, detail, color)
}

function bridgeLine (b: NonNullable<DoctorReport['bridge']>, harness: string, color: boolean): string {
  if (b.status === 'ready') return line('MCP bridge', `✓ ready (mcp-remote ${b.version})`, C.green, '', color)
  const label = b.status === 'missing' ? 'not provisioned' : `invalid${b.reason ? ` (${b.reason})` : ''}`
  if (b.required) {
    return line('MCP bridge', `✗ ${label}`, C.red, `Run: nsolid-plugin setup --harness ${harness}`, color)
  }
  // Informational for harnesses/configs whose MCP transport is native HTTP:
  // a missing bridge does not break them, so never paint them red.
  return line('MCP bridge', `? ${label}`, C.dim, 'not used by this harness configuration', color)
}

function line (label: string, value: string, pick: (s: string) => string, fix: string, color: boolean): string {
  const v = color ? pick(value) : value
  const tail = fix ? `  ${color ? C.dim('— ' + fix) : '— ' + fix}` : ''
  return `${label.padEnd(13)} ${v}${tail}`
}

export function formatDoctorReport (report: DoctorReport, harness: HarnessType, color: boolean): string {
  const out: string[] = []
  const title = color ? C.dim(`NodeSource plugin health — ${harness}`) : `NodeSource plugin health — ${harness}`
  out.push(title, '─'.repeat(34))
  out.push(credLine(report.credentials, color))
  const plugin = pluginLine(report.plugin, harness, color)
  if (plugin) out.push(plugin)
  out.push(skillsLine(report.skills, color))
  // The 'unverified' MCP line must name the servers doctor actually inspected,
  // and the authoritative source differs by inspection mode: external-active
  // mode records them in externalMcp.configured (mcpServers.reachable is
  // deliberately empty there — config presence was never probed), while
  // skills-only/native inspection records the names found in the harness
  // config in mcpServers.reachable. Feeding the external list into a
  // skills-only report made the text claim "(none found)" while the JSON
  // listed the inspected servers.
  const inspected = report.externalMcp === undefined && report.mcpServers.status === 'unverified'
    ? report.mcpServers.reachable
    : (report.externalMcp?.configured ?? [])
  out.push(mcpLine(report.mcpServers, color, inspected))
  if (report.externalMcp) out.push(externalMcpLine(report.externalMcp, color))
  if (report.bridge) out.push(bridgeLine(report.bridge, harness, color))

  if (harness === 'pi' && report.mcpServers.status !== 'unknown' && report.mcpServers.reachable.length > 0) {
    const note = 'ℹ Pi needs an MCP adapter extension to use these servers — run: pi install npm:pi-mcp-adapter'
    out.push(color ? C.yellow('  ' + note) : '  ' + note)
  }

  for (const e of report.errors) out.push((color ? C.yellow('  • ' + e) : '  • ' + e))
  out.push('')
  if (report.healthy) out.push(color ? C.green('✓ All checks passed') : '✓ All checks passed')
  else if (report.externalMcp && report.errors.length === 0) {
    const note = '? Verification incomplete — external MCP config is present but not connection-tested'
    out.push(color ? C.yellow(note) : note)
  } else out.push(color ? C.red('✗ Problems found') : '✗ Problems found')
  return out.join('\n')
}

export interface SwitchOrgGuidanceInput {
  /** Raw harness id, e.g. "claude" — used to build the `--harness` value in printed commands. */
  harness: string;
  /** Display label for the harness, e.g. "Claude Code". */
  harnessLabel: string;
  /** True for claude/codex/antigravity — harnesses with a native plugin model. */
  isPluginOwned: boolean;
  /** Result of adapter.detectNativePlugin()?.installed for this harness. */
  nativeInstalled: boolean;
  /**
   * True when this harness has an on-disk MCP config written by the fallback
   * direct installer (nsolid-plugin install --harness <harness>), tracked via
   * listTrackedMcps(harness). Independent of nativeInstalled: a machine can
   * have BOTH a native plugin install and a leftover/parallel fallback
   * install at once, and Claude Code (or another harness) may route real
   * tool calls through whichever one is actually connected — so both must be
   * checked and reported on independently, not as an either/or.
   */
  fallbackTracked: boolean;
  /**
   * True when the switch ran in the experimental `--external-mcp` mode: the
   * selected harness's direct HTTP config was (or should have been) refreshed
   * on disk, so guidance is reconnect-only — never a recommendation of the
   * old native plugin or an unnecessary skill installation — plus a reminder
   * that other --external-mcp harnesses keep the previous org until each is
   * refreshed explicitly with the flag.
   */
  externalMcp?: boolean;
}

/**
 * Follow-up guidance printed after `switch-org` completes. Native-plugin
 * installs read credentials live on reconnect, so they only need a
 * reconnect/restart reminder. Fallback direct installs bake a resolved
 * token into the harness's on-disk MCP config at `install()` time, so they
 * stay stale until `install --harness <harness>` re-runs — regardless of
 * whether a native plugin is ALSO installed for the same harness.
 */
export function formatSwitchOrgGuidance (input: SwitchOrgGuidanceInput, color: boolean): string[] {
  const { harness, harnessLabel, isPluginOwned, nativeInstalled, fallbackTracked, externalMcp } = input
  const dim = (s: string) => color ? C.dim(s) : s
  const yellow = (s: string) => color ? C.yellow(s) : s
  const lines: string[] = []

  // Experimental --external-mcp mode: the selected harness holds a direct
  // HTTP config on disk. Reconnect guidance only — never point at the old
  // plugin or a skill installation, and remind the user that other
  // --external-mcp harnesses keep the previous org until refreshed.
  if (externalMcp === true) {
    lines.push(`  ${dim('Reconnect:')} restart/reconnect ${harnessLabel} so it reloads the refreshed direct MCP config from disk.`)
    lines.push(`  ${yellow('⚠ Other harnesses configured with --external-mcp keep the previous org baked into their MCP config.')}`)
    lines.push(`  ${yellow('  Refresh each explicitly: nsolid-plugin setup --harness <harness> --external-mcp')}`)
    return lines
  }

  if (!isPluginOwned) {
    lines.push(`  ${dim('Reconnect:')} restart/reconnect ${harnessLabel} so it reloads the refreshed MCP config from disk.`)
    return lines
  }

  if (nativeInstalled) {
    lines.push(`  ${dim('Reconnect:')} restart/reconnect your ${harnessLabel} MCP session to pick up the new org.`)
  }

  if (fallbackTracked) {
    lines.push(`  ${yellow(`⚠ ${harnessLabel} also has a fallback direct install with a stale token baked in.`)}`)
    lines.push(`  ${yellow('  Run: nsolid-plugin install --harness ' + harness)} to refresh it with the new org's token, then reconnect it too.`)
  }

  if (!nativeInstalled && !fallbackTracked) {
    lines.push(`  ${dim('Reconnect:')} restart/reconnect ${harnessLabel} so it can pick up the refreshed credentials.`)
  }

  return lines
}

export interface SwitchOrgOutcomeInput {
  /** result.success — false when any step failed. */
  success: boolean
  /**
   * result.authSucceeded — the org-switch signal. When false, the switch did
   * not happen (OAuth failed, or the bundle has no `auth` so no OAuth ran),
   * regardless of `success`; the outcome is always `auth-failed`.
   */
  authSucceeded: boolean
  /** result.errors — non-empty when a step failed. */
  errors: string[]
  /** Org id signed in BEFORE the switch (undefined when none). */
  previousOrg?: string | null
  /** Org id signed in AFTER the switch (undefined when unknown). */
  currentOrg?: string | null
  harness: string
  harnessLabel: string
  isPluginOwned: boolean
  /**
   * True when the switch ran in the experimental `--external-mcp` mode. The
   * selected harness's direct HTTP config refresh must then be retried with
   * `setup --external-mcp` (the public `install` command has no such flag),
   * and success guidance describes a direct-config harness, not the old
   * native plugin.
   */
  externalMcp?: boolean
}

export type SwitchOrgOutcomeKind = 'auth-failed' | 'partial' | 'success'

/**
 * Structured result of the `switch-org` orchestration, so the CLI handler and
 * its exit-code/output semantics are unit-testable without spawning a browser
 * or the CLI process. Deliberately separates an auth failure (the switch did
 * not happen — OAuth failed or no OAuth ran) from a partial success (the org
 * DID switch, but the selected harness's direct config refresh failed
 * afterward — credentials are live and MUST NOT be rolled back).
 */
export interface SwitchOrgOutcome {
  kind: SwitchOrgOutcomeKind
  /** 1 for both auth-failure and partial (incomplete refresh); 0 only on full success. */
  exitCode: 0 | 1
  currentOrg: string
  orgChanged: boolean
  /** "Now signed in to org: X" / "Still signed in to org: X" (colorized green by caller). */
  stateLine: string
  /** Red header shown only when auth itself failed. */
  errorHeader: string | null
  /** Yellow warning shown only on partial success (config refresh incomplete). */
  warning: string | null
  /** Plain error detail lines (from result.errors). */
  detail: string[]
  /** Dim retry commands to print verbatim. */
  commands: string[]
}

export function buildSwitchOrgOutcome (input: SwitchOrgOutcomeInput): SwitchOrgOutcome {
  const { success, authSucceeded, errors, previousOrg, currentOrg, harness, harnessLabel, isPluginOwned, externalMcp } = input
  const org = currentOrg ?? '(unknown)'
  const orgChanged = currentOrg !== previousOrg
  const stateLine = `${orgChanged ? '✓ Now signed in to org' : '✓ Still signed in to org'}: ${org}`

  if (!authSucceeded) {
    // Auth did not happen — the org was not switched. This covers both an
    // OAuth failure AND a bundle without `auth` (where setup() succeeds with
    // no OAuth round-trip, leaving authSucceeded false): for switch-org,
    // authSucceeded is the switch signal, so its absence is always a failure,
    // never a success.
    return {
      kind: 'auth-failed',
      exitCode: 1,
      currentOrg: org,
      orgChanged,
      stateLine,
      errorHeader: `✗ Switch organization failed for ${harness}:`,
      warning: null,
      detail: errors.map((e) => `  - ${e}`),
      commands: [],
    }
  }

  if (!success) {
    // Org switched (credentials live on disk) but the harness's direct MCP
    // config could not be refreshed. Partial success: report it accurately,
    // show the active org + retry command, and still exit nonzero.
    // In experimental --external-mcp mode the retry must also carry the flag:
    // `install` does not accept it, and an unflagged setup would provision
    // the bridge runtime instead of rewriting the direct HTTP config.
    const commands = externalMcp === true
      ? [`nsolid-plugin setup --harness ${harness} --external-mcp`]
      : [`nsolid-plugin install --harness ${harness}`]
    if (!isPluginOwned && externalMcp !== true) commands.push(`(or re-run: nsolid-plugin setup --harness ${harness})`)
    return {
      kind: 'partial',
      exitCode: 1,
      currentOrg: org,
      orgChanged,
      stateLine,
      errorHeader: null,
      warning: `! Organization switched to ${org}, but ${harnessLabel} MCP config could not be fully refreshed.`,
      detail: errors.map((e) => `  - ${e}`),
      commands,
    }
  }

  // Full success. Caller still appends formatSwitchOrgGuidance / the
  // "other direct-config harnesses" note.
  return {
    kind: 'success',
    exitCode: 0,
    currentOrg: org,
    orgChanged,
    stateLine,
    errorHeader: null,
    warning: null,
    detail: [],
    commands: [],
  }
}
