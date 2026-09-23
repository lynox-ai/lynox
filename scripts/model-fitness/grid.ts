/**
 * The tier-fitness DECISION, extracted as a pure function.
 *
 * It lives here rather than inline in run.ts for the reason replay.ts states for
 * its own helpers: this decides which model is called fit for a production slot,
 * and `scripts/` is executed by nothing in CI, so anything verdict-shaped has to
 * be importable by a test under `tests/`. run.ts cannot be that import — it calls
 * `main()` at module scope, so importing it would start a paid run.
 */
import type { Candidate, Capability, MatrixCell } from './types.js';

export interface TierFit {
  /** False when this run measured NOTHING that gates the tier. */
  readonly measured: boolean;
  readonly fit: readonly Candidate[];
}

/**
 * Which candidates clear every gate this run measured for a tier.
 *
 * Two emptiness traps, both of which used to read as a clean pass:
 *
 *  · **No gating case at all.** `[].every(…)` is `true`, so a tier with no case in
 *    the current suite reported every context-clearing candidate as FIT having
 *    measured nothing. It is reachable on a documented path — `--scenarios` carries
 *    no fast-tier case — and by a typo in `--only`, which empties all three.
 *  · **A cell with no runs.** A context-skipped cell is 0 passes out of 0 runs, and
 *    `0 === 0` is true. The specialized-job block always guarded this; the tier grid
 *    did not.
 *
 * `measured: false` is therefore a distinct outcome from an empty `fit`, and the
 * caller must say "not measured" rather than "(none passed)".
 */
export function tierFit(
  gating: readonly Capability[],
  candidates: readonly Candidate[],
  cells: readonly MatrixCell[],
  ctxFit: (id: string) => boolean,
): TierFit {
  if (gating.length === 0) return { measured: false, fit: [] };
  const fit = candidates.filter((cand) => {
    if (!ctxFit(cand.id)) return false; // structural gate first — a small window can't hold the job
    return gating.every((cap) => {
      const cell = cells.find((x) => x.capabilityId === cap.id && x.candidateId === cand.id);
      return cell !== undefined && cell.runs > 0 && cell.passes === cell.runs && cell.errors === 0;
    });
  });
  return { measured: true, fit };
}
