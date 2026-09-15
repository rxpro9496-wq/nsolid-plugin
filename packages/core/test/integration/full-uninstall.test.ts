import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, chmodSync, lstatSync } from 'node:fs'
import { join, dirname, sep } from 'node:path'
import { tmpdir } from 'node:os'
import type { BundleDescriptor, HarnessType } from '../../src/types.js'
import type { UninstallResult } from '../../src/uninstall.js'
import type { CliRunner } from '../../src/harnesses/native-plugin-uninstaller.js'

/**
 * Focused regression coverage for the owner-contract full uninstall: selected
 * -harness skills + MCP + exact native plugin + exact marketplace registration,
 * with no collateral damage to unrelated plugins/skills/scopes and honest,
 * retryable partial failures. Native harness CLIs are mocked with explicit
 * outcomes; no real profile or network operation runs.
 */

let tmpDir: string
let originalHome: string | undefined
let originalUserProfile: string | undefined

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'nsolid-full-uninstall-'))
  originalHome = process.env.HOME
  originalUserProfile = process.env.USERPROFILE
  process.env.HOME = tmpDir
  process.env.USERPROFILE = tmpDir
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
  if (originalHome !== undefined) process.env.HOME = originalHome
  else delete process.env.HOME
  if (originalUserProfile !== undefined) process.env.USERPROFILE = originalUserProfile
  else delete process.env.USERPROFILE
})

const HARNESSES = ['claude', 'codex', 'antigravity'] as const

type Toml = { parse: (s: string) => any, stringify: (v: any) => string }
async function toml (): Promise<Toml> {
  return await import('smol-toml') as unknown as Toml
}

function claudeInstalledPath (): string { return join(tmpDir, '.claude/plugins/installed_plugins.json') }
function claudeSettingsPath (): string { return join(tmpDir, '.claude/settings.json') }
function codexConfigPath (): string { return join(tmpDir, '.codex/config.toml') }
function agyPluginDir (name = 'nsolid-skills-plugin'): string { return join(tmpDir, '.gemini/config/plugins', name) }
function agyManifestPath (): string { return join(tmpDir, '.gemini/config/import_manifest.json') }
function trackingFile (): string { return join(tmpDir, '.agents/.nodesource-installed.json') }
function authFile (): string { return join(tmpDir, '.agents/.nodesource-auth.json') }

function seedAuth (): void {
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

function seedUnrelatedSkill (): string {
  const dir = join(tmpDir, '.agents/skills/ns-user-skill')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), '# user skill')
  return dir
}

/** A legacy CLI-tracked install (skills + MCP) that the uninstall must attribute. */
async function seedTrackedInstall (harness: HarnessType): Promise<void> {
  const skillsSource = join(tmpDir, 'source')
  mkdirSync(join(skillsSource, 'skills/ns-tracked-skill'), { recursive: true })
  writeFileSync(join(skillsSource, 'skills/ns-tracked-skill/SKILL.md'), '# tracked')
  const bundlePath = join(tmpDir, 'bundle.json')
  writeFileSync(bundlePath, JSON.stringify({
    name: 'tracked',
    version: '1.0.0',
    skills: [{ name: 'ns-tracked-skill', path: 'skills/ns-tracked-skill', description: '' }],
    mcpServers: [{ name: 'nsolid-console', url: 'https://mcp.example.com/x', headers: { token: 't' } }],
  }))
  const { install } = await import('../../src/index.js')
  const result = await install({ harness, bundlePath, skillsSource })
  assert.strictEqual(result.success, true, `${harness} tracked install: ${result.errors.join('; ')}`)
}

/** Stage a native plugin registration; `id` is the exact installed identity. */
async function seedNativePlugin (harness: HarnessType, id: string): Promise<void> {
  if (harness === 'claude') {
    mkdirSync(dirname(claudeInstalledPath()), { recursive: true })
    writeFileSync(claudeInstalledPath(), JSON.stringify({ version: 2, plugins: { [id]: [{ scope: 'user' }] } }))
    writeFileSync(join(tmpDir, '.claude.json'), JSON.stringify({ enabledPlugins: { [id]: true } }))
  } else if (harness === 'codex') {
    const { parse, stringify } = await toml()
    mkdirSync(dirname(codexConfigPath()), { recursive: true })
    const existing = existsSync(codexConfigPath())
      ? parse(readFileSync(codexConfigPath(), 'utf8'))
      : {}
    existing.plugins = { ...(existing.plugins ?? {}), [id]: { enabled: true } }
    writeFileSync(codexConfigPath(), stringify(existing))
  } else {
    mkdirSync(agyPluginDir(id), { recursive: true })
    writeFileSync(join(agyPluginDir(id), 'plugin.json'), JSON.stringify({ name: id }))
    const ownedSkill = join(agyPluginDir(id), 'skills', 'ns-owned')
    mkdirSync(ownedSkill, { recursive: true })
    writeFileSync(join(ownedSkill, 'SKILL.md'), '# owned skill')
    mkdirSync(dirname(agyManifestPath()), { recursive: true })
    writeFileSync(agyManifestPath(), JSON.stringify({ imports: [{ name: id, source: 'local' }, { name: 'unrelated-plugin', source: 'local' }] }))
  }
}

async function seedMarketplace (harness: HarnessType, name: string): Promise<void> {
  if (harness === 'claude') {
    mkdirSync(dirname(claudeSettingsPath()), { recursive: true })
    const existing = existsSync(claudeSettingsPath())
      ? JSON.parse(readFileSync(claudeSettingsPath(), 'utf8'))
      : {}
    existing.extraKnownMarketplaces = {
      ...(existing.extraKnownMarketplaces ?? {}),
      [name]: { source: { source: 'directory', path: '/tmp/marketplace' } },
    }
    writeFileSync(claudeSettingsPath(), JSON.stringify(existing))
  } else if (harness === 'codex') {
    const { stringify } = await toml()
    const existing = existsSync(codexConfigPath())
      ? (await toml()).parse(readFileSync(codexConfigPath(), 'utf8'))
      : {}
    existing.marketplaces = { ...(existing.marketplaces ?? {}), [name]: { source_type: 'local', source: '/tmp/marketplace' } }
    mkdirSync(dirname(codexConfigPath()), { recursive: true })
    writeFileSync(codexConfigPath(), stringify(existing))
  }
}

async function seedUnrelatedPluginFromMarketplace (harness: HarnessType, marketplace: string): Promise<void> {
  if (harness === 'claude') {
    const data = JSON.parse(readFileSync(claudeInstalledPath(), 'utf8'))
    data.plugins[`other-plugin@${marketplace}`] = [{}]
    writeFileSync(claudeInstalledPath(), JSON.stringify(data))
  } else if (harness === 'codex') {
    const { parse, stringify } = await toml()
    const data = parse(readFileSync(codexConfigPath(), 'utf8'))
    data.plugins[`other@${marketplace}`] = { enabled: true }
    writeFileSync(codexConfigPath(), stringify(data))
  }
}

async function readPlugins (harness: HarnessType): Promise<string[]> {
  if (harness === 'claude') return Object.keys(JSON.parse(readFileSync(claudeInstalledPath(), 'utf8')).plugins ?? {})
  const { parse } = await toml()
  return Object.keys(parse(readFileSync(codexConfigPath(), 'utf8')).plugins ?? {})
}

/** Deterministic timestamps so fixtures stay byte-stable across runs. */
const FIXED_TS = '2026-01-01T00:00:00.000Z'

function agentsDir (): string { return join(tmpDir, '.agents') }
function sharedSkillDir (name: string): string { return join(tmpDir, '.agents/skills', name) }

function claudeSkillsDir (): string { return join(tmpDir, '.claude/skills') }

interface TrackingSeed {
  skills?: unknown[]
  mcpServers?: unknown[]
  externalMcp?: unknown
  pendingMarketplaceRemovals?: unknown
}

/** Write a tracking file directly so a fixture can seed durable/legacy state exactly. */
function writeTracking (data: TrackingSeed): void {
  mkdirSync(agentsDir(), { recursive: true })
  writeFileSync(trackingFile(), JSON.stringify({
    version: '1.0.0',
    installedAt: FIXED_TS,
    harness: 'claude',
    skills: [],
    mcpServers: [],
    ...data,
  }))
}

/** Mock harness CLIs that perform the real on-disk effect for each supported command. */
async function simulateNativeCli (options: { failMarketplaceOnce?: boolean } = {}): Promise<{ calls: Array<{ cmd: string, args: string[] }>, runCli: CliRunner }> {
  const calls: Array<{ cmd: string, args: string[] }> = []
  let marketplaceFailures = 0
  const runCli: CliRunner = async (cmd, args) => {
    calls.push({ cmd, args })
    if (cmd === 'claude' && args[0] === 'plugin' && args[1] === 'uninstall') {
      const id = args[2]
      const scopeFlag = args.indexOf('--scope')
      const scope = scopeFlag >= 0 ? args[scopeFlag + 1] : undefined
      if (existsSync(claudeInstalledPath())) {
        const data = JSON.parse(readFileSync(claudeInstalledPath(), 'utf8'))
        if (data.plugins && !Array.isArray(data.plugins) && id in data.plugins) {
          if (scope === undefined) {
            delete data.plugins[id]
          } else {
            const kept = (data.plugins[id] as Array<{ scope?: string }>)
              .filter((record) => !(record && typeof record === 'object' && record.scope === scope))
            if (kept.length === 0) delete data.plugins[id]
            else data.plugins[id] = kept
          }
          writeFileSync(claudeInstalledPath(), JSON.stringify(data))
        }
      }
      // The real CLI clears the enable flag only when no install remains.
      const claudeJson = join(tmpDir, '.claude.json')
      if (existsSync(claudeJson)) {
        const settings = JSON.parse(readFileSync(claudeJson, 'utf8'))
        const installed = JSON.parse(readFileSync(claudeInstalledPath(), 'utf8')).plugins ?? {}
        if (settings.enabledPlugins && id in settings.enabledPlugins && !(id in installed)) {
          delete settings.enabledPlugins[id]
          writeFileSync(claudeJson, JSON.stringify(settings))
        }
      }
      return 0
    }
    if (cmd === 'claude' && args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'remove') {
      if (options.failMarketplaceOnce && marketplaceFailures++ === 0) return 1
      const name = args[3]
      // Claude resolves --scope project/local against the working directory, so
      // the simulated effect must target that same file (the code under test
      // verifies removal through the same lookup).
      const scopeFlag = args.indexOf('--scope')
      const scope = scopeFlag >= 0 ? args[scopeFlag + 1] : undefined
      const settingsFile = scope === 'project'
        ? join(process.cwd(), '.claude/settings.json')
        : scope === 'local'
          ? join(process.cwd(), '.claude/settings.local.json')
          : claudeSettingsPath()
      if (existsSync(settingsFile)) {
        const data = JSON.parse(readFileSync(settingsFile, 'utf8'))
        if (data.extraKnownMarketplaces && name in data.extraKnownMarketplaces) {
          delete data.extraKnownMarketplaces[name]
          writeFileSync(settingsFile, JSON.stringify(data))
        }
      }
      return 0
    }
    if (cmd === 'codex' && args[0] === 'plugin' && args[1] === 'remove') {
      const id = args[2]
      if (existsSync(codexConfigPath())) {
        const { parse, stringify } = await toml()
        const data = parse(readFileSync(codexConfigPath(), 'utf8'))
        if (data.plugins && id in data.plugins) { delete data.plugins[id]; writeFileSync(codexConfigPath(), stringify(data)) }
      }
      return 0
    }
    if (cmd === 'codex' && args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'remove') {
      if (options.failMarketplaceOnce && marketplaceFailures++ === 0) return 1
      const name = args[3]
      if (existsSync(codexConfigPath())) {
        const { parse, stringify } = await toml()
        const data = parse(readFileSync(codexConfigPath(), 'utf8'))
        if (data.marketplaces && name in data.marketplaces) { delete data.marketplaces[name]; writeFileSync(codexConfigPath(), stringify(data)) }
      }
      return 0
    }
    if (cmd === 'agy' && args[0] === 'plugin' && args[1] === 'uninstall') {
      rmSync(agyPluginDir(args[2]), { recursive: true, force: true })
      if (existsSync(agyManifestPath())) {
        const data = JSON.parse(readFileSync(agyManifestPath(), 'utf8'))
        // The real agy CLI rewrites the manifest as {"imports": null} once the
        // last import is removed (observed 2026-09); the sim must match it.
        const kept = (data.imports ?? []).filter((entry: { name?: string }) => entry.name !== args[2])
        data.imports = kept.length > 0 ? kept : null
        writeFileSync(agyManifestPath(), JSON.stringify(data))
      }
      return 0
    }
    return 0
  }
  return { calls, runCli }
}

describe('full uninstall: complete selected-harness cleanup', () => {
  it('removes the exact nsolid plugin and marketplace for all three harnesses, preserving unrelated state', async () => {
    for (const harness of HARNESSES) {
      tmpDir = mkdtempSync(join(tmpdir(), 'nsolid-full-uninstall-'))
      process.env.HOME = tmpDir
      process.env.USERPROFILE = tmpDir
      seedAuth()
      const unrelatedSkill = seedUnrelatedSkill()
      await seedTrackedInstall(harness)
      const pluginId = harness === 'antigravity' ? 'nsolid-skills-plugin' : 'nsolid-skills-plugin@nodesource'
      await seedNativePlugin(harness, pluginId)
      await seedMarketplace(harness, 'nodesource')
      await seedMarketplace(harness, 'nsolid-skills')
      await seedUnrelatedPluginFromMarketplace(harness, 'other-market')

      const { runCli } = await simulateNativeCli()
      const { uninstall } = await import('../../src/index.js')
      const result = await uninstall(harness, { runCli })

      assert.deepStrictEqual(result.errors, [], `${harness}: ${result.errors.join('; ')}`)
      assert.strictEqual(result.success, true, harness)
      assert.strictEqual(result.stages.find((entry) => entry.stage === 'mcp')?.status, 'removed', `${harness} tracked MCP`)
      assert.strictEqual(result.stages.find((entry) => entry.stage === 'skills')?.status, 'removed', `${harness} tracked skill`)
      assert.ok(!existsSync(join(tmpDir, '.agents/skills/ns-tracked-skill')), `${harness} tracked shared skill removed`)
      assert.strictEqual(result.stages.find((entry) => entry.stage === 'nativePlugin')?.status, 'removed', `${harness} native plugin`)
      const marketplaceStage = result.stages.find((entry) => entry.stage === 'marketplace')
      assert.strictEqual(
        marketplaceStage?.status,
        harness === 'antigravity' ? 'not-present' : 'removed',
        `${harness} marketplace: ${JSON.stringify(marketplaceStage)}`
      )

      if (harness !== 'antigravity') {
        const plugins = await readPlugins(harness)
        assert.ok(!plugins.some((id) => id.startsWith('nsolid-skills-plugin@')), `${harness} nsolid plugin removed: ${plugins}`)
        assert.ok(plugins.includes('other-plugin@other-market') || plugins.includes('other@other-market'), `${harness} unrelated plugin preserved: ${plugins}`)
      } else {
        assert.strictEqual(existsSync(agyPluginDir()), false, 'agy native plugin dir removed')
        assert.equal(existsSync(join(agyPluginDir(), 'skills/ns-owned/SKILL.md')), false, 'agy plugin-owned skill removed with the plugin')
        const manifest = JSON.parse(readFileSync(agyManifestPath(), 'utf8'))
        assert.ok(!manifest.imports.some((entry: { name: string }) => entry.name === 'nsolid-skills-plugin'))
        assert.ok(manifest.imports.some((entry: { name: string }) => entry.name === 'unrelated-plugin'), 'unrelated agy import preserved')
      }
      assert.ok(existsSync(unrelatedSkill), `${harness} unrelated shared skill preserved`)
    }
  })

  it('uses the exact CLI commands for the canonical plugin and marketplace identities', async () => {
    seedAuth()
    await seedNativePlugin('claude', 'nsolid-skills-plugin@nodesource')
    await seedMarketplace('claude', 'nodesource')
    const { calls, runCli } = await simulateNativeCli()
    const { uninstall } = await import('../../src/index.js')
    await uninstall('claude', { runCli })
    assert.deepStrictEqual(calls, [
      { cmd: 'claude', args: ['plugin', 'uninstall', 'nsolid-skills-plugin@nodesource', '--scope', 'user'] },
      { cmd: 'claude', args: ['plugin', 'marketplace', 'remove', 'nodesource', '--scope', 'user'] },
    ])

    tmpDir = mkdtempSync(join(tmpdir(), 'nsolid-full-uninstall-'))
    process.env.HOME = tmpDir
    process.env.USERPROFILE = tmpDir
    await seedNativePlugin('codex', 'nsolid-skills-plugin@nodesource')
    await seedMarketplace('codex', 'nodesource')
    const codex = await simulateNativeCli()
    await (await import('../../src/index.js')).uninstall('codex', { runCli: codex.runCli })
    assert.deepStrictEqual(codex.calls, [
      { cmd: 'codex', args: ['plugin', 'remove', 'nsolid-skills-plugin@nodesource'] },
      { cmd: 'codex', args: ['plugin', 'marketplace', 'remove', 'nodesource'] },
    ])
  })

  it('still recognizes and removes the legacy nsolid-plugin identity', async () => {
    seedAuth()
    await seedNativePlugin('codex', 'nsolid-plugin@nodesource')
    await seedMarketplace('codex', 'nodesource')
    const { calls, runCli } = await simulateNativeCli()
    const result = await (await import('../../src/index.js')).uninstall('codex', { runCli })
    assert.deepStrictEqual(result.errors, [])
    assert.deepStrictEqual(calls[0], { cmd: 'codex', args: ['plugin', 'remove', 'nsolid-plugin@nodesource'] })
    assert.deepStrictEqual(await readPlugins('codex'), [])
  })

  it('plain and --external-mcp uninstall behave identically for all three harnesses (flag no longer narrows)', async () => {
    for (const harness of HARNESSES) {
      const pluginId = harness === 'antigravity' ? 'nsolid-skills-plugin' : 'nsolid-skills-plugin@nodesource'
      tmpDir = mkdtempSync(join(tmpdir(), 'nsolid-full-uninstall-'))
      process.env.HOME = tmpDir
      process.env.USERPROFILE = tmpDir
      await seedNativePlugin(harness, pluginId)
      const plain = await simulateNativeCli()
      await (await import('../../src/index.js')).uninstall(harness, { runCli: plain.runCli })

      tmpDir = mkdtempSync(join(tmpdir(), 'nsolid-full-uninstall-'))
      process.env.HOME = tmpDir
      process.env.USERPROFILE = tmpDir
      await seedNativePlugin(harness, pluginId)
      const flagged = await simulateNativeCli()
      const flaggedResult = await (await import('../../src/index.js')).uninstall(harness, { runCli: flagged.runCli, externalMcp: true })

      assert.deepStrictEqual(flaggedResult.errors, [], harness)
      assert.deepStrictEqual(flagged.calls, plain.calls, `${harness} flag must not change the cleanup commands`)
    }
  })

  it('refuses when a Claude marketplace registration is declared in more than one scope', async () => {
    await seedMarketplace('claude', 'nodesource')
    const previousCwd = process.cwd()
    const projectDir = join(tmpDir, 'project')
    mkdirSync(join(projectDir, '.claude'), { recursive: true })
    writeFileSync(join(projectDir, '.claude/settings.json'), JSON.stringify({ extraKnownMarketplaces: { nodesource: {} } }))
    process.chdir(projectDir)
    try {
      await assert.rejects(
        () => import('../../src/index.js').then(({ uninstall }) => uninstall('claude')),
        (err: any) => {
          assert.strictEqual(err.code, 'UNINSTALL_PREFLIGHT_FAILED')
          assert.match(err.message, /multiple scopes/)
          return true
        }
      )
    } finally {
      process.chdir(previousCwd)
    }
  })
})

describe('full uninstall: preflight refusal without collateral', () => {
  it('refuses before effects when the nsolid marketplace also feeds an unrelated plugin (claude)', async () => {
    await seedNativePlugin('claude', 'nsolid-skills-plugin@nodesource')
    await seedMarketplace('claude', 'nodesource')
    await seedUnrelatedPluginFromMarketplace('claude', 'nodesource')
    const before = readFileSync(claudeInstalledPath(), 'utf8')
    const { calls, runCli } = await simulateNativeCli()

    await assert.rejects(
      () => import('../../src/index.js').then(({ uninstall }) => uninstall('claude', { runCli })),
      (err: any) => {
        assert.strictEqual(err.code, 'UNINSTALL_PREFLIGHT_FAILED')
        assert.match(err.message, /also feeds unrelated plugin/)
        return true
      }
    )
    assert.deepStrictEqual(calls, [], 'no native command may run after a preflight refusal')
    assert.strictEqual(readFileSync(claudeInstalledPath(), 'utf8'), before, 'registration byte-identical')
  })

  it('refuses before effects when the nsolid marketplace also feeds an unrelated plugin (codex)', async () => {
    await seedNativePlugin('codex', 'nsolid-skills-plugin@nodesource')
    await seedMarketplace('codex', 'nodesource')
    await seedUnrelatedPluginFromMarketplace('codex', 'nodesource')
    const before = readFileSync(codexConfigPath(), 'utf8')
    const { calls, runCli } = await simulateNativeCli()
    await assert.rejects(
      () => import('../../src/index.js').then(({ uninstall }) => uninstall('codex', { runCli })),
      (err: any) => { assert.strictEqual(err.code, 'UNINSTALL_PREFLIGHT_FAILED'); return true }
    )
    assert.deepStrictEqual(calls, [])
    assert.strictEqual(readFileSync(codexConfigPath(), 'utf8'), before)
  })

  it('refuses plain uninstall of an edited external-owned entry before any removal', async () => {
    const { install } = await import('../../src/index.js')
    seedAuth()
    const bundleDir = join(tmpDir, 'bundle')
    mkdirSync(bundleDir, { recursive: true })
    const bundle: BundleDescriptor = {
      name: 'ext',
      version: '1.0.0',
      skills: [{ name: 'ns-ext', path: 'skills/ns-ext', description: '' }],
      mcpServers: [{ name: 'nsolid-console', url: 'https://mcp.example.com/x', headers: { token: 'first' } }],
    }
    const bundlePath = join(bundleDir, 'bundle.json')
    writeFileSync(bundlePath, JSON.stringify(bundle))
    mkdirSync(join(tmpDir, 'source'), { recursive: true })
    await install({ harness: 'claude', bundlePath, skillsSource: join(tmpDir, 'source'), packageOwnedSkills: true, externalMcp: true })
    assert.ok(existsSync(join(tmpDir, '.claude.json')), 'external install wrote the claude MCP config')

    const configPath = join(tmpDir, '.claude.json')
    writeFileSync(configPath, readFileSync(configPath, 'utf8').replace('first', 'edited'))
    const before = readFileSync(configPath, 'utf8')
    const trackingBefore = readFileSync(trackingFile(), 'utf8')

    await assert.rejects(
      () => import('../../src/index.js').then(({ uninstall }) => uninstall('claude')),
      (err: any) => { assert.strictEqual(err.code, 'UNINSTALL_PREFLIGHT_FAILED'); return true }
    )
    assert.strictEqual(readFileSync(configPath, 'utf8'), before, 'edited entry aborts before effects')
    assert.strictEqual(readFileSync(trackingFile(), 'utf8'), trackingBefore)
  })

  // Preflight-atomicity regression: an ACTIVE record plus a DISCONNECTED
  // record whose recorded configPath exists but is unreadable must refuse the
  // WHOLE selection up front. The old disconnected branch swallowed the read
  // error, preflight passed, and execution deleted the active harness's
  // entries before failing on the unreadable one.
  it('refuses the whole selection when a disconnected record points at an unreadable config', async () => {
    const { fingerprintExternalMcpEntry } = await import('../../src/mcp/external-ownership.js')
    const claudeConfig = join(tmpDir, '.claude.json')
    // Antigravity's native-plugin inspection never reads the MCP config file,
    // so a corrupt mcp_config.json is only discovered through the
    // disconnected-branch ownership read — exactly the swallowed path.
    const agyMcpConfig = join(tmpDir, '.gemini', 'config', 'mcp_config.json')
    mkdirSync(dirname(agyMcpConfig), { recursive: true })
    const claudeEntry = { type: 'http', url: 'https://mcp.example.com/x', headers: { token: 't' } }
    writeFileSync(claudeConfig, JSON.stringify({ mcpServers: { 'nsolid-console': claudeEntry } }, null, 2))
    writeFileSync(agyMcpConfig, '{ not json')
    writeTracking({
      externalMcp: {
        claude: {
          state: 'active',
          updatedAt: FIXED_TS,
          entries: [{ name: 'nsolid-console', configPath: claudeConfig, fingerprint: fingerprintExternalMcpEntry(claudeEntry) as string, recordedAt: FIXED_TS }],
        },
        antigravity: {
          state: 'disconnected',
          updatedAt: FIXED_TS,
          entries: [{ name: 'nsolid-console', configPath: agyMcpConfig, fingerprint: '0'.repeat(64), recordedAt: FIXED_TS }],
        },
      },
    })
    seedAuth()

    const claudeBefore = readFileSync(claudeConfig, 'utf8')
    const agyBefore = readFileSync(agyMcpConfig, 'utf8')
    const trackingBefore = readFileSync(trackingFile(), 'utf8')

    await assert.rejects(
      () => import('../../src/uninstall.js').then(({ uninstallHarnesses }) => uninstallHarnesses(['claude', 'antigravity'])),
      (err: any) => {
        assert.strictEqual(err.code, 'UNINSTALL_PREFLIGHT_FAILED')
        assert.ok(err.message.includes(`Cannot read ${agyMcpConfig} to verify antigravity`), err.message)
        assert.ok(!err.message.includes('verify claude'), 'the active record verified fine and must not be blamed')
        return true
      }
    )
    assert.strictEqual(readFileSync(claudeConfig, 'utf8'), claudeBefore, 'claude entries must NOT be deleted when the selection is refused')
    assert.strictEqual(readFileSync(agyMcpConfig, 'utf8'), agyBefore)
    assert.strictEqual(readFileSync(trackingFile(), 'utf8'), trackingBefore)
  })

  it('rejects corrupt tracking before any effect', async () => {
    mkdirSync(join(tmpDir, '.agents'), { recursive: true })
    writeFileSync(trackingFile(), '{ not json')
    await assert.rejects(
      () => import('../../src/index.js').then(({ uninstall }) => uninstall('claude')),
      (err: any) => { assert.strictEqual(err.code, 'TRACKING_CORRUPT'); return true }
    )
    assert.strictEqual(readFileSync(trackingFile(), 'utf8'), '{ not json')
  })

  // Preflight atomicity regression for the LEGACY tracked branch: the legacy
  // MCP stage reads the harness config during removeMcpConfig, so a malformed
  // config was only discovered mid-run — after earlier harnesses in the
  // selection had already been mutated. Preflight must read every config the
  // execution will edit (tracked legacy entries, no external record) before
  // any effect.
  it('refuses the whole selection when a tracked legacy harness config is unreadable', async () => {
    const { uninstallHarnesses } = await import('../../src/uninstall.js')
    seedAuth()
    await seedTrackedInstall('codex')
    await seedTrackedInstall('claude')
    const claudeConfig = join(tmpDir, '.claude.json')
    writeFileSync(claudeConfig, '{ not json')

    const codexBefore = readFileSync(codexConfigPath(), 'utf8')
    const claudeBefore = readFileSync(claudeConfig, 'utf8')
    const trackingBefore = readFileSync(trackingFile(), 'utf8')

    await assert.rejects(
      () => uninstallHarnesses(['codex', 'claude']),
      (err: any) => {
        assert.strictEqual(err.code, 'UNINSTALL_PREFLIGHT_FAILED')
        assert.ok(err.message.includes(`Cannot read ${claudeConfig} to verify claude`), err.message)
        return true
      }
    )
    assert.strictEqual(readFileSync(codexConfigPath(), 'utf8'), codexBefore, 'codex entries must NOT be deleted when the selection is refused')
    assert.strictEqual(readFileSync(claudeConfig, 'utf8'), claudeBefore)
    assert.strictEqual(readFileSync(trackingFile(), 'utf8'), trackingBefore)
    assert.ok(codexBefore.includes('nsolid-console'), 'fixture sanity: codex tracked the MCP entry')
  })

  for (const harness of ['claude', 'opencode'] as const) {
    it(`removes valid tracked legacy configs for codex and ${harness}`, async () => {
      const { uninstallHarnesses } = await import('../../src/uninstall.js')
      seedAuth()
      await seedTrackedInstall('codex')
      await seedTrackedInstall(harness)

      const batch = await uninstallHarnesses(['codex', harness])

      assert.strictEqual(batch.success, true, JSON.stringify(batch.results.map((r) => r.errors)))
      const configPath = join(tmpDir, harness === 'claude' ? '.claude.json' : '.config/opencode/opencode.jsonc')
      for (const file of [codexConfigPath(), configPath]) {
        assert.ok(!readFileSync(file, 'utf8').includes('nsolid-console'), `${file}: MCP entry removed`)
      }
    })
  }

  it('green-lock: an external record keeps preflight coverage and legacy harnesses stay readable', async () => {
    // An external record routes the claude MCP stage through the ownership
    // branches; the new legacy preflight read must not add reads for that
    // harness, and the tracked codex config (valid) must not trigger a refusal.
    const { fingerprintExternalMcpEntry } = await import('../../src/mcp/external-ownership.js')
    const { uninstallHarnesses } = await import('../../src/uninstall.js')
    seedAuth()
    await seedTrackedInstall('codex')
    const claudeConfig = join(tmpDir, '.claude.json')
    const claudeEntry = { type: 'http', url: 'https://mcp.example.com/x', headers: { token: 't' } }
    writeFileSync(claudeConfig, JSON.stringify({ mcpServers: { 'nsolid-console': claudeEntry } }, null, 2))
    // Merge the external record into the existing tracking so the codex legacy
    // entries seeded above stay intact.
    const tracking = JSON.parse(readFileSync(trackingFile(), 'utf8'))
    tracking.externalMcp = {
      claude: {
        state: 'active',
        updatedAt: FIXED_TS,
        entries: [{ name: 'nsolid-console', configPath: claudeConfig, fingerprint: fingerprintExternalMcpEntry(claudeEntry) as string, recordedAt: FIXED_TS }],
      },
    }
    writeFileSync(trackingFile(), JSON.stringify(tracking))

    const batch = await uninstallHarnesses(['codex', 'claude'])

    assert.strictEqual(batch.success, true, JSON.stringify(batch.results.map((r) => r.errors)))
    assert.ok(!readFileSync(codexConfigPath(), 'utf8').includes('nsolid-console'), 'codex MCP entry removed')
  })
})

describe('full uninstall: truthful partial failure and retry', () => {
  it('reports nonzero when a native plugin cannot be removed and never claims success', async () => {
    // The CLI is missing and the config fallback cannot run because the shared
    // backup directory is unusable: the command must surface the failure rather
    // than claim the plugin is gone.
    await seedNativePlugin('claude', 'nsolid-skills-plugin@nodesource')
    const installedPath = claudeInstalledPath()
    const before = readFileSync(installedPath, 'utf8')
    mkdirSync(join(tmpDir, '.agents'), { recursive: true })
    writeFileSync(join(tmpDir, '.agents/.config-backup'), 'not a directory')
    const result = await (await import('../../src/index.js')).uninstall('claude', {
      runCli: async () => { throw new Error('ENOENT') },
    })
    assert.strictEqual(result.success, false)
    assert.ok(result.errors.some((entry) => entry.includes('still installed')), result.errors.join('; '))
    const stage = result.stages.find((entry) => entry.stage === 'nativePlugin')
    assert.strictEqual(stage?.status, 'failed')
    assert.strictEqual(readFileSync(installedPath, 'utf8'), before, 'a failed removal must not corrupt the registry')
  })

  it('reports an unsupported agy marketplace registration honestly and does not invent a command', async () => {
    mkdirSync(join(tmpDir, '.gemini/config/plugins/marketplaces/nsolid-skills-plugin'), { recursive: true })
    const { calls, runCli } = await simulateNativeCli()
    const result = await (await import('../../src/index.js')).uninstall('antigravity', { runCli })
    assert.strictEqual(result.success, false)
    assert.ok(result.errors.some((entry) => entry.includes('no supported marketplace-remove command')), result.errors.join('; '))
    assert.ok(!calls.some((call) => call.args.includes('marketplace')), 'no marketplace-remove command may be invented for agy')
  })

  it('retries marketplace cleanup on a repeated uninstall after a partial failure', async () => {
    await seedNativePlugin('codex', 'nsolid-skills-plugin@nodesource')
    await seedMarketplace('codex', 'nodesource')

    const first = await simulateNativeCli({ failMarketplaceOnce: true })
    const firstResult = await (await import('../../src/index.js')).uninstall('codex', { runCli: first.runCli })
    assert.strictEqual(firstResult.success, false)
    assert.ok(firstResult.errors.some((entry) => entry.includes('marketplace')), firstResult.errors.join('; '))
    assert.deepStrictEqual(await readPlugins('codex'), [], 'plugin removed before the marketplace failure')

    // Retry must actually retry the marketplace stage, not return early.
    const retry = await simulateNativeCli()
    const retryResult = await (await import('../../src/index.js')).uninstall('codex', { runCli: retry.runCli })
    assert.strictEqual(retryResult.success, true, retryResult.errors.join('; '))
    assert.ok(retry.calls.some((call) => call.args[1] === 'marketplace'), 'retry re-runs marketplace removal')
    assert.strictEqual(retryResult.stages.find((entry) => entry.stage === 'marketplace')?.status, 'removed')
  })
})

describe('full uninstall: no-tracking ownership is never inferred by name', () => {
  it('refuses before effects when shared ns-* skills exist but there is no tracking file', async () => {
    const sharedSkill = join(tmpDir, '.agents/skills/ns-shared')
    mkdirSync(sharedSkill, { recursive: true })
    writeFileSync(join(sharedSkill, 'SKILL.md'), '# shared')
    await seedNativePlugin('claude', 'nsolid-skills-plugin@nodesource')
    const installedBefore = readFileSync(claudeInstalledPath(), 'utf8')
    const { calls, runCli } = await simulateNativeCli()

    await assert.rejects(
      () => import('../../src/index.js').then(({ uninstall }) => uninstall('claude', { runCli })),
      (err: any) => {
        assert.strictEqual(err.code, 'UNINSTALL_PREFLIGHT_FAILED')
        assert.match(err.message, /no tracking file/)
        return true
      }
    )
    assert.deepStrictEqual(calls, [], 'no native command may run after a no-tracking refusal')
    assert.ok(existsSync(join(sharedSkill, 'SKILL.md')), 'shared skill preserved')
    assert.strictEqual(readFileSync(claudeInstalledPath(), 'utf8'), installedBefore, 'registry byte-identical')
  })

  it('refuses before effects when the harness MCP config holds NodeSource servers but there is no tracking file', async () => {
    writeFileSync(join(tmpDir, '.claude.json'), JSON.stringify({
      mcpServers: { 'nsolid-console': { url: 'https://mcp.example.com/x' }, unrelated: { command: 'x' } },
    }))
    const before = readFileSync(join(tmpDir, '.claude.json'), 'utf8')
    const { calls, runCli } = await simulateNativeCli()
    await assert.rejects(
      () => import('../../src/index.js').then(({ uninstall }) => uninstall('claude', { runCli })),
      (err: any) => {
        assert.strictEqual(err.code, 'UNINSTALL_PREFLIGHT_FAILED')
        assert.match(err.message, /nsolid-console/)
        return true
      }
    )
    assert.deepStrictEqual(calls, [])
    assert.strictEqual(readFileSync(join(tmpDir, '.claude.json'), 'utf8'), before, 'MCP config byte-identical')
  })

  it('with no tracking file and no nsolid-like shared content, removes only the exact native plugin', async () => {
    await seedNativePlugin('claude', 'nsolid-skills-plugin@nodesource')
    const { calls, runCli } = await simulateNativeCli()
    const result = await (await import('../../src/index.js')).uninstall('claude', { runCli })
    assert.deepStrictEqual(result.errors, [])
    assert.strictEqual(result.stages.find((entry) => entry.stage === 'skills')?.status, 'not-present')
    assert.strictEqual(result.stages.find((entry) => entry.stage === 'mcp')?.status, 'not-present')
    assert.deepStrictEqual(
      calls.filter((call) => call.args[1] === 'uninstall').map((call) => call.args),
      [['plugin', 'uninstall', 'nsolid-skills-plugin@nodesource', '--scope', 'user']]
    )
  })
})

describe('full uninstall: malformed registries fail closed before effects', () => {
  it('refuses and preserves bytes when the Claude installed registry is corrupt', async () => {
    mkdirSync(dirname(claudeInstalledPath()), { recursive: true })
    writeFileSync(claudeInstalledPath(), '{ not json')
    await seedMarketplace('claude', 'nodesource')
    const installedBefore = readFileSync(claudeInstalledPath(), 'utf8')
    const settingsBefore = readFileSync(claudeSettingsPath(), 'utf8')
    const { calls, runCli } = await simulateNativeCli()

    await assert.rejects(
      () => import('../../src/index.js').then(({ uninstall }) => uninstall('claude', { runCli })),
      (err: any) => {
        assert.strictEqual(err.code, 'UNINSTALL_PREFLIGHT_FAILED')
        assert.match(err.message, /installed_plugins\.json/)
        return true
      }
    )
    assert.deepStrictEqual(calls, [], 'a corrupt registry must not authorize any CLI call')
    assert.strictEqual(readFileSync(claudeInstalledPath(), 'utf8'), installedBefore, 'corrupt registry bytes preserved')
    assert.strictEqual(readFileSync(claudeSettingsPath(), 'utf8'), settingsBefore, 'marketplace registration preserved')
  })

  it('refuses and preserves bytes when a Claude marketplace settings file is corrupt', async () => {
    mkdirSync(dirname(claudeSettingsPath()), { recursive: true })
    writeFileSync(claudeSettingsPath(), '{ not json')
    const before = readFileSync(claudeSettingsPath(), 'utf8')
    const { calls, runCli } = await simulateNativeCli()
    await assert.rejects(
      () => import('../../src/index.js').then(({ uninstall }) => uninstall('claude', { runCli })),
      (err: any) => {
        assert.strictEqual(err.code, 'UNINSTALL_PREFLIGHT_FAILED')
        assert.match(err.message, /not valid JSON/)
        return true
      }
    )
    assert.deepStrictEqual(calls, [])
    assert.strictEqual(readFileSync(claudeSettingsPath(), 'utf8'), before)
  })

  it('refuses and preserves bytes when the Codex config is corrupt', async () => {
    mkdirSync(dirname(codexConfigPath()), { recursive: true })
    writeFileSync(codexConfigPath(), 'this is = not valid toml [[[')
    const before = readFileSync(codexConfigPath(), 'utf8')
    const { calls, runCli } = await simulateNativeCli()
    await assert.rejects(
      () => import('../../src/index.js').then(({ uninstall }) => uninstall('codex', { runCli })),
      (err: any) => { assert.strictEqual(err.code, 'UNINSTALL_PREFLIGHT_FAILED'); return true }
    )
    assert.deepStrictEqual(calls, [])
    assert.strictEqual(readFileSync(codexConfigPath(), 'utf8'), before)
  })

  it('refuses and preserves bytes when the Antigravity import manifest is corrupt', async () => {
    mkdirSync(dirname(agyManifestPath()), { recursive: true })
    writeFileSync(agyManifestPath(), '{ not json')
    const before = readFileSync(agyManifestPath(), 'utf8')
    const { calls, runCli } = await simulateNativeCli()
    await assert.rejects(
      () => import('../../src/index.js').then(({ uninstall }) => uninstall('antigravity', { runCli })),
      (err: any) => { assert.strictEqual(err.code, 'UNINSTALL_PREFLIGHT_FAILED'); return true }
    )
    assert.deepStrictEqual(calls, [])
    assert.strictEqual(readFileSync(agyManifestPath(), 'utf8'), before)
  })
})

describe('full uninstall: Antigravity import manifest accepts real agy-written state', () => {
  // The real Antigravity CLI rewrites import_manifest.json as {"imports": null}
  // once its last import is removed (observed with `agy plugin uninstall`).
  // That is a legitimate empty state, not a corrupt manifest: uninstall must
  // proceed instead of failing closed on a shape the real CLI produces.
  it('completes the tracked antigravity uninstall when the manifest is the real agy-written {"imports": null}', async () => {
    mkdirSync(dirname(agyManifestPath()), { recursive: true })
    writeFileSync(agyManifestPath(), JSON.stringify({ imports: null }))
    const before = readFileSync(agyManifestPath(), 'utf8')
    await seedTrackedInstall('antigravity')
    const { runCli } = await simulateNativeCli()

    const result = await (await import('../../src/index.js')).uninstall('antigravity', { runCli })

    assert.deepStrictEqual(result.errors, [])
    assert.strictEqual(readFileSync(agyManifestPath(), 'utf8'), before, 'legitimate empty manifest bytes preserved')
  })

  it('still refuses when "imports" is a non-null non-array value', async () => {
    mkdirSync(dirname(agyManifestPath()), { recursive: true })
    writeFileSync(agyManifestPath(), JSON.stringify({ imports: { not: 'an array' } }))
    const before = readFileSync(agyManifestPath(), 'utf8')
    const { calls, runCli } = await simulateNativeCli()

    await assert.rejects(
      () => import('../../src/index.js').then(({ uninstall }) => uninstall('antigravity', { runCli })),
      (err: any) => {
        assert.strictEqual(err.code, 'UNINSTALL_PREFLIGHT_FAILED')
        assert.match(err.message, /is not an array/)
        return true
      }
    )
    assert.deepStrictEqual(calls, [])
    assert.strictEqual(readFileSync(agyManifestPath(), 'utf8'), before)
  })

  it('attributes the refusal to the selection, not to the first harness', async () => {
    mkdirSync(dirname(agyManifestPath()), { recursive: true })
    writeFileSync(agyManifestPath(), JSON.stringify({ imports: { not: 'an array' } }))
    writeTracking({})
    const { calls, runCli } = await simulateNativeCli()

    await assert.rejects(
      () => import('../../src/index.js').then(({ uninstallHarnesses }) => uninstallHarnesses(['claude', 'antigravity'], { runCli })),
      (err: any) => {
        assert.strictEqual(err.code, 'UNINSTALL_PREFLIGHT_FAILED')
        assert.strictEqual(err.harness, undefined, 'a multi-harness refusal must not claim a single harness')
        return true
      }
    )
    await assert.rejects(
      () => import('../../src/index.js').then(({ uninstall }) => uninstall('antigravity', { runCli })),
      (err: any) => {
        assert.strictEqual(err.code, 'UNINSTALL_PREFLIGHT_FAILED')
        assert.strictEqual(err.harness, 'antigravity', 'a single-harness refusal still names its harness')
        return true
      }
    )
    assert.deepStrictEqual(calls, [], 'no native command may run after a preflight refusal')
  })
})

describe('full uninstall: Claude install scope attribution', () => {
  it('removes every explicitly attributable Claude scope and preserves other registrations', async () => {
    mkdirSync(dirname(claudeInstalledPath()), { recursive: true })
    writeFileSync(claudeInstalledPath(), JSON.stringify({
      version: 2,
      plugins: {
        'nsolid-skills-plugin@nodesource': [{ scope: 'user' }, { scope: 'local' }],
        'other-plugin@x': [{ scope: 'user' }],
      },
    }))
    writeFileSync(join(tmpDir, '.claude.json'), JSON.stringify({
      enabledPlugins: { 'nsolid-skills-plugin@nodesource': true, 'other-plugin@x': true },
    }))
    const { calls, runCli } = await simulateNativeCli()
    const result = await (await import('../../src/index.js')).uninstall('claude', { runCli })

    assert.deepStrictEqual(result.errors, [])
    const uninstallCalls = calls.filter((call) => call.args[1] === 'uninstall').map((call) => call.args)
    assert.deepStrictEqual(uninstallCalls, [
      ['plugin', 'uninstall', 'nsolid-skills-plugin@nodesource', '--scope', 'user'],
      ['plugin', 'uninstall', 'nsolid-skills-plugin@nodesource', '--scope', 'local'],
    ], 'every removal must name its exact scope; no scope-wide command')
    assert.ok(!calls.some((call) => call.args[1] === 'uninstall' && !call.args.includes('--scope')), 'never a scope-less Claude uninstall')

    const data = JSON.parse(readFileSync(claudeInstalledPath(), 'utf8'))
    assert.ok(!('nsolid-skills-plugin@nodesource' in data.plugins), 'all nsolid scopes removed')
    assert.deepStrictEqual(data.plugins['other-plugin@x'], [{ scope: 'user' }], 'unrelated plugin registration preserved')
  })

  it('refuses before effects when a Claude project install spans multiple project paths', async () => {
    mkdirSync(dirname(claudeInstalledPath()), { recursive: true })
    writeFileSync(claudeInstalledPath(), JSON.stringify({
      version: 2,
      plugins: {
        'nsolid-skills-plugin@nodesource': [
          { scope: 'project', projectPath: '/tmp/project-a' },
          { scope: 'project', projectPath: '/tmp/project-b' },
        ],
      },
    }))
    const before = readFileSync(claudeInstalledPath(), 'utf8')
    const { calls, runCli } = await simulateNativeCli()
    await assert.rejects(
      () => import('../../src/index.js').then(({ uninstall }) => uninstall('claude', { runCli })),
      (err: any) => {
        assert.strictEqual(err.code, 'UNINSTALL_PREFLIGHT_FAILED')
        assert.match(err.message, /multiple project paths/)
        return true
      }
    )
    assert.deepStrictEqual(calls, [])
    assert.strictEqual(readFileSync(claudeInstalledPath(), 'utf8'), before)
  })

  it('refuses before effects when a Claude install record has no recognizable scope', async () => {
    mkdirSync(dirname(claudeInstalledPath()), { recursive: true })
    writeFileSync(claudeInstalledPath(), JSON.stringify({
      version: 2,
      plugins: { 'nsolid-skills-plugin@nodesource': [] },
    }))
    const before = readFileSync(claudeInstalledPath(), 'utf8')
    const { calls, runCli } = await simulateNativeCli()
    await assert.rejects(
      () => import('../../src/index.js').then(({ uninstall }) => uninstall('claude', { runCli })),
      (err: any) => { assert.strictEqual(err.code, 'UNINSTALL_PREFLIGHT_FAILED'); return true }
    )
    assert.deepStrictEqual(calls, [])
    assert.strictEqual(readFileSync(claudeInstalledPath(), 'utf8'), before)
  })
})

describe('full uninstall: Antigravity marketplace evidence survives execution and retries', () => {
  async function seedManifestOnlyMarketplace (): Promise<void> {
    mkdirSync(agyPluginDir('nsolid-skills-plugin'), { recursive: true })
    writeFileSync(join(agyPluginDir('nsolid-skills-plugin'), 'plugin.json'), JSON.stringify({ name: 'nsolid-skills-plugin' }))
    mkdirSync(dirname(agyManifestPath()), { recursive: true })
    writeFileSync(agyManifestPath(), JSON.stringify({
      imports: [
        { name: 'nsolid-skills-plugin', source: 'marketplace', marketplace: 'nodesource' },
        { name: 'unrelated-plugin', source: 'local' },
      ],
    }))
  }

  it('recognizes the canonical nodesource link identity exactly', async () => {
    mkdirSync(join(tmpDir, '.gemini/config/plugins/marketplaces/nodesource'), { recursive: true })
    const { calls, runCli } = await simulateNativeCli()
    const result = await (await import('../../src/index.js')).uninstall('antigravity', { runCli })
    assert.strictEqual(result.success, false)
    assert.strictEqual(result.stages.find((entry) => entry.stage === 'marketplace')?.status, 'unsupported')
    assert.ok(!calls.some((call) => call.args.includes('marketplace')), 'no agy marketplace command may be invented')
  })

  it('does not treat an unrelated similarly-named link as nsolid', async () => {
    mkdirSync(join(tmpDir, '.gemini/config/plugins/marketplaces/nodesource-tools'), { recursive: true })
    const { runCli } = await simulateNativeCli()
    const result = await (await import('../../src/index.js')).uninstall('antigravity', { runCli })
    assert.deepStrictEqual(result.errors, [])
    assert.strictEqual(result.stages.find((entry) => entry.stage === 'marketplace')?.status, 'not-present')
  })

  it('keeps the manifest-only marketplace actionable after native removal and on retry', async () => {
    await seedManifestOnlyMarketplace()
    const first = await simulateNativeCli()
    const firstResult = await (await import('../../src/index.js')).uninstall('antigravity', { runCli: first.runCli })
    assert.strictEqual(firstResult.success, false)
    assert.strictEqual(firstResult.stages.find((entry) => entry.stage === 'nativePlugin')?.status, 'removed')
    assert.strictEqual(firstResult.stages.find((entry) => entry.stage === 'marketplace')?.status, 'unsupported')
    assert.ok(firstResult.errors.some((entry) => entry.includes('no supported marketplace-remove command')), firstResult.errors.join('; '))
    assert.strictEqual(existsSync(agyPluginDir('nsolid-skills-plugin')), false, 'native plugin removed')

    // Retry: the manifest evidence is gone, but the durable record must keep the
    // manual marketplace stage actionable instead of reporting success.
    const retry = await simulateNativeCli()
    const retryResult = await (await import('../../src/index.js')).uninstall('antigravity', { runCli: retry.runCli })
    assert.strictEqual(retryResult.success, false)
    assert.strictEqual(retryResult.stages.find((entry) => entry.stage === 'marketplace')?.status, 'unsupported')
    assert.ok(retryResult.errors.some((entry) => entry.includes('no supported marketplace-remove command')), retryResult.errors.join('; '))
    assert.ok(!retry.calls.some((call) => call.args.includes('marketplace')), 'no agy marketplace command may be invented')
  })
})

describe('full uninstall: multi-harness shared skills', () => {
  it('deletes attributable orphaned shared content once the last selected owner is unlinked', async () => {
    seedAuth()
    await seedTrackedInstall('claude')
    await seedTrackedInstall('codex')
    const tracking = JSON.parse(readFileSync(trackingFile(), 'utf8'))
    const entry = tracking.skills.find((skill: { name: string }) => skill.name === 'ns-tracked-skill')
    assert.deepStrictEqual([...entry.harnesses].sort(), ['claude', 'codex'])
    const sharedDir = join(tmpDir, '.agents/skills/ns-tracked-skill')
    assert.ok(existsSync(sharedDir))

    await seedNativePlugin('claude', 'nsolid-skills-plugin@nodesource')
    await seedNativePlugin('codex', 'nsolid-skills-plugin@nodesource')
    const { runCli } = await simulateNativeCli()
    const batch = await (await import('../../src/index.js')).uninstallHarnesses(['claude', 'codex'], { runCli })
    assert.strictEqual(batch.success, true, batch.results.flatMap((r) => r.errors).join('; '))
    assert.strictEqual(existsSync(sharedDir), false, 'orphaned shared content removed after both owners are gone')
  })

  it('preserves shared content that still has a non-selected owner', async () => {
    seedAuth()
    await seedTrackedInstall('claude')
    await seedTrackedInstall('codex')
    const sharedDir = join(tmpDir, '.agents/skills/ns-tracked-skill')
    await seedNativePlugin('claude', 'nsolid-skills-plugin@nodesource')
    const { runCli } = await simulateNativeCli()
    const result = await (await import('../../src/index.js')).uninstall('claude', { runCli })
    assert.deepStrictEqual(result.errors, [])
    assert.ok(existsSync(sharedDir), 'shared content preserved for the non-selected codex owner')
    const tracking = JSON.parse(readFileSync(trackingFile(), 'utf8'))
    const entry = tracking.skills.find((skill: { name: string }) => skill.name === 'ns-tracked-skill')
    assert.deepStrictEqual(entry.harnesses, ['codex'], 'ownership narrowed to the remaining owner')
  })
})

describe('full uninstall: external MCP tombstone does not stop plugin/marketplace retries', () => {
  it('continues native plugin and marketplace cleanup on retry after an MCP-only disconnect', async () => {
    const { install } = await import('../../src/index.js')
    seedAuth()
    const bundleDir = join(tmpDir, 'bundle')
    mkdirSync(bundleDir, { recursive: true })
    const bundle: BundleDescriptor = {
      name: 'ext',
      version: '1.0.0',
      skills: [{ name: 'ns-ext', path: 'skills/ns-ext', description: '' }],
      mcpServers: [{ name: 'nsolid-console', url: 'https://mcp.example.com/x', headers: { token: 'dummy' } }],
    }
    const bundlePath = join(bundleDir, 'bundle.json')
    writeFileSync(bundlePath, JSON.stringify(bundle))
    mkdirSync(join(tmpDir, 'source'), { recursive: true })
    const installed = await install({
      harness: 'codex',
      bundlePath,
      skillsSource: join(tmpDir, 'source'),
      packageOwnedSkills: true,
      externalMcp: true,
    })
    assert.strictEqual(installed.success, true, installed.errors.join('; '))
    await seedNativePlugin('codex', 'nsolid-skills-plugin@nodesource')
    await seedMarketplace('codex', 'nodesource')

    const first = await simulateNativeCli({ failMarketplaceOnce: true })
    const firstResult = await (await import('../../src/index.js')).uninstall('codex', { runCli: first.runCli })
    assert.strictEqual(firstResult.success, false)
    assert.strictEqual(firstResult.stages.find((entry) => entry.stage === 'mcp')?.status, 'removed', 'external MCP entries disconnected')
    assert.strictEqual(firstResult.stages.find((entry) => entry.stage === 'nativePlugin')?.status, 'removed')
    assert.strictEqual(firstResult.stages.find((entry) => entry.stage === 'marketplace')?.status, 'failed')

    const retry = await simulateNativeCli()
    const retryResult = await (await import('../../src/index.js')).uninstall('codex', { runCli: retry.runCli })
    assert.strictEqual(retryResult.success, true, retryResult.errors.join('; '))
    assert.strictEqual(retryResult.stages.find((entry) => entry.stage === 'mcp')?.status, 'not-present', 'already-disconnected tombstone is a no-op')
    assert.strictEqual(retryResult.stages.find((entry) => entry.stage === 'marketplace')?.status, 'removed')
    assert.ok(retry.calls.some((call) => call.args[1] === 'marketplace'), 'retry still runs the marketplace stage')
  })
})

/**
 * Six reviewer-identified regressions. Each fixture reproduces an accepted
 * malformed/ambiguous state that must be refused before any CLI call or file
 * change, and each assertion is written to fail on the pre-fix behaviour.
 */
describe('full uninstall: pending marketplace state is validated and preflighted', () => {
  const RECORDED = FIXED_TS

  async function seedNativeAndMarketplace (): Promise<void> {
    await seedNativePlugin('claude', 'nsolid-skills-plugin@nodesource')
    await seedMarketplace('claude', 'nodesource')
  }

  async function expectRefusal (code: string, externalMcp?: boolean): Promise<void> {
    const before = {
      installed: readFileSync(claudeInstalledPath(), 'utf8'),
      settings: readFileSync(claudeSettingsPath(), 'utf8'),
      tracking: readFileSync(trackingFile(), 'utf8'),
    }
    const { calls, runCli } = await simulateNativeCli()
    await assert.rejects(
      () => import('../../src/index.js').then(({ uninstall }) =>
        uninstall('claude', externalMcp === undefined ? { runCli } : { runCli, externalMcp })),
      (err: any) => {
        assert.strictEqual(err.code, code)
        return true
      }
    )
    assert.deepStrictEqual(calls, [], 'a refusal must not run any harness CLI')
    assert.strictEqual(readFileSync(claudeInstalledPath(), 'utf8'), before.installed, 'registry byte-identical')
    assert.strictEqual(readFileSync(claudeSettingsPath(), 'utf8'), before.settings, 'marketplace settings byte-identical')
    assert.strictEqual(readFileSync(trackingFile(), 'utf8'), before.tracking, 'tracking file byte-identical')
  }

  it('validates pendingMarketplaceRemovals even when externalMcp is absent (plain and flagged)', async () => {
    await seedNativeAndMarketplace()
    writeTracking({ pendingMarketplaceRemovals: 'corrupt' })
    await expectRefusal('TRACKING_CORRUPT')
    await expectRefusal('TRACKING_CORRUPT', true)
  })

  it('rejects an unrelated pending marketplace target even with an empty externalMcp', async () => {
    await seedNativeAndMarketplace()
    writeTracking({
      externalMcp: {},
      pendingMarketplaceRemovals: { claude: [{ name: 'unrelated-marketplace', scope: 'bogus', reason: 'retry' }] },
    })
    await expectRefusal('TRACKING_CORRUPT')
  })

  it('rejects pending records with an unsupported name, harness, scope, shape or field', async () => {
    await seedNativeAndMarketplace()
    const cases: Array<[string, unknown]> = [
      ['unknown harness key', { 'not-a-harness': [] }],
      ['non-object record', { claude: [42] }],
      ['unrelated marketplace name', { claude: [{ name: 'nodesource-tools', scope: 'user', reason: 'r', recordedAt: RECORDED }] }],
      ['plugin base name used as a marketplace name', { claude: [{ name: 'nsolid-skills-plugin', scope: 'user', reason: 'r', recordedAt: RECORDED }] }],
      ['invalid explicit scope', { claude: [{ name: 'nodesource', scope: 'bogus', reason: 'r', recordedAt: RECORDED }] }],
      ['non-string scope', { claude: [{ name: 'nodesource', scope: 7, reason: 'r', recordedAt: RECORDED }] }],
      ['missing Claude scope', { claude: [{ name: 'nodesource', reason: 'r', recordedAt: RECORDED }] }],
      ['scope on a non-Claude harness', { codex: [{ name: 'nodesource', scope: 'user', reason: 'r', recordedAt: RECORDED }] }],
      ['missing reason', { claude: [{ name: 'nodesource', scope: 'user', recordedAt: RECORDED }] }],
    ]
    for (const [label, pending] of cases) {
      writeTracking({ pendingMarketplaceRemovals: pending })
      await assert.rejects(
        () => import('../../src/index.js').then(({ uninstall }) => uninstall('claude', { runCli: async () => 0 })),
        (err: any) => {
          assert.strictEqual(err.code, 'TRACKING_CORRUPT', label)
          return true
        }
      )
    }
  })

  it('accepts the canonical and legacy-experimental pending marketplace identities', async () => {
    await seedNativeAndMarketplace()
    writeTracking({
      externalMcp: {},
      pendingMarketplaceRemovals: {
        claude: [{ name: 'nsolid-skills', scope: 'user', reason: 'manual', recordedAt: RECORDED }],
        codex: [{ name: 'nodesource', reason: 'manual', recordedAt: RECORDED }],
        antigravity: [{ name: 'nodesource', reason: 'manual', recordedAt: RECORDED }],
      },
    })
    const { calls, runCli } = await simulateNativeCli()
    const result = await (await import('../../src/index.js')).uninstall('claude', { runCli })
    assert.deepStrictEqual(result.errors, [])
    assert.strictEqual(result.stages.find((entry) => entry.stage === 'marketplace')?.status, 'removed')
    assert.ok(
      calls.some((call) => call.args[1] === 'marketplace' && call.args[3] === 'nsolid-skills'),
      'the durable legacy pending target is still removed'
    )
  })

  it('refuses when a durable pending target feeds an unrelated plugin although the fresh registration was erased', async () => {
    mkdirSync(dirname(claudeInstalledPath()), { recursive: true })
    writeFileSync(claudeInstalledPath(), JSON.stringify({
      version: 2,
      plugins: { 'other-plugin@nodesource': [{ scope: 'user' }] },
    }))
    writeTracking({
      pendingMarketplaceRemovals: { claude: [{ name: 'nodesource', scope: 'user', reason: 'manual', recordedAt: RECORDED }] },
    })
    const installedBefore = readFileSync(claudeInstalledPath(), 'utf8')
    const { calls, runCli } = await simulateNativeCli()
    await assert.rejects(
      () => import('../../src/index.js').then(({ uninstall }) => uninstall('claude', { runCli })),
      (err: any) => {
        assert.strictEqual(err.code, 'UNINSTALL_PREFLIGHT_FAILED')
        assert.match(err.message, /also feeds unrelated plugin/)
        return true
      }
    )
    assert.deepStrictEqual(calls, [], 'no marketplace command may run for a shared pending target')
    assert.strictEqual(readFileSync(claudeInstalledPath(), 'utf8'), installedBefore)
  })

  it('refuses when the durable pending scope conflicts with the freshly inspected scope', async () => {
    // Fresh evidence: a single project-scope registration. Durable evidence: a
    // user-scope removal for the same marketplace. The combined plan names two
    // scopes, so removing both would touch registrations outside the inspection.
    const projectDir = join(tmpDir, 'project')
    mkdirSync(join(projectDir, '.claude'), { recursive: true })
    writeFileSync(join(projectDir, '.claude/settings.json'), JSON.stringify({ extraKnownMarketplaces: { nodesource: {} } }))
    writeTracking({
      pendingMarketplaceRemovals: { claude: [{ name: 'nodesource', scope: 'user', reason: 'manual', recordedAt: RECORDED }] },
    })
    const projectBefore = readFileSync(join(projectDir, '.claude/settings.json'), 'utf8')
    const previousCwd = process.cwd()
    process.chdir(projectDir)
    try {
      const { calls, runCli } = await simulateNativeCli()
      await assert.rejects(
        () => import('../../src/index.js').then(({ uninstall }) => uninstall('claude', { runCli })),
        (err: any) => {
          assert.strictEqual(err.code, 'UNINSTALL_PREFLIGHT_FAILED')
          assert.match(err.message, /multiple scopes/)
          return true
        }
      )
      assert.deepStrictEqual(calls, [])
    } finally {
      process.chdir(previousCwd)
    }
    assert.strictEqual(readFileSync(join(projectDir, '.claude/settings.json'), 'utf8'), projectBefore)
  })
})

describe('full uninstall: explicit invalid Claude install scopes refuse before effects', () => {
  async function writeRegistry (registry: unknown): Promise<void> {
    mkdirSync(dirname(claudeInstalledPath()), { recursive: true })
    writeFileSync(claudeInstalledPath(), JSON.stringify(registry))
  }

  it('does not degrade a present-but-invalid scope into the legacy scope-less removal', async () => {
    await writeRegistry({ version: 2, plugins: { 'nsolid-skills-plugin@nodesource': [{ scope: 'bogus' }] } })
    await seedMarketplace('claude', 'nodesource')
    const installedBefore = readFileSync(claudeInstalledPath(), 'utf8')
    const settingsBefore = readFileSync(claudeSettingsPath(), 'utf8')
    const { calls, runCli } = await simulateNativeCli()
    await assert.rejects(
      () => import('../../src/index.js').then(({ uninstall }) => uninstall('claude', { runCli })),
      (err: any) => {
        assert.strictEqual(err.code, 'UNINSTALL_PREFLIGHT_FAILED')
        assert.match(err.message, /installed_plugins\.json/)
        return true
      }
    )
    assert.deepStrictEqual(calls, [], 'an invalid scope must never authorize a removal command')
    assert.strictEqual(readFileSync(claudeInstalledPath(), 'utf8'), installedBefore)
    assert.strictEqual(readFileSync(claudeSettingsPath(), 'utf8'), settingsBefore)
  })

  it('refuses every unsupported explicit scope value', async () => {
    for (const scope of ['bogus', 42, null, {}, [], true]) {
      await writeRegistry({ version: 2, plugins: { 'nsolid-skills-plugin@nodesource': [{ scope }] } })
      await seedMarketplace('claude', 'nodesource')
      const { calls, runCli } = await simulateNativeCli()
      await assert.rejects(
        () => import('../../src/index.js').then(({ uninstall }) => uninstall('claude', { runCli })),
        (err: any) => {
          assert.strictEqual(err.code, 'UNINSTALL_PREFLIGHT_FAILED', `scope ${JSON.stringify(scope)}`)
          return true
        }
      )
      assert.deepStrictEqual(calls, [], `scope ${JSON.stringify(scope)}`)
    }
  })

  it('keeps the absent-scope legacy registration removable without a scope flag', async () => {
    await writeRegistry({ version: 2, plugins: { 'nsolid-skills-plugin@nodesource': [{}] } })
    writeFileSync(join(tmpDir, '.claude.json'), JSON.stringify({ enabledPlugins: { 'nsolid-skills-plugin@nodesource': true } }))
    const { calls, runCli } = await simulateNativeCli()
    const result = await (await import('../../src/index.js')).uninstall('claude', { runCli })
    assert.deepStrictEqual(result.errors, [])
    assert.deepStrictEqual(
      calls.filter((call) => call.args[1] === 'uninstall').map((call) => call.args),
      [['plugin', 'uninstall', 'nsolid-skills-plugin@nodesource']],
      'an absent scope is the supported legacy registration, removed without --scope'
    )
  })
})

describe('full uninstall: unsupported Claude registry shapes fail closed', () => {
  const adversarial: Array<[string, unknown]> = [
    ['array with a primitive entry', { version: 2, plugins: [42] }],
    ['array with a null entry', { version: 2, plugins: [null] }],
    ['array with a boolean entry', { version: 2, plugins: [true] }],
    ['array with a nested array entry', { version: 2, plugins: [[]] }],
    ['array with an id-less object entry', { version: 2, plugins: [{ noId: true }] }],
    ['map value that is a primitive', { version: 2, plugins: { 'nsolid-skills-plugin@nodesource': 42 } }],
    ['map value that is null', { version: 2, plugins: { 'nsolid-skills-plugin@nodesource': null } }],
    ['map value array with a primitive entry', { version: 2, plugins: { 'nsolid-skills-plugin@nodesource': [42] } }],
    ['map value array with a null entry', { version: 2, plugins: { 'nsolid-skills-plugin@nodesource': [null] } }],
    ['map value array with a nested array entry', { version: 2, plugins: { 'nsolid-skills-plugin@nodesource': [[{}]] } }],
    // Observed real-CLI empty state is {"version": 2, "plugins": {}} (valid,
    // see "keeps the documented empty schemas valid"); null is not a real
    // Claude CLI shape and stays refused. Contrast the antigravity
    // {"imports": null} acceptance elsewhere in this file.
    ['plugins present as null', { version: 2, plugins: null }],
    ['plugins present as a string', { version: 2, plugins: 'nsolid-skills-plugin@nodesource' }],
    ['top-level array with a primitive entry', [42]],
    ['top-level string', 'nsolid-skills-plugin@nodesource'],
    ['top-level number', 42],
    ['top-level null', null],
  ]

  for (const [label, registry] of adversarial) {
    it(`refuses ${label} instead of silently dropping the consumer`, async () => {
      mkdirSync(dirname(claudeInstalledPath()), { recursive: true })
      writeFileSync(claudeInstalledPath(), JSON.stringify(registry))
      await seedMarketplace('claude', 'nodesource')
      const registryBefore = readFileSync(claudeInstalledPath(), 'utf8')
      const settingsBefore = readFileSync(claudeSettingsPath(), 'utf8')
      const { calls, runCli } = await simulateNativeCli()
      await assert.rejects(
        () => import('../../src/index.js').then(({ uninstall }) => uninstall('claude', { runCli })),
        (err: any) => {
          assert.strictEqual(err.code, 'UNINSTALL_PREFLIGHT_FAILED', label)
          assert.match(err.message, /installed_plugins\.json/, label)
          return true
        }
      )
      assert.deepStrictEqual(calls, [], label)
      assert.strictEqual(readFileSync(claudeInstalledPath(), 'utf8'), registryBefore, `${label}: registry bytes preserved`)
      assert.strictEqual(readFileSync(claudeSettingsPath(), 'utf8'), settingsBefore, `${label}: marketplace settings preserved`)
    })
  }

  it('keeps the documented empty schemas valid', async () => {
    for (const registry of [{ version: 2, plugins: {} }, { version: 2, plugins: [] }, {}, []]) {
      mkdirSync(dirname(claudeInstalledPath()), { recursive: true })
      writeFileSync(claudeInstalledPath(), JSON.stringify(registry))
      const { runCli } = await simulateNativeCli()
      const result = await (await import('../../src/index.js')).uninstall('claude', { runCli })
      assert.deepStrictEqual(result.errors, [], `schema ${JSON.stringify(registry)}`)
    }
  })

  it('keeps an empty installed_plugins.json valid', async () => {
    mkdirSync(dirname(claudeInstalledPath()), { recursive: true })
    writeFileSync(claudeInstalledPath(), '')
    const { runCli } = await simulateNativeCli()
    const result = await (await import('../../src/index.js')).uninstall('claude', { runCli })
    assert.deepStrictEqual(result.errors, [])
  })
})

describe('full uninstall: Antigravity inspection validates every source', () => {
  function marketplaceLinkDir (): string { return join(tmpDir, '.gemini/config/plugins/marketplaces') }

  function seedMarketplaceLink (name: string): void {
    mkdirSync(marketplaceLinkDir(), { recursive: true })
    mkdirSync(join(marketplaceLinkDir(), name), { recursive: true })
  }

  for (const identity of ['nodesource', 'nsolid-skills', 'nsolid-skills-plugin']) {
    it(`refuses when the "${identity}" link exists but the import manifest is corrupt`, async () => {
      await seedNativePlugin('antigravity', 'nsolid-skills-plugin')
      seedMarketplaceLink(identity)
      writeFileSync(agyManifestPath(), '{ not json')
      const manifestBefore = readFileSync(agyManifestPath(), 'utf8')
      const { calls, runCli } = await simulateNativeCli()
      await assert.rejects(
        () => import('../../src/index.js').then(({ uninstall }) => uninstall('antigravity', { runCli })),
        (err: any) => {
          assert.strictEqual(err.code, 'UNINSTALL_PREFLIGHT_FAILED')
          assert.match(err.message, /[Ii]mport manifest/)
          return true
        }
      )
      assert.deepStrictEqual(calls, [], 'no agy command may run after a refusal')
      assert.strictEqual(readFileSync(agyManifestPath(), 'utf8'), manifestBefore, 'corrupt manifest bytes preserved')
      assert.ok(existsSync(agyPluginDir('nsolid-skills-plugin')), 'the selected native plugin survives the refusal')
    })
  }

  it('refuses when a matched link coexists with an unreadable import manifest', {
    skip: process.platform === 'win32' ? 'POSIX chmod permission simulation is not reliable on Windows' : false
  }, async () => {
    seedMarketplaceLink('nodesource')
    mkdirSync(dirname(agyManifestPath()), { recursive: true })
    writeFileSync(agyManifestPath(), JSON.stringify({
      imports: [{ name: 'nsolid-skills-plugin', source: 'marketplace', marketplace: 'nodesource' }],
    }))
    chmodSync(agyManifestPath(), 0o000)
    try {
      const { calls, runCli } = await simulateNativeCli()
      await assert.rejects(
        () => import('../../src/index.js').then(({ uninstall }) => uninstall('antigravity', { runCli })),
        (err: any) => {
          assert.strictEqual(err.code, 'UNINSTALL_PREFLIGHT_FAILED')
          assert.match(err.message, /could not be read/)
          return true
        }
      )
      assert.deepStrictEqual(calls, [])
    } finally {
      chmodSync(agyManifestPath(), 0o644)
    }
  })

  it('never follows or deletes the marketplace link target', async () => {
    const target = join(tmpDir, 'outside-marketplace')
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'marker.txt'), 'outside')
    mkdirSync(marketplaceLinkDir(), { recursive: true })
    const link = join(marketplaceLinkDir(), 'nsolid-skills')
    symlinkSync(target, link, 'dir')
    mkdirSync(dirname(agyManifestPath()), { recursive: true })
    writeFileSync(agyManifestPath(), '{ not json')

    const { calls, runCli } = await simulateNativeCli()
    await assert.rejects(
      () => import('../../src/index.js').then(({ uninstall }) => uninstall('antigravity', { runCli })),
      (err: any) => { assert.strictEqual(err.code, 'UNINSTALL_PREFLIGHT_FAILED'); return true }
    )
    assert.deepStrictEqual(calls, [])
    assert.strictEqual(readFileSync(join(target, 'marker.txt'), 'utf8'), 'outside', 'link target untouched')
    assert.ok(lstatSync(link).isSymbolicLink(), 'the link itself is preserved')
  })
})

describe('full uninstall: skill removal failures never lose ownership', () => {
  const RECORDED = FIXED_TS

  function seedTrackedClaudeSkill (name = 'ns-shared'): string {
    const dir = sharedSkillDir(name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), '# shared')
    writeTracking({
      skills: [{ name, path: dir, paths: { claude: dir }, installedAt: RECORDED, harnesses: ['claude'] }],
      externalMcp: { codex: { state: 'disconnected', updatedAt: RECORDED, disconnectedAt: RECORDED, entries: [] } },
    })
    return dir
  }

  it('retains ownership when orphan deletion fails so the retry still removes it', {
    skip: process.platform === 'win32' ? 'POSIX chmod permission simulation is not reliable on Windows' : false
  }, async () => {
    const dir = seedTrackedClaudeSkill()
    const first = await simulateNativeCli()
    chmodSync(dir, 0o555)
    let firstResult: UninstallResult
    try {
      firstResult = await (await import('../../src/index.js')).uninstall('claude', { runCli: first.runCli })
    } finally {
      chmodSync(dir, 0o755)
    }
    assert.strictEqual(firstResult.success, false)
    assert.strictEqual(firstResult.stages.find((entry) => entry.stage === 'skills')?.status, 'failed')
    assert.ok(existsSync(join(dir, 'SKILL.md')), 'a failed deletion must leave the content in place')
    assert.deepStrictEqual(
      JSON.parse(readFileSync(trackingFile(), 'utf8')).skills.map((entry: { name: string }) => entry.name),
      ['ns-shared'],
      'ownership must survive a failed deletion'
    )

    const retry = await simulateNativeCli()
    const retryResult = await (await import('../../src/index.js')).uninstall('claude', { runCli: retry.runCli })
    assert.deepStrictEqual(retryResult.errors, [])
    assert.strictEqual(retryResult.stages.find((entry) => entry.stage === 'skills')?.status, 'removed')
    assert.ok(!existsSync(dir), 'the retry removes the orphaned content')
    assert.deepStrictEqual(JSON.parse(readFileSync(trackingFile(), 'utf8')).skills, [])
  })

  it('deletes content before tracking and reports a tracking-write failure without losing ownership', {
    skip: process.platform === 'win32' ? 'POSIX chmod permission simulation is not reliable on Windows' : false
  }, async () => {
    const dir = seedTrackedClaudeSkill()
    const first = await simulateNativeCli()
    chmodSync(agentsDir(), 0o500)
    let firstResult: UninstallResult
    try {
      firstResult = await (await import('../../src/index.js')).uninstall('claude', { runCli: first.runCli })
    } finally {
      chmodSync(agentsDir(), 0o755)
    }
    assert.strictEqual(firstResult.success, false)
    assert.strictEqual(firstResult.stages.find((entry) => entry.stage === 'skills')?.status, 'failed')
    assert.ok(firstResult.errors.length > 0, 'the tracking failure must be reported, never swallowed')
    assert.ok(!existsSync(dir), 'content deletion precedes the tracking update')
    assert.deepStrictEqual(
      JSON.parse(readFileSync(trackingFile(), 'utf8')).skills.map((entry: { name: string }) => entry.name),
      ['ns-shared'],
      'the deleted content stays owned until the tracking write succeeds'
    )

    const retry = await simulateNativeCli()
    const retryResult = await (await import('../../src/index.js')).uninstall('claude', { runCli: retry.runCli })
    assert.deepStrictEqual(retryResult.errors, [])
    assert.strictEqual(retryResult.stages.find((entry) => entry.stage === 'skills')?.status, 'removed')
    assert.deepStrictEqual(JSON.parse(readFileSync(trackingFile(), 'utf8')).skills, [])
  })
})

describe('full uninstall: no-tracking ns-* symlinks are ambiguous evidence', () => {
  for (const root of ['shared', 'harness'] as const) {
    it(`refuses (plain and flagged) for an ns-* symlink in the ${root} skills dir with no tracking`, async () => {
      const target = join(tmpDir, 'outside-target')
      mkdirSync(target, { recursive: true })
      writeFileSync(join(target, 'marker.txt'), 'outside')
      const skillsRoot = root === 'shared' ? join(tmpDir, '.agents/skills') : claudeSkillsDir()
      mkdirSync(skillsRoot, { recursive: true })
      symlinkSync(target, join(skillsRoot, 'ns-live'), 'dir')
      symlinkSync(join(tmpDir, 'missing-target'), join(skillsRoot, 'ns-dangling'), 'dir')

      for (const flagged of [false, true]) {
        const label = `${root} ${flagged ? 'flagged' : 'plain'}`
        const { calls, runCli } = await simulateNativeCli()
        await assert.rejects(
          () => import('../../src/index.js').then(({ uninstall }) =>
            uninstall('claude', flagged ? { runCli, externalMcp: true } : { runCli })),
          (err: any) => {
            assert.strictEqual(err.code, 'UNINSTALL_PREFLIGHT_FAILED', label)
            assert.match(err.message, /ns-live|ns-dangling/, label)
            return true
          }
        )
        assert.deepStrictEqual(calls, [], label)
      }

      assert.ok(lstatSync(join(skillsRoot, 'ns-live')).isSymbolicLink(), 'live link preserved')
      assert.ok(lstatSync(join(skillsRoot, 'ns-dangling')).isSymbolicLink(), 'dangling link preserved')
      assert.strictEqual(readFileSync(join(target, 'marker.txt'), 'utf8'), 'outside', 'link target never followed or deleted')
    })
  }
})

/**
 * Project/local marketplace provenance regression: a pending obligation recorded
 * while uninstalling project A must keep its originating settings file, and every
 * later run must prove that file is the one this process would actually edit
 * before any CLI command runs. The pre-fix code dropped the path and replayed the
 * scoped command in whatever directory the retry happened to run from.
 */
describe('full uninstall: project/local pending marketplace provenance', () => {
  const RECORDED = FIXED_TS
  const SCOPES = ['project', 'local'] as const
  type ProjScope = typeof SCOPES[number]

  function scopedSettingsPath (projectDir: string, scope: ProjScope): string {
    return join(projectDir, '.claude', scope === 'project' ? 'settings.json' : 'settings.local.json')
  }

  function seedScopedMarketplace (projectDir: string, scope: ProjScope, name = 'nodesource'): void {
    mkdirSync(join(projectDir, '.claude'), { recursive: true })
    writeFileSync(scopedSettingsPath(projectDir, scope), JSON.stringify({ extraKnownMarketplaces: { [name]: {} } }))
  }

  function pendingScoped (scope: ProjScope, settingsPath: string, name = 'nodesource'): Record<string, unknown> {
    return { name, scope, settingsPath, reason: 'retry from project A', recordedAt: RECORDED }
  }

  async function inDir<T> (dir: string, fn: () => Promise<T>): Promise<T> {
    const previous = process.cwd()
    process.chdir(dir)
    try {
      return await fn()
    } finally {
      process.chdir(previous)
    }
  }

  for (const scope of SCOPES) {
    it(`refuses a ${scope}-scope pending removal recorded for another project (plain and flagged)`, async () => {
      const projectA = join(tmpDir, 'project-A')
      const projectB = join(tmpDir, 'project-B')
      mkdirSync(projectA, { recursive: true })
      mkdirSync(projectB, { recursive: true })
      writeTracking({
        pendingMarketplaceRemovals: { claude: [pendingScoped(scope, scopedSettingsPath(projectA, scope))] },
      })
      const trackingBefore = readFileSync(trackingFile(), 'utf8')
      await inDir(projectB, async () => {
        for (const flagged of [false, true]) {
          const label = `${scope} ${flagged ? 'flagged' : 'plain'}`
          const { calls, runCli } = await simulateNativeCli()
          await assert.rejects(
            () => import('../../src/index.js').then(({ uninstall }) =>
              uninstall('claude', flagged ? { runCli, externalMcp: true } : { runCli })),
            (err: any) => {
              assert.strictEqual(err.code, 'UNINSTALL_PREFLIGHT_FAILED', label)
              assert.match(err.message, /project-A/, label)
              return true
            }
          )
          assert.deepStrictEqual(calls, [], `${label}: a misattributed pending target must not run a CLI`)
        }
      })
      assert.strictEqual(readFileSync(trackingFile(), 'utf8'), trackingBefore, 'a refusal must not touch the tracking file')
    })
  }

  it('refuses a pending obligation when a matching-scope fresh registration exists in the current project', async () => {
    const projectA = join(tmpDir, 'project-A')
    const projectB = join(tmpDir, 'project-B')
    seedScopedMarketplace(projectA, 'project')
    seedScopedMarketplace(projectB, 'project')
    writeTracking({ pendingMarketplaceRemovals: { claude: [pendingScoped('project', scopedSettingsPath(projectA, 'project'))] } })
    const projectBBefore = readFileSync(scopedSettingsPath(projectB, 'project'), 'utf8')
    await inDir(projectB, async () => {
      const { calls, runCli } = await simulateNativeCli()
      await assert.rejects(
        () => import('../../src/index.js').then(({ uninstall }) => uninstall('claude', { runCli })),
        (err: any) => {
          assert.strictEqual(err.code, 'UNINSTALL_PREFLIGHT_FAILED')
          assert.match(err.message, /project-A/)
          return true
        }
      )
      assert.deepStrictEqual(calls, [], 'the conflicting pending obligation must not authorize a command')
    })
    assert.strictEqual(readFileSync(scopedSettingsPath(projectB, 'project'), 'utf8'), projectBBefore, 'the fresh project is untouched')
  })

  it('refuses missing, null, non-string or relative project provenance before any effect', async () => {
    const projectB = join(tmpDir, 'project-B')
    mkdirSync(projectB, { recursive: true })
    const cases: Array<[string, Record<string, unknown>]> = [
      ['missing project settings path', { name: 'nodesource', scope: 'project', reason: 'retry', recordedAt: RECORDED }],
      ['null project settings path', { name: 'nodesource', scope: 'project', settingsPath: null, reason: 'retry', recordedAt: RECORDED }],
      ['non-string project settings path', { name: 'nodesource', scope: 'project', settingsPath: 42, reason: 'retry', recordedAt: RECORDED }],
      ['relative project settings path', { name: 'nodesource', scope: 'project', settingsPath: '.claude/settings.json', reason: 'retry', recordedAt: RECORDED }],
      ['missing local settings path', { name: 'nodesource', scope: 'local', reason: 'retry', recordedAt: RECORDED }],
      ['relative local settings path', { name: 'nodesource', scope: 'local', settingsPath: '.claude/settings.local.json', reason: 'retry', recordedAt: RECORDED }],
      ['project settings path on a user record', { name: 'nodesource', scope: 'user', settingsPath: join(projectB, '.claude/settings.json'), reason: 'retry', recordedAt: RECORDED }],
    ]
    await inDir(projectB, async () => {
      for (const [label, record] of cases) {
        writeTracking({ pendingMarketplaceRemovals: { claude: [record] } })
        const before = readFileSync(trackingFile(), 'utf8')
        const { calls, runCli } = await simulateNativeCli()
        await assert.rejects(
          () => import('../../src/index.js').then(({ uninstall }) => uninstall('claude', { runCli })),
          (err: any) => {
            assert.strictEqual(err.code, 'TRACKING_CORRUPT', label)
            return true
          }
        )
        assert.deepStrictEqual(calls, [], label)
        assert.strictEqual(readFileSync(trackingFile(), 'utf8'), before, label)
      }
    })
  })

  it('refuses malformed absolute project/local provenance before any effect (plain and flagged)', async () => {
    const projectA = join(tmpDir, 'project-A')
    mkdirSync(projectA, { recursive: true })
    const cases: Array<[string, ProjScope, string]> = [
      ['project settings.json with a trailing separator', 'project', scopedSettingsPath(projectA, 'project') + sep],
      ['local settings.local.json with a trailing separator', 'local', scopedSettingsPath(projectA, 'local') + sep],
      ['project path with a dot segment', 'project', `${projectA}/.claude/./settings.json`],
      ['project path with a parent segment', 'project', `${projectA}/.claude/../.claude/settings.json`],
      ['local path with a parent segment', 'local', `${projectA}/.claude/../.claude/settings.local.json`],
      ['project path with redundant separators', 'project', projectA + '//.claude/settings.json'],
      ['project path with a NUL byte', 'project', scopedSettingsPath(projectA, 'project') + '\u0000'],
    ]
    await inDir(projectA, async () => {
      for (const [label, scope, settingsPath] of cases) {
        writeTracking({ pendingMarketplaceRemovals: { claude: [pendingScoped(scope, settingsPath)] } })
        const before = readFileSync(trackingFile(), 'utf8')
        for (const flagged of [false, true]) {
          const tag = `${label} (${flagged ? 'flagged' : 'plain'})`
          const { calls, runCli } = await simulateNativeCli()
          await assert.rejects(
            () => import('../../src/index.js').then(({ uninstall }) =>
              uninstall('claude', flagged ? { runCli, externalMcp: true } : { runCli })),
            (err: any) => {
              assert.strictEqual(err.code, 'TRACKING_CORRUPT', tag)
              return true
            }
          )
          assert.deepStrictEqual(calls, [], `${tag}: malformed provenance must not run a CLI`)
        }
        assert.strictEqual(readFileSync(trackingFile(), 'utf8'), before, `${label}: tracking file byte-identical`)
      }
    })
  })

  for (const scope of SCOPES) {
    it(`persists the originating ${scope} settings path and retries in the same project with the exact scoped command`, async () => {
      const projectA = join(tmpDir, 'project-A')
      seedScopedMarketplace(projectA, scope)
      const expected = scopedSettingsPath(projectA, scope)
      await inDir(projectA, async () => {
        const first = await simulateNativeCli({ failMarketplaceOnce: true })
        const firstResult = await (await import('../../src/index.js')).uninstall('claude', { runCli: first.runCli })
        assert.strictEqual(firstResult.success, false)
        assert.strictEqual(firstResult.stages.find((entry) => entry.stage === 'marketplace')?.status, 'failed')

        const recorded = JSON.parse(readFileSync(trackingFile(), 'utf8')).pendingMarketplaceRemovals.claude
        assert.strictEqual(recorded.length, 1, 'exactly one pending obligation')
        assert.strictEqual(recorded[0].scope, scope)
        assert.strictEqual(recorded[0].settingsPath, expected, 'the originating settings path survives serialization')

        const { readTrackingFileStrict } = await import('../../src/skills/skill-tracker.js')
        const strict = await readTrackingFileStrict()
        assert.strictEqual(
          strict?.pendingMarketplaceRemovals?.claude?.[0]?.settingsPath,
          expected,
          'the strict reader roundtrips the originating path'
        )

        const retry = await simulateNativeCli()
        const retryResult = await (await import('../../src/index.js')).uninstall('claude', { runCli: retry.runCli })
        assert.deepStrictEqual(retryResult.errors, [])
        assert.strictEqual(retryResult.stages.find((entry) => entry.stage === 'marketplace')?.status, 'removed')
        assert.deepStrictEqual(
          retry.calls.filter((call) => call.args[1] === 'marketplace').map((call) => call.args),
          [['plugin', 'marketplace', 'remove', 'nodesource', '--scope', scope]],
          'the retry runs the exact scoped command in the originating project'
        )
      })
    })
  }

  for (const scope of SCOPES) {
    it(`refuses a ${scope}-scope retry from another project without touching the pending obligation`, async () => {
      const projectA = join(tmpDir, 'project-A')
      const projectB = join(tmpDir, 'project-B')
      seedScopedMarketplace(projectA, scope)
      mkdirSync(projectB, { recursive: true })
      let trackingAfterFailure: string | undefined
      await inDir(projectA, async () => {
        const first = await simulateNativeCli({ failMarketplaceOnce: true })
        const firstResult = await (await import('../../src/index.js')).uninstall('claude', { runCli: first.runCli })
        assert.strictEqual(firstResult.success, false)
        trackingAfterFailure = readFileSync(trackingFile(), 'utf8')
      })
      await inDir(projectB, async () => {
        const { calls, runCli } = await simulateNativeCli()
        await assert.rejects(
          () => import('../../src/index.js').then(({ uninstall }) => uninstall('claude', { runCli })),
          (err: any) => {
            assert.strictEqual(err.code, 'UNINSTALL_PREFLIGHT_FAILED')
            assert.match(err.message, /project-A/)
            return true
          }
        )
        assert.deepStrictEqual(calls, [], 'a cross-project retry must not run any CLI')
        assert.strictEqual(readFileSync(trackingFile(), 'utf8'), trackingAfterFailure, 'the pending obligation is unchanged')
      })
    })
  }

  it('keeps a user-scope pending retry independent of the project working directory', async () => {
    const projectB = join(tmpDir, 'project-B')
    mkdirSync(projectB, { recursive: true })
    writeTracking({ pendingMarketplaceRemovals: { claude: [{ name: 'nodesource', scope: 'user', reason: 'manual', recordedAt: RECORDED }] } })
    await inDir(projectB, async () => {
      const { calls, runCli } = await simulateNativeCli()
      const result = await (await import('../../src/index.js')).uninstall('claude', { runCli })
      assert.deepStrictEqual(result.errors, [])
      assert.strictEqual(result.stages.find((entry) => entry.stage === 'marketplace')?.status, 'removed')
      assert.deepStrictEqual(
        calls.filter((call) => call.args[1] === 'marketplace').map((call) => call.args),
        [['plugin', 'marketplace', 'remove', 'nodesource', '--scope', 'user']],
        'a user-scope retry is not tied to the working directory'
      )
    })
  })
})

describe('full uninstall: pi package-owned native plugin is never reported as verified absence', () => {
  /**
   * Mirror how `pi install npm:nsolid-pi-plugin` leaves the harness: the
   * package lives on disk and is recorded in `~/.pi/agent/settings.json`
   * (see packages/pi-plugin and pi-plugin-detector). Pi has no uninstall CLI
   * command and no config-file fallback editor, so the stage must honestly
   * report the plugin as still present instead of silently claiming absence.
   */
  async function seedPiNativePlugin (): Promise<void> {
    const packageRoot = join(tmpDir, 'pi-package')
    mkdirSync(packageRoot, { recursive: true })
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: 'nsolid-pi-plugin', version: '1.0.0' }))
    mkdirSync(join(tmpDir, '.pi', 'agent'), { recursive: true })
    writeFileSync(join(tmpDir, '.pi', 'agent', 'settings.json'), JSON.stringify({ packages: [packageRoot] }))
  }

  it('reports the installed nsolid-pi-plugin as still present with manual-removal guidance, not not-present success', async () => {
    seedAuth()
    await seedPiNativePlugin()
    const { calls, runCli } = await simulateNativeCli()
    const { uninstall } = await import('../../src/index.js')
    const result = await uninstall('pi', { runCli })

    const nativeStage = result.stages.find((entry) => entry.stage === 'nativePlugin')
    assert.strictEqual(nativeStage?.status, 'failed', `native plugin stage: ${JSON.stringify(nativeStage)}`)
    assert.ok(nativeStage?.detail?.includes('nsolid-pi-plugin'), `detail names the plugin: ${nativeStage?.detail}`)
    assert.ok(nativeStage?.detail?.includes('remove it manually'), `detail gives manual guidance: ${nativeStage?.detail}`)
    assert.strictEqual(result.success, false, 'a leftover native plugin is never a clean success')
    assert.deepStrictEqual(calls, [], 'pi has no harness uninstall CLI command to delegate to')
  })

  it('green-lock: pi without the nsolid-pi-plugin package still reports the native plugin as not-present', async () => {
    seedAuth()
    const { uninstall } = await import('../../src/index.js')
    const result = await uninstall('pi', {})

    const nativeStage = result.stages.find((entry) => entry.stage === 'nativePlugin')
    assert.strictEqual(nativeStage?.status, 'not-present')
    assert.deepStrictEqual(result.errors, [])
    assert.strictEqual(result.success, true)
  })
})

/**
 * Mixed external + legacy MCP ownership. The external ownership record covers
 * only the entries the CLI actually wrote (the write-set); tracked legacy
 * entries for the same harness may coexist. Identity is harness + name +
 * normalized config path, never name-only. The uninstall must clean BOTH
 * attributable sets, and preflight must read-validate every config file the
 * execution will edit — including legacy files next to an external record.
 */
describe('full uninstall: mixed external + legacy MCP ownership', () => {
  function claudeMcpConfigPath (): string { return join(tmpDir, '.claude.json') }

  async function installLegacyBundle (harness: HarnessType, serverNames: string[]): Promise<void> {
    seedAuth()
    const skillsSource = join(tmpDir, 'source-mixed')
    mkdirSync(join(skillsSource, 'skills/ns-mixed-skill'), { recursive: true })
    writeFileSync(join(skillsSource, 'skills/ns-mixed-skill/SKILL.md'), '# mixed skill')
    const bundlePath = join(tmpDir, 'bundle-mixed.json')
    writeFileSync(bundlePath, JSON.stringify({
      name: 'mixed',
      version: '1.0.0',
      skills: [{ name: 'ns-mixed-skill', path: 'skills/ns-mixed-skill', description: '' }],
      mcpServers: serverNames.map((name) => ({ name, url: `https://mcp.example.com/${name}`, headers: { token: 'legacy' } })),
    }))
    const { install } = await import('../../src/index.js')
    const result = await install({ harness, bundlePath, skillsSource })
    assert.strictEqual(result.success, true, result.errors.join('; '))
  }

  async function installExternalServer (harness: HarnessType, serverName: string): Promise<void> {
    seedAuth()
    const bundlePath = join(tmpDir, 'bundle-external.json')
    writeFileSync(bundlePath, JSON.stringify({
      name: 'external',
      version: '1.0.0',
      skills: [{ name: 'ns-external-skill', path: 'skills/ns-external-skill', description: '' }],
      mcpServers: [{ name: serverName, url: `https://mcp.example.com/ext-${serverName}`, headers: { token: 'external' } }],
    }))
    const { install } = await import('../../src/index.js')
    const result = await install({
      harness,
      bundlePath,
      skillsSource: join(tmpDir, 'source-mixed'),
      packageOwnedSkills: true,
      externalMcp: true,
    })
    assert.strictEqual(result.success, true, result.errors.join('; '))
  }

  async function seedMixedOwnership (): Promise<string> {
    await installLegacyBundle('claude', ['ncm', 'nsolid-console'])
    const configPath = claudeMcpConfigPath()
    const config = JSON.parse(readFileSync(configPath, 'utf8'))
    config.mcpServers['foreign-server'] = { command: 'echo', args: ['hi'] }
    writeFileSync(configPath, JSON.stringify(config))
    // External setup re-owns ONLY nsolid-console; the legacy ncm entry stays tracked.
    await installExternalServer('claude', 'nsolid-console')
    assert.deepStrictEqual(
      (JSON.parse(readFileSync(trackingFile(), 'utf8')).mcpServers as Array<{ harness: string, name: string }>)
        .filter((entry) => entry.harness === 'claude').map((entry) => entry.name).sort(),
      ['ncm', 'nsolid-console'],
      'fixture sanity: both entries tracked'
    )
    assert.strictEqual(
      (JSON.parse(readFileSync(trackingFile(), 'utf8')).externalMcp as Record<string, { state: string }>).claude.state,
      'active'
    )
    return configPath
  }

  function trackedNames (harness: HarnessType): string[] {
    const tracking = JSON.parse(readFileSync(trackingFile(), 'utf8'))
    return (tracking.mcpServers as Array<{ harness: string, name: string }>)
      .filter((entry) => entry.harness === harness)
      .map((entry) => entry.name)
  }

  /** Claude external record at the adapter config + a tracked legacy entry in a second file. */
  async function seedMixedWithLegacyFile (legacyBody: string): Promise<{ claudeConfig: string, legacyPath: string }> {
    const { fingerprintExternalMcpEntry } = await import('../../src/mcp/external-ownership.js')
    const claudeConfig = claudeMcpConfigPath()
    const claudeEntry = { type: 'http', url: 'https://mcp.example.com/x', headers: { token: 't' } }
    writeFileSync(claudeConfig, JSON.stringify({ mcpServers: { 'nsolid-console': claudeEntry } }, null, 2))
    const legacyPath = join(tmpDir, 'legacy-config', 'mcp.json')
    mkdirSync(dirname(legacyPath), { recursive: true })
    writeFileSync(legacyPath, legacyBody)
    writeTracking({
      mcpServers: [{ name: 'ncm', configPath: legacyPath, harness: 'claude', configuredAt: FIXED_TS }],
      externalMcp: {
        claude: {
          state: 'active',
          updatedAt: FIXED_TS,
          entries: [{ name: 'nsolid-console', configPath: claudeConfig, fingerprint: fingerprintExternalMcpEntry(claudeEntry) as string, recordedAt: FIXED_TS }],
        },
      },
    })
    return { claudeConfig, legacyPath }
  }

  it('cleans BOTH the external set and the tracked legacy remainder under mixed ownership', async () => {
    const configPath = await seedMixedOwnership()

    const { runCli } = await simulateNativeCli()
    const result = await (await import('../../src/index.js')).uninstall('claude', { runCli })

    assert.deepStrictEqual(result.errors, [], result.errors.join('; '))
    assert.strictEqual(result.success, true)
    const mcpStage = result.stages.find((entry) => entry.stage === 'mcp')
    assert.strictEqual(mcpStage?.status, 'removed')
    assert.ok(mcpStage?.detail?.includes('external MCP entries disconnected'), `detail: ${mcpStage?.detail}`)
    assert.ok(mcpStage?.detail?.includes('tracked MCP entry'), `detail: ${mcpStage?.detail}`)

    const after = JSON.parse(readFileSync(configPath, 'utf8'))
    assert.ok(!('nsolid-console' in (after.mcpServers ?? {})), 'external-owned entry removed')
    assert.ok(!('ncm' in (after.mcpServers ?? {})), 'legacy tracked remainder removed (defect: skipped today)')
    assert.ok('foreign-server' in (after.mcpServers ?? {}), 'foreign server preserved')
    const tracking = JSON.parse(readFileSync(trackingFile(), 'utf8'))
    assert.deepStrictEqual(trackedNames('claude'), [], 'no attributable MCP tracking entry left behind')
    assert.strictEqual(
      (tracking.externalMcp as Record<string, { state: string }>).claude.state,
      'disconnected',
      'external tombstone retained for idempotent retries'
    )
    const configBytes = readFileSync(configPath, 'utf8')
    const trackingBytes = readFileSync(trackingFile(), 'utf8')
    const retry = await (await import('../../src/index.js')).uninstall('claude', { runCli })
    assert.deepStrictEqual(retry.errors, [])
    assert.strictEqual(retry.stages.find((entry) => entry.stage === 'mcp')?.status, 'not-present')
    assert.strictEqual(readFileSync(configPath, 'utf8'), configBytes)
    assert.strictEqual(readFileSync(trackingFile(), 'utf8'), trackingBytes)
  })

  it('external-only ownership removes every tracked entry with no legacy remainder', async () => {
    await installLegacyBundle('claude', ['nsolid-console'])
    await installExternalServer('claude', 'nsolid-console')
    assert.deepStrictEqual(trackedNames('claude'), ['nsolid-console'], 'fixture sanity: the external write-set covers the tracked entry')

    const { runCli } = await simulateNativeCli()
    const result = await (await import('../../src/index.js')).uninstall('claude', { runCli })

    assert.deepStrictEqual(result.errors, [], result.errors.join('; '))
    assert.strictEqual(result.stages.find((entry) => entry.stage === 'mcp')?.status, 'removed')
    assert.deepStrictEqual(
      Object.keys(JSON.parse(readFileSync(claudeMcpConfigPath(), 'utf8')).mcpServers ?? {}),
      [],
      'config cleaned'
    )
    assert.deepStrictEqual(trackedNames('claude'), [])
    assert.strictEqual(
      (JSON.parse(readFileSync(trackingFile(), 'utf8')).externalMcp as Record<string, { state: string }>).claude.state,
      'disconnected'
    )
  })

  it('removes the tracked legacy remainder next to a disconnected tombstone', async () => {
    const configPath = claudeMcpConfigPath()
    const ncmEntry = { type: 'http', url: 'https://mcp.example.com/ncm', headers: { token: 't' } }
    writeFileSync(configPath, JSON.stringify({
      mcpServers: { ncm: ncmEntry, 'foreign-server': { command: 'echo' } },
    }, null, 2))
    writeTracking({
      mcpServers: [{ name: 'ncm', configPath, harness: 'claude', configuredAt: FIXED_TS }],
      externalMcp: {
        claude: {
          state: 'disconnected',
          updatedAt: FIXED_TS,
          disconnectedAt: FIXED_TS,
          entries: [{ name: 'nsolid-console', configPath, fingerprint: '0'.repeat(64), recordedAt: FIXED_TS }],
        },
      },
    })

    const { runCli } = await simulateNativeCli()
    const result = await (await import('../../src/index.js')).uninstall('claude', { runCli })

    assert.deepStrictEqual(result.errors, [], result.errors.join('; '))
    assert.strictEqual(
      result.stages.find((entry) => entry.stage === 'mcp')?.status,
      'removed',
      'the legacy remainder is still attributable and must be removed (defect: tombstone skipped it)'
    )
    const after = JSON.parse(readFileSync(configPath, 'utf8'))
    assert.ok(!('ncm' in (after.mcpServers ?? {})), 'legacy entry removed next to the tombstone')
    assert.ok('foreign-server' in (after.mcpServers ?? {}), 'foreign server preserved')
    const tracking = JSON.parse(readFileSync(trackingFile(), 'utf8'))
    assert.deepStrictEqual(trackedNames('claude'), [])
    assert.strictEqual(
      (tracking.externalMcp as Record<string, { state: string }>).claude.state,
      'disconnected',
      'tombstone retained'
    )
  })

  it('reports an honest partial failure when the legacy phase fails after the external disconnect succeeded', async () => {
    const { claudeConfig, legacyPath } = await seedMixedWithLegacyFile(JSON.stringify({
      mcpServers: {
        ncm: { type: 'http', url: 'https://mcp.example.com/ncm', headers: { token: 't' } },
        'foreign-server': { command: 'echo' },
      },
    }, null, 2))
    // The legacy phase edits the legacy file's directory; make it unwritable
    // while preflight reads (and every other write target) stay usable.
    const legacyDir = dirname(legacyPath)
    chmodSync(legacyDir, 0o500)

    const { runCli } = await simulateNativeCli()
    try {
      const result = await (await import('../../src/index.js')).uninstall('claude', { runCli })

      assert.strictEqual(result.success, false, 'a skipped legacy phase is never a clean success')
      const mcpStage = result.stages.find((entry) => entry.stage === 'mcp')
      assert.strictEqual(mcpStage?.status, 'failed')
      assert.ok(mcpStage?.detail?.includes('external MCP entries disconnected'), `what was done: ${mcpStage?.detail}`)
      assert.ok(mcpStage?.detail?.includes('MCP removal failed'), `what remains: ${mcpStage?.detail}`)
      const claudeAfter = JSON.parse(readFileSync(claudeConfig, 'utf8'))
      assert.ok(!('nsolid-console' in (claudeAfter.mcpServers ?? {})), 'external half completed')
      const legacyAfter = JSON.parse(readFileSync(legacyPath, 'utf8'))
      assert.ok('ncm' in (legacyAfter.mcpServers ?? {}), 'legacy entry kept when its phase failed')
      assert.ok('foreign-server' in (legacyAfter.mcpServers ?? {}), 'foreign server preserved')
      const tracking = JSON.parse(readFileSync(trackingFile(), 'utf8'))
      assert.strictEqual(
        (tracking.externalMcp as Record<string, { state: string }>).claude.state,
        'disconnected',
        'external half finalized'
      )
      assert.deepStrictEqual(trackedNames('claude'), ['ncm'], 'legacy obligation preserved as retry evidence')

      // Retry after the environment is fixed cleans the pending legacy obligation.
      chmodSync(legacyDir, 0o755)
      const retry = await (await import('../../src/index.js')).uninstall('claude', { runCli })
      assert.deepStrictEqual(retry.errors, [], retry.errors.join('; '))
      assert.strictEqual(retry.stages.find((entry) => entry.stage === 'mcp')?.status, 'removed')
      const legacyRetried = JSON.parse(readFileSync(legacyPath, 'utf8'))
      assert.ok(!('ncm' in (legacyRetried.mcpServers ?? {})), 'retry removes the pending legacy entry')
      assert.ok('foreign-server' in (legacyRetried.mcpServers ?? {}), 'foreign server still preserved')
      assert.deepStrictEqual(trackedNames('claude'), [])
      assert.strictEqual(
        (JSON.parse(readFileSync(trackingFile(), 'utf8')).externalMcp as Record<string, { state: string }>).claude.state,
        'disconnected'
      )
    } finally {
      chmodSync(legacyDir, 0o755)
    }
  })

  for (const problem of ['mixed malformed config', 'empty active record', 'invalid opencode entry'] as const) {
    for (const reversed of [false, true]) {
      it(`refuses ${problem} before mutations (reversed=${reversed})`, async () => {
        seedAuth()
        const harness = problem === 'invalid opencode entry' ? 'opencode' : 'claude'
        const configPath = harness === 'opencode' ? join(tmpDir, '.config/opencode/opencode.jsonc') : claudeMcpConfigPath()
        const paths = [configPath, codexConfigPath(), trackingFile(), authFile(), join(sharedSkillDir('ns-tracked-skill'), 'SKILL.md')]
        let expectedProblem = `Cannot read ${configPath} to verify ${harness}`
        if (problem === 'mixed malformed config') {
          const { legacyPath } = await seedMixedWithLegacyFile('{ not json')
          paths.push(legacyPath)
          expectedProblem = `Cannot read ${legacyPath} to verify claude`
        } else {
          await seedTrackedInstall(harness)
          if (harness === 'opencode') {
            writeFileSync(configPath, JSON.stringify({ mcp: { 'nsolid-console': null } }))
          } else {
            expectedProblem = 'External MCP record for claude has no entries to disconnect'
            const tracking = JSON.parse(readFileSync(trackingFile(), 'utf8'))
            tracking.externalMcp = { claude: { state: 'active', updatedAt: FIXED_TS, entries: [] } }
            writeTracking(tracking)
          }
        }
        await seedTrackedInstall('codex')
        const before = paths.map((file) => readFileSync(file, 'utf8'))
        const { calls, runCli } = await simulateNativeCli()
        const order: HarnessType[] = reversed ? ['codex', harness] : [harness, 'codex']
        await assert.rejects(
          () => import('../../src/uninstall.js').then(({ uninstallHarnesses }) => uninstallHarnesses(order, { runCli })),
          (err: any) => {
            assert.strictEqual(err.code, 'UNINSTALL_PREFLIGHT_FAILED')
            assert.ok(err.message.includes(expectedProblem), err.message)
            return true
          }
        )
        assert.deepStrictEqual(calls, [], 'no native CLI before refusal')
        assert.deepStrictEqual(paths.map((file) => readFileSync(file, 'utf8')), before, 'all config, auth, skill and tracking bytes preserved')
      })
    }
  }

  it('prunes tracked mirrors by identity, not name: a same-name duplicate row survives the external phase and retries honestly', async () => {
    const { fingerprintExternalMcpEntry } = await import('../../src/mcp/external-ownership.js')
    const claudeConfig = claudeMcpConfigPath()
    const entryA = { type: 'http', url: 'https://mcp.example.com/a', headers: { token: 't' } }
    writeFileSync(claudeConfig, JSON.stringify({ mcpServers: { 'ns-x': entryA } }, null, 2))
    const legacyPath = join(tmpDir, 'legacy-config', 'mcp.json')
    mkdirSync(dirname(legacyPath), { recursive: true })
    writeFileSync(legacyPath, JSON.stringify({
      mcpServers: { 'ns-x': { type: 'http', url: 'https://mcp.example.com/b', headers: { token: 't' } } },
    }, null, 2))
    writeTracking({
      mcpServers: [
        { name: 'ns-x', configPath: claudeConfig, harness: 'claude', configuredAt: FIXED_TS },
        { name: 'ns-x', configPath: legacyPath, harness: 'claude', configuredAt: FIXED_TS },
      ],
      externalMcp: {
        claude: {
          state: 'active',
          updatedAt: FIXED_TS,
          entries: [{ name: 'ns-x', configPath: claudeConfig, fingerprint: fingerprintExternalMcpEntry(entryA) as string, recordedAt: FIXED_TS }],
        },
      },
    })

    const legacyDir = dirname(legacyPath)
    chmodSync(legacyDir, 0o500)
    const { runCli } = await simulateNativeCli()
    try {
      const first = await (await import('../../src/index.js')).uninstall('claude', { runCli })

      assert.strictEqual(first.success, false, 'the failed legacy phase is never a clean success')
      const claudeAfter = JSON.parse(readFileSync(claudeConfig, 'utf8'))
      assert.ok(!('ns-x' in (claudeAfter.mcpServers ?? {})), 'external half completed')
      const legacyAfter = JSON.parse(readFileSync(legacyPath, 'utf8'))
      assert.ok('ns-x' in (legacyAfter.mcpServers ?? {}), 'same-name legacy copy kept when its phase failed')
      assert.deepStrictEqual(
        trackedNames('claude'),
        ['ns-x'],
        'the same-name legacy row must survive the external phase as retry evidence'
      )

      // Retry after the environment is fixed: the pending obligation must be
      // completed, not reported as not-present while the entry stays on disk.
      chmodSync(legacyDir, 0o755)
      const retry = await (await import('../../src/index.js')).uninstall('claude', { runCli })
      assert.deepStrictEqual(retry.errors, [], retry.errors.join('; '))
      assert.strictEqual(
        retry.stages.find((e) => e.stage === 'mcp')?.status,
        'removed',
        'the retry completes the pending legacy obligation'
      )
      const legacyRetried = JSON.parse(readFileSync(legacyPath, 'utf8'))
      assert.ok(!('ns-x' in (legacyRetried.mcpServers ?? {})), 'the retry removes the same-name legacy copy')
      assert.deepStrictEqual(trackedNames('claude'), [], 'no attributable row left behind')
    } finally {
      chmodSync(legacyDir, 0o755)
    }
  })
})
