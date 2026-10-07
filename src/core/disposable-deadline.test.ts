import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// `Agent.send`'s `disposableDeadline` makes an aborted run stop waiting for its tool
// calls, which then finish on the agent unobserved. That is only safe on an agent the
// caller throws away; on a long-lived one their late state lands in its next run. The
// name says so, and this sweep keeps the callers to the one that does throw it away.
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWED = new Set(['core/agent.ts', 'tools/builtin/spawn.ts']);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [path] : [];
  });
}

describe('disposableDeadline callers', () => {
  it('only spawn.ts (besides its definition) names it', () => {
    const files = sourceFiles(SRC);
    const naming = files
      .filter((f) => /\bdisposableDeadline\b/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(SRC, f).split('\\').join('/'));
    // Positive control: the sweep sees the tree, and sees the real caller pass it.
    expect(files.length).toBeGreaterThan(100);
    expect(readFileSync(join(SRC, 'tools/builtin/spawn.ts'), 'utf8')).toMatch(/disposableDeadline: deadline/);
    expect(naming.sort()).toEqual([...ALLOWED].sort());
  });
});
