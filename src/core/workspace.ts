import { existsSync, realpathSync, lstatSync } from 'node:fs';
import { resolve, dirname, basename, join, isAbsolute, relative } from 'node:path';
import type { LynoxContext } from '../types/index.js';
import { ensureDirSync } from './atomic-write.js';

let _cachedDir: string | null | undefined;
let _tenantOverride: string | null = null;

/** Returns the workspace directory if configured, else null. */
export function getWorkspaceDir(): string | null {
  // Tenant workspace override takes precedence
  if (_tenantOverride !== null) return _tenantOverride;
  if (_cachedDir !== undefined) return _cachedDir;
  const env = process.env['LYNOX_WORKSPACE'];
  _cachedDir = env && existsSync(env) ? realpathSync(resolve(env)) : null;
  return _cachedDir;
}

/** Set a tenant-specific workspace directory override. */
export function setTenantWorkspace(dir: string | null): void {
  _tenantOverride = dir;
}

/** Clear the tenant workspace override. */
export function clearTenantWorkspace(): void {
  _tenantOverride = null;
}

/** Whether workspace isolation is active. */
export function isWorkspaceActive(): boolean {
  return getWorkspaceDir() !== null;
}

/** Working directory: workspace dir if active, else process.cwd(). */
export function getWorkspaceCwd(): string {
  return getWorkspaceDir() ?? process.cwd();
}

function isPathWithin(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Allowed read-only roots (besides workspace + /tmp). */
const READ_ONLY_ROOTS = ['/app'];

/**
 * Resolve a path and validate it's within allowed boundaries.
 * Throws if the path escapes the sandbox.
 * Returns the resolved real path.
 */
export function validatePath(filePath: string, operation: 'read' | 'write'): string {
  const ws = getWorkspaceDir();
  if (!ws) return resolve(filePath);

  // Resolve the path, following symlinks where possible
  const resolved = resolve(filePath);
  let real: string;
  if (existsSync(resolved)) {
    real = realpathSync(resolved);
  } else if (existsSync(dirname(resolved))) {
    real = join(realpathSync(dirname(resolved)), basename(resolved));
  } else {
    // Walk up to find closest existing ancestor (supports recursive mkdir)
    let ancestor = dirname(resolved);
    let tail = basename(resolved);
    while (!existsSync(ancestor) && ancestor !== dirname(ancestor)) {
      tail = join(basename(ancestor), tail);
      ancestor = dirname(ancestor);
    }
    if (!existsSync(ancestor)) {
      throw new Error(
        `Path '${filePath}' cannot be validated: no existing ancestor directory found.`,
      );
    }
    real = join(realpathSync(ancestor), tail);
  }

  // Check workspace + /tmp (resolve /tmp via realpath for macOS /private/tmp)
  const realTmp = existsSync('/tmp') ? realpathSync('/tmp') : '/tmp';

  // Block writes through symlinks pointing outside workspace
  if (existsSync(resolved) && operation === 'write') {
    const stat = lstatSync(resolved);
    if (stat.isSymbolicLink() && !isPathWithin(real, ws) && !isPathWithin(real, realTmp)) {
      throw new Error(
        `Path '${filePath}' is a symlink to '${real}' which is outside the workspace. ` +
        `Symlink writes are blocked when workspace isolation is active.`,
      );
    }
  }

  if (isPathWithin(real, ws) || isPathWithin(real, realTmp)) {
    return real;
  }

  // Read operations also allowed from read-only roots
  if (operation === 'read') {
    for (const root of READ_ONLY_ROOTS) {
      if (existsSync(root) && isPathWithin(real, realpathSync(root))) {
        return real;
      }
    }
  }

  const allowed = operation === 'write'
    ? `${ws} and /tmp`
    : `${ws}, /tmp, and ${READ_ONLY_ROOTS.join(', ')}`;
  throw new Error(
    `Path '${filePath}' resolves to '${real}' which is outside allowed directories (${allowed}). ` +
    `${operation === 'write' ? 'Write' : 'Read'} operations are restricted when workspace isolation is active.`,
  );
}

/**
 * Ensure the workspace directory for a context exists.
 * Creates it with mode 0o700 if missing.
 * Returns the workspace directory path.
 */
export function ensureContextWorkspace(context: LynoxContext): string {
  const dir = context.workspaceDir;
  ensureDirSync(dir);
  return dir;
}

/** Reset cached workspace dir (for testing). */
export function _resetCache(): void {
  _cachedDir = undefined;
  _tenantOverride = null;
}
