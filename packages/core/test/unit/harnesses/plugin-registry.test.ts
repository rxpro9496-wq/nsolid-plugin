import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join, dirname, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import {
  planClaudeNativeRemoval,
  marketplaceRemovalCommand,
  marketplaceRegistrationProblem,
  claudeScopeSettingsPath,
} from '../../../src/harnesses/plugin-registry.js'
import type { NativeInspection } from '../../../src/harnesses/plugin-registry.js'

/**
 * Pure planning coverage for Claude install-scope attribution: which scopes may
 * be removed exactly, and which ambiguous states must refuse before effects.
 */

function record (
  id: string,
  scope: 'user' | 'project' | 'local' | null,
  projectPath?: string
): { id: string, scope: 'user' | 'project' | 'local' | null, projectPath?: string, ambiguous: boolean } {
  return { id, scope, ...(projectPath ? { projectPath } : {}), ambiguous: false }
}

describe('planClaudeNativeRemoval', () => {
  it('plans both explicit scopes for a user+local install', () => {
    const plan = planClaudeNativeRemoval([
      record('nsolid-skills-plugin@nodesource', 'user'),
      record('nsolid-skills-plugin@nodesource', 'local'),
    ])
    assert.strictEqual(plan.problem, undefined)
    assert.deepStrictEqual(plan.plans, [{ id: 'nsolid-skills-plugin@nodesource', scopes: ['user', 'local'] }])
  })

  it('plans a scope-less single registration as legacy (no --scope)', () => {
    const plan = planClaudeNativeRemoval([record('nsolid-skills-plugin@nodesource', null)])
    assert.strictEqual(plan.problem, undefined)
    assert.deepStrictEqual(plan.plans, [{ id: 'nsolid-skills-plugin@nodesource', scopes: [null] }])
  })

  it('refuses a scope-less registration when more than one record exists', () => {
    const plan = planClaudeNativeRemoval([
      record('nsolid-skills-plugin@nodesource', 'user'),
      record('nsolid-skills-plugin@nodesource', null),
    ])
    assert.match(plan.problem ?? '', /mixes scoped and scope-less/)
    assert.deepStrictEqual(plan.plans, [])
  })

  it('refuses ambiguous records that carry no scope at all', () => {
    const plan = planClaudeNativeRemoval([
      { id: 'nsolid-skills-plugin@nodesource', scope: null, ambiguous: true },
    ])
    assert.match(plan.problem ?? '', /no recognizable scope/)
  })

  it('refuses multiple project paths for one id', () => {
    const plan = planClaudeNativeRemoval([
      record('nsolid-skills-plugin@nodesource', 'project', '/tmp/a'),
      record('nsolid-skills-plugin@nodesource', 'project', '/tmp/b'),
    ])
    assert.match(plan.problem ?? '', /multiple project paths/)
  })

  it('refuses a project install recorded for a different working directory', () => {
    const plan = planClaudeNativeRemoval([
      record('nsolid-skills-plugin@nodesource', 'project', '/tmp/other-project'),
    ], '/tmp/current')
    assert.match(plan.problem ?? '', /registered for project/)
  })

  it('accepts a project install recorded for the current working directory', () => {
    const plan = planClaudeNativeRemoval([
      record('nsolid-skills-plugin@nodesource', 'project', '/tmp/current'),
    ], '/tmp/current')
    assert.strictEqual(plan.problem, undefined)
    assert.deepStrictEqual(plan.plans, [{ id: 'nsolid-skills-plugin@nodesource', scopes: ['project'] }])
  })
})

describe('marketplaceRemovalCommand', () => {
  it('requires an explicit Claude scope (never a scope-wide removal)', () => {
    assert.deepStrictEqual(marketplaceRemovalCommand('claude', 'nodesource', 'user'), {
      cmd: 'claude',
      args: ['plugin', 'marketplace', 'remove', 'nodesource', '--scope', 'user'],
    })
    assert.strictEqual(marketplaceRemovalCommand('claude', 'nodesource', undefined), null)
  })

  it('uses the Codex marketplace-remove command', () => {
    assert.deepStrictEqual(marketplaceRemovalCommand('codex', 'nodesource'), {
      cmd: 'codex',
      args: ['plugin', 'marketplace', 'remove', 'nodesource'],
    })
  })

  it('has no command for Antigravity', () => {
    assert.strictEqual(marketplaceRemovalCommand('antigravity', 'nodesource'), null)
  })
})

describe('marketplaceRegistrationProblem', () => {
  const projectA = '/tmp/project-a'
  const projectASettings = resolve(projectA, '.claude/settings.json')

  it('requires project/local provenance to match the settings file of the given project', () => {
    assert.strictEqual(
      marketplaceRegistrationProblem({ name: 'nodesource', scope: 'project', settingsPath: projectASettings }, projectA),
      null
    )
    assert.strictEqual(
      marketplaceRegistrationProblem(
        { name: 'nodesource', scope: 'local', settingsPath: resolve(projectA, '.claude/settings.local.json') },
        projectA
      ),
      null
    )
    assert.match(
      marketplaceRegistrationProblem({ name: 'nodesource', scope: 'project' }, projectA) ?? '',
      /no recorded settings path/
    )
    assert.match(
      marketplaceRegistrationProblem(
        { name: 'nodesource', scope: 'project', settingsPath: '.claude/settings.json' },
        projectA
      ) ?? '',
      /relative settings path/
    )
    assert.match(
      marketplaceRegistrationProblem(
        { name: 'nodesource', scope: 'project', settingsPath: resolve('/tmp/project-b', '.claude/settings.json') },
        projectA
      ) ?? '',
      /belongs to/
    )
    assert.match(
      marketplaceRegistrationProblem(
        { name: 'nodesource', scope: 'local', settingsPath: projectASettings },
        projectA
      ) ?? '',
      /belongs to/
    )
  })

  it('rejects malformed absolute provenance lexically instead of normalizing it into a permission', () => {
    const cases: Array<[string, 'project' | 'local', string]> = [
      ['a trailing separator after settings.json', 'project', projectASettings + sep],
      ['a trailing separator after settings.local.json', 'local', resolve(projectA, '.claude/settings.local.json') + sep],
      ['a dot segment before the file', 'project', `${projectA}/.claude/./settings.json`],
      ['a parent segment in the middle', 'project', `${projectA}/.claude/../.claude/settings.json`],
      ['a parent segment before the local file', 'local', `${projectA}/.claude/../.claude/settings.local.json`],
      ['redundant separators', 'project', projectA + '//.claude/settings.json'],
      ['an invalid NUL byte', 'project', projectASettings + '\u0000'],
    ]
    for (const [label, scope, settingsPath] of cases) {
      const problem = marketplaceRegistrationProblem({ name: 'nodesource', scope, settingsPath }, projectA)
      assert.match(problem ?? '', /malformed settings path/, label)
    }
    // The exact paths the config lookup generates stay valid.
    assert.strictEqual(
      marketplaceRegistrationProblem({ name: 'nodesource', scope: 'project', settingsPath: projectASettings }, projectA),
      null
    )
    assert.strictEqual(
      marketplaceRegistrationProblem(
        { name: 'nodesource', scope: 'local', settingsPath: resolve(projectA, '.claude/settings.local.json') },
        projectA
      ),
      null
    )
  })

  it('keeps user-scope registrations independent of the project and rejects project provenance on them', () => {
    assert.strictEqual(marketplaceRegistrationProblem({ name: 'nodesource', scope: 'user' }, projectA), null)
    assert.match(
      marketplaceRegistrationProblem(
        { name: 'nodesource', scope: 'user', settingsPath: projectASettings },
        projectA
      ) ?? '',
      /must not be attributed to a project/
    )
  })

  it('leaves scope-less registrations (codex, antigravity, legacy) unconstrained', () => {
    assert.strictEqual(marketplaceRegistrationProblem({ name: 'nodesource' }, projectA), null)
  })

  it('resolves the settings file exactly like the config lookup', () => {
    assert.strictEqual(
      claudeScopeSettingsPath('project', projectA),
      resolve(projectA, '.claude/settings.json')
    )
    assert.strictEqual(
      claudeScopeSettingsPath('local', projectA),
      resolve(projectA, '.claude/settings.local.json')
    )
  })
})

describe('removeNativePlugin Claude fallback scope preservation', () => {
  let tmpDir: string
  let originalHome: string | undefined
  let originalUserProfile: string | undefined

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'nsolid-scope-fallback-'))
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

  it('removes only the targeted scope record and preserves the other scopes/paths', async () => {
    const { getAdapter } = await import('../../../src/harnesses/index.js')
    const { removeNativePlugin } = await import('../../../src/harnesses/native-plugin-uninstaller.js')
    const { resolveHome } = await import('../../../src/utils/path.js')

    const installedPath = resolveHome('~/.claude/plugins/installed_plugins.json')
    mkdirSync(dirname(installedPath), { recursive: true })
    writeFileSync(installedPath, JSON.stringify({
      version: 2,
      plugins: {
        'nsolid-skills-plugin@nodesource': [
          { scope: 'user' },
          { scope: 'project', projectPath: '/tmp/other' },
        ],
      },
    }))

    // A preflight plan that only authorizes the user scope: the fallback must
    // not widen it to the whole array.
    const inspection: NativeInspection = {
      pluginIds: ['nsolid-skills-plugin@nodesource'],
      claudeInstallRecords: [record('nsolid-skills-plugin@nodesource', 'user')],
      installedPluginIds: ['nsolid-skills-plugin@nodesource'],
      marketplaces: [],
      supportsMarketplaceRemove: true,
      marketplaceUnknown: false,
      installedPluginsByMarketplace: new Map(),
      issues: [],
    }

    const adapter = getAdapter('claude')
    const result = await removeNativePlugin('claude', adapter, {
      inspection,
      runCli: async () => { throw new Error('ENOENT') },
    })

    const remaining = JSON.parse(readFileSync(installedPath, 'utf8'))
    assert.deepStrictEqual(remaining.plugins['nsolid-skills-plugin@nodesource'], [{ scope: 'project', projectPath: '/tmp/other' }])
    // The other scope/path still owns the install, so removal must report failure.
    assert.strictEqual(result.removed, false)
  })
})
