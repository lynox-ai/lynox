/**
 * Wilson score interval — 95% confidence bound on a binomial proportion.
 *
 * Used by Performance-Verification (P2 audit tool) to classify whether an
 * entity's conversion-rate moved between two windows: we compare the Wilson
 * confidence intervals on (conversions / clicks) per window. Non-overlapping
 * intervals = real change; overlapping = NEUTRAL even if point estimates
 * differ. Tiny entities get wide intervals → automatic NEUTRAL, no
 * magic-number floor required.
 *
 * Pure utility. No deps. No I/O.
 */

const Z_95 = 1.959963984540054;

export interface WilsonInterval {
  /** Number of successes (e.g. conversions). */
  successes: number;
  /** Number of trials (e.g. clicks). */
  trials: number;
  /** Point estimate (successes / trials), or 0 when trials = 0. */
  point: number;
  /** Lower bound of the 95% Wilson CI. NaN when trials = 0. */
  lower: number;
  /** Upper bound of the 95% Wilson CI. NaN when trials = 0. */
  upper: number;
}

/**
 * Compute the Wilson score interval for a binomial proportion at 95% CI.
 * Returns NaN bounds when trials = 0 (caller must handle this — treat as
 * "no information" / NICHT_VERGLEICHBAR).
 */
export function wilsonScoreInterval(successes: number, trials: number): WilsonInterval {
  if (trials < 0 || successes < 0) {
    throw new Error('wilsonScoreInterval: successes and trials must be non-negative');
  }
  if (successes > trials) {
    throw new Error('wilsonScoreInterval: successes cannot exceed trials');
  }
  if (trials === 0) {
    return { successes, trials, point: 0, lower: NaN, upper: NaN };
  }
  const p = successes / trials;
  const z = Z_95;
  const z2 = z * z;
  const denom = 1 + z2 / trials;
  const center = (p + z2 / (2 * trials)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p) + z2 / (4 * trials)) / trials)) / denom;
  return {
    successes,
    trials,
    point: p,
    lower: Math.max(0, center - margin),
    upper: Math.min(1, center + margin),
  };
}

export type WilsonClassification =
  | 'ERFOLG'           // post-import CI strictly above pre-import CI
  | 'VERSCHLECHTERUNG' // post-import CI strictly below pre-import CI
  | 'NEUTRAL'          // intervals overlap (cannot tell)
  | 'NICHT_VERGLEICHBAR'; // at least one window has 0 trials

/**
 * Classify a delta between two Wilson intervals. Strict non-overlap is
 * required for ERFOLG/VERSCHLECHTERUNG. The asymmetric handling (post above
 * pre = success) is symmetric in implementation since we use point order.
 */
export function classifyWilsonDelta(prev: WilsonInterval, curr: WilsonInterval): WilsonClassification {
  if (prev.trials === 0 || curr.trials === 0) return 'NICHT_VERGLEICHBAR';
  if (curr.lower > prev.upper) return 'ERFOLG';
  if (curr.upper < prev.lower) return 'VERSCHLECHTERUNG';
  return 'NEUTRAL';
}
