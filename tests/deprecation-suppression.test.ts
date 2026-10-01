/**
 * `src/index.ts` overrides `process.emit` to drop DeprecationWarning events (a transitive
 * dependency's punycode warning) and to let every other warning through.
 *
 * Pinned here because the override's call line changed for a TYPE reason (`@types/node` now
 * follows the Node 22 runtime, and the old spread form no longer type-checks), and a type-driven
 * rewrite is exactly the kind of change that can quietly alter behaviour. Both halves are
 * asserted, in a separate process so the override cannot leak into this test run, and a control
 * run without the import shows that the probe would see the deprecation if it were emitted.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX = join(ROOT, 'node_modules/.bin/tsx');
const DEP = 'DEP-PROBE-deprecation';
const OTHER = 'OTHER-PROBE-warning';

let dir: string;
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'emit-probe-')); });
afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

function run(withOverride: boolean): string {
  const file = join(dir, withOverride ? 'with.mts' : 'without.mts');
  writeFileSync(file, [
    withOverride ? `await import(${JSON.stringify(join(ROOT, 'src/index.ts'))});` : '',
    `process.emitWarning(${JSON.stringify(DEP)}, 'DeprecationWarning');`,
    `process.emitWarning(${JSON.stringify(OTHER)});`,
    'setTimeout(() => process.exit(0), 300);',
  ].join('\n'));
  const r = spawnSync(TSX, [file], { encoding: 'utf8', timeout: 60_000 });
  return `${r.stdout}${r.stderr}`;
}

describe('process.emit override in src/index.ts', () => {
  it('CONTROL: without the override both warnings reach stderr', () => {
    const out = run(false);
    expect(out).toContain(DEP);
    expect(out).toContain(OTHER);
  }, 60_000);

  it('drops the DeprecationWarning and lets any other warning through', () => {
    const out = run(true);
    expect(out).not.toContain(DEP);
    expect(out).toContain(OTHER);
  }, 60_000);
});
