import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, isAbsolute } from 'node:path'
import { tmpdir } from 'node:os'
import type { SkillRef } from '../../../src/types.js'

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

const skills: SkillRef[] = [
  { name: 'ns-analyze-cpu', path: 'skills/ns-analyze-cpu', description: 'CPU analysis' },
  { name: 'ns-analyze-memory', path: 'skills/ns-analyze-memory', description: 'Memory analysis' },
]

describe('readTrackingFile', () => {
  it('returns null when file does not exist', async () => {
    const { readTrackingFile } = await import('../../../src/skills/skill-tracker.js')

    assert.strictEqual(await readTrackingFile(), null)
  })

  it('returns null for corrupted file', async () => {
    const { readTrackingFile } = await import('../../../src/skills/skill-tracker.js')
    const { mkdirSync } = await import('node:fs')
    const { getAgentsDir, getTrackingFilePath } = await import('../../../src/utils/path.js')

    mkdirSync(getAgentsDir(), { recursive: true })
    writeFileSync(getTrackingFilePath(), 'not valid json')

    assert.strictEqual(await readTrackingFile(), null)
  })
})

describe('addTrackedSkills', () => {
  it('creates tracking file with skills', async () => {
    const { addTrackedSkills, readTrackingFile } = await import('../../../src/skills/skill-tracker.js')

    await addTrackedSkills(skills, 'claude')

    const tracking = await readTrackingFile()
    assert.notStrictEqual(tracking, null)
    assert.strictEqual(tracking!.skills.length, 2)
    assert.strictEqual(tracking!.skills[0].name, 'ns-analyze-cpu')
    assert.deepStrictEqual(tracking!.skills[0].harnesses, ['claude'])
    assert.strictEqual(tracking!.harness, 'claude')
  })

  it('adds harness to existing skill entry', async () => {
    const { addTrackedSkills, readTrackingFile } = await import('../../../src/skills/skill-tracker.js')

    await addTrackedSkills(skills, 'claude')
    await addTrackedSkills([skills[0]], 'codex')

    const tracking = await readTrackingFile()
    const entry = tracking!.skills.find((s) => s.name === 'ns-analyze-cpu')
    assert.deepStrictEqual(entry!.harnesses, ['claude', 'codex'])
  })

  it('backfills per-harness paths without overwriting an existing shared path', async () => {
    const { addTrackedSkills, readTrackingFile } = await import('../../../src/skills/skill-tracker.js')
    const { getTrackingFilePath } = await import('../../../src/utils/path.js')
    const sharedDir = join(tmpDir, 'shared-skills')
    const opencodeDir = join(tmpDir, 'opencode-skills')

    await addTrackedSkills([skills[0]], 'claude', undefined, sharedDir)

    const legacyTracking = await readTrackingFile()
    delete legacyTracking!.skills[0].paths
    writeFileSync(getTrackingFilePath(), JSON.stringify(legacyTracking, null, 2))

    await addTrackedSkills([skills[0]], 'opencode', undefined, opencodeDir)

    const tracking = await readTrackingFile()
    const entry = tracking!.skills.find((s) => s.name === 'ns-analyze-cpu')!
    assert.deepStrictEqual(entry.harnesses, ['claude', 'opencode'])
    assert.strictEqual(entry.path, join(sharedDir, 'ns-analyze-cpu'))
    assert.deepStrictEqual(entry.paths, {
      claude: join(sharedDir, 'ns-analyze-cpu'),
      opencode: join(opencodeDir, 'ns-analyze-cpu'),
    })
  })

  it('does not duplicate harness entries', async () => {
    const { addTrackedSkills, readTrackingFile } = await import('../../../src/skills/skill-tracker.js')

    await addTrackedSkills(skills, 'claude')
    await addTrackedSkills(skills, 'claude')

    const tracking = await readTrackingFile()
    assert.deepStrictEqual(tracking!.skills[0].harnesses, ['claude'])
  })

  it('stores normalized absolute paths', async () => {
    const { addTrackedSkills, readTrackingFile } = await import('../../../src/skills/skill-tracker.js')

    await addTrackedSkills([skills[0]], 'claude')

    const tracking = await readTrackingFile()
    const entry = tracking!.skills[0]
    assert.ok(isAbsolute(entry.path), `expected absolute path, got ${entry.path}`)
    assert.ok(entry.path.includes('ns-analyze-cpu'))
  })

  it('stores ISO8601 timestamps', async () => {
    const { addTrackedSkills, readTrackingFile } = await import('../../../src/skills/skill-tracker.js')

    await addTrackedSkills([skills[0]], 'claude')

    const tracking = await readTrackingFile()
    const entry = tracking!.skills[0]
    assert.strictEqual(new Date(entry.installedAt).toISOString(), entry.installedAt)
  })
})

describe('removeTrackedSkills', () => {
  it('removes harness from entry when harness specified', async () => {
    const { addTrackedSkills, removeTrackedSkills, readTrackingFile } = await import('../../../src/skills/skill-tracker.js')

    await addTrackedSkills([skills[0]], 'claude')
    await addTrackedSkills([skills[0]], 'codex')
    await removeTrackedSkills([skills[0]], 'claude')

    const tracking = await readTrackingFile()
    const entry = tracking!.skills.find((s) => s.name === 'ns-analyze-cpu')
    assert.deepStrictEqual(entry!.harnesses, ['codex'])
  })

  it('removes per-harness path and keeps legacy path aligned with remaining harness', async () => {
    const { addTrackedSkills, removeTrackedSkills, readTrackingFile } = await import('../../../src/skills/skill-tracker.js')
    const sharedDir = join(tmpDir, 'shared-skills')
    const opencodeDir = join(tmpDir, 'opencode-skills')

    await addTrackedSkills([skills[0]], 'claude', undefined, sharedDir)
    await addTrackedSkills([skills[0]], 'opencode', undefined, opencodeDir)
    await removeTrackedSkills([skills[0]], 'claude')

    const tracking = await readTrackingFile()
    const entry = tracking!.skills.find((s) => s.name === 'ns-analyze-cpu')!
    assert.deepStrictEqual(entry.harnesses, ['opencode'])
    assert.strictEqual(entry.path, join(opencodeDir, 'ns-analyze-cpu'))
    assert.deepStrictEqual(entry.paths, { opencode: join(opencodeDir, 'ns-analyze-cpu') })
  })

  it('removes entire entry when last harness removed', async () => {
    const { addTrackedSkills, removeTrackedSkills, readTrackingFile } = await import('../../../src/skills/skill-tracker.js')

    await addTrackedSkills([skills[0]], 'claude')
    await removeTrackedSkills([skills[0]], 'claude')

    assert.strictEqual(await readTrackingFile(), null)
  })

  it('removes entire entry when no harness specified', async () => {
    const { addTrackedSkills, removeTrackedSkills, readTrackingFile } = await import('../../../src/skills/skill-tracker.js')

    await addTrackedSkills(skills, 'claude')
    await removeTrackedSkills([skills[0]])

    const tracking = await readTrackingFile()
    assert.strictEqual(tracking!.skills.length, 1)
    assert.strictEqual(tracking!.skills[0].name, 'ns-analyze-memory')
  })

  it('deletes file when skills and mcpServers are both empty', async () => {
    const { addTrackedSkills, removeTrackedSkills, readTrackingFile } = await import('../../../src/skills/skill-tracker.js')
    const { getTrackingFilePath } = await import('../../../src/utils/path.js')

    await addTrackedSkills([skills[0]], 'claude')
    await removeTrackedSkills([skills[0]], 'claude')

    assert.ok(!existsSync(getTrackingFilePath()))
    assert.strictEqual(await readTrackingFile(), null)
  })

  it('does nothing when tracking file missing', async () => {
    const { removeTrackedSkills } = await import('../../../src/skills/skill-tracker.js')

    assert.strictEqual(await removeTrackedSkills(skills, 'claude'), undefined)
  })
})

describe('listTrackedSkills', () => {
  it('returns empty array when no tracking file', async () => {
    const { listTrackedSkills } = await import('../../../src/skills/skill-tracker.js')

    assert.deepStrictEqual(await listTrackedSkills(), [])
  })

  it('returns tracked skills', async () => {
    const { addTrackedSkills, listTrackedSkills } = await import('../../../src/skills/skill-tracker.js')

    await addTrackedSkills(skills, 'claude')

    const listed = await listTrackedSkills()
    assert.strictEqual(listed.length, 2)
    assert.deepStrictEqual(listed.map((s) => s.name), ['ns-analyze-cpu', 'ns-analyze-memory'])
  })
})

describe('readTrackingFileStrict: pending marketplace removal validation', () => {
  const recordedAt = '2026-01-01T00:00:00.000Z'
  const base = { version: '1.0.0', installedAt: recordedAt, harness: 'claude', skills: [], mcpServers: [] }

  function writeTracking (value: unknown): void {
    mkdirSync(join(tmpDir, '.agents'), { recursive: true })
    writeFileSync(join(tmpDir, '.agents/.nodesource-installed.json'), JSON.stringify(value))
  }

  /** Every shape here must be refused: a malformed pending record can authorize an unrelated cleanup. */
  const malformed: Array<[string, Record<string, unknown>]> = [
    ['a non-object field with no externalMcp state', { pendingMarketplaceRemovals: 'corrupt' }],
    ['a null field', { pendingMarketplaceRemovals: null }],
    ['an array field', { pendingMarketplaceRemovals: [] }],
    ['an unknown harness key', { pendingMarketplaceRemovals: { 'not-a-harness': [] } }],
    ['a non-array harness record', { pendingMarketplaceRemovals: { claude: 'nodesource' } }],
    ['a non-object entry', { pendingMarketplaceRemovals: { claude: [42] } }],
    ['an unrelated marketplace name', { pendingMarketplaceRemovals: { claude: [{ name: 'unrelated-marketplace', scope: 'bogus', reason: 'retry' }] } }],
    ['a plugin base name used as a marketplace name', { pendingMarketplaceRemovals: { claude: [{ name: 'nsolid-skills-plugin', scope: 'user', reason: 'r', recordedAt }] } }],
    ['an invalid explicit scope', { pendingMarketplaceRemovals: { claude: [{ name: 'nodesource', scope: 'bogus', reason: 'r', recordedAt }] } }],
    ['a non-string scope', { pendingMarketplaceRemovals: { claude: [{ name: 'nodesource', scope: 7, reason: 'r', recordedAt }] } }],
    ['a missing Claude scope', { pendingMarketplaceRemovals: { claude: [{ name: 'nodesource', reason: 'r', recordedAt }] } }],
    ['a scope on a non-Claude harness', { pendingMarketplaceRemovals: { codex: [{ name: 'nodesource', scope: 'user', reason: 'r', recordedAt }] } }],
    ['a missing reason', { pendingMarketplaceRemovals: { claude: [{ name: 'nodesource', scope: 'user', recordedAt }] } }],
    ['a non-string recordedAt', { pendingMarketplaceRemovals: { claude: [{ name: 'nodesource', scope: 'user', reason: 'r', recordedAt: 7 }] } }],
    ['a project-scope entry with no settings path', { pendingMarketplaceRemovals: { claude: [{ name: 'nodesource', scope: 'project', reason: 'r', recordedAt }] } }],
    ['a local-scope entry with no settings path', { pendingMarketplaceRemovals: { claude: [{ name: 'nodesource', scope: 'local', reason: 'r', recordedAt }] } }],
    ['a null settings path', { pendingMarketplaceRemovals: { claude: [{ name: 'nodesource', scope: 'project', settingsPath: null, reason: 'r', recordedAt }] } }],
    ['a non-string settings path', { pendingMarketplaceRemovals: { claude: [{ name: 'nodesource', scope: 'project', settingsPath: 7, reason: 'r', recordedAt }] } }],
    ['a relative project settings path', { pendingMarketplaceRemovals: { claude: [{ name: 'nodesource', scope: 'project', settingsPath: '.claude/settings.json', reason: 'r', recordedAt }] } }],
    ['a relative local settings path', { pendingMarketplaceRemovals: { claude: [{ name: 'nodesource', scope: 'local', settingsPath: '.claude/settings.local.json', reason: 'r', recordedAt }] } }],
    ['a settings path on a user-scope entry', { pendingMarketplaceRemovals: { claude: [{ name: 'nodesource', scope: 'user', settingsPath: '/tmp/p/.claude/settings.json', reason: 'r', recordedAt }] } }],
    ['a settings path on a non-Claude harness', { pendingMarketplaceRemovals: { codex: [{ name: 'nodesource', settingsPath: '/tmp/p/.claude/settings.json', reason: 'r', recordedAt }] } }],
    ['a project settings path with a trailing separator', { pendingMarketplaceRemovals: { claude: [{ name: 'nodesource', scope: 'project', settingsPath: '/tmp/p/.claude/settings.json/', reason: 'r', recordedAt }] } }],
    ['a local settings path with a dot segment', { pendingMarketplaceRemovals: { claude: [{ name: 'nodesource', scope: 'local', settingsPath: '/tmp/p/.claude/./settings.local.json', reason: 'r', recordedAt }] } }],
    ['a project settings path with a parent segment', { pendingMarketplaceRemovals: { claude: [{ name: 'nodesource', scope: 'project', settingsPath: '/tmp/p/x/../.claude/settings.json', reason: 'r', recordedAt }] } }],
    ['a project settings path with redundant separators', { pendingMarketplaceRemovals: { claude: [{ name: 'nodesource', scope: 'project', settingsPath: '/tmp//p/.claude/settings.json', reason: 'r', recordedAt }] } }],
    ['a local settings path with a NUL byte', { pendingMarketplaceRemovals: { claude: [{ name: 'nodesource', scope: 'local', settingsPath: '/tmp/p/.claude/settings.local.json\u0000', reason: 'r', recordedAt }] } }],
  ]

  for (const [label, pending] of malformed) {
    it(`rejects ${label}`, async () => {
      const { readTrackingFileStrict } = await import('../../../src/skills/skill-tracker.js')
      writeTracking({ ...base, externalMcp: {}, ...pending })
      await assert.rejects(
        () => readTrackingFileStrict(),
        (err: any) => {
          assert.strictEqual(err.code, 'TRACKING_CORRUPT', label)
          assert.match(err.message, /pendingMarketplaceRemovals/, label)
          return true
        }
      )
    })
  }

  it('rejects a malformed pending map even when externalMcp is absent', async () => {
    const { readTrackingFileStrict } = await import('../../../src/skills/skill-tracker.js')
    writeTracking({ ...base, pendingMarketplaceRemovals: 'corrupt' })
    await assert.rejects(
      () => readTrackingFileStrict(),
      (err: any) => {
        assert.strictEqual(err.code, 'TRACKING_CORRUPT')
        assert.match(err.message, /pendingMarketplaceRemovals/)
        return true
      }
    )
  })

  it('accepts the canonical and legacy-experimental pending identities', async () => {
    const { readTrackingFileStrict } = await import('../../../src/skills/skill-tracker.js')
    writeTracking({
      ...base,
      pendingMarketplaceRemovals: {
        claude: [{ name: 'nodesource', scope: 'user', reason: 'r', recordedAt }],
        codex: [{ name: 'nodesource', reason: 'r', recordedAt }],
        antigravity: [{ name: 'nsolid-skills', reason: 'r', recordedAt }],
      },
    })
    const tracking = await readTrackingFileStrict()
    assert.strictEqual(tracking?.pendingMarketplaceRemovals?.claude?.length, 1)
  })

  it('accepts project and local identities that carry an absolute settings path', async () => {
    const { readTrackingFileStrict } = await import('../../../src/skills/skill-tracker.js')
    const settingsPath = join(tmpDir, 'project-a/.claude/settings.json')
    const localSettingsPath = join(tmpDir, 'project-a/.claude/settings.local.json')
    writeTracking({
      ...base,
      pendingMarketplaceRemovals: {
        claude: [
          { name: 'nodesource', scope: 'project', settingsPath, reason: 'r', recordedAt },
          { name: 'nsolid-skills', scope: 'local', settingsPath: localSettingsPath, reason: 'r', recordedAt },
        ],
      },
    })
    const tracking = await readTrackingFileStrict()
    assert.deepStrictEqual(
      tracking?.pendingMarketplaceRemovals?.claude?.map((record) => [record.scope, record.settingsPath]),
      [['project', settingsPath], ['local', localSettingsPath]]
    )
  })

  it('still accepts a legacy file with no pending and no external state', async () => {
    const { readTrackingFileStrict } = await import('../../../src/skills/skill-tracker.js')
    writeTracking(base)
    assert.deepStrictEqual((await readTrackingFileStrict())?.skills, [])
  })
})
