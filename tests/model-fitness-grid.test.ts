/**
 * The tier-fitness decision (`scripts/model-fitness/grid.ts`).
 *
 * Regression tests for the defect that mattered most in this harness: it printed
 * a model as FIT for a tier it had measured nothing for. `scripts/` is outside the
 * vitest include, so a test living next to the code would never be collected — the
 * decision was extracted into an importable module and is asserted from here, the
 * same arrangement as `tests/model-fitness-replay.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { isRetryableRunError, tierFit } from '../scripts/model-fitness/grid.js';
import { JudgeError } from '../scripts/model-fitness/judge.js';
import type { Candidate, Capability, MatrixCell } from '../scripts/model-fitness/types.js';

const cand = (id: string): Candidate => ({
  id, label: id, provider: 'anthropic', tierHint: 'fast', prefilter: 'test fixture',
});
const cap = (id: string): Capability => ({
  id, point: 'p', tiers: ['fast'], detail: 'd', run: async () => ({ pass: true }),
});
const cell = (capabilityId: string, candidateId: string, o: Partial<MatrixCell> = {}): MatrixCell => ({
  capabilityId, candidateId, passes: 1, runs: 1, errors: 0, ...o,
});
const allCtxFit = (): boolean => true;

describe('tierFit', () => {
  it('reports NOT MEASURED when no case gates the tier, instead of passing everyone', () => {
    // `[].every(…)` is true. Reachable on a documented path: `--scenarios` carries
    // no fast-tier case, so the grid used to print the whole roster as fast-FIT.
    const d = tierFit([], [cand('a'), cand('b')], [], allCtxFit);
    expect(d.measured).toBe(false);
    expect(d.fit).toEqual([]);
  });

  it('is FIT when every gating case passed every run', () => {
    const d = tierFit([cap('c1')], [cand('a')], [cell('c1', 'a')], allCtxFit);
    expect(d.measured).toBe(true);
    expect(d.fit.map((c) => c.id)).toEqual(['a']);
  });

  it('does not count a cell that never ran', () => {
    // A context-skipped cell is 0 of 0, and `0 === 0` read as a clean pass.
    const d = tierFit([cap('c1')], [cand('a')], [cell('c1', 'a', { passes: 0, runs: 0 })], allCtxFit);
    expect(d.measured).toBe(true);
    expect(d.fit).toEqual([]);
  });

  it('does not count a cell with errors, even when its runs all passed', () => {
    const d = tierFit([cap('c1')], [cand('a')], [cell('c1', 'a', { errors: 1 })], allCtxFit);
    expect(d.fit).toEqual([]);
  });

  it('does not count a partial pass-rate', () => {
    const d = tierFit([cap('c1')], [cand('a')], [cell('c1', 'a', { passes: 1, runs: 2 })], allCtxFit);
    expect(d.fit).toEqual([]);
  });

  it('requires a cell for EVERY gating case, not just one', () => {
    const d = tierFit([cap('c1'), cap('c2')], [cand('a')], [cell('c1', 'a')], allCtxFit);
    expect(d.fit).toEqual([]);
  });

  it('excludes a candidate that fails the structural context gate, however it scored', () => {
    // Not an ordering assertion — `tierFit` may evaluate the two in any order. What
    // is pinned is that a sub-floor candidate cannot be FIT on behaviour alone.
    const d = tierFit([cap('c1')], [cand('a')], [cell('c1', 'a')], () => false);
    expect(d.measured).toBe(true);
    expect(d.fit).toEqual([]);
  });
});

describe('isRetryableRunError', () => {
  it('retries a rate limit from the candidate', () => {
    expect(isRetryableRunError(new Error('429 Too Many Requests'))).toBe(true);
    expect(isRetryableRunError(new Error('rate limit exceeded'))).toBe(true);
  });

  it('does NOT retry a judge failure, even one that says 429', () => {
    // The whole point: a JudgeError carries the judge's status text, so the plain
    // pattern match would re-run the case and re-call the PAID candidate model up
    // to four times because somebody else's rate limit was hit.
    expect(isRetryableRunError(new JudgeError('judge HTTP 429 — a configured judge that fails is an error, not a pass'))).toBe(false);
  });

  it('does not retry an ordinary failure', () => {
    expect(isRetryableRunError(new Error('the model returned nothing'))).toBe(false);
    expect(isRetryableRunError('a thrown string')).toBe(false);
  });
});
