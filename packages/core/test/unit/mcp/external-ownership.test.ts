import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { SkillRef } from '../../../src/types.js'

let tmpDir: string
let originalHome: string | undefined
let originalUserProfile: string | undefined

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'nsolid-ext-owner-'))
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

const CLAUDE_CONFIG = '~/.claude.json'
const CODEX_CONFIG = '~/.codex/config.toml'

function claudeConfigPath (): string {
  return join(tmpDir, '.claude.json')
}

function codexConfigPath (): string {
  return join(tmpDir, '.codex', 'config.toml')
}

/** Claude JSON config with the two owned entries plus a user-owned server. */
function writeClaudeConfig (servers: Record<string, unknown> = {
  'nsolid-console': { type: 'http', url: 'https://mcp.nodesource.com/console', headers: { 'X-Nsolid-Service-Token': 'token-one' } },
  ncm: { type: 'http', url: 'https://mcp.nodesource.com/ncm', headers: { 'X-Nsolid-Service-Token': 'token-one' } },
  'user-server': { type: 'http', url: 'https://user.example.com', headers: { Authorization: 'Bearer user' } },
}): void {
  const configPath = claudeConfigPath()
  mkdirSync(join(tmpDir), { recursive: true })
  writeFileSync(configPath, JSON.stringify({ mcpServers: servers }, null, 2) + '\n')
}

function writeCodexConfig (url = 'https://mcp.nodesource.com/console', token = 'token-one'): void {
  const configPath = codexConfigPath()
  mkdirSync(join(tmpDir, '.codex'), { recursive: true })
  writeFileSync(configPath, [
    '[mcp_servers.nsolid-console]',
    `url = "${url}"`,
    '[mcp_servers.nsolid-console.headers]',
    `X-Nsolid-Service-Token = "${token}"`,
    '',
  ].join('\n'))
}

function trackingPath (): string {
  return join(tmpDir, '.agents', '.nodesource-installed.json')
}

function readTracking (): Record<string, any> {
  return JSON.parse(readFileSync(trackingPath(), 'utf8'))
}

async function recordClaudeOwnership (): Promise<void> {
  const { recordExternalMcpOwnership } = await import('../../../src/mcp/external-ownership.js')
  await recordExternalMcpOwnership('claude', [
    { name: 'nsolid-console', configPath: CLAUDE_CONFIG },
    { name: 'ncm', configPath: CLAUDE_CONFIG },
  ])
}

describe('external MCP ownership fingerprints', () => {
  it('normalizes Antigravity serverUrl to the canonical url', async () => {
    const { normalizeExternalMcpEntry, fingerprintExternalMcpEntry } = await import('../../../src/mcp/external-ownership.js')

    assert.deepStrictEqual(
      normalizeExternalMcpEntry({ serverUrl: 'https://mcp.example.com', headers: { Authorization: 'Bearer abc' } }),
      { url: 'https://mcp.example.com', headers: [['authorization', 'Bearer abc']], fields: [] }
    )
    assert.strictEqual(
      fingerprintExternalMcpEntry({ serverUrl: 'https://mcp.example.com', headers: { Authorization: 'Bearer abc' } }),
      fingerprintExternalMcpEntry({ url: 'https://mcp.example.com', headers: { authorization: 'Bearer abc' } }),
      'serverUrl/url and header-name casing must not change the fingerprint'
    )
  })

  it('treats the Codex headers/http_headers spellings as the same entry (schema migration)', async () => {
    const { fingerprintExternalMcpEntry } = await import('../../../src/mcp/external-ownership.js')

    const preFix = { url: 'https://mcp.nodesource.com/console', headers: { 'X-Nsolid-Service-Token': 'token-one' } }
    const postFix = { url: 'https://mcp.nodesource.com/console', http_headers: { 'X-Nsolid-Service-Token': 'token-one' } }

    assert.strictEqual(fingerprintExternalMcpEntry(preFix), fingerprintExternalMcpEntry(postFix))
  })

  it('changes the fingerprint on meaningful field edits but not on key order', async () => {
    const { fingerprintExternalMcpEntry } = await import('../../../src/mcp/external-ownership.js')

    const base = { url: 'https://mcp.nodesource.com/console', headers: { 'X-Nsolid-Service-Token': 'token-one' }, enabled: true }
    const reordered = { enabled: true, headers: { 'X-Nsolid-Service-Token': 'token-one' }, url: 'https://mcp.nodesource.com/console' }
    const editedToken = { ...base, headers: { 'X-Nsolid-Service-Token': 'token-two' } }
    const editedUrl = { ...base, url: 'https://mcp.nodesource.com/other' }
    const editedEnabled = { ...base, enabled: false }
    const editedCommand = { url: 'https://mcp.nodesource.com/console', command: 'node', args: ['server.js'] }
    const editedEnv = { ...base, env: { EXTRA_AUTH: 'one' } }

    assert.strictEqual(fingerprintExternalMcpEntry(base), fingerprintExternalMcpEntry(reordered), 'key order is not an edit')
    assert.notStrictEqual(fingerprintExternalMcpEntry(base), fingerprintExternalMcpEntry(editedToken))
    assert.notStrictEqual(fingerprintExternalMcpEntry(base), fingerprintExternalMcpEntry(editedUrl))
    assert.notStrictEqual(fingerprintExternalMcpEntry(base), fingerprintExternalMcpEntry(editedEnabled), 'enabled is a meaningful field')
    assert.notStrictEqual(fingerprintExternalMcpEntry(editedCommand), fingerprintExternalMcpEntry({ ...editedCommand, env: { EXTRA_AUTH: 'two' } }))
    assert.notStrictEqual(fingerprintExternalMcpEntry(base), fingerprintExternalMcpEntry(editedEnv), 'an extra auth option/env is a meaningful field')
  })

  it('stores only a sha256 digest and never the header value', async () => {
    const { fingerprintExternalMcpEntry } = await import('../../../src/mcp/external-ownership.js')

    const fingerprint = fingerprintExternalMcpEntry({ url: 'https://mcp.example.com', headers: { Authorization: 'Bearer super-secret-token' } })

    assert.match(fingerprint!, /^[0-9a-f]{64}$/)
    assert.ok(!fingerprint!.includes('super-secret-token'))
  })

  it('returns null for non-objects and URL-less entries', async () => {
    const { fingerprintExternalMcpEntry } = await import('../../../src/mcp/external-ownership.js')

    assert.strictEqual(fingerprintExternalMcpEntry(null), null)
    assert.strictEqual(fingerprintExternalMcpEntry('nope'), null)
    assert.strictEqual(fingerprintExternalMcpEntry({ command: 'node', args: [] }), null)
  })
})

describe('external ownership tracking', () => {
  it('records active ownership with per-entry fingerprints read back from disk', async () => {
    writeClaudeConfig()
    await recordClaudeOwnership()

    const tracking = readTracking()
    const record = tracking.externalMcp.claude
    assert.strictEqual(record.state, 'active')
    assert.deepStrictEqual(record.entries.map((e: any) => e.name).sort(), ['ncm', 'nsolid-console'])
    for (const entry of record.entries) {
      assert.match(entry.fingerprint, /^[0-9a-f]{64}$/)
      assert.strictEqual(entry.configPath, claudeConfigPath())
    }
    const raw = readFileSync(trackingPath(), 'utf8')
    assert.ok(!raw.includes('token-one'), 'ownership state must not store token values')
  })

  it('keeps the tracking file alive when removeTrackedSkills empties the skill array', async () => {
    const { addTrackedSkills, removeTrackedSkills } = await import('../../../src/skills/skill-tracker.js')
    const skill: SkillRef = { name: 'ns-skill', path: 'skills/ns-skill', description: '' }

    writeClaudeConfig()
    await recordClaudeOwnership()
    await addTrackedSkills([skill], 'claude')
    await removeTrackedSkills([skill], 'claude')

    assert.ok(existsSync(trackingPath()), 'external state must survive the skill-side unlink condition')
    const tracking = readTracking()
    assert.strictEqual(tracking.skills.length, 0)
    assert.strictEqual(tracking.externalMcp.claude.state, 'active')
  })

  it('keeps the tracking file alive when removeTrackedMcps empties the MCP array', async () => {
    const { addTrackedMcps, removeTrackedMcps } = await import('../../../src/mcp/mcp-tracker.js')

    writeClaudeConfig()
    await recordClaudeOwnership()
    await addTrackedMcps([{ name: 'nsolid-console', configPath: CLAUDE_CONFIG }], 'claude')
    await removeTrackedMcps(['nsolid-console'], 'claude')

    assert.ok(existsSync(trackingPath()), 'external state must survive the MCP-side unlink condition')
    const tracking = readTracking()
    assert.strictEqual(tracking.mcpServers.length, 0)
    assert.strictEqual(tracking.externalMcp.claude.state, 'active')
  })
})

describe('recordExternalMcpOwnership survivor reconciliation', () => {
  const SECOND_CONFIG = '~/.claude-second.json'

  function secondConfigPath (): string {
    return join(tmpDir, '.claude-second.json')
  }

  function writeSecondConfig (servers: Record<string, unknown>): void {
    mkdirSync(tmpDir, { recursive: true })
    writeFileSync(secondConfigPath(), JSON.stringify({ mcpServers: servers }, null, 2) + '\n')
  }

  // writeMcpConfig MERGES: a refreshed external setup with a smaller write-set
  // leaves earlier owned servers configured. The record used to shrink to the
  // new write-set, so a later disconnect removed only the recorded subset and
  // reported success while unrecorded servers (with their tokens) stayed
  // configured. Survivors must be re-verified from disk and kept owned.
  it('keeps verified survivors in the record when a smaller write-set is re-recorded', async () => {
    const { recordExternalMcpOwnership, disconnectExternalMcp } = await import('../../../src/mcp/external-ownership.js')
    writeClaudeConfig()
    await recordClaudeOwnership() // nsolid-console + ncm

    // ncm survives on disk (merge) but is not in the new write-set.
    await recordExternalMcpOwnership('claude', [{ name: 'nsolid-console', configPath: CLAUDE_CONFIG }])

    const record = readTracking().externalMcp.claude
    assert.strictEqual(record.state, 'active')
    assert.deepStrictEqual(record.entries.map((e: any) => e.name).sort(), ['ncm', 'nsolid-console'], 'survivor kept with fresh evidence')
    for (const entry of record.entries) assert.match(entry.fingerprint, /^[0-9a-f]{64}$/)

    // The later disconnect removes the full surviving set, not just the subset.
    const result = await disconnectExternalMcp(['claude'])
    assert.strictEqual(result.success, true, result.errors.join('; '))
    const config = JSON.parse(readFileSync(claudeConfigPath(), 'utf8'))
    assert.ok(!config.mcpServers['nsolid-console'], 'owned entry removed')
    assert.ok(!config.mcpServers.ncm, 'survivor removed too')
    assert.ok(config.mcpServers['user-server'], 'user-owned server untouched')
  })

  it('drops a prior recorded entry that no longer exists on disk (ghost)', async () => {
    const { recordExternalMcpOwnership } = await import('../../../src/mcp/external-ownership.js')
    writeClaudeConfig()
    await recordClaudeOwnership()

    // Delete ncm from the config before the re-record: it must vanish from the
    // ownership record instead of making the next disconnect fail or lie.
    const config = JSON.parse(readFileSync(claudeConfigPath(), 'utf8'))
    delete config.mcpServers.ncm
    writeFileSync(claudeConfigPath(), JSON.stringify(config, null, 2) + '\n')

    await recordExternalMcpOwnership('claude', [{ name: 'nsolid-console', configPath: CLAUDE_CONFIG }])

    const record = readTracking().externalMcp.claude
    assert.deepStrictEqual(record.entries.map((e: any) => e.name), ['nsolid-console'], 'ghost dropped from ownership')
  })

  it('fails like a new-entry read-back failure when a surviving prior entry is unreadable', async () => {
    const { recordExternalMcpOwnership } = await import('../../../src/mcp/external-ownership.js')
    // The prior record spans two files so the NEW entry stays readable while
    // the SURVIVOR's file becomes corrupt: the failure must come from the
    // survivor branch, not from the new-entry read-back.
    writeClaudeConfig()
    writeSecondConfig({ ncm: { type: 'http', url: 'https://mcp.nodesource.com/ncm', headers: { 'X-Nsolid-Service-Token': 'token-one' } } })
    await recordExternalMcpOwnership('claude', [
      { name: 'nsolid-console', configPath: CLAUDE_CONFIG },
      { name: 'ncm', configPath: SECOND_CONFIG },
    ])

    writeFileSync(secondConfigPath(), '{ not json')
    const trackingBefore = readFileSync(trackingPath(), 'utf8')

    await assert.rejects(
      () => recordExternalMcpOwnership('claude', [{ name: 'nsolid-console', configPath: CLAUDE_CONFIG }]),
      (err: any) => {
        assert.strictEqual(err.code, 'EXTERNAL_MCP_UNMANAGED')
        assert.match(err.message, /could not be read back/)
        return true
      }
    )

    assert.strictEqual(
      readFileSync(trackingPath(), 'utf8'),
      trackingBefore,
      'a refused refresh must not persist partial tracking: prior ownership evidence survives intact'
    )
  })
})

describe('assertNoActiveExternalMcp', () => {
  it('throws EXTERNAL_MCP_ACTIVE for an active record', async () => {
    const { assertNoActiveExternalMcp } = await import('../../../src/mcp/external-ownership.js')
    writeClaudeConfig()
    await recordClaudeOwnership()

    await assert.rejects(
      () => assertNoActiveExternalMcp(['claude'], 'install'),
      (err: any) => {
        assert.strictEqual(err.code, 'EXTERNAL_MCP_ACTIVE')
        assert.match(err.message, /install cannot run/)
        assert.match(err.message, /claude/)
        assert.match(err.action, /uninstall --external-mcp --harness claude/)
        return true
      }
    )
  })

  it('does not block a disconnected tombstone or missing tracking', async () => {
    const { assertNoActiveExternalMcp } = await import('../../../src/mcp/external-ownership.js')

    await assertNoActiveExternalMcp(['claude'], 'setup')
    mkdirSync(join(tmpDir, '.agents'), { recursive: true })
    writeFileSync(trackingPath(), JSON.stringify({
      version: '1.0.0',
      installedAt: new Date().toISOString(),
      harness: 'claude',
      skills: [],
      mcpServers: [],
      externalMcp: { claude: { state: 'disconnected', updatedAt: new Date().toISOString(), entries: [] } },
    }))

    await assertNoActiveExternalMcp(['claude'], 'setup')
  })

  function writeTracking (data: unknown): void {
    mkdirSync(join(tmpDir, '.agents'), { recursive: true })
    writeFileSync(trackingPath(), typeof data === 'string' ? data : JSON.stringify(data))
  }

  it('rejects an unparsable tracking file instead of treating it as fresh', async () => {
    const { assertNoActiveExternalMcp } = await import('../../../src/mcp/external-ownership.js')
    writeTracking('{ not json')

    await assert.rejects(
      () => assertNoActiveExternalMcp(['claude'], 'setup'),
      (err: any) => {
        assert.strictEqual(err.code, 'TRACKING_CORRUPT')
        assert.match(err.message, /could not be parsed/)
        return true
      }
    )
  })

  it('rejects malformed external state instead of bypassing the active guard', async () => {
    const { assertNoActiveExternalMcp } = await import('../../../src/mcp/external-ownership.js')
    const base = { version: '1.0.0', installedAt: new Date().toISOString(), harness: 'claude', skills: [], mcpServers: [] }

    for (const externalMcp of [
      { claude: 'active' },
      { claude: { state: 'actve', entries: [] } },
      { claude: { state: 'active' } },
      { claude: { state: 'active', entries: [{ name: 'ncm' }] } },
      'active',
    ]) {
      writeTracking({ ...base, externalMcp })
      await assert.rejects(
        () => assertNoActiveExternalMcp(['claude'], 'setup'),
        (err: any) => {
          assert.strictEqual(err.code, 'TRACKING_CORRUPT', `malformed state must not bypass the guard: ${JSON.stringify(externalMcp)}`)
          assert.match(err.message, /is malformed/)
          return true
        }
      )
    }
  })
})

describe('disconnectExternalMcp', () => {
  it('reports an active record with no entries during shared ownership preflight', async () => {
    const { externalMcpOwnershipProblems } = await import('../../../src/mcp/external-ownership.js')

    assert.deepStrictEqual(
      externalMcpOwnershipProblems('claude', { state: 'active', entries: [], updatedAt: new Date().toISOString() }),
      ['External MCP record for claude has no entries to disconnect']
    )
  })

  it('removes only owned entries, retains a tombstone, and is idempotent', async () => {
    const { disconnectExternalMcp } = await import('../../../src/mcp/external-ownership.js')
    const { listTrackedMcps } = await import('../../../src/mcp/mcp-tracker.js')

    writeClaudeConfig()
    await recordClaudeOwnership()

    const first = await disconnectExternalMcp(['claude'])
    assert.deepStrictEqual(first.errors, [])
    assert.deepStrictEqual(first.disconnected, ['claude'])
    assert.strictEqual(first.success, true)

    const config = JSON.parse(readFileSync(claudeConfigPath(), 'utf8'))
    assert.deepStrictEqual(Object.keys(config.mcpServers), ['user-server'], 'owned entries removed, unrelated server preserved')
    assert.strictEqual((await listTrackedMcps('claude')).length, 0)
    const tracking = readTracking()
    assert.strictEqual(tracking.externalMcp.claude.state, 'disconnected')
    assert.ok(tracking.externalMcp.claude.disconnectedAt)
    assert.deepStrictEqual(tracking.externalMcp.claude.entries.map((e: any) => e.name).sort(), ['ncm', 'nsolid-console'])
    assert.ok(existsSync(trackingPath()), 'tombstone keeps the tracking file alive')

    const configBefore = readFileSync(claudeConfigPath(), 'utf8')
    const backupDir = join(tmpDir, '.agents', '.config-backup', 'claude')
    const backupsBefore = existsSync(backupDir) ? readdirSync(backupDir).length : 0

    const second = await disconnectExternalMcp(['claude'])
    assert.strictEqual(second.success, true)
    assert.deepStrictEqual(second.alreadyDisconnected, ['claude'])
    assert.deepStrictEqual(second.disconnected, [])
    assert.strictEqual(readFileSync(claudeConfigPath(), 'utf8'), configBefore, 'no-op re-run is byte-identical')
    const backupsAfter = existsSync(backupDir) ? readdirSync(backupDir).length : 0
    assert.strictEqual(backupsAfter, backupsBefore, 'no-op re-run must not churn backups')
  })

  it('aborts the whole command when a recorded entry was edited', async () => {
    const { disconnectExternalMcp } = await import('../../../src/mcp/external-ownership.js')

    writeClaudeConfig()
    await recordClaudeOwnership()

    const edited = JSON.parse(readFileSync(claudeConfigPath(), 'utf8'))
    edited.mcpServers['nsolid-console'].headers['X-Nsolid-Service-Token'] = 'token-edited'
    writeFileSync(claudeConfigPath(), JSON.stringify(edited, null, 2) + '\n')
    const configBefore = readFileSync(claudeConfigPath(), 'utf8')
    const trackingBefore = readFileSync(trackingPath(), 'utf8')

    const result = await disconnectExternalMcp(['claude'])

    assert.strictEqual(result.success, false)
    assert.deepStrictEqual(result.disconnected, [])
    assert.ok(result.errors.some((e) => e.includes('no longer matches the ownership evidence')))
    assert.strictEqual(readFileSync(claudeConfigPath(), 'utf8'), configBefore)
    assert.strictEqual(readFileSync(trackingPath(), 'utf8'), trackingBefore)
  })

  it('aborts when a recorded entry is missing from the config', async () => {
    const { disconnectExternalMcp } = await import('../../../src/mcp/external-ownership.js')

    writeClaudeConfig()
    await recordClaudeOwnership()

    const edited = JSON.parse(readFileSync(claudeConfigPath(), 'utf8'))
    delete edited.mcpServers['ncm']
    writeFileSync(claudeConfigPath(), JSON.stringify(edited, null, 2) + '\n')
    const configBefore = readFileSync(claudeConfigPath(), 'utf8')

    const result = await disconnectExternalMcp(['claude'])

    assert.strictEqual(result.success, false)
    assert.ok(result.errors.some((e) => e.includes('is missing from')))
    assert.strictEqual(readFileSync(claudeConfigPath(), 'utf8'), configBefore)
  })

  it('refuses entries with no external record (pre-wave state) without any deletion', async () => {
    const { disconnectExternalMcp } = await import('../../../src/mcp/external-ownership.js')
    const { addTrackedMcps } = await import('../../../src/mcp/mcp-tracker.js')

    writeClaudeConfig()
    await addTrackedMcps([{ name: 'nsolid-console', configPath: CLAUDE_CONFIG }], 'claude')
    const configBefore = readFileSync(claudeConfigPath(), 'utf8')
    const trackingBefore = readFileSync(trackingPath(), 'utf8')

    const result = await disconnectExternalMcp(['claude'])

    assert.strictEqual(result.success, false)
    assert.ok(result.errors.some((e) => e.includes('No external MCP ownership record')))
    assert.strictEqual(readFileSync(claudeConfigPath(), 'utf8'), configBefore)
    assert.strictEqual(readFileSync(trackingPath(), 'utf8'), trackingBefore)
  })

  it('refuses when the tracking file is missing or corrupt', async () => {
    const { disconnectExternalMcp } = await import('../../../src/mcp/external-ownership.js')

    writeClaudeConfig()
    const missing = await disconnectExternalMcp(['claude'])
    assert.strictEqual(missing.success, false)
    assert.ok(missing.errors.some((e) => e.includes('no tracking file was found')))

    mkdirSync(join(tmpDir, '.agents'), { recursive: true })
    writeFileSync(trackingPath(), 'not valid json')
    const corrupt = await disconnectExternalMcp(['claude'])
    assert.strictEqual(corrupt.success, false)
    assert.ok(corrupt.errors.some((e) => e.includes('could not be parsed')))
    assert.strictEqual(readFileSync(claudeConfigPath(), 'utf8').includes('nsolid-console'), true)
  })

  it('refuses re-created entries after a completed disconnect (restore case)', async () => {
    const { disconnectExternalMcp } = await import('../../../src/mcp/external-ownership.js')

    writeClaudeConfig()
    await recordClaudeOwnership()
    const original = readFileSync(claudeConfigPath(), 'utf8')

    await disconnectExternalMcp(['claude'])
    writeFileSync(claudeConfigPath(), original)
    const configBefore = readFileSync(claudeConfigPath(), 'utf8')

    const result = await disconnectExternalMcp(['claude'])
    assert.strictEqual(result.success, false)
    assert.ok(result.errors.some((e) => e.includes('already disconnected')))
    assert.strictEqual(readFileSync(claudeConfigPath(), 'utf8'), configBefore)
  })

  it('aborts all selected harnesses when any one of them mismatches', async () => {
    const { disconnectExternalMcp } = await import('../../../src/mcp/external-ownership.js')
    const { recordExternalMcpOwnership } = await import('../../../src/mcp/external-ownership.js')

    writeClaudeConfig()
    writeCodexConfig()
    await recordClaudeOwnership()
    await recordExternalMcpOwnership('codex', [{ name: 'nsolid-console', configPath: CODEX_CONFIG }])

    const codexEdited = readFileSync(codexConfigPath(), 'utf8').replace('token-one', 'token-edited')
    writeFileSync(codexConfigPath(), codexEdited)

    const claudeBefore = readFileSync(claudeConfigPath(), 'utf8')
    const codexBefore = readFileSync(codexConfigPath(), 'utf8')
    const trackingBefore = readFileSync(trackingPath(), 'utf8')

    const result = await disconnectExternalMcp(['claude', 'codex'])

    assert.strictEqual(result.success, false)
    assert.deepStrictEqual(result.disconnected, [])
    assert.ok(result.errors.some((e) => e.includes('codex')))
    assert.strictEqual(readFileSync(claudeConfigPath(), 'utf8'), claudeBefore, 'verified harness must not be mutated when another aborts')
    assert.strictEqual(readFileSync(codexConfigPath(), 'utf8'), codexBefore)
    assert.strictEqual(readFileSync(trackingPath(), 'utf8'), trackingBefore)
  })

  it('matches a pre-Codex-fix fingerprint against a post-fix http_headers config', async () => {
    const { recordExternalMcpOwnership, disconnectExternalMcp } = await import('../../../src/mcp/external-ownership.js')

    // Record against the legacy `headers` spelling...
    writeCodexConfig()
    await recordExternalMcpOwnership('codex', [{ name: 'nsolid-console', configPath: CODEX_CONFIG }])

    // ...then simulate the fixed writer having rewritten the same entry with
    // the supported `http_headers` key.
    writeFileSync(codexConfigPath(), [
      '[mcp_servers.nsolid-console]',
      'url = "https://mcp.nodesource.com/console"',
      '[mcp_servers.nsolid-console.http_headers]',
      'X-Nsolid-Service-Token = "token-one"',
      '',
    ].join('\n'))

    const result = await disconnectExternalMcp(['codex'])
    assert.deepStrictEqual(result.errors, [])
    assert.deepStrictEqual(result.disconnected, ['codex'])
    assert.ok(!readFileSync(codexConfigPath(), 'utf8').includes('nsolid-console'))
  })

  it('refuses malformed external state without mutating config or tracking bytes', async () => {
    const { disconnectExternalMcp } = await import('../../../src/mcp/external-ownership.js')

    writeClaudeConfig()
    mkdirSync(join(tmpDir, '.agents'), { recursive: true })
    const malformed = {
      version: '1.0.0',
      installedAt: new Date().toISOString(),
      harness: 'claude',
      skills: [],
      mcpServers: [],
      externalMcp: { claude: { state: 'active', entries: 'not-an-array' } },
    }
    writeFileSync(trackingPath(), JSON.stringify(malformed))
    const configBefore = readFileSync(claudeConfigPath(), 'utf8')
    const trackingBefore = readFileSync(trackingPath(), 'utf8')

    const result = await disconnectExternalMcp(['claude'])

    assert.strictEqual(result.success, false)
    assert.ok(result.errors.some((e) => e.includes('is malformed')), result.errors.join('; '))
    assert.strictEqual(readFileSync(claudeConfigPath(), 'utf8'), configBefore, 'config bytes unchanged')
    assert.strictEqual(readFileSync(trackingPath(), 'utf8'), trackingBefore, 'tracking bytes unchanged')
  })

  it('rejects harnesses outside the external-capable set', async () => {
    const { disconnectExternalMcp } = await import('../../../src/mcp/external-ownership.js')

    await assert.rejects(
      () => disconnectExternalMcp(['opencode']),
      (err: any) => {
        assert.strictEqual(err.code, 'INVALID_OPTION')
        return true
      }
    )
  })
})

describe('recordExternalMcpOwnership survivor continuity', () => {
  const SECOND_CONFIG = '~/.claude-continuity.json'

  function secondConfigPath (): string {
    return join(tmpDir, '.claude-continuity.json')
  }

  function writeSecondConfig (servers: Record<string, unknown>): void {
    mkdirSync(tmpDir, { recursive: true })
    writeFileSync(secondConfigPath(), JSON.stringify({ mcpServers: servers }, null, 2) + '\n')
  }

  function readClaudeConfig (): Record<string, any> {
    return JSON.parse(readFileSync(claudeConfigPath(), 'utf8'))
  }

  function writeClaudeConfigRaw (config: unknown): void {
    writeFileSync(claudeConfigPath(), JSON.stringify(config, null, 2) + '\n')
  }

  function writeTrackingRaw (data: unknown): void {
    mkdirSync(join(tmpDir, '.agents'), { recursive: true })
    writeFileSync(trackingPath(), JSON.stringify(data))
  }

  function entryNamed (record: any, name: string): any {
    return record.entries.find((e: any) => e.name === name)
  }

  for (const { description, edit } of [
    { description: 'a URL', edit: (entry: any) => { entry.url = 'https://user.example.com/ncm-redirect' } },
    { description: 'a header', edit: (entry: any) => { entry.headers['X-Nsolid-Service-Token'] = 'token-rotated-by-user' } },
  ]) {
    it(`refuses to re-adopt a survivor edited in ${description} and keeps the prior record intact`, async () => {
      const { recordExternalMcpOwnership, disconnectExternalMcp } = await import('../../../src/mcp/external-ownership.js')
      writeClaudeConfig()
      await recordClaudeOwnership()

      const edited = readClaudeConfig()
      edit(edited.mcpServers.ncm)
      writeClaudeConfigRaw(edited)
      const trackingBefore = readFileSync(trackingPath(), 'utf8')

      await assert.rejects(
        () => recordExternalMcpOwnership('claude', [{ name: 'nsolid-console', configPath: CLAUDE_CONFIG }]),
        (err: any) => {
          assert.strictEqual(err.code, 'EXTERNAL_MCP_UNMANAGED')
          assert.ok(err.message.includes('ncm'), `diagnostic must name the entry: ${err.message}`)
          assert.ok(err.message.includes(claudeConfigPath()), `diagnostic must name the path: ${err.message}`)
          assert.match(err.message, /changed since ownership was recorded/)
          return true
        }
      )
      assert.strictEqual(readFileSync(trackingPath(), 'utf8'), trackingBefore, 'refused refresh must not persist partial tracking')
      const record = readTracking().externalMcp.claude
      assert.deepStrictEqual(record.entries.map((e: any) => e.name).sort(), ['ncm', 'nsolid-console'], 'prior record kept intact')

      const configBefore = readFileSync(claudeConfigPath(), 'utf8')
      const result = await disconnectExternalMcp(['claude'])
      assert.strictEqual(result.success, false)
      assert.deepStrictEqual(result.disconnected, [])
      assert.ok(result.errors.some((e) => e.includes('no longer matches the ownership evidence')), result.errors.join('; '))
      assert.strictEqual(readFileSync(claudeConfigPath(), 'utf8'), configBefore, 'edited survivor must not be deleted')
    })
  }

  // A URL-less survivor is presence that no longer admits a fingerprint, not
  // real absence: it must be refused instead of silently dropped as a ghost,
  // which would leave it configured behind a false "removed everything" success.
  it('refuses a survivor converted to a URL-less entry instead of ghost-dropping it', async () => {
    const { recordExternalMcpOwnership } = await import('../../../src/mcp/external-ownership.js')
    writeClaudeConfig()
    await recordClaudeOwnership()

    const edited = readClaudeConfig()
    edited.mcpServers.ncm = { command: 'node', args: ['server.js'] }
    writeClaudeConfigRaw(edited)
    const trackingBefore = readFileSync(trackingPath(), 'utf8')

    await assert.rejects(
      () => recordExternalMcpOwnership('claude', [{ name: 'nsolid-console', configPath: CLAUDE_CONFIG }]),
      (err: any) => {
        assert.strictEqual(err.code, 'EXTERNAL_MCP_UNMANAGED')
        assert.ok(err.message.includes('ncm'), `diagnostic must name the entry: ${err.message}`)
        assert.match(err.message, /no longer admits an ownership fingerprint/)
        return true
      }
    )
    assert.strictEqual(readFileSync(trackingPath(), 'utf8'), trackingBefore, 'refused refresh must not persist partial tracking')
    const record = readTracking().externalMcp.claude
    assert.ok(entryNamed(record, 'ncm'), 'prior evidence for the URL-less survivor is not silently discarded')
  })

  for (const [description, replacement] of [
    ['a scalar', '"user-owned-replacement"'],
    ['an array', '["user-owned-replacement"]'],
  ]) {
    it(`refuses a TOML survivor replaced with ${description} instead of ghost-dropping it`, async () => {
      const { recordExternalMcpOwnership } = await import('../../../src/mcp/external-ownership.js')
      mkdirSync(join(tmpDir, '.codex'), { recursive: true })
      writeFileSync(codexConfigPath(), [
        '[mcp_servers.nsolid-console]',
        'url = "https://mcp.nodesource.com/console"',
        '[mcp_servers.ncm]',
        'url = "https://mcp.nodesource.com/ncm"',
        '',
      ].join('\n'))
      await recordExternalMcpOwnership('codex', [
        { name: 'nsolid-console', configPath: CODEX_CONFIG },
        { name: 'ncm', configPath: CODEX_CONFIG },
      ])

      writeFileSync(codexConfigPath(), [
        '[mcp_servers]',
        `ncm = ${replacement}`,
        '[mcp_servers.nsolid-console]',
        'url = "https://mcp.nodesource.com/console"',
        '',
      ].join('\n'))
      const trackingBefore = readFileSync(trackingPath(), 'utf8')

      await assert.rejects(
        () => recordExternalMcpOwnership('codex', [{ name: 'nsolid-console', configPath: CODEX_CONFIG }]),
        (err: any) => {
          assert.strictEqual(err.code, 'EXTERNAL_MCP_UNMANAGED')
          assert.match(err.message, /ncm/)
          assert.match(err.message, /could not be read back/)
          return true
        }
      )
      assert.strictEqual(readFileSync(trackingPath(), 'utf8'), trackingBefore)
    })
  }

  // Continuity, not fresh adoption: the conserved survivor carries the PRIOR
  // fingerprint, proving the on-disk value is still the recorded one.
  it('conserves an intact survivor with its prior fingerprint', async () => {
    const { recordExternalMcpOwnership, disconnectExternalMcp } = await import('../../../src/mcp/external-ownership.js')
    writeClaudeConfig()
    await recordClaudeOwnership()
    const priorNcm = entryNamed(readTracking().externalMcp.claude, 'ncm')

    await recordExternalMcpOwnership('claude', [{ name: 'nsolid-console', configPath: CLAUDE_CONFIG }])

    const record = readTracking().externalMcp.claude
    assert.strictEqual(record.state, 'active')
    const freshNcm = entryNamed(record, 'ncm')
    assert.ok(freshNcm, 'intact survivor conserved')
    assert.strictEqual(freshNcm.fingerprint, priorNcm.fingerprint, 'survivor kept by continuity with prior evidence')
    assert.strictEqual(freshNcm.configPath, priorNcm.configPath)

    const result = await disconnectExternalMcp(['claude'])
    assert.strictEqual(result.success, true, result.errors.join('; '))
    const config = readClaudeConfig()
    assert.ok(!config.mcpServers['nsolid-console'])
    assert.ok(!config.mcpServers.ncm, 'conserved survivor is still removable')
    assert.ok(config.mcpServers['user-server'])
  })

  // Identity is harness + normalized config path + name: the same server name
  // in a different file is a different entry, so the prior ncm record (file A)
  // and the freshly written ncm (file B) coexist in the record.
  it('treats the same server name in a different config file as a different entry', async () => {
    const { recordExternalMcpOwnership, disconnectExternalMcp } = await import('../../../src/mcp/external-ownership.js')
    writeClaudeConfig()
    await recordClaudeOwnership() // nsolid-console@A + ncm@A
    writeSecondConfig({ ncm: { type: 'http', url: 'https://mcp.nodesource.com/ncm', headers: { 'X-Nsolid-Service-Token': 'token-one' } } })

    await recordExternalMcpOwnership('claude', [
      { name: 'nsolid-console', configPath: CLAUDE_CONFIG },
      { name: 'ncm', configPath: SECOND_CONFIG },
    ])

    const identities = readTracking().externalMcp.claude.entries
      .map((e: any) => `${e.name}@${e.configPath}`)
      .sort()
    assert.deepStrictEqual(identities, [
      `ncm@${secondConfigPath()}`,
      `ncm@${claudeConfigPath()}`,
      `nsolid-console@${claudeConfigPath()}`,
    ], 'same name in another file is a distinct entry, not an overwrite or a loss')

    const result = await disconnectExternalMcp(['claude'])
    assert.strictEqual(result.success, true, result.errors.join('; '))
    assert.ok(!readClaudeConfig().mcpServers.ncm, 'both same-name entries are owned and removable')
    assert.ok(!readClaudeConfig().mcpServers['nsolid-console'])
    assert.ok(!JSON.parse(readFileSync(secondConfigPath(), 'utf8')).mcpServers.ncm)
  })

  // Entries IN the write-set are fingerprinted fresh on purpose: a legitimate
  // re-setup may rotate values, and the new fingerprint must replace the old.
  it('renews the fingerprint for an in-write-set entry the CLI rewrote with new content', async () => {
    const { recordExternalMcpOwnership, disconnectExternalMcp, fingerprintExternalMcpEntry } = await import('../../../src/mcp/external-ownership.js')
    writeClaudeConfig()
    await recordClaudeOwnership()

    // Simulate the CLI legitimately rewriting nsolid-console with new values.
    const rewritten = readClaudeConfig()
    rewritten.mcpServers['nsolid-console'].headers['X-Nsolid-Service-Token'] = 'token-rotated-by-setup'
    writeClaudeConfigRaw(rewritten)

    await recordExternalMcpOwnership('claude', [
      { name: 'nsolid-console', configPath: CLAUDE_CONFIG },
      { name: 'ncm', configPath: CLAUDE_CONFIG },
    ])

    const record = readTracking().externalMcp.claude
    const renewed = entryNamed(record, 'nsolid-console')
    assert.strictEqual(
      renewed.fingerprint,
      fingerprintExternalMcpEntry(rewritten.mcpServers['nsolid-console']),
      'write-set entries record the fresh fingerprint, not the stale one'
    )

    const result = await disconnectExternalMcp(['claude'])
    assert.strictEqual(result.success, true, result.errors.join('; '))
    assert.ok(!readClaudeConfig().mcpServers['nsolid-console'], 'renewed entry is removable with its new fingerprint')
  })

  // A disconnected tombstone is user-superseded evidence, never renewal
  // authorization: an entry reapplied by the user after a disconnect and found
  // outside the write-set must not be carried into the fresh active record.
  it('does not re-adopt an entry reapplied from a disconnected tombstone outside the write-set', async () => {
    const { recordExternalMcpOwnership, disconnectExternalMcp, fingerprintExternalMcpEntry } = await import('../../../src/mcp/external-ownership.js')
    writeClaudeConfig() // user reapplied ncm (identical content) alongside nsolid-console
    const ncmOnDisk = readClaudeConfig().mcpServers.ncm
    const now = new Date().toISOString()
    writeTrackingRaw({
      version: '1.0.0',
      installedAt: now,
      harness: 'claude',
      skills: [],
      mcpServers: [],
      externalMcp: {
        claude: {
          state: 'disconnected',
          updatedAt: now,
          disconnectedAt: now,
          entries: [{
            name: 'ncm',
            configPath: claudeConfigPath(),
            fingerprint: fingerprintExternalMcpEntry(ncmOnDisk),
            recordedAt: now,
          }],
        },
      },
    })

    await recordExternalMcpOwnership('claude', [{ name: 'nsolid-console', configPath: CLAUDE_CONFIG }])

    const record = readTracking().externalMcp.claude
    assert.strictEqual(record.state, 'active', 'the fresh external setup supersedes the tombstone')
    assert.deepStrictEqual(
      record.entries.map((e: any) => e.name),
      ['nsolid-console'],
      'a reapplied tombstone entry outside the write-set is not re-adopted'
    )

    // The reapplied copy stays on disk as a user copy, outside CLI ownership.
    const result = await disconnectExternalMcp(['claude'])
    assert.strictEqual(result.success, true, result.errors.join('; '))
    assert.ok(readClaudeConfig().mcpServers.ncm, 'reapplied user copy must not be deleted as CLI-owned')
    assert.ok(!readClaudeConfig().mcpServers['nsolid-console'])
  })
})
