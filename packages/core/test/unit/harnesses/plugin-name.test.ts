import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

describe('plugin-name legacy-conflict identity role', () => {
  it('isNsolidPluginId stays broad (both distributions, any marketplace) for uninstall', async () => {
    const { isNsolidPluginId } = await import('../../../src/harnesses/plugin-name.js')
    assert.equal(isNsolidPluginId('nsolid-plugin@nodesource'), true)
    assert.equal(isNsolidPluginId('nsolid-skills-plugin@nodesource'), true)
    assert.equal(isNsolidPluginId('nsolid-plugin@claude-plugins-official'), true)
    assert.equal(isNsolidPluginId('nsolid-plugin'), true)
    assert.equal(isNsolidPluginId('other-plugin@nodesource'), false)
  })

  it('isLegacyNsolidPluginId matches only the pre-skills-only distribution', async () => {
    const { isLegacyNsolidPluginId } = await import('../../../src/harnesses/plugin-name.js')
    assert.equal(isLegacyNsolidPluginId('nsolid-plugin@nodesource'), true)
    assert.equal(isLegacyNsolidPluginId('nsolid-plugin@claude-plugins-official'), true)
    assert.equal(isLegacyNsolidPluginId('nsolid-plugin'), true)
    assert.equal(isLegacyNsolidPluginId('nsolid-skills-plugin@nodesource'), false)
    assert.equal(isLegacyNsolidPluginId('nsolid-skills-plugin'), false)
    assert.equal(isLegacyNsolidPluginId('other@nodesource'), false)
  })

  it('legacyNsolidPluginIds selects the legacy ids over the COMPLETE detected list', async () => {
    const { legacyNsolidPluginIds } = await import('../../../src/harnesses/plugin-name.js')
    assert.deepEqual(legacyNsolidPluginIds({ installedIds: ['nsolid-skills-plugin@nodesource'] }), [])
    assert.deepEqual(
      legacyNsolidPluginIds({ installedIds: ['nsolid-skills-plugin@nodesource', 'nsolid-plugin@nodesource'] }),
      ['nsolid-plugin@nodesource'],
      'a mixed install conflicts on the OLD id even when the new label is detected first'
    )
    assert.deepEqual(
      legacyNsolidPluginIds({ installedIds: ['nsolid-plugin@other-mp', 'nsolid-skills-plugin@nodesource'] }),
      ['nsolid-plugin@other-mp']
    )
    // Adapter surfaced no concrete ids: the label decides; unknown labels fail
    // safe as the legacy plugin.
    assert.deepEqual(legacyNsolidPluginIds({ label: 'nsolid-skills-plugin' }), [])
    assert.deepEqual(legacyNsolidPluginIds({ label: undefined }), ['nsolid-plugin'])
    assert.deepEqual(legacyNsolidPluginIds({}), ['nsolid-plugin'])
  })
})
