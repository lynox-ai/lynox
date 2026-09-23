/**
 * The tier-fitness decision (`scripts/model-fitness/grid.ts`).
 *
 * Regression tests for the defect that mattered most in this harness: it printed
 * a model as FIT for a tier it had measured nothing for. `scripts/` is executed by
 * nothing in CI, which is why the decision was extracted into an importable module
 * and is asserted here — same arrangement as `tests/model-fitness-replay.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { tierFit } from '../scripts/model-fitness/grid.js';
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

  it('applies the structural context gate before any behaviour', () => {
    const d = tierFit([cap('c1')], [cand('a')], [cell('c1', 'a')], () => false);
    expect(d.measured).toBe(true);
    expect(d.fit).toEqual([]);
  });
});
