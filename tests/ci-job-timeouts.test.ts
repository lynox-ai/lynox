import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';

/**
 * Every job in ci.yml that runs on a runner carries its own `timeout-minutes` (a call to a
 * reusable workflow has none of its own and is not checked here).
 *
 * Without one a job runs until the 6 h runner default. A docker-scan build that stalled held its
 * required check open for over an hour, and the pull request could not merge until it was
 * cancelled by hand. The right value differs per job, so this test only asks that one is there
 * and that it is a real bound, not the default restated.
 */
const CI = '.github/workflows/ci.yml';
const MAX_MINUTES = 60;
type Job = { 'timeout-minutes'?: unknown; uses?: string };
type Workflow = { jobs?: Record<string, Job> };

/** Jobs that run on a runner (not a reusable-workflow call) and lack a bound in 1..MAX_MINUTES. */
function unbounded(wf: Workflow): string[] {
  return Object.entries(wf.jobs ?? {})
    .filter(([, job]) => job.uses === undefined)
    .filter(([, job]) => {
      const t = job['timeout-minutes'];
      return !Number.isInteger(t) || (t as number) < 1 || (t as number) > MAX_MINUTES;
    })
    .map(([id]) => id);
}

describe('ci.yml job timeouts', () => {
  it('every runner job in ci.yml has a timeout of 1 to 60 minutes', () => {
    const wf = parseYaml(readFileSync(CI, 'utf8')) as Workflow;
    expect(Object.keys(wf.jobs ?? {}).length).toBeGreaterThan(0);
    expect(unbounded(wf)).toEqual([]);
  });

  it('the check flags a job without a timeout, a non-number and one past the cap', () => {
    const wf: Workflow = {
      jobs: {
        none: {},
        text: { 'timeout-minutes': '12' },
        expr: { 'timeout-minutes': '${{ 12 }}' },
        zero: { 'timeout-minutes': 0 },
        huge: { 'timeout-minutes': 360 },
        ok: { 'timeout-minutes': 12 },
        call: { uses: './.github/workflows/x.yml' },
      },
    };
    expect(unbounded(wf)).toEqual(['none', 'text', 'expr', 'zero', 'huge']);
  });
});
