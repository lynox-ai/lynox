import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';

/**
 * Every job in ci.yml and release.yml that runs on a runner carries its own `timeout-minutes` (a
 * call to a reusable workflow has none of its own and is not checked here).
 *
 * Without one a job runs until the 6 h runner default. A docker-scan build that stalled held its
 * required check open for over an hour, and the pull request could not merge until it was
 * cancelled by hand. release.yml runs the same suite in its test job and holds the release run
 * open the same way. The right value differs per job, so this test only asks that one is there
 * and that it is a real bound, not the default restated.
 *
 * A job gated by an `environment` may bound each of its steps instead. Such a job can wait hours
 * for an approval, and it is not established whether a job-level bound counts that wait; a step's
 * bound counts only the step's own run.
 */
const WORKFLOWS = ['.github/workflows/ci.yml', '.github/workflows/release.yml'];
const MAX_MINUTES = 60;
type Step = { 'timeout-minutes'?: unknown };
type Job = { 'timeout-minutes'?: unknown; uses?: string; environment?: unknown; steps?: Step[] };

const isBound = (t: unknown): boolean =>
  Number.isInteger(t) && (t as number) >= 1 && (t as number) <= MAX_MINUTES;

/** An environment-gated job whose every step carries a bound. */
const hasEnvironment = (env: unknown): boolean =>
  (typeof env === 'string' && env.trim() !== '') ||
  (typeof env === 'object' && env !== null && typeof (env as { name?: unknown }).name === 'string' &&
    (env as { name: string }).name.trim() !== '');

const stepsBounded = (job: Job): boolean =>
  hasEnvironment(job.environment) &&
  (job.steps ?? []).length > 0 &&
  (job.steps ?? []).every((step) => isBound(step['timeout-minutes']));
type Workflow = { jobs?: Record<string, Job> };

/** Jobs that run on a runner (not a reusable-workflow call) and lack a bound in 1..MAX_MINUTES. */
function unbounded(wf: Workflow): string[] {
  return Object.entries(wf.jobs ?? {})
    .filter(([, job]) => job.uses === undefined)
    .filter(([, job]) => !isBound(job['timeout-minutes']) && !stepsBounded(job))
    .map(([id]) => id);
}

describe('workflow job timeouts', () => {
  it.each(WORKFLOWS)('every runner job in %s has a timeout of 1 to 60 minutes', (file) => {
    const wf = parseYaml(readFileSync(file, 'utf8')) as Workflow;
    expect(Object.keys(wf.jobs ?? {}).length).toBeGreaterThan(0);
    expect(unbounded(wf)).toEqual([]);
  });

  it('the check flags a job without a timeout, a non-number, one past the cap, and step bounds outside a gated job or with a step left open', () => {
    const wf: Workflow = {
      jobs: {
        none: {},
        text: { 'timeout-minutes': '12' },
        expr: { 'timeout-minutes': '${{ 12 }}' },
        zero: { 'timeout-minutes': 0 },
        huge: { 'timeout-minutes': 360 },
        ok: { 'timeout-minutes': 12 },
        call: { uses: './.github/workflows/x.yml' },
        gated: { environment: 'production', steps: [{ 'timeout-minutes': 10 }, { 'timeout-minutes': 5 }] },
        gatedOpen: { environment: 'production', steps: [{ 'timeout-minutes': 10 }, {}] },
        gatedEmpty: { environment: 'production', steps: [] },
        stepsNoEnv: { steps: [{ 'timeout-minutes': 10 }] },
        envNull: { environment: null, steps: [{ 'timeout-minutes': 10 }] },
        envBlank: { environment: '', steps: [{ 'timeout-minutes': 10 }] },
        envObject: { environment: { name: 'production' }, steps: [{ 'timeout-minutes': 10 }] },
        envNoName: { environment: {}, steps: [{ 'timeout-minutes': 10 }] },
      },
    };
    expect(unbounded(wf)).toEqual([
      'none', 'text', 'expr', 'zero', 'huge', 'gatedOpen', 'gatedEmpty', 'stepsNoEnv', 'envNull', 'envBlank', 'envNoName',
    ]);
  });
});
