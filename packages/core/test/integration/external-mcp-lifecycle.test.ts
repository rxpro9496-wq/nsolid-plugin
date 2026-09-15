import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { BundleDescriptor, HarnessType, InstallResult } from '../../src/types.js'
import { getAdapter } from '../../src/harnesses/index.js'

// The external-MCP lifecycle must never consult the shared mcp-remote runtime
// manager; the mock fails loudly if a path unexpectedly provisions or repairs it.
const runtimeControl = { ensureCalls: 0, inspectCalls: 0 }
function resetRuntimeControl (): void {
  runtimeControl.ensureCalls = 0
  runtimeControl.inspectCalls = 0
}

mock.module('../../src/mcp/mcp-remote-runtime.js', {
  namedExports: {
    MCP_REMOTE_VERSION: '0.1.38',
    McpRemoteRuntimeError: class McpRemoteRuntimeError extends Error {
      override readonly name = 'McpRemoteRuntimeError'
      readonly code = 'MCP_REMOTE_RUNTIME_SETUP_FAILED'
    },
    getMcpRemoteRuntimeParent: () => join(tmpDir, '.agents', 'nsolid-plugin', 'runtime', 'mcp-remote'),
    getMcpRemoteRuntimeRoot: () => join(tmpDir, '.agents', 'nsolid-plugin', 'runtime', 'mcp-remote', '0.1.38'),
    resolveNpmCommand: () => { throw new Error('resolveNpmCommand is not part of these tests') },
    inspectMcpRemoteRuntime: () => {
      runtimeControl.inspectCalls++
      return { status: 'missing', version: '0.1.38', root: join(tmpDir, '.agents', 'nsolid-plugin', 'runtime', 'mcp-remote', '0.1.38') }
    },
    ensureMcpRemoteRuntime: async () => {
      runtimeControl.ensureCalls++
      throw new Error('external MCP lifecycle must not consult the shared runtime')
    },
  },
})

// Deterministic fault injection for the tracking write: the real tracker is
// re-exported and only the Nth write can be made to fail, so a test can prove
// the fail-safe path after config removal without touching file permissions.
const trackingModule = await import('../../src/skills/skill-tracker.js')
const trackingWriteControl = { failOnCall: null as number | null, calls: 0 }
function resetTrackingWriteControl (): void {
  trackingWriteControl.failOnCall = null
  trackingWriteControl.calls = 0
}
mock.module('../../src/skills/skill-tracker.js', {
  namedExports: {
    ...trackingModule,
    writeTrackingFile: async (
      data: Parameters<typeof trackingModule.writeTrackingFile>[0],
      logger?: Parameters<typeof trackingModule.writeTrackingFile>[1]
    ) => {
      trackingWriteControl.calls++
      if (trackingWriteControl.failOnCall !== null && trackingWriteControl.calls === trackingWriteControl.failOnCall) {
        throw new Error('injected tracking write failure')
      }
      return trackingModule.writeTrackingFile(data, logger)
    },
  },
})

let tmpDir: string
let originalHome: string | undefined
let originalUserProfile: string | undefined
let originalFetch: typeof globalThis.fetch

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'nsolid-ext-lifecycle-'))
  originalHome = process.env.HOME
  originalUserProfile = process.env.USERPROFILE
  originalFetch = globalThis.fetch
  process.env.HOME = tmpDir
  process.env.USERPROFILE = tmpDir
  resetRuntimeControl()
  resetTrackingWriteControl()
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
  if (originalHome !== undefined) process.env.HOME = originalHome
  else delete process.env.HOME
  if (originalUserProfile !== undefined) process.env.USERPROFILE = originalUserProfile
  else delete process.env.USERPROFILE
  globalThis.fetch = originalFetch
})

const EXTERNAL_HARNESSES = ['claude', 'codex', 'antigravity'] as const

function configPath (harness: HarnessType): string {
  const rels: Record<HarnessType, string> = {
    claude: '.claude.json',
    codex: '.codex/config.toml',
    opencode: '.config/opencode/opencode.jsonc',
    antigravity: '.gemini/config/mcp_config.json',
    pi: '.pi/agent/mcp.json',
  }
  return join(tmpDir, ...rels[harness].split('/'))
}

function trackingFile (): string {
  return join(tmpDir, '.agents', '.nodesource-installed.json')
}

function authFile (): string {
  return join(tmpDir, '.agents', '.nodesource-auth.json')
}

function readTracking (): Record<string, any> {
  return JSON.parse(readFileSync(trackingFile(), 'utf8'))
}

/** Bundle without auth: install() can write MCP config directly (no credentials needed). */
function createInstallBundle (): BundleDescriptor {
  return {
    name: 'ext-bundle',
    version: '1.0.0',
    skills: [{ name: 'ns-ext-skill', path: 'skills/ns-ext-skill', description: 'External skill' }],
    mcpServers: [
      { name: 'nsolid-console', url: 'https://mcp.nodesource.com/console', headers: { 'X-Nsolid-Service-Token': 'token-one' } },
      { name: 'ncm', url: 'https://mcp.nodesource.com/ncm', headers: { 'X-Nsolid-Service-Token': 'token-one' } },
    ],
  }
}

function createAuthBundle (): BundleDescriptor {
  return {
    ...createInstallBundle(),
    auth: {
      type: 'oauth',
      provider: 'nodesource',
      accountsUrl: 'https://accounts.nodesource.com',
      callbackPort: 8642,
    },
  }
}

function writeBundle (bundle: BundleDescriptor): string {
  const dir = join(tmpDir, 'bundle')
  mkdirSync(dir, { recursive: true })
  const bundlePath = join(dir, 'bundle.json')
  writeFileSync(bundlePath, JSON.stringify(bundle, null, 2))
  return bundlePath
}

function createSkillSource (): string {
  const sourceDir = join(tmpDir, 'source')
  mkdirSync(join(sourceDir, 'skills', 'ns-ext-skill'), { recursive: true })
  writeFileSync(join(sourceDir, 'skills', 'ns-ext-skill', 'SKILL.md'), '# ns-ext-skill')
  return sourceDir
}

function seedCredentials (): void {
  mkdirSync(join(tmpDir, '.agents'), { recursive: true })
  writeFileSync(authFile(), JSON.stringify({
    serviceToken: 'test-token',
    organizationId: 'test-org',
    saasToken: 'test-saas',
    consoleUrl: 'https://console.nodesource.com',
    mcpUrl: 'https://mcp.nodesource.com',
    expiresAt: '2099-01-01T00:00:00.000Z',
    permissions: [],
  }))
}

const OK_FETCH = (async () => ({
  ok: true,
  status: 200,
  headers: new Headers({ 'content-type': 'application/json' }),
  json: async () => ({ permissions: [] }),
})) as unknown as typeof fetch

/** Seed a user-owned unrelated server before any external install. */
function seedUserServer (harness: HarnessType): void {
  const path = configPath(harness)
  mkdirSync(join(path, '..'), { recursive: true })
  if (harness === 'codex') {
    writeFileSync(path, '[mcp_servers.user-server]\nurl = "https://user.example.com/mcp"\n')
  } else if (harness === 'antigravity') {
    writeFileSync(path, JSON.stringify({ mcpServers: { 'user-server': { serverUrl: 'https://user.example.com/mcp' } } }, null, 2) + '\n')
  } else {
    writeFileSync(path, JSON.stringify({ mcpServers: { 'user-server': { type: 'http', url: 'https://user.example.com/mcp' } } }, null, 2) + '\n')
  }
}

async function installExternal (harness: HarnessType, bundle: BundleDescriptor = createInstallBundle()): Promise<InstallResult> {
  const { install } = await import('../../src/index.js')
  return install({
    harness,
    bundlePath: writeBundle(bundle),
    skillsSource: createSkillSource(),
    packageOwnedSkills: true,
    externalMcp: true,
  })
}

async function ownedEntriesOnDisk (harness: HarnessType): Promise<string[]> {
  const config = await getAdapter(harness).readMcpConfig()
  return Object.keys(config.mcpServers).sort()
}

describe('external-MCP lifecycle: ownership tracking', () => {
  it('records active ownership for all three harnesses without skills or runtime', async () => {
    seedUserServer('claude')
    for (const harness of EXTERNAL_HARNESSES) {
      const result = await installExternal(harness)
      assert.strictEqual(result.success, true, `${harness}: ${result.errors.join('; ')}`)
      assert.strictEqual(result.skillsInstalled, 0)
      assert.strictEqual(result.mcpServersConfigured.length, 2)
    }

    const tracking = readTracking()
    for (const harness of EXTERNAL_HARNESSES) {
      const record = tracking.externalMcp[harness]
      assert.strictEqual(record.state, 'active', `${harness} record active`)
      assert.deepStrictEqual(record.entries.map((e: any) => e.name).sort(), ['ncm', 'nsolid-console'])
      for (const entry of record.entries) assert.match(entry.fingerprint, /^[0-9a-f]{64}$/)
    }
    assert.ok(!readFileSync(trackingFile(), 'utf8').includes('token-one'), 'no token values in tracking state')
    assert.strictEqual(runtimeControl.ensureCalls, 0, 'external mode must not provision the shared runtime')
    assert.strictEqual(runtimeControl.inspectCalls, 0, 'external mode must not inspect the shared runtime')
    assert.ok(!existsSync(join(tmpDir, '.agents', 'skills', 'ns-ext-skill')), 'no shared skill copies')
    assert.ok(!existsSync(join(tmpDir, '.claude', 'skills')), 'no harness skill links')
    assert.ok((await ownedEntriesOnDisk('claude')).includes('user-server'), 'unrelated server preserved')
  })

  it('setup --external-mcp reuses credentials and records ownership through the flagged install', async () => {
    const { setup } = await import('../../src/index.js')
    seedCredentials()
    globalThis.fetch = OK_FETCH

    const result = await setup({
      harness: 'claude',
      bundlePath: writeBundle(createAuthBundle()),
      skillsSource: createSkillSource(),
      packageOwnedSkills: true,
      externalMcp: true,
    })

    assert.strictEqual(result.success, true, result.errors.join('; '))
    assert.strictEqual(result.authSucceeded, true)
    assert.strictEqual(result.skillsInstalled, 0)
    assert.strictEqual(readTracking().externalMcp.claude.state, 'active')
    assert.strictEqual(runtimeControl.ensureCalls, 0)
  })

  it('refreshes ownership on a repeat external setup (T7)', async () => {
    const { setup } = await import('../../src/index.js')
    seedCredentials()
    globalThis.fetch = OK_FETCH
    const bundlePath = writeBundle(createAuthBundle())

    const first = await setup({ harness: 'claude', bundlePath, skillsSource: createSkillSource(), packageOwnedSkills: true, externalMcp: true })
    const firstFingerprint = readTracking().externalMcp.claude.entries[0].fingerprint
    const second = await setup({ harness: 'claude', bundlePath, skillsSource: createSkillSource(), packageOwnedSkills: true, externalMcp: true })

    assert.strictEqual(first.success, true)
    assert.strictEqual(second.success, true)
    assert.strictEqual(readTracking().externalMcp.claude.state, 'active')
    assert.strictEqual(readTracking().externalMcp.claude.entries[0].fingerprint, firstFingerprint, 'same content refreshes to the same evidence')
  })

  it('reports failure instead of claiming a safely managed install when the ownership record cannot be written', async () => {
    const { install } = await import('../../src/index.js')
    // External install writes tracking twice (MCP entries, then ownership);
    // fail only the ownership write so the config entry exists but the
    // command must still report failure rather than success.
    trackingWriteControl.failOnCall = 2

    const result = await install({
      harness: 'claude',
      bundlePath: writeBundle(createInstallBundle()),
      skillsSource: createSkillSource(),
      packageOwnedSkills: true,
      externalMcp: true,
    })

    assert.strictEqual(result.success, false, 'tracking failure must not report success')
    assert.ok(result.errors.some((e) => e.includes('Tracking update failed')), result.errors.join('; '))
  })
})

describe('external-MCP lifecycle: explicit disconnect', () => {
  it('disconnects one of three, is idempotent, and disconnects the last without touching credentials', async () => {
    const { disconnectExternalMcp } = await import('../../src/index.js')
    const { listTrackedMcps } = await import('../../src/mcp/index.js')
    seedCredentials()
    for (const harness of EXTERNAL_HARNESSES) await installExternal(harness)

    const codexBefore = readFileSync(configPath('codex'), 'utf8')
    const antigravityBefore = readFileSync(configPath('antigravity'), 'utf8')

    const first = await disconnectExternalMcp(['claude'])
    assert.strictEqual(first.success, true, first.errors.join('; '))
    assert.deepStrictEqual(first.disconnected, ['claude'])
    assert.ok(!(await ownedEntriesOnDisk('claude')).includes('nsolid-console'))
    assert.strictEqual(readFileSync(configPath('codex'), 'utf8'), codexBefore, 'other harnesses untouched')
    assert.strictEqual(readFileSync(configPath('antigravity'), 'utf8'), antigravityBefore, 'other harnesses untouched')
    assert.strictEqual((await listTrackedMcps('claude')).length, 0)
    assert.strictEqual(readTracking().externalMcp.claude.state, 'disconnected')

    const repeat = await disconnectExternalMcp(['claude'])
    assert.strictEqual(repeat.success, true)
    assert.deepStrictEqual(repeat.alreadyDisconnected, ['claude'])

    const last = await disconnectExternalMcp(['codex', 'antigravity'])
    assert.strictEqual(last.success, true, last.errors.join('; '))
    assert.deepStrictEqual(last.disconnected, ['codex', 'antigravity'])
    const tracking = readTracking()
    assert.strictEqual(tracking.mcpServers.length, 0)
    assert.ok(existsSync(trackingFile()), 'tombstones keep the tracking file alive')
    for (const harness of EXTERNAL_HARNESSES) assert.strictEqual(tracking.externalMcp[harness].state, 'disconnected')
    assert.ok(existsSync(authFile()), 'disconnect never purges shared credentials')
  })

  it('full cleanup removes the exact nsolid native plugin and preserves unrelated plugins/skills', async () => {
    const { uninstall } = await import('../../src/index.js')
    seedCredentials()
    await installExternal('claude')

    // A staged native skills plugin (canonical identity) alongside an unrelated
    // plugin that shares nothing with nsolid.
    const pluginsDir = join(tmpDir, '.claude', 'plugins')
    mkdirSync(pluginsDir, { recursive: true })
    const installedPlugins = join(pluginsDir, 'installed_plugins.json')
    writeFileSync(installedPlugins, JSON.stringify({
      version: 2,
      plugins: { 'nsolid-skills-plugin@nodesource': [{}], 'other-plugin@x': [{}] },
    }))
    mkdirSync(join(tmpDir, '.agents', 'skills', 'ns-other'), { recursive: true })

    const result = await uninstall('claude', { externalMcp: true, runCli: async () => { throw new Error('ENOENT') } })

    assert.deepStrictEqual(result.errors, [])
    assert.strictEqual(result.credentialsPurged, false)
    const remaining = JSON.parse(readFileSync(installedPlugins, 'utf8'))
    assert.ok(!('nsolid-skills-plugin@nodesource' in remaining.plugins), 'exact nsolid plugin removed')
    assert.ok('other-plugin@x' in remaining.plugins, 'unrelated plugin preserved')
    assert.ok(existsSync(join(tmpDir, '.agents', 'skills', 'ns-other')), 'unrelated shared skills survive full cleanup')
    assert.ok(existsSync(authFile()), 'credentials survive external-flow cleanup')
    assert.strictEqual(runtimeControl.ensureCalls, 0)
  })

  it('whole-command preflight leaves every harness byte-identical when one was edited', async () => {
    const { disconnectExternalMcp } = await import('../../src/index.js')
    await installExternal('claude')
    await installExternal('codex')

    const edited = readFileSync(configPath('codex'), 'utf8').replace('token-one', 'token-edited')
    writeFileSync(configPath('codex'), edited)

    const claudeBefore = readFileSync(configPath('claude'), 'utf8')
    const codexBefore = readFileSync(configPath('codex'), 'utf8')
    const trackingBefore = readFileSync(trackingFile(), 'utf8')

    const result = await disconnectExternalMcp(['claude', 'codex'])

    assert.strictEqual(result.success, false)
    assert.deepStrictEqual(result.disconnected, [])
    assert.strictEqual(readFileSync(configPath('claude'), 'utf8'), claudeBefore)
    assert.strictEqual(readFileSync(configPath('codex'), 'utf8'), codexBefore)
    assert.strictEqual(readFileSync(trackingFile(), 'utf8'), trackingBefore)
  })

  it('aborts the whole command, byte-identical, when a meaningful non-header field was edited', async () => {
    const { disconnectExternalMcp } = await import('../../src/index.js')
    await installExternal('claude')

    const edited = JSON.parse(readFileSync(configPath('claude'), 'utf8'))
    edited.mcpServers['nsolid-console'].enabled = false
    writeFileSync(configPath('claude'), JSON.stringify(edited, null, 2) + '\n')

    const configBefore = readFileSync(configPath('claude'), 'utf8')
    const trackingBefore = readFileSync(trackingFile(), 'utf8')

    const result = await disconnectExternalMcp(['claude'])

    assert.strictEqual(result.success, false)
    assert.deepStrictEqual(result.disconnected, [])
    assert.ok(result.errors.some((e) => e.includes('no longer matches the ownership evidence')), result.errors.join('; '))
    assert.strictEqual(readFileSync(configPath('claude'), 'utf8'), configBefore)
    assert.strictEqual(readFileSync(trackingFile(), 'utf8'), trackingBefore)
  })

  it('reports failure after removal, preserves the active record, and fails safe on retry when the finalize write fails', async () => {
    const { disconnectExternalMcp } = await import('../../src/index.js')
    await installExternal('claude')
    const trackingBefore = readFileSync(trackingFile(), 'utf8')

    // The finalize write is the next tracking write after the install.
    trackingWriteControl.failOnCall = trackingWriteControl.calls + 1

    const result = await disconnectExternalMcp(['claude'])

    assert.strictEqual(result.success, false, 'a failed finalize must report nonzero honestly')
    assert.deepStrictEqual(result.disconnected, [])
    assert.ok(result.errors.some((e) => e.includes('updating the ownership record failed')), result.errors.join('; '))
    assert.ok(result.errors.some((e) => e.includes('setup --harness claude --external-mcp')), 'retry guidance must be actionable')

    // Entries are gone from the config, but the ownership record is still the
    // pre-failure ACTIVE record, byte-identical.
    assert.ok(!(await ownedEntriesOnDisk('claude')).includes('nsolid-console'))
    assert.strictEqual(readFileSync(trackingFile(), 'utf8'), trackingBefore)
    assert.strictEqual(readTracking().externalMcp.claude.state, 'active')

    // Retry fails safe: the recorded entry is missing, so nothing else is
    // removed and the user is pointed at the ownership refresh.
    trackingWriteControl.failOnCall = null
    const configBefore = readFileSync(configPath('claude'), 'utf8')
    const retry = await disconnectExternalMcp(['claude'])
    assert.strictEqual(retry.success, false)
    assert.deepStrictEqual(retry.disconnected, [])
    assert.ok(retry.errors.some((e) => e.includes('Refresh ownership')), retry.errors.join('; '))
    assert.strictEqual(readFileSync(configPath('claude'), 'utf8'), configBefore)
    assert.strictEqual(readFileSync(trackingFile(), 'utf8'), trackingBefore)

    // The documented recovery path (flagged setup) refreshes the record so a
    // later disconnect succeeds.
    const { install } = await import('../../src/index.js')
    const refreshed = await install({
      harness: 'claude',
      bundlePath: writeBundle(createInstallBundle()),
      skillsSource: createSkillSource(),
      packageOwnedSkills: true,
      externalMcp: true,
    })
    assert.strictEqual(refreshed.success, true, refreshed.errors.join('; '))
    assert.strictEqual(readTracking().externalMcp.claude.state, 'active')
    const afterRefresh = await disconnectExternalMcp(['claude'])
    assert.strictEqual(afterRefresh.success, true, afterRefresh.errors.join('; '))
    assert.deepStrictEqual(afterRefresh.disconnected, ['claude'])
  })
})

describe('external-MCP lifecycle: legacy interactions', () => {
  it('legacy uninstall of an unrelated harness keeps credentials while an ACTIVE external record exists', async () => {
    const { install, uninstall } = await import('../../src/index.js')
    seedCredentials()
    await installExternal('claude')
    await install({ harness: 'opencode', bundlePath: writeBundle(createInstallBundle()), skillsSource: createSkillSource() })

    const result = await uninstall('opencode')

    assert.deepStrictEqual(result.errors, [])
    assert.strictEqual(result.credentialsPurged, false)
    assert.ok(existsSync(authFile()), 'shared credentials survive while the external record remains')
    assert.ok(!existsSync(join(tmpDir, '.agents', 'skills', 'ns-ext-skill')), 'opencode skills still removed')
    assert.strictEqual(readTracking().externalMcp.claude.state, 'active')
  })

  it('legacy uninstall of an unrelated harness keeps credentials while a DISCONNECTED tombstone exists', async () => {
    const { install, uninstall, disconnectExternalMcp } = await import('../../src/index.js')
    seedCredentials()
    await installExternal('claude')
    await disconnectExternalMcp(['claude'])
    await install({ harness: 'opencode', bundlePath: writeBundle(createInstallBundle()), skillsSource: createSkillSource() })

    const result = await uninstall('opencode')

    assert.deepStrictEqual(result.errors, [])
    assert.strictEqual(result.credentialsPurged, false)
    assert.ok(existsSync(authFile()), 'tombstone suppresses the implicit credential purge')
    assert.strictEqual(readTracking().externalMcp.claude.state, 'disconnected')
  })

  it('legacy install + uninstall keeps the old purge behavior when no external state exists', async () => {
    const { install, uninstall } = await import('../../src/index.js')
    seedCredentials()
    await install({ harness: 'claude', bundlePath: writeBundle(createInstallBundle()), skillsSource: createSkillSource() })

    const result = await uninstall('claude')

    assert.deepStrictEqual(result.errors, [])
    assert.strictEqual(result.credentialsPurged, true, 'old default: last tracked harness purges credentials')
    assert.ok(!existsSync(authFile()))
    assert.ok(!existsSync(trackingFile()))
  })

  // Dead-end regression: external setup → disconnect (tombstone retained) →
  // successful flagless (legacy) setup for the same harness → full uninstall.
  // The tombstone used to survive the legacy transition, so the final uninstall
  // refused with "present again" and the user had no CLI path out.
  it('a successful flagless setup supersedes a disconnected tombstone so the full uninstall completes', async () => {
    const { install, uninstall } = await import('../../src/index.js')
    await installExternal('claude')

    // Disconnect: entries removed, tombstone retained.
    const first = await uninstall('claude')
    assert.strictEqual(first.success, true, first.errors.join('; '))
    assert.strictEqual(readTracking().externalMcp.claude.state, 'disconnected')

    // Successful flagless (legacy) setup re-creates the same-name entries and
    // supersedes the tombstone.
    const legacy = await install({ harness: 'claude', bundlePath: writeBundle(createInstallBundle()), skillsSource: createSkillSource() })
    assert.strictEqual(legacy.success, true, legacy.errors.join('; '))
    const tracking = readTracking()
    assert.strictEqual(tracking.externalMcp?.claude, undefined, 'the legacy transition supersedes the tombstone')

    // Full uninstall must now remove the legacy entries instead of refusing.
    const final = await uninstall('claude')
    assert.strictEqual(final.success, true, final.errors.join('; '))
    assert.strictEqual(final.stages.find((entry) => entry.stage === 'mcp')?.status, 'removed')
    assert.strictEqual(final.stages.find((entry) => entry.stage === 'skills')?.status, 'removed')
    const config = JSON.parse(readFileSync(configPath('claude'), 'utf8'))
    assert.deepStrictEqual(Object.keys(config.mcpServers ?? {}), [], 'legacy MCP entries removed')
  })

  // The supersession must require an actual successful legacy setup: a
  // manually re-created entry without any legacy transition still refuses with
  // the "present again" problem, and the tombstone stays untouched.
  it('a re-created entry without a legacy setup still refuses uninstall (present again)', async () => {
    const { uninstall } = await import('../../src/index.js')
    await installExternal('claude')
    const first = await uninstall('claude')
    assert.strictEqual(first.success, true, first.errors.join('; '))
    assert.strictEqual(readTracking().externalMcp.claude.state, 'disconnected')

    // Re-create the recorded entry by hand; no legacy setup ran.
    const cp = configPath('claude')
    const config = JSON.parse(readFileSync(cp, 'utf8'))
    config.mcpServers['nsolid-console'] = { type: 'http', url: 'https://mcp.nodesource.com/console', headers: { 'X-Nsolid-Service-Token': 'token-one' } }
    writeFileSync(cp, JSON.stringify(config, null, 2) + '\n')
    const before = readFileSync(cp, 'utf8')
    const trackingBefore = readFileSync(trackingFile(), 'utf8')

    await assert.rejects(
      () => uninstall('claude'),
      (err: any) => {
        assert.strictEqual(err.code, 'UNINSTALL_PREFLIGHT_FAILED')
        assert.match(err.message, /present again/)
        return true
      }
    )
    assert.strictEqual(readFileSync(cp, 'utf8'), before, 'refusal is read-only')
    assert.strictEqual(readFileSync(trackingFile(), 'utf8'), trackingBefore, 'tombstone untouched on refusal')
  })

  // Survivor-ownership regression: writeMcpConfig MERGES, so a refreshed
  // external setup with a smaller bundle leaves earlier servers configured —
  // the ownership record used to shrink with the write-set and a later
  // uninstall reported success while leaving unrecorded servers (with their
  // tokens) in the config.
  it('refreshed external setup with a smaller bundle keeps ownership of surviving entries', async () => {
    const { uninstall } = await import('../../src/index.js')
    const threeServers: BundleDescriptor = {
      name: 'ext-bundle',
      version: '1.0.0',
      skills: [{ name: 'ns-ext-skill', path: 'skills/ns-ext-skill', description: 'External skill' }],
      mcpServers: [
        { name: 'nsolid-console', url: 'https://mcp.nodesource.com/console', headers: { 'X-Nsolid-Service-Token': 'token-one' } },
        { name: 'ncm', url: 'https://mcp.nodesource.com/ncm', headers: { 'X-Nsolid-Service-Token': 'token-one' } },
        { name: 'nsolid-audit', url: 'https://mcp.nodesource.com/audit', headers: { 'X-Nsolid-Service-Token': 'token-one' } },
      ],
    }
    const first = await installExternal('claude', threeServers)
    assert.strictEqual(first.success, true, first.errors.join('; '))

    // Refresh with a 2-server subset: the third entry survives in the config
    // through the merge and must keep its ownership evidence.
    const twoServers: BundleDescriptor = { ...threeServers, mcpServers: threeServers.mcpServers.slice(0, 2) }
    const second = await installExternal('claude', twoServers)
    assert.strictEqual(second.success, true, second.errors.join('; '))

    const onDisk = await ownedEntriesOnDisk('claude')
    assert.deepStrictEqual(onDisk.sort(), ['ncm', 'nsolid-audit', 'nsolid-console'], 'merge kept all three entries configured')
    const record = readTracking().externalMcp.claude
    assert.strictEqual(record.state, 'active')
    assert.deepStrictEqual(record.entries.map((e: any) => e.name).sort(), ['ncm', 'nsolid-audit', 'nsolid-console'], 'ownership record lists the survivors too')

    // The subsequent full uninstall removes all three with truthful success.
    const cleanup = await uninstall('claude')
    assert.strictEqual(cleanup.success, true, cleanup.errors.join('; '))
    const after = await ownedEntriesOnDisk('claude')
    assert.deepStrictEqual(after, [], 'every owned entry removed, not just the recorded subset')
  })
})

describe('external-MCP lifecycle: corrupt tracking evidence', () => {
  function writeCorruptTracking (content: string): void {
    mkdirSync(join(tmpDir, '.agents'), { recursive: true })
    writeFileSync(trackingFile(), content)
  }

  function malformedExternalState (): string {
    return JSON.stringify({
      version: '1.0.0',
      installedAt: new Date().toISOString(),
      harness: 'claude',
      skills: [],
      mcpServers: [],
      externalMcp: { claude: { state: 'active', entries: 'not-an-array' } },
    })
  }

  async function assertAllMutatingCommandsReject (): Promise<void> {
    const { setup, install, installWithRuntime, uninstall, restore } = await import('../../src/index.js')
    const bundlePath = writeBundle(createInstallBundle())
    const skillsSource = createSkillSource()
    const authBefore = readFileSync(authFile(), 'utf8')
    const trackingBefore = readFileSync(trackingFile(), 'utf8')

    const cases: Array<[string, () => Promise<unknown>]> = [
      ['setup --external-mcp', () => setup({ harness: 'claude', bundlePath, skillsSource, packageOwnedSkills: true, externalMcp: true })],
      ['flagless setup', () => setup({ harness: 'claude', bundlePath, skillsSource, packageOwnedSkills: true })],
      ['install', () => install({ harness: 'claude', bundlePath, skillsSource })],
      ['installWithRuntime', () => installWithRuntime({ harness: 'claude', bundlePath, skillsSource })],
      ['uninstall', () => uninstall('claude')],
      ['restore', () => restore('claude')],
    ]

    for (const [name, run] of cases) {
      await assert.rejects(run, (err: any) => {
        assert.strictEqual(err.code, 'TRACKING_CORRUPT', `${name} must reject corrupt tracking evidence`)
        return true
      }, name)
    }

    assert.strictEqual(runtimeControl.ensureCalls, 0, 'no runtime provisioning before the rejection')
    assert.ok(!existsSync(configPath('claude')), 'no harness config was written')
    assert.strictEqual(readFileSync(authFile(), 'utf8'), authBefore, 'auth bytes unchanged')
    assert.strictEqual(readFileSync(trackingFile(), 'utf8'), trackingBefore, 'tracking bytes unchanged')
  }

  it('rejects an unparsable tracking file before any side effect', async () => {
    seedCredentials()
    writeCorruptTracking('{ not json')
    await assertAllMutatingCommandsReject()
  })

  it('rejects malformed external state before any side effect instead of treating it as fresh', async () => {
    seedCredentials()
    writeCorruptTracking(malformedExternalState())
    await assertAllMutatingCommandsReject()
  })
})

describe('external-MCP lifecycle: mode guards', () => {
  it('rejects flagless setup/install/installWithRuntime and switch-org before any side effect', async () => {
    const { setup, install, installWithRuntime } = await import('../../src/index.js')
    seedCredentials()
    await installExternal('claude')
    const bundlePath = writeBundle(createAuthBundle())
    const configBefore = readFileSync(configPath('claude'), 'utf8')
    const trackingBefore = readFileSync(trackingFile(), 'utf8')

    const cases: Array<[string, () => Promise<unknown>]> = [
      ['setup', () => setup({ harness: 'claude', bundlePath, skillsSource: createSkillSource(), packageOwnedSkills: true })],
      ['switch-org', () => setup({ harness: 'claude', bundlePath, skillsSource: createSkillSource(), packageOwnedSkills: true, force: true })],
      ['install', () => install({ harness: 'claude', bundlePath, skillsSource: createSkillSource() })],
      ['installWithRuntime', () => installWithRuntime({ harness: 'claude', bundlePath, skillsSource: createSkillSource() })],
    ]

    for (const [name, run] of cases) {
      await assert.rejects(run, (err: any) => {
        assert.strictEqual(err.code, 'EXTERNAL_MCP_ACTIVE', `${name} must reject with EXTERNAL_MCP_ACTIVE`)
        assert.match(err.message, /ACTIVE external MCP/)
        return true
      }, `${name} must reject`)
    }

    assert.strictEqual(runtimeControl.ensureCalls, 0, 'rejection happened before runtime provisioning')
    assert.strictEqual(readFileSync(configPath('claude'), 'utf8'), configBefore)
    assert.strictEqual(readFileSync(trackingFile(), 'utf8'), trackingBefore)
    assert.ok(existsSync(authFile()), 'no auth mutation on rejected transitions')
  })

  it('routes plain uninstall of an ACTIVE external harness through safe external cleanup (no longer rejected)', async () => {
    const { uninstall } = await import('../../src/index.js')
    seedCredentials()
    await installExternal('claude')

    const result = await uninstall('claude')

    assert.deepStrictEqual(result.errors, [])
    assert.strictEqual(result.success, true)
    const mcpStage = result.stages.find((entry) => entry.stage === 'mcp')
    assert.strictEqual(mcpStage?.status, 'removed', 'recorded external entries removed, not name-swept')
    assert.ok(!(await ownedEntriesOnDisk('claude')).includes('nsolid-console'))
    assert.strictEqual(readTracking().externalMcp.claude.state, 'disconnected')
    assert.ok(existsSync(authFile()), 'external-flow cleanup never purges shared credentials')
    assert.strictEqual(runtimeControl.ensureCalls, 0)
  })

  it('allows the flagged refresh (setup --external-mcp) on an active harness', async () => {
    const { setup } = await import('../../src/index.js')
    seedCredentials()
    globalThis.fetch = OK_FETCH
    await installExternal('claude')

    const result = await setup({
      harness: 'claude',
      bundlePath: writeBundle(createAuthBundle()),
      skillsSource: createSkillSource(),
      packageOwnedSkills: true,
      externalMcp: true,
    })

    assert.strictEqual(result.success, true, result.errors.join('; '))
    assert.strictEqual(readTracking().externalMcp.claude.state, 'active')
  })

  it('allows legacy transitions once the harness is disconnected', async () => {
    const { install, disconnectExternalMcp } = await import('../../src/index.js')
    await installExternal('claude')
    await disconnectExternalMcp(['claude'])

    const result = await install({ harness: 'claude', bundlePath: writeBundle(createInstallBundle()), skillsSource: createSkillSource() })

    assert.strictEqual(result.success, true, result.errors.join('; '))
    // The successful flagless (legacy) install re-created the entries and
    // supersedes the disconnected tombstone: a retained tombstone would refuse
    // the next uninstall with "present again" and leave no CLI path out.
    assert.strictEqual(readTracking().externalMcp?.claude, undefined, 'tombstone superseded by the legacy transition')
  })

  it('whole-command external setup preflight aborts on a later harness conflict before configuring the first (T14)', async () => {
    const { assertExternalMcpSetupPreflight } = await import('../../src/index.js')
    // Codex has the old native plugin installed; claude does not.
    mkdirSync(join(tmpDir, '.codex'), { recursive: true })
    writeFileSync(join(tmpDir, '.codex', 'config.toml'), '[plugins."nsolid-plugin@nodesource"]\nenabled = false\n')

    assert.throws(
      () => assertExternalMcpSetupPreflight(['claude', 'codex']),
      (err: any) => {
        assert.strictEqual(err.code, 'INVALID_OPTION')
        assert.match(err.message, /old native N\|Solid plugin is installed for codex/)
        return true
      }
    )
    assert.ok(!existsSync(configPath('claude')), 'no harness may be configured before the preflight aborts')
    assert.ok(!existsSync(trackingFile()))
  })

  // Skills-only coexistence regression: the harness's native plugin registry
  // may legitimately hold the NEW skills-only plugin
  // (`nsolid-skills-plugin@nodesource`) before external setup runs. It
  // registers no MCP servers, so it must NOT trip the old-plugin MCP-conflict
  // guard, for every external harness, enabled or disabled.
  it('external setup preflight allows a skills-only native install (codex registry)', async () => {
    const { assertExternalMcpSetupPreflight } = await import('../../src/index.js')
    mkdirSync(join(tmpDir, '.codex'), { recursive: true })
    writeFileSync(join(tmpDir, '.codex', 'config.toml'), '[plugins."nsolid-skills-plugin@nodesource"]\nenabled = true\n')
    assert.doesNotThrow(() => assertExternalMcpSetupPreflight(['codex']))
  })

  it('external setup preflight allows a skills-only install under the legacy experimental marketplace (codex)', async () => {
    const { assertExternalMcpSetupPreflight } = await import('../../src/index.js')
    mkdirSync(join(tmpDir, '.codex'), { recursive: true })
    writeFileSync(join(tmpDir, '.codex', 'config.toml'), '[plugins."nsolid-skills-plugin@nsolid-skills"]\nenabled = true\n')
    assert.doesNotThrow(() => assertExternalMcpSetupPreflight(['codex']))
  })

  it('external setup preflight allows a skills-only native install (claude registry, disabled)', async () => {
    const { assertExternalMcpSetupPreflight } = await import('../../src/index.js')
    const pluginsDir = join(tmpDir, '.claude', 'plugins')
    mkdirSync(pluginsDir, { recursive: true })
    writeFileSync(join(pluginsDir, 'installed_plugins.json'), JSON.stringify({
      version: 2,
      plugins: { 'nsolid-skills-plugin@nodesource': [{ scope: 'user' }] },
    }))
    writeFileSync(join(tmpDir, '.claude.json'), JSON.stringify({ enabledPlugins: { 'nsolid-skills-plugin@nodesource': false } }))
    assert.doesNotThrow(() => assertExternalMcpSetupPreflight(['claude']))
  })

  it('external setup preflight allows a skills-only native install (antigravity staging)', async () => {
    const { assertExternalMcpSetupPreflight } = await import('../../src/index.js')
    mkdirSync(join(tmpDir, '.gemini', 'config', 'plugins', 'nsolid-skills-plugin'), { recursive: true })
    assert.doesNotThrow(() => assertExternalMcpSetupPreflight(['antigravity']))
  })

  it('external setup preflight still blocks the legacy plugin under ANY marketplace while disabled', async () => {
    const { assertExternalMcpSetupPreflight } = await import('../../src/index.js')
    mkdirSync(join(tmpDir, '.codex'), { recursive: true })
    writeFileSync(join(tmpDir, '.codex', 'config.toml'), '[plugins."nsolid-plugin@claude-plugins-official"]\nenabled = false\n')
    assert.throws(
      () => assertExternalMcpSetupPreflight(['codex']),
      (err: any) => {
        assert.strictEqual(err.code, 'INVALID_OPTION')
        assert.match(err.message, /old native N\|Solid plugin is installed for codex \(nsolid-plugin@claude-plugins-official\)/)
        return true
      }
    )
  })

  it('mixed install blocks on the OLD id with exact removal guidance and no broad full-uninstall suggestion', async () => {
    const { assertExternalMcpSetupPreflight } = await import('../../src/index.js')
    mkdirSync(join(tmpDir, '.codex'), { recursive: true })
    // The skills-only id is detected first; the legacy plugin is still present.
    writeFileSync(join(tmpDir, '.codex', 'config.toml'), [
      '[plugins."nsolid-skills-plugin@nodesource"]',
      'enabled = true',
      '',
      '[plugins."nsolid-plugin@nodesource"]',
      'enabled = false',
      '',
    ].join('\n'))
    assert.throws(
      () => assertExternalMcpSetupPreflight(['codex']),
      (err: any) => {
        assert.strictEqual(err.code, 'INVALID_OPTION')
        assert.match(err.message, /\(nsolid-plugin@nodesource\)/, 'the conflict must name the OLD id, not the first detected label')
        assert.match(err.action ?? '', /codex plugin remove nsolid-plugin@nodesource/, 'guidance names the exact old-plugin removal command')
        assert.doesNotMatch(err.action ?? '', /nsolid-plugin uninstall --harness/, 'guidance must not recommend the broad full uninstall')
        assert.match(err.action ?? '', /nsolid-skills-plugin/, 'guidance says the skills-only plugin must stay installed')
        return true
      }
    )
  })

  it('claude conflict guidance names the exact legacy plugin without guessing a scope', async () => {
    const { assertExternalMcpSetupPreflight } = await import('../../src/index.js')
    const pluginsDir = join(tmpDir, '.claude', 'plugins')
    mkdirSync(pluginsDir, { recursive: true })
    writeFileSync(join(pluginsDir, 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'nsolid-plugin@nodesource': [{}] } }))
    assert.throws(
      () => assertExternalMcpSetupPreflight(['claude']),
      (err: any) => {
        assert.strictEqual(err.code, 'INVALID_OPTION')
        assert.match(err.message, /\(nsolid-plugin@nodesource\)/)
        assert.doesNotMatch(err.action ?? '', /claude plugin uninstall/, 'no copy-pastable command when the scope is unknown')
        assert.match(err.action ?? '', /nsolid-plugin@nodesource/)
        return true
      }
    )
  })
})

describe('external-MCP lifecycle: doctor and restore', () => {
  it('doctor reports verification scope without claiming reachability (T13)', async () => {
    const { doctor } = await import('../../src/index.js')
    const { formatDoctorReport } = await import('../../src/utils/format.js')
    seedCredentials()
    const bundlePath = writeBundle(createInstallBundle())
    await installExternal('claude')

    const report = await doctor('claude', bundlePath)

    assert.strictEqual(report.healthy, false, 'unverified external install must not be healthy')
    assert.strictEqual(report.skills.status, 'unverified')
    assert.deepStrictEqual(report.skills.missing, [], 'external skills must not be reported missing')
    assert.strictEqual(report.mcpServers.status, 'unverified')
    assert.deepStrictEqual(report.mcpServers.reachable, [], 'configured is not reachable')
    assert.deepStrictEqual(report.mcpServers.unreachable, [])
    assert.strictEqual(report.externalMcp?.status, 'unverified')
    assert.deepStrictEqual(report.externalMcp?.configured, ['nsolid-console', 'ncm'])
    assert.strictEqual(report.externalMcp?.checks.authentication, 'unverified')
    assert.strictEqual(report.credentials.status, 'ok')

    const text = formatDoctorReport(report, 'claude', false)
    assert.match(text, /External MCP\s+\? unverified/)
    assert.match(text, /MCP servers\s+\? configured, not probed/)
    assert.match(text, /Verification incomplete/)
    assert.doesNotMatch(text, /✗ missing/)
    assert.ok(!JSON.stringify(report).includes('token-one'), 'doctor output must not carry tokens')
  })

  it('doctor does not require the MCP bridge for a skills-only native plugin install', async () => {
    const { doctor } = await import('../../src/index.js')
    seedCredentials()
    const bundlePath = writeBundle(createInstallBundle())
    mkdirSync(join(tmpDir, '.codex'), { recursive: true })
    writeFileSync(join(tmpDir, '.codex', 'config.toml'), '[plugins."nsolid-skills-plugin@nodesource"]\nenabled = true\n')

    const report = await doctor('codex', bundlePath)

    assert.strictEqual(report.plugin.installed, true)
    assert.strictEqual(report.plugin.label, 'nsolid-skills-plugin@nodesource')
    assert.strictEqual(report.bridge?.required, false, 'the skills-only plugin registers no MCP servers, so no bridge is required')
    assert.ok(!report.errors.some((e) => e.includes('MCP bridge')), 'no bridge error for a skills-only install')
  })

  it('doctor still requires the MCP bridge for a legacy native plugin install', async () => {
    const { doctor } = await import('../../src/index.js')
    seedCredentials()
    const bundlePath = writeBundle(createInstallBundle())
    mkdirSync(join(tmpDir, '.codex'), { recursive: true })
    writeFileSync(join(tmpDir, '.codex', 'config.toml'), '[plugins."nsolid-plugin@nodesource"]\nenabled = true\n')

    const report = await doctor('codex', bundlePath)

    assert.strictEqual(report.plugin.installed, true)
    assert.strictEqual(report.bridge?.required, true, 'the legacy plugin routes MCP through the bridge')
    assert.ok(report.errors.some((e) => e.includes('MCP bridge')))
  })

  it('doctor distinguishes a structural config error from the unverified state', async () => {
    const { doctor } = await import('../../src/index.js')
    await installExternal('claude')
    writeFileSync(configPath('claude'), '{ not json')

    const report = await doctor('claude', writeBundle(createInstallBundle()))

    assert.strictEqual(report.healthy, false)
    assert.ok(report.externalMcp?.configError, 'structural error is recorded')
    assert.ok(report.errors.some((e) => e.includes('MCP config could not be read')))
  })

  it('rejects restore for an active external harness before writing, then allows it after disconnect', async () => {
    const { restore, disconnectExternalMcp } = await import('../../src/index.js')
    const { createConfigBackup } = await import('../../src/utils/backup.js')
    await installExternal('claude')
    // Ensure a restorable backup exists even if no pre-write backup was made.
    createConfigBackup('claude', configPath('claude'), { reason: 'test' })

    const configBefore = readFileSync(configPath('claude'), 'utf8')
    await assert.rejects(
      () => restore('claude'),
      (err: any) => {
        assert.strictEqual(err.code, 'EXTERNAL_MCP_ACTIVE')
        return true
      }
    )
    assert.strictEqual(readFileSync(configPath('claude'), 'utf8'), configBefore, 'restore rejected before the write')

    await disconnectExternalMcp(['claude'])
    const entry = await restore('claude')
    assert.ok(existsSync(entry.originalPath))
    assert.ok((await ownedEntriesOnDisk('claude')).includes('nsolid-console'), 'restored entries come back untracked')
    const refused = await disconnectExternalMcp(['claude'])
    assert.strictEqual(refused.success, false, 'restored entries are not name-swept without an active record')
  })
})

describe('external-MCP lifecycle: CLI surface', () => {
  const repoRoot = join(import.meta.dirname, '..', '..', '..', '..')
  const cliEntry = join(repoRoot, 'packages', 'core', 'src', 'cli.ts')

  function runCli (args: string[]): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync(process.execPath, ['--import', 'tsx/esm', cliEntry, ...args], {
      cwd: repoRoot,
      env: { ...process.env, HOME: tmpDir, USERPROFILE: tmpDir, NO_COLOR: '1' },
      encoding: 'utf8',
      timeout: 60_000,
    })
    return { status: result.status, stdout: result.stdout, stderr: result.stderr }
  }

  it('accepts uninstall --external-mcp as complete cleanup and is idempotent on repeat', async () => {
    seedUserServer('claude')
    await installExternal('claude')

    const first = runCli(['uninstall', '--harness', 'claude', '--external-mcp'])
    assert.strictEqual(first.status, 0, first.stderr || first.stdout)
    assert.match(first.stdout, /Uninstalled N\|Solid for Claude Code/)
    assert.match(first.stdout, /mcp: removed/)
    const config = await getAdapter('claude').readMcpConfig()
    assert.deepStrictEqual(Object.keys(config.mcpServers), ['user-server'])

    const repeat = runCli(['uninstall', '--harness', 'claude', '--external-mcp'])
    assert.strictEqual(repeat.status, 0, repeat.stderr || repeat.stdout)
    assert.match(repeat.stdout, /mcp: not-present/)
  })

  it('rejects flagless setup/install but accepts plain uninstall on an active external harness', async () => {
    await installExternal('claude')
    const configBefore = readFileSync(configPath('claude'), 'utf8')
    const trackingBefore = readFileSync(trackingFile(), 'utf8')

    for (const command of ['setup', 'install']) {
      const result = runCli([command, '--harness', 'claude', '--yes'])
      assert.strictEqual(result.status, 1, `${command} must exit 1: ${result.stdout}`)
      assert.match(result.stderr, /ACTIVE external MCP/, `${command} must explain the active external record`)
      assert.ok(!existsSync(join(tmpDir, '.agents', 'nsolid-plugin', 'runtime')), `${command} must not provision the runtime`)
    }
    assert.strictEqual(readFileSync(configPath('claude'), 'utf8'), configBefore)
    assert.strictEqual(readFileSync(trackingFile(), 'utf8'), trackingBefore)

    // Plain uninstall is no longer guarded: it routes to safe external cleanup.
    const plain = runCli(['uninstall', '--harness', 'claude', '--yes'])
    assert.strictEqual(plain.status, 0, plain.stderr || plain.stdout)
    assert.match(plain.stdout, /Uninstalled N\|Solid for Claude Code/)
    assert.strictEqual(readTracking().externalMcp.claude.state, 'disconnected')
  })

  it('rejects restore for an active external harness without rewriting the config', async () => {
    await installExternal('claude')
    const configBefore = readFileSync(configPath('claude'), 'utf8')

    const result = runCli(['restore', '--harness', 'claude'])

    assert.strictEqual(result.status, 1)
    assert.match(result.stderr, /EXTERNAL_MCP_ACTIVE|ACTIVE external MCP/)
    assert.strictEqual(readFileSync(configPath('claude'), 'utf8'), configBefore)
  })

  it('doctor --json reports unverified externally and exits nonzero', async () => {
    await installExternal('claude')
    const bundlePath = writeBundle(createInstallBundle())

    const result = runCli(['doctor', '--harness', 'claude', '--json', '--bundle', bundlePath])

    assert.strictEqual(result.status, 1)
    const report = JSON.parse(result.stdout)
    assert.strictEqual(report.healthy, false)
    assert.strictEqual(report.mcpServers.status, 'unverified')
    assert.deepStrictEqual(report.mcpServers.reachable, [])
    assert.strictEqual(report.externalMcp.status, 'unverified')
    assert.deepStrictEqual(report.externalMcp.configured, ['nsolid-console', 'ncm'])
  })

  it('logout warns that copied tokens survive and nothing is revoked', async () => {
    seedCredentials()
    await installExternal('claude')
    const configBefore = readFileSync(configPath('claude'), 'utf8')

    const result = runCli(['logout'])

    assert.strictEqual(result.status, 0, result.stderr)
    assert.match(result.stdout, /nothing was revoked server-side/)
    assert.match(result.stdout, /uninstall --external-mcp --harness/)
    assert.ok(!existsSync(authFile()), 'logout removes the shared auth file')
    assert.strictEqual(readFileSync(configPath('claude'), 'utf8'), configBefore, 'logout never rewrites harness configs')
  })

  it('rejects a corrupt tracking file before side effects', () => {
    mkdirSync(join(tmpDir, '.agents'), { recursive: true })
    writeFileSync(trackingFile(), '{ not json')

    const result = runCli(['setup', '--harness', 'claude', '--yes'])

    assert.strictEqual(result.status, 1)
    assert.match(result.stderr, /TRACKING_CORRUPT/)
    assert.ok(!existsSync(configPath('claude')), 'no config written')
    assert.strictEqual(readFileSync(trackingFile(), 'utf8'), '{ not json')
  })
})

describe('external-MCP lifecycle: refresh integrity and atomic selection walkthroughs', () => {
  it('a reduced refresh refuses to re-own a user-edited omitted entry and keeps prior evidence', async () => {
    const twoServers = createInstallBundle()
    const first = await installExternal('claude', twoServers)
    assert.strictEqual(first.success, true, first.errors.join('; '))

    // The user edits the entry that the next refresh will omit from its bundle.
    const cp = configPath('claude')
    const config = JSON.parse(readFileSync(cp, 'utf8'))
    config.mcpServers.ncm.url = 'https://user-edited.example.com/mcp'
    writeFileSync(cp, JSON.stringify(config, null, 2) + '\n')

    const trackingBefore = readFileSync(trackingFile(), 'utf8')
    const configBefore = readFileSync(cp, 'utf8')

    const oneServer: BundleDescriptor = { ...twoServers, mcpServers: twoServers.mcpServers.slice(0, 1) }
    const second = await installExternal('claude', oneServer)

    assert.strictEqual(second.success, false, 'a refresh over an edited survivor must fail, not adopt it')
    assert.ok(
      second.errors.some((e: string) => e.includes('"ncm"') && e.includes('changed since ownership was recorded')),
      second.errors.join('; ')
    )
    // The external ownership evidence must survive byte-for-byte (the refusal
    // fires before writeTrackingFile inside recordExternalMcpOwnership).
    // addTrackedMcps legitimately re-stamps configuredAt for write-set entries,
    // so only the externalMcp block is compared, not the whole tracking file.
    const ownershipBefore = JSON.parse(trackingBefore).externalMcp
    const ownershipAfter = readTracking().externalMcp
    assert.deepStrictEqual(ownershipAfter, ownershipBefore, 'prior ownership evidence survives exactly')
    assert.strictEqual(readFileSync(cp, 'utf8'), configBefore, 'the refusal leaves the user edit untouched')
    const record = readTracking().externalMcp.claude
    assert.deepStrictEqual(
      record.entries.map((e: any) => e.name).sort(),
      ['ncm', 'nsolid-console'],
      'no adoption: both entries keep their prior evidence'
    )
  })

  for (const harnesses of [
    ['claude', 'codex'],
    ['codex', 'claude'],
  ] as const) {
    it(`a malformed config under ACTIVE external ownership refuses the two-harness selection atomically (${harnesses[0]} first)`, async () => {
      const { uninstallHarnesses } = await import('../../src/uninstall.js')
      await installExternal('claude')
      await installExternal('codex')
      const cp = configPath('claude')
      writeFileSync(cp, '{ not json')
      const claudeBefore = readFileSync(cp, 'utf8')
      const codexBefore = readFileSync(configPath('codex'), 'utf8')
      const trackingBefore = readFileSync(trackingFile(), 'utf8')

      await assert.rejects(
        () => uninstallHarnesses([...harnesses]),
        (err: any) => {
          assert.strictEqual(err.code, 'UNINSTALL_PREFLIGHT_FAILED')
          assert.ok(err.message.includes(`Cannot read ${cp} to verify claude`), err.message)
          return true
        }
      )
      assert.strictEqual(readFileSync(cp, 'utf8'), claudeBefore, 'malformed config untouched')
      assert.strictEqual(readFileSync(configPath('codex'), 'utf8'), codexBefore, 'sibling harness untouched')
      assert.strictEqual(readFileSync(trackingFile(), 'utf8'), trackingBefore, 'tracking untouched')
    })
  }
})
