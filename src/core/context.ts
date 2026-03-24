import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import type { NodynConfig, NodynContext } from '../types/index.js';
import { detectProjectRoot } from './project.js';
import { sha256Short } from './utils.js';

/**
 * Resolve the NodynContext for the current session.
 *
 * - If `config.context` is provided (Telegram, Slack, PWA, MCP): use it directly,
 *   ensuring workspaceDir is set.
 * - If not (CLI): detect project root, wrap the result.
 */
export function resolveContext(config: NodynConfig): NodynContext {
  // Explicit context from non-CLI sources
  if (config.context) {
    const ctx = config.context;
    return {
      ...ctx,
      workspaceDir: ctx.workspaceDir || join(homedir(), '.nodyn', 'workspace', ctx.id),
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
      workspaceDir: join(homedir(), '.nodyn', 'workspace', project.id),
      localDir: project.root,
    };
  }

  // No project found — use cwd hash
  const id = sha256Short(cwd);
  return {
    id,
    name: basename(cwd),
    source: 'cli',
    workspaceDir: join(homedir(), '.nodyn', 'workspace', id),
    localDir: cwd,
  };
}
