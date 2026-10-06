import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * A trigger's `maxRetries` reaches the worker's retry through four layers, and today no
 * product path gives it a value: every line below passes it on, maps it, declares it, stores
 * it as a column, reads it, or sets 0. A retry runs the whole failed run again, so every
 * write it made happens a second time — including writes to other systems that cannot tell a
 * repeat from a new request. Before a caller sets `maxRetries`, decide how a retried run
 * avoids repeating those writes.
 *
 * This test holds every line under `src/` and `packages/web-ui/src/` that names the field, in either spelling, with
 * how often it occurs. A new one — a route, a tool, a default, a shorthand `{ maxRetries }`,
 * a SQL column list — fails it, and so does a moved or reworded one: updating the list is the
 * decision this test asks for. What it cannot see: a value carried by spreading an object that
 * holds the field, or by a computed key, with the name written nowhere. The two spreads into
 * the task manager today build their object field by field (`src/server/http-api.ts`,
 * `baseParams`). Measured when written: 37 lines, 29 distinct.
 */
const MENTIONS: ReadonlyArray<readonly [string, number]> = [
  ["src/core/engine-db.ts: max_retries INTEGER,", 1],
  ["src/core/run-history-persistence.ts: max_retries: number | null;", 1],
  ["src/core/run-history.ts: ALTER TABLE tasks ADD COLUMN max_retries INTEGER NOT NULL DEFAULT 0;", 1],
  ["src/core/run-history.ts: last_run_status, task_type, watch_config, max_retries, retry_count,", 2],
  ["src/core/run-history.ts: maxRetries?: number | undefined;", 1],
  ["src/core/run-history.ts: max_retries INTEGER NOT NULL DEFAULT 0,", 2],
  ["src/core/run-history.ts: watch_config, max_retries, retry_count, notification_channel, pipeline_id, pipeline_params, enabled", 2],
  ["src/core/task-manager.ts: && (task.retry_count ?? 0) < task.max_retries", 1],
  ["src/core/task-manager.ts: && task.max_retries", 1],
  ["src/core/task-manager.ts: // One-shot trigger that failed permanently (no max_retries, or", 1],
  ["src/core/task-manager.ts: maxRetries: params.maxRetries,", 4],
  ["src/core/task-manager.ts: maxRetries?: number | undefined;", 3],
  ["src/core/trigger-store.ts: * 'project'/'', max_retries 0, retry_count 0, enabled 1, params_json '{}'. Callers", 1],
  ["src/core/trigger-store.ts: * (`scope_type`/`scope_id`/`notification_channel`/`max_retries`/`updated_at`),", 1],
  ["src/core/trigger-store.ts: last_run_status, notification_channel, max_retries, retry_count, created_at, updated_at,", 1],
  ["src/core/trigger-store.ts: maxRetries: 0,", 1],
  ["src/core/trigger-store.ts: maxRetries: params.maxRetries ?? 0,", 1],
  ["src/core/trigger-store.ts: maxRetries: rec.max_retries ?? null,", 1],
  ["src/core/trigger-store.ts: maxRetries?: number | null | undefined;", 1],
  ["src/core/trigger-store.ts: maxRetries?: number | undefined;", 1],
  ["src/core/trigger-store.ts: max_retries = excluded.max_retries,", 1],
  ["src/core/trigger-store.ts: max_retries, retry_count, confirmed_at, created_untrusted, created_at, updated_at", 1],
  ["src/core/trigger-store.ts: max_retries: number | null;", 1],
  ["src/core/trigger-store.ts: max_retries: row.max_retries ?? undefined,", 1],
  ["src/core/trigger-store.ts: row.maxRetries ?? null,", 1],
  ["src/core/verb-graph-backfill.ts: max_retries: row.max_retries ?? undefined,", 1],
  ["src/core/worker-loop.ts: && (task.retry_count ?? 0) < (task.max_retries ?? 0);", 1],
  ["src/core/worker-loop.ts: const willRetry = (task.max_retries ?? 0) > 0", 1],
  ["src/types/pipeline.ts: max_retries?: number | undefined;", 1],
];

const ROOT = join(import.meta.dirname, '..', '..');
const NAME_RE = /\b(maxRetries|max_retries)\b/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(ts|svelte)$/.test(name) && !name.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

/** Every line naming the field, as `file: trimmed line`, with its count. */
function mentions(root: string, dirs: readonly string[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const dir of dirs) {
    for (const file of sourceFiles(join(root, dir))) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!NAME_RE.test(line)) continue;
        const key = `${relative(root, file)}: ${line.trim()}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
  }
  return [...counts.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

describe('maxRetries has no product entry', () => {
  it('is named nowhere but the lines that pass it on, map, declare, store, read it or set 0', () => {
    expect(mentions(ROOT, ['src', 'packages/web-ui/src'])).toEqual([...MENTIONS].map(([k, n]) => [k, n]));
  });

  it('the scan finds a shorthand, a repeated line and a quoted key, and skips tests', () => {
    const root = mkdtempSync(join(tmpdir(), 'lynox-max-retries-'));
    try {
      mkdirSync(join(root, 'src'));
      writeFileSync(join(root, 'src', 'a.ts'), 'const t = { maxRetries };\nfoo(row.max_retries);\nfoo(row.max_retries);\n');
      writeFileSync(join(root, 'src', 'b.ts'), "const o = { 'maxRetries': 3 };\n");
      writeFileSync(join(root, 'src', 'b.test.ts'), 'const o = { maxRetries: 3 };\n');
      expect(mentions(root, ['src'])).toEqual([
        ['src/a.ts: const t = { maxRetries };', 1],
        ['src/a.ts: foo(row.max_retries);', 2],
        ["src/b.ts: const o = { 'maxRetries': 3 };", 1],
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
