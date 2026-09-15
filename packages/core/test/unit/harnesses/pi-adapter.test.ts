import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import path, { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('PiAdapter', () => {
  let tmpDir: string
  let originalHome: string | undefined
  let originalUserProfile: string | undefined

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'nsolid-test-'))
    originalHome = process.env.HOME
    originalUserProfile = process.env.USERPROFILE
    process.env.HOME = tmpDir
    process.env.USERPROFILE = tmpDir
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
    if (originalHome !== undefined) {
      process.env.HOME = originalHome
    } else {
      delete process.env.HOME
    }
    if (originalUserProfile !== undefined) {
      process.env.USERPROFILE = originalUserProfile
    } else {
      delete process.env.USERPROFILE
    }
  })

  it('returns Pi MCP config path', async () => {
    const { PiAdapter } = await import('../../../src/harnesses/pi-adapter.js')
    const adapter = new PiAdapter()

    const configPath = adapter.getMcpConfigPath()
    assert.ok(configPath)
    assert.ok(configPath.includes(['.pi', 'agent', 'mcp.json'].join(path.sep)))
  })

  it('returns correct skills path', async () => {
    const { PiAdapter } = await import('../../../src/harnesses/pi-adapter.js')
    const adapter = new PiAdapter()

    const skillsPath = adapter.getSkillsPath()
    assert.ok(skillsPath.includes(['.pi', 'agent', 'skills'].join(path.sep)))
  })

  it('supports MCP', async () => {
    const { PiAdapter } = await import('../../../src/harnesses/pi-adapter.js')
    const adapter = new PiAdapter()

    assert.strictEqual(adapter.supportsMcp(), true)
  })

  it('reads existing MCP config', async () => {
    const { PiAdapter } = await import('../../../src/harnesses/pi-adapter.js')
    const adapter = new PiAdapter()
    const configPath = adapter.getMcpConfigPath()

    mkdirSync(path.dirname(configPath), { recursive: true })
    writeFileSync(configPath, JSON.stringify({
      mcpServers: {
        'ns-benchmark': { url: 'https://benchmark.mcp.saas.nodesource.io/mcp', headers: {} },
      },
    }, null, 2))

    const config = await adapter.readMcpConfig()
    assert.deepStrictEqual(config, {
      mcpServers: {
        'ns-benchmark': { url: 'https://benchmark.mcp.saas.nodesource.io/mcp', headers: {} },
      },
    })
  })

  it('writes MCP config', async () => {
    const { PiAdapter } = await import('../../../src/harnesses/pi-adapter.js')
    const adapter = new PiAdapter()
    const configPath = adapter.getMcpConfigPath()

    await adapter.writeMcpConfig({
      mcpServers: {
        'ns-benchmark': { url: 'https://benchmark.mcp.saas.nodesource.io/mcp', headers: {} },
      },
    })

    const written = JSON.parse(readFileSync(configPath, 'utf-8'))
    assert.deepStrictEqual(written, {
      mcpServers: {
        'ns-benchmark': { url: 'https://benchmark.mcp.saas.nodesource.io/mcp', headers: {}, auth: false },
      },
    })
  })

  it('returns correct name', async () => {
    const { PiAdapter } = await import('../../../src/harnesses/pi-adapter.js')
    const adapter = new PiAdapter()

    assert.strictEqual(adapter.name, 'pi')
  })
})

describe('PiAdapter.detectNativePlugin', () => {
  let tmpDir: string
  let originalHome: string | undefined
  let originalUserProfile: string | undefined

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'nsolid-test-'))
    originalHome = process.env.HOME
    originalUserProfile = process.env.USERPROFILE
    process.env.HOME = tmpDir
    process.env.USERPROFILE = tmpDir
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
    if (originalHome !== undefined) {
      process.env.HOME = originalHome
    } else {
      delete process.env.HOME
    }
    if (originalUserProfile !== undefined) {
      process.env.USERPROFILE = originalUserProfile
    } else {
      delete process.env.USERPROFILE
    }
  })

  /** Mirror how `pi install npm:nsolid-pi-plugin` records a package-backed plugin. */
  function seedPiPlugin (): void {
    const packageRoot = join(tmpDir, 'pi-package')
    mkdirSync(packageRoot, { recursive: true })
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: 'nsolid-pi-plugin', version: '1.0.0' }))
    mkdirSync(join(tmpDir, '.pi', 'agent'), { recursive: true })
    writeFileSync(join(tmpDir, '.pi', 'agent', 'settings.json'), JSON.stringify({ packages: [packageRoot] }))
  }

  it('surfaces concrete installed ids when the nsolid-pi-plugin package is installed', async () => {
    seedPiPlugin()
    const { PiAdapter } = await import('../../../src/harnesses/pi-adapter.js')
    const adapter = new PiAdapter()

    const status = adapter.detectNativePlugin()
    assert.strictEqual(status.installed, true)
    assert.strictEqual(status.enabled, true)
    assert.deepStrictEqual(status.installedIds, ['nsolid-pi-plugin'])
    assert.strictEqual(status.label, 'nsolid-pi-plugin')
  })

  it('reports an empty id set when the package is not installed', async () => {
    const { PiAdapter } = await import('../../../src/harnesses/pi-adapter.js')
    const adapter = new PiAdapter()

    const status = adapter.detectNativePlugin()
    assert.strictEqual(status.installed, false)
    assert.deepStrictEqual(status.installedIds, [])
  })

  it('feeds the plugin registry inspection so uninstall never sees verified absence for an installed package', async () => {
    seedPiPlugin()
    const { PiAdapter } = await import('../../../src/harnesses/pi-adapter.js')
    const { inspectNativeInstallation } = await import('../../../src/harnesses/plugin-registry.js')
    const adapter = new PiAdapter()

    const inspection = inspectNativeInstallation('pi', adapter)
    assert.deepStrictEqual(inspection.pluginIds, ['nsolid-pi-plugin'])
    assert.strictEqual(inspection.installedPluginIds.includes('nsolid-pi-plugin'), true)
    assert.strictEqual(inspection.supportsMarketplaceRemove, false)
  })
})
