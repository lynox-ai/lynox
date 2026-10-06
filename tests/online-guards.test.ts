/**
 * Offline guards for the online suites — they need no key, so they live outside tests/online/,
 * which runs only with LYNOX_ONLINE=1. Left inside it, they would stop running anywhere by
 * default, and a guard that silently stops running reports nothing.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { LAZY_DEFERRED_TOOLS } from '../src/core/agent.js';
import { catalogEntryKey } from '../src/core/llm/catalog.js';
import { CASES } from './online/lazy-tool-cases.js';
import { REMOTE_PRESETS, LOOPBACK_DEFAULT_MODEL, PRESETS_UNDER_TEST } from './online/provider-presets.js';
import { FIREWORKS_HOST, pinnedSlots } from './online/preset-slots.js';

describe('lazy-tool-reachability matrix coverage', () => {
  // Keeps the matrix honest as LAZY_DEFERRED_TOOLS evolves — no hardcoded count.
  it('has exactly one case per member of LAZY_DEFERRED_TOOLS, no more, no less', () => {
    const covered = new Set(CASES.map(c => c.tool));
    expect(covered.size, 'duplicate tool entries in CASES').toBe(CASES.length);
    expect(covered).toEqual(LAZY_DEFERRED_TOOLS);
  });
});

describe('provider preset reachability coverage', () => {
  // A guard, not a formality: if the catalog gains a preset and nobody teaches
  // the reachability suite about it, the preset would silently ship untested.
  it('knows about every pinned preset in the catalog', () => {
    const untested = PRESETS_UNDER_TEST
      .map(catalogEntryKey)
      .filter((k) => !(k in REMOTE_PRESETS) && !(k in LOOPBACK_DEFAULT_MODEL));
    expect(untested).toEqual([]);
  });
});

describe('preset slots coverage', () => {
  // Not `describe.skip` on an empty list: zero pinned slots would mean the presets
  // stopped pinning anything, which is itself worth failing on.
  it('the presets pin at least one Fireworks-hosted slot', () => {
    expect(pinnedSlots().filter(s => s.baseUrl.includes(FIREWORKS_HOST)).length).toBeGreaterThan(0);
  });
});

/**
 * The rule that keeps this file necessary, measured rather than read: run tests/online/ opted in
 * but with NO credentials — empty environment, empty HOME — and every test must skip. A test
 * that PASSES there needed no provider, so it is an offline check, and inside tests/online/ it
 * would run nowhere by default. Move it here (or next to the code it guards).
 */
describe('tests/online/ holds only tests that need a provider', () => {
  const root = resolve(__dirname, '..');
  let scratch = '';
  let report: {
    numTotalTests: number;
    testResults: Array<{ name: string; assertionResults: Array<{ status: string; fullName: string }> }>;
  };

  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), 'lynox-online-sweep-'));
    const out = join(scratch, 'report.json');
    const env = { PATH: process.env['PATH'] ?? '', HOME: scratch, TMPDIR: scratch, LYNOX_ONLINE: '1' };
    try {
      execFileSync(join(root, 'node_modules', '.bin', 'vitest'), ['run', 'tests/online/', '--reporter=json', `--outputFile=${out}`], {
        cwd: root, env, stdio: 'ignore',
      });
    } catch { /* a failing online test still writes the report; judged below */ }
    report = JSON.parse(readFileSync(out, 'utf8')) as typeof report;
  }, 300_000); // a nested run of the whole online directory; the hook default is 10s

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it('collected the online suite at all (else an empty run would pass the next check)', () => {
    const files = report.testResults.map(f => relative(root, f.name));
    expect(files.length).toBeGreaterThan(10);
    expect(files.every(f => f.startsWith('tests/online/'))).toBe(true);
  });

  it('no test there passes without credentials', () => {
    const offline = report.testResults.flatMap(f =>
      f.assertionResults.filter(a => a.status === 'passed').map(a => `${relative(root, f.name)} > ${a.fullName}`));
    expect(offline, 'offline checks inside tests/online/ — move them to tests/online-guards.test.ts').toEqual([]);
  });
});
