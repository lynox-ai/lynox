import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * A trigger's `maxRetries` reaches the worker's retry through four layers, and today no
 * product path gives it a value: every site below only passes it on, maps it, declares it,
 * or sets 0. A retry runs the whole failed run again, so every write it made happens a
 * second time — including writes to other systems that cannot tell a repeat from a new
 * request. Before a caller sets `maxRetries`, decide how a retried run avoids repeating
 * those writes.
 *
 * This test holds the list of sites. A new one — a route, a tool, a default — fails it.
 * What it cannot see: a value carried by spreading an object that holds the field, with no
 * `maxRetries:` written anywhere. The two spreads into the task manager today build their
 * object field by field (`src/server/http-api.ts`, `baseParams`).
 */
const SITES = [
  'src/core/trigger-store.ts: maxRetries: rec.max_retries ?? null,',
  'src/core/trigger-store.ts: max_retries: number | null;',
  'src/core/trigger-store.ts: max_retries: row.max_retries ?? undefined,',
  'src/core/trigger-store.ts: max_retries = excluded.max_retries,',
  'src/core/trigger-store.ts: maxRetries: params.maxRetries ?? 0,',
  'src/core/trigger-store.ts: maxRetries: 0,',
  'src/core/verb-graph-backfill.ts: max_retries: row.max_retries ?? undefined,',
  'src/core/task-manager.ts: maxRetries: params.maxRetries,',
  'src/core/run-history-persistence.ts: max_retries: number | null;',
];

const ROOT = join(import.meta.dirname, '..', '..');
const SITE_RE = /\b(maxRetries|max_retries)\s*[:=]/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(ts|svelte)$/.test(name) && !name.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

function sites(): string[] {
  const found = new Set<string>();
  for (const dir of ['src', 'packages/web-ui/src']) {
    for (const file of sourceFiles(join(ROOT, dir))) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (SITE_RE.test(line)) found.add(`${relative(ROOT, file)}: ${line.trim()}`);
      }
    }
  }
  return [...found].sort();
}

describe('maxRetries has no product entry', () => {
  it('is set nowhere but the sites that pass it on, map it, declare it or set 0', () => {
    expect(sites()).toEqual([...SITES].sort());
  });

  it('the scan finds a site it does not know', () => {
    // The scanner itself, on a line it has to catch and one it has to skip.
    expect(SITE_RE.test('  maxRetries: 3,')).toBe(true);
    expect(SITE_RE.test('  const retries = task.max_retries ?? 0;')).toBe(false);
  });
});
