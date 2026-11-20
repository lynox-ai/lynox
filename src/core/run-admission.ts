import type { LynoxHooks, RunContext } from './engine.js';

/**
 * What an `onBeforeRun` hook may hand back when it admits a run.
 *
 * A hook that returns nothing admits the run unchanged. A hook that returns an admission
 * can bound what the admitted run may spend (`maxCostCents`) and hand over a `release`
 * that gives back whatever it set aside for the run. The control plane may ask the engine
 * to admit runs only within the balance; the managed hook answers that with an admission.
 */
export interface RunAdmission {
  /** The most this run may spend, in US cents. Absent: no bound from this hook. */
  maxCostCents?: number | undefined;
  /** Gives back what the hook set aside for this run. Called once the run has ended. */
  release?: (() => void) | undefined;
}

/**
 * A refusal by an admission hook because the balance cannot cover what the run asked for,
 * while the control plane asks the engine to admit runs only within the balance. Its
 * message is the hook's ordinary refusal text; a caller with its own words for that case
 * (a saved workflow) can tell it apart by class.
 */
export class RunAdmissionRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunAdmissionRefusedError';
  }
}

/**
 * The worst case, in US cents, assumed for a single model call outside a run (a title, a
 * memory or graph extraction, a voice request, an inbox classification) when its caller
 * does not name one. Generous on purpose: under a balance-bounded admission a call is
 * refused unless this much is free, and refusing a cheap call costs less than admitting
 * an expensive one.
 */
export const SINGLE_CALL_WORST_CASE_CENTS = 10;

/** Every admission the hooks of one run handed back, combined. */
export interface CombinedAdmission {
  /** The smallest bound any hook set, in US cents; `undefined` when none set one. */
  readonly maxCostCents: number | undefined;
  /** Calls every hook's `release` once; later calls do nothing. */
  release(): void;
}

function isAdmission(value: unknown): value is RunAdmission {
  return typeof value === 'object' && value !== null;
}

/**
 * Collects what several hooks handed back. The smallest bound wins; every release is
 * called. A bound that is not a number, or is NaN or negative, counts as 0 — nothing may be
 * spent — so a malformed answer refuses rather than admits.
 */
export class AdmissionCollector implements CombinedAdmission {
  private ceiling: number | undefined = undefined;
  private readonly releases: Array<() => void> = [];
  private released = false;

  get maxCostCents(): number | undefined {
    return this.ceiling;
  }

  add(value: unknown): void {
    if (!isAdmission(value)) return;
    const release = value.release;
    if (typeof release === 'function') {
      if (this.released) release();
      else this.releases.push(release);
    }
    if ('maxCostCents' in value && value.maxCostCents !== undefined) {
      const raw = value.maxCostCents;
      const cents = typeof raw === 'number' && !Number.isNaN(raw) && raw >= 0 ? raw : 0;
      this.ceiling = this.ceiling === undefined ? cents : Math.min(this.ceiling, cents);
    }
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    for (const release of this.releases.splice(0)) {
      try {
        release();
      } catch { /* one hook's failure must not keep the others' reservations */ }
    }
  }
}

/**
 * Runs every `onBeforeRun` hook in order and combines what they hand back. A hook that
 * throws refuses the run: what the hooks before it set aside is given back, and the error
 * is thrown on unchanged.
 */
export async function fireAdmissionHooks(
  hooks: readonly LynoxHooks[],
  runId: string,
  context: RunContext,
): Promise<CombinedAdmission> {
  const admission = new AdmissionCollector();
  for (const hook of hooks) {
    if (!hook.onBeforeRun) continue;
    try {
      admission.add(await hook.onBeforeRun(runId, context));
    } catch (err: unknown) {
      admission.release();
      throw err;
    }
  }
  return admission;
}
