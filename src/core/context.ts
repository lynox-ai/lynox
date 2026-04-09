import { join, basename } from 'node:path';
import type { LynoxConfig, LynoxContext } from '../types/index.js';
import { detectProjectRoot } from './project.js';
import { sha256Short } from './utils.js';
import { getLynoxDir } from './config.js';

/**
 * Resolve the LynoxContext for the current session.
 *
 * - If `config.context` is provided (Telegram, Slack, PWA, MCP): use it directly,
 *   ensuring workspaceDir is set.
 * - If not (CLI): detect project root, wrap the result.
 */
export function resolveContext(config: LynoxConfig): LynoxContext {
  // Explicit context from non-CLI sources
  if (config.context) {
    const ctx = config.context;
    return {
      ...ctx,
      workspaceDir: ctx.workspaceDir || join(getLynoxDir(), 'workspace', ctx.id),
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
      workspaceDir: join(getLynoxDir(), 'workspace', project.id),
      localDir: project.root,
    };
  }

  // No project found — use cwd hash
  const id = sha256Short(cwd);
  return {
    id,
    name: basename(cwd),
    source: 'cli',
    workspaceDir: join(getLynoxDir(), 'workspace', id),
    localDir: cwd,
  };
}
