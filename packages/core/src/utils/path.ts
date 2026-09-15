import os from 'node:os'
import path from 'node:path'
import type { HarnessType } from '../types.js'

export function resolveHome (tildePath: string): string {
  if (tildePath === '~' || tildePath.startsWith('~/') || tildePath.startsWith('~\\')) {
    return path.join(os.homedir(), tildePath.slice(1).replace(/\\/g, path.sep))
  }
  return tildePath
}

export function normalizePath (p: string): string {
  return path.resolve(p)
}

/**
 * True when `value` is an absolute path in canonical lexical form: no trailing
 * separator (except the filesystem root), no `.`/`..` segment, no redundant
 * separator, and no NUL byte. A persisted settings path authorizes a filesystem
 * target on a later retry, so a malformed value must be refused lexically
 * rather than normalized into a permission.
 */
export function isCanonicalAbsolutePath (value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false
  if (value.includes('\u0000')) return false
  if (!path.isAbsolute(value)) return false
  if (path.normalize(value) !== value) return false
  const root = path.parse(value).root
  return value.length <= root.length || !value.endsWith(path.sep)
}

export function getAgentsDir (): string {
  return path.join(os.homedir(), '.agents')
}

export function getSkillsDir (): string {
  return path.join(os.homedir(), '.agents', 'skills')
}

export function getAuthFilePath (): string {
  return path.join(os.homedir(), '.agents', '.nodesource-auth.json')
}

export function getTrackingFilePath (): string {
  return path.join(os.homedir(), '.agents', '.nodesource-installed.json')
}

export function getConfigBackupDir (harness?: HarnessType): string {
  return harness
    ? path.join(os.homedir(), '.agents', '.config-backup', harness)
    : path.join(os.homedir(), '.agents', '.config-backup')
}
