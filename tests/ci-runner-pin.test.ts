import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';

/**
 * Every job in ci.yml and release.yml names its runner image by version, never `ubuntu-latest`.
 *
 * GitHub moves `ubuntu-latest` to a new Ubuntu release on its own schedule. When it moved to
 * 26.04, Playwright could not install Chromium there, and the required `smoke` check failed on
 * every run on that image, whatever the diff. A release cut on a moved image would build and test on
 * something no pull request ran on. A pinned image changes only through a commit.
 *
 * A pinned image is retired by GitHub in time; raising the pin is then a deliberate change.
 */
const WORKFLOWS = ['.github/workflows/ci.yml', '.github/workflows/release.yml'] as const;
const PINNED = new Set(['ubuntu-24.04', 'ubuntu-24.04-arm']);
type Job = { 'runs-on'?: unknown; uses?: string; strategy?: { matrix?: unknown } };
type Workflow = { jobs?: Record<string, Job> };

/**
 * The runner names a job can resolve to: its literal `runs-on`, or every `runner` of its matrix,
 * from the base `runner` list and from `include` alike. A matrix that names no runner at all (no
 * strategy, an expression, no `runner` key) resolves to `undefined`, which counts as unpinned.
 */
function runnersOf(job: Job): unknown[] {
  const r = job['runs-on'];
  if (typeof r === 'string' && /^\$\{\{\s*matrix\.runner\s*\}\}$/.test(r)) {
    const m = job.strategy?.matrix;
    if (typeof m !== 'object' || m === null) return [undefined];
    const base = (m as Record<string, unknown>)['runner'];
    const include = (m as Record<string, unknown>)['include'];
    const found = [
      ...(Array.isArray(base) ? base : base === undefined ? [] : [base]),
      ...(Array.isArray(include) ? include.map((e) => (e as Record<string, unknown>)['runner']) : include === undefined ? [] : [include]),
    ];
    return found.length > 0 ? found : [undefined];
  }
  return [r];
}

/** `job: runner` for every runner job whose runner is not a pinned image. */
function unpinned(wf: Workflow): string[] {
  return Object.entries(wf.jobs ?? {})
    .filter(([, job]) => job.uses === undefined)
    .flatMap(([id, job]) => runnersOf(job).filter((r) => typeof r !== 'string' || !PINNED.has(r)).map((r) => `${id}: ${String(r)}`));
}

describe('runner images in ci.yml and release.yml', () => {
  for (const file of WORKFLOWS) {
    it(`every runner job in ${file} runs on a pinned image`, () => {
      const wf = parseYaml(readFileSync(file, 'utf8')) as Workflow;
      expect(Object.keys(wf.jobs ?? {}).length).toBeGreaterThan(0);
      expect(unpinned(wf)).toEqual([]);
    });
  }

  it('the check flags ubuntu-latest, an unknown image and a matrix entry, and passes pinned ones', () => {
    const wf: Workflow = {
      jobs: {
        latest: { 'runs-on': 'ubuntu-latest' },
        other: { 'runs-on': 'ubuntu-26.04' },
        list: { 'runs-on': ['self-hosted'] },
        matrix: {
          'runs-on': '${{ matrix.runner }}',
          strategy: { matrix: { include: [{ runner: 'ubuntu-24.04' }, { runner: 'ubuntu-latest' }] } },
        },
        base: { 'runs-on': '${{ matrix.runner }}', strategy: { matrix: { runner: ['ubuntu-latest'] } } },
        empty: { 'runs-on': '${{ matrix.runner }}', strategy: { matrix: { os: ['x'] } } },
        nostrat: { 'runs-on': '${{ matrix.runner }}' },
        expr: { 'runs-on': '${{ matrix.runner }}', strategy: { matrix: '${{ fromJSON(x) }}' } },
        ok: { 'runs-on': 'ubuntu-24.04' },
        okbase: { 'runs-on': '${{ matrix.runner }}', strategy: { matrix: { runner: ['ubuntu-24.04'] } } },
        arm: { 'runs-on': 'ubuntu-24.04-arm' },
        call: { uses: './.github/workflows/x.yml' },
      },
    };
    expect(unpinned(wf)).toEqual([
      'latest: ubuntu-latest',
      'other: ubuntu-26.04',
      'list: self-hosted',
      'matrix: ubuntu-latest',
      'base: ubuntu-latest',
      'empty: undefined',
      'nostrat: undefined',
      'expr: undefined',
    ]);
  });
});
