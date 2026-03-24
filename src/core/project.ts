import { existsSync, readdirSync, lstatSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, join, relative, sep } from 'node:path';
import { sha256Short } from './utils.js';
import type { RunHistory, RunRecord } from './run-history.js';
import { detectInjectionAttempt } from './data-boundary.js';

const PROJECT_MARKERS = [
  '.git',
  'package.json',
  '.nodyn-project',
] as const;

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
]);

/** Directories to skip during file manifest walk */
function shouldSkipDir(name: string): boolean {
  return SKIP_DIRS.has(name);
}

export interface ProjectInfo {
  root: string;
  id: string;
}

export interface ManifestDiff {
  added: string[];
  modified: string[];
  removed: string[];
}

/**
 * Walk up from `cwd` looking for project root markers.
 * Returns `{ root, id }` where id is first 16 hex chars of SHA-256 of absolute root path.
 * Returns `null` if no marker is found (walks until filesystem root).
 */
export function detectProjectRoot(cwd: string): ProjectInfo | null {
  let dir = resolve(cwd);

  while (true) {
    for (const marker of PROJECT_MARKERS) {
      if (existsSync(resolve(dir, marker))) {
        return { root: dir, id: sha256Short(dir) };
      }
    }

    const parent = dirname(dir);
    if (parent === dir) {
      // Reached filesystem root
      return null;
    }
    dir = parent;
  }
}

/**
 * Query last N runs for this project from run history and format a brief summary.
 * Returns a human-readable briefing string suitable for injection into the system prompt.
 */
export function generateBriefing(projectDir: string, runHistory: RunHistory, limit = 5): string {
  const normalizedProjectDir = resolve(projectDir);
  const runs = runHistory.getRecentRuns(100)
    .filter((r: RunRecord) => {
      if (!r.context_id) return false;
      const runDir = resolve(r.context_id);
      return runDir === normalizedProjectDir
        || runDir.startsWith(normalizedProjectDir + sep);
    })
    .slice(0, limit);

  if (runs.length === 0) {
    return '';
  }

  const lines = runs.map((r: RunRecord) => {
    const taskRaw = r.task_text.length > 80
      ? r.task_text.slice(0, 77) + '...'
      : r.task_text;
    const task = detectInjectionAttempt(taskRaw).detected ? '[redacted]' : taskRaw;
    const cost = r.cost_usd > 0 ? ` | $${r.cost_usd.toFixed(4)}` : '';
    return `- [${r.status}] ${r.model_tier}: "${task}"${cost}`;
  });

  // Enrich with last run details
  const lastRun = runs[0];
  if (lastRun?.response_text) {
    const summaryRaw = lastRun.response_text.length > 300
      ? lastRun.response_text.slice(0, 297) + '...'
      : lastRun.response_text;
    const summary = detectInjectionAttempt(summaryRaw).detected ? '[redacted]' : summaryRaw;
    lines.push(`\nLast response summary:\n${summary}`);
  }
  if (lastRun?.status === 'failed') {
    lines.push(`⚠ Last run failed.`);
  }

  // Top tools used in last run
  if (lastRun) {
    const toolCalls = runHistory.getRunToolCalls(lastRun.id);
    if (toolCalls.length > 0) {
      const toolCounts = new Map<string, number>();
      for (const tc of toolCalls) toolCounts.set(tc.tool_name, (toolCounts.get(tc.tool_name) ?? 0) + 1);
      const top3 = [...toolCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
      lines.push(`Tools used: ${top3.map(([name, count]) => `${name}(${count})`).join(', ')}`);
    }
  }

  return `<session_briefing>
Recent runs in this project:
${lines.join('\n')}
</session_briefing>`;
}

/**
 * Walk the directory tree and collect `relative_path → mtime_ms` pairs.
 * Skips node_modules, .git, dist, build, .nodyn-* directories.
 */
export function buildFileManifest(
  root: string,
  opts?: { maxFiles?: number | undefined; maxDepth?: number | undefined },
): Map<string, number> {
  const maxFiles = opts?.maxFiles ?? 10_000;
  const maxDepth = opts?.maxDepth ?? 10;
  const manifest = new Map<string, number>();

  function walk(dir: string, depth: number): void {
    if (depth > maxDepth || manifest.size >= maxFiles) return;

    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (manifest.size >= maxFiles) break;

      const fullPath = join(dir, entry);
      let stat;
      try {
        stat = lstatSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isSymbolicLink()) {
        continue;
      }

      if (stat.isDirectory()) {
        if (!shouldSkipDir(entry)) {
          walk(fullPath, depth + 1);
        }
      } else if (stat.isFile()) {
        const relPath = relative(root, fullPath);
        manifest.set(relPath, Math.floor(stat.mtimeMs));
      }
    }
  }

  walk(root, 0);
  return manifest;
}

/**
 * Compare two file manifests and return added/modified/removed files.
 */
export function diffManifest(
  oldManifest: Map<string, number>,
  newManifest: Map<string, number>,
): ManifestDiff {
  const added: string[] = [];
  const modified: string[] = [];
  const removed: string[] = [];

  for (const [path, mtime] of newManifest) {
    const oldMtime = oldManifest.get(path);
    if (oldMtime === undefined) {
      added.push(path);
    } else if (oldMtime !== mtime) {
      modified.push(path);
    }
  }

  for (const path of oldManifest.keys()) {
    if (!newManifest.has(path)) {
      removed.push(path);
    }
  }

  return { added, modified, removed };
}

/**
 * Save a file manifest to disk as JSON.
 * Stored at `<nodynDir>/memory/<projectId>/manifest.json`.
 */
export function saveManifest(nodynDir: string, projectId: string, manifest: Map<string, number>): void {
  const dir = join(nodynDir, 'memory', projectId);
  mkdirSync(dir, { recursive: true });
  const obj: Record<string, number> = {};
  for (const [k, v] of manifest) {
    obj[k] = v;
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(obj), 'utf-8');
}

/**
 * Load a previously saved file manifest from disk.
 * Returns null if no manifest exists.
 */
export function loadManifest(nodynDir: string, projectId: string): Map<string, number> | null {
  const filePath = join(nodynDir, 'memory', projectId, 'manifest.json');
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const obj: unknown = JSON.parse(raw);
    if (typeof obj !== 'object' || obj === null) return null;
    const map = new Map<string, number>();
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (typeof v === 'number') {
        map.set(k, v);
      }
    }
    return map;
  } catch {
    return null;
  }
}

/**
 * Format a ManifestDiff into a human-readable string for the briefing.
 * Caps output at maxFiles entries.
 */
export function formatManifestDiff(diff: ManifestDiff, maxFiles = 20): string {
  const { added, modified, removed } = diff;
  const total = added.length + modified.length + removed.length;
  if (total === 0) return '';

  const lines: string[] = [];
  let shown = 0;

  for (const f of added) {
    if (shown >= maxFiles) break;
    lines.push(`  + ${f}`);
    shown++;
  }
  for (const f of modified) {
    if (shown >= maxFiles) break;
    lines.push(`  ~ ${f}`);
    shown++;
  }
  for (const f of removed) {
    if (shown >= maxFiles) break;
    lines.push(`  - ${f}`);
    shown++;
  }

  const remaining = total - shown;
  if (remaining > 0) {
    lines.push(`  ... and ${remaining} more`);
  }

  return `<file_changes_since_last_session>
${lines.join('\n')}
</file_changes_since_last_session>`;
}
