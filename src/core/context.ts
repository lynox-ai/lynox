import { join, basename } from 'node:path';
import type { LynoxConfig, LynoxContext } from '../types/index.js';
import { detectProjectRoot } from './project.js';
import { sha256Short } from './utils.js';
import { getWorkspaceRoot } from './workspace-root.js';
import { contextLabel, ShellIsolationError, type ShellIsolation } from './shell-isolation.js';

/**
 * Resolve the LynoxContext for the current session.
 *
 * - If `config.context` is provided (HTTP API / PWA): use it directly,
 *   ensuring workspaceDir is set.
 * - If not (CLI): detect project root, wrap the result.
 */
export function resolveContext(config: LynoxConfig, isolation: ShellIsolation): LynoxContext {
  // Explicit context from non-CLI sources
  if (config.context) {
    const ctx = config.context;
    if (isolation.kind === 'sidecar') {
      // In sidecar mode the context's workspace is the label from the constant, the path the shell
      // sees too (PRD shell-sidecar-activation D0). A context that names another one would
      // override it here, so it stops the start instead.
      const label = contextLabel(ctx.id);
      // Empty (or missing) is "not set", as the `||` below reads it.
      if (ctx.workspaceDir && ctx.workspaceDir !== label) {
        throw new ShellIsolationError('D0', `the context sets its workspace to ${JSON.stringify(ctx.workspaceDir)}; in sidecar mode it is ${label}.`);
      }
      return { ...ctx, workspaceDir: label };
    }
    return {
      ...ctx,
      workspaceDir: ctx.workspaceDir || join(getWorkspaceRoot(), ctx.id),
    };
  }

  // CLI: detect project root
  const cwd = process.cwd();
  const project = detectProjectRoot(cwd);

  if (project) {
    return {
      id: project.id,
      name: basename(project.root),
      source: 'cli',
      workspaceDir: join(getWorkspaceRoot(), project.id),
      localDir: project.root,
    };
  }

  // No project found — use cwd hash
  const id = sha256Short(cwd);
  return {
    id,
    name: basename(cwd),
    source: 'cli',
    workspaceDir: join(getWorkspaceRoot(), id),
    localDir: cwd,
  };
}
