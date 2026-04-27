import { describe, it, expect } from 'vitest';
import { wilsonScoreInterval, classifyWilsonDelta } from './ads-wilson-score.js';

describe('wilsonScoreInterval', () => {
  it('returns 0/NaN bounds for zero trials', () => {
    const r = wilsonScoreInterval(0, 0);
    expect(r.point).toBe(0);
    expect(Number.isNaN(r.lower)).toBe(true);
    expect(Number.isNaN(r.upper)).toBe(true);
  });

  it('produces tight CI for high-volume balanced data', () => {
    const r = wilsonScoreInterval(50, 500);
    expect(r.point).toBeCloseTo(0.1, 5);
    expect(r.upper - r.lower).toBeLessThan(0.06);
    expect(r.lower).toBeGreaterThan(0.07);
    expect(r.upper).toBeLessThan(0.14);
  });

  it('produces wide CI for low-volume data', () => {
    const r = wilsonScoreInterval(2, 10);
    expect(r.point).toBeCloseTo(0.2, 5);
    expect(r.upper - r.lower).toBeGreaterThan(0.4);
  });

  it('clamps lower bound at 0 and upper at 1', () => {
    const all = wilsonScoreInterval(10, 10);
    expect(all.lower).toBeGreaterThan(0);
    expect(all.upper).toBeLessThanOrEqual(1);

    const none = wilsonScoreInterval(0, 10);
    expect(none.lower).toBe(0);
    expect(none.upper).toBeLessThan(0.4);
  });

  it('rejects invalid inputs', () => {
    expect(() => wilsonScoreInterval(-1, 10)).toThrow();
    expect(() => wilsonScoreInterval(10, 5)).toThrow();
    expect(() => wilsonScoreInterval(5, -1)).toThrow();
  });
});

describe('classifyWilsonDelta', () => {
  it('returns NICHT_VERGLEICHBAR when either window has zero trials', () => {
    const empty = wilsonScoreInterval(0, 0);
    const some = wilsonScoreInterval(5, 50);
    expect(classifyWilsonDelta(empty, some)).toBe('NICHT_VERGLEICHBAR');
    expect(classifyWilsonDelta(some, empty)).toBe('NICHT_VERGLEICHBAR');
  });

  it('returns ERFOLG when curr CI is strictly above prev CI', () => {
    // 2% conv-rate vs 18% conv-rate, both at 500 trials → clearly non-overlapping
    const prev = wilsonScoreInterval(10, 500);
    const curr = wilsonScoreInterval(90, 500);
    expect(classifyWilsonDelta(prev, curr)).toBe('ERFOLG');
  });

  it('returns VERSCHLECHTERUNG when curr CI is strictly below prev CI', () => {
    const prev = wilsonScoreInterval(90, 500);
    const curr = wilsonScoreInterval(10, 500);
    expect(classifyWilsonDelta(prev, curr)).toBe('VERSCHLECHTERUNG');
  });

  it('returns NEUTRAL when intervals overlap (low volume)', () => {
    // Low volume gives wide CIs that overlap even when point estimates differ
    const prev = wilsonScoreInterval(2, 10);
    const curr = wilsonScoreInterval(4, 10);
    expect(classifyWilsonDelta(prev, curr)).toBe('NEUTRAL');
  });

  it('returns NEUTRAL when point estimates are identical', () => {
    const prev = wilsonScoreInterval(20, 200);
    const curr = wilsonScoreInterval(20, 200);
    expect(classifyWilsonDelta(prev, curr)).toBe('NEUTRAL');
  });
});
