/**
 * Types for `probe-freshness.mjs`.
 *
 * The module is plain `.mjs` like its neighbours in `scripts/` — those run under bare node
 * with no build step, and giving this one a `.ts` extension would break the probes that
 * import it directly. Without this declaration `tests/eval/probe-freshness.test.ts` imports
 * it as an implicit `any`, so the test that exists to pin the signatures pins nothing: every
 * call site typechecks no matter what the module returns.
 */

/** The per-run token shared by every fact of one process. */
export function runToken(): string;

/**
 * A per-run subject name: `Talbach` → `TalbachK7Q2X1`. No separator — a non-alphanumeric
 * boundary lets `KnowledgeStore._mentions` still match the original name.
 */
export function freshName(base: string): string;

/** A per-run, per-index Swiss UID in `CHE-ddd.ddd.ddd` form. */
export function freshUid(index: number): string;

/** True when a `remember` result reports the store's dedup path. */
export function sawDedup(result: string | undefined | null): boolean;

/** True when a `remember` result reports an ACTIVE store — the only dedup-target outcome. */
export function storedActive(result: string | undefined | null): boolean;
