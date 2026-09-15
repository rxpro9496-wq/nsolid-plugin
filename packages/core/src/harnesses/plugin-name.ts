/**
 * Canonical identity of the N|Solid skills plugin as it appears in its own
 * manifest (`plugin.json` `name` field) and the marketplace that distributes
 * it. Harnesses key installs by a `<name>@<marketplace>` id, so uninstall must
 * match on BOTH parts rather than a hardcoded full id or a bare name sweep.
 *
 * Canonical (owner contract): marketplace `nodesource`, plugin
 * `nsolid-skills-plugin`. The repository keeps the `nsolid-skills-plugin`
 * name, so plugin base name and repository name coincide.
 *
 * Legacy: the pre-skills-only distribution shipped the plugin as
 * `nsolid-plugin` (also under the `nodesource` marketplace). Its existing
 * default flow (fallback CLI installs, old native plugin registrations) must
 * still be removable, so the legacy base name stays recognized.
 *
 * Experimental/history: an earlier skills-only experiment registered the
 * marketplace as `nsolid-skills`. It is recognized ONLY for migration/removal
 * when actually detected on disk; the canonical guide and new installs use
 * `nodesource`.
 */
export const SKILLS_PLUGIN_BASE_NAME = 'nsolid-skills-plugin'

/** Legacy plugin base name kept for the pre-skills-only default flow. */
export const LEGACY_PLUGIN_BASE_NAME = 'nsolid-plugin'

/**
 * Backward-compatible alias used by the native-plugin adapters for the legacy
 * default flow. New code should prefer {@link SKILLS_PLUGIN_BASE_NAME} or
 * iterate {@link PLUGIN_BASE_NAMES}.
 */
export const PLUGIN_BASE_NAME = LEGACY_PLUGIN_BASE_NAME

/**
 * Every plugin base name the nsolid distribution has used, newest first.
 * Ordering matters only for display defaults.
 */
export const PLUGIN_BASE_NAMES = [SKILLS_PLUGIN_BASE_NAME, LEGACY_PLUGIN_BASE_NAME] as const

/** Canonical marketplace name for the skills-only distribution. */
export const NSOLID_MARKETPLACE = 'nodesource'

/**
 * Marketplace names ever used by the nsolid distribution. `nsolid-skills` is
 * legacy-experimental: it is handled for removal only when detected, never as
 * the canonical install target.
 */
export const NSOLID_MARKETPLACES = [NSOLID_MARKETPLACE, 'nsolid-skills'] as const

/** True when `name` is exactly one of the marketplaces used by nsolid. */
export function isNsolidMarketplace (name: string): boolean {
  return (NSOLID_MARKETPLACES as readonly string[]).includes(name)
}

/** The nsolid plugin base name a `<name>@<marketplace>` id refers to, or null. */
export function nsolidPluginBaseName (id: string): string | null {
  for (const base of PLUGIN_BASE_NAMES) {
    if (id === base || id.startsWith(`${base}@`)) return base
  }
  return null
}

/**
 * True when `id` is the nsolid plugin under any marketplace: it equals a known
 * base name exactly, or is qualified as `<base>@<marketplace>`.
 */
export function isNsolidPluginId (id: string): boolean {
  return nsolidPluginBaseName(id) !== null
}

/**
 * Legacy-conflict predicate: true ONLY for the pre-skills-only distribution
 * (`nsolid-plugin`, under any marketplace). The skills-only plugin registers
 * no MCP servers, so MCP-conflict guards must use this predicate — never the
 * broad {@link isNsolidPluginId}, which also matches the skills-only plugin
 * that uninstall legitimately targets.
 */
export function isLegacyNsolidPluginId (id: string): boolean {
  return nsolidPluginBaseName(id) === LEGACY_PLUGIN_BASE_NAME
}

/**
 * Complete-ID selection for legacy MCP-conflict guards: every detected id that
 * is the legacy distribution. Must be evaluated over ALL detected ids, never
 * the first label alone — a mixed install can surface the skills-only id first
 * while the legacy `nsolid-plugin` is still present. Callers pass the full
 * {@link NativePluginStatus}-like detection result; when an adapter surfaces no
 * concrete ids the detection label is used, defaulting to the legacy base name
 * so an undeterminable identity fails safe as the old plugin.
 */
export function legacyNsolidPluginIds (detected: { installedIds?: string[]; label?: string }): string[] {
  const candidates = detected.installedIds && detected.installedIds.length > 0
    ? detected.installedIds
    : [detected.label ?? LEGACY_PLUGIN_BASE_NAME]
  return candidates.filter(isLegacyNsolidPluginId)
}
