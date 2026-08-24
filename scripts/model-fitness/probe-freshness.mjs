/**
 * Per-RUN fact freshness for every probe that sends durable facts through a live engine.
 *
 * THE TRAP, stated as the store actually implements it. `KnowledgeStore.write` dedups only
 * `status === 'active'` writes, and only against candidates selected by
 * `WHERE status = 'active' AND (subject_id = ? OR source_run_id = ?)` — the same SUBJECT or
 * the same RUN. So a probe is distorted not by the age of its fact but by whether an ACTIVE
 * row for that fact's subject already exists on the target engine. It does, as soon as the
 * probe has run there once: measured 2026-08-24 on the staging engine, where `Meridian AG`
 * (a capture-fitness fixture subject) and `Nordberg Treuhand AG` (the `dk-capture-repro`
 * fact) both carry active rows from earlier runs.
 *
 * WHY A FRESH NAME AND NOT A FRESH NUMBER. Dedup coverage is measured over CONTENT tokens
 * against a 0.7 bar, so swapping only a UID leaves the sentence far above it. Changing the
 * SUBJECT is what removes the old rows from the candidate set entirely — a structural
 * escape, not a textual one.
 *
 * WHICH DIRECTION THE DAMAGE RUNS, because it is not the obvious one. A deduped write still
 * counts as a `remember` CALL, so a probe that counts tool calls reads unchanged; what falls
 * is the number of rows that actually became knowledge. In `capture-fitness-runner.mjs` that
 * is precisely the line labelled "← the number that matters", while the headline stays put.
 * Stale facts therefore do not inflate a probe — they quietly deflate its important half and
 * leave its visible half looking healthy.
 *
 * SCOPE. Every probe under this repo that POSTs to `/api/sessions/:id/run` with a fact in the
 * task text is a member; `tests/eval/probe-freshness-members.test.ts` enumerates them from
 * the source tree and fails when one does not import this module, so the rule is kept by a
 * member count rather than by remembering to apply a pattern.
 */

/**
 * One token per PROCESS, so every cell of a single sweep shares it (a run is the unit of
 * freshness, not a cell — `dk-capture-repro` deliberately sends the SAME fact through three
 * prompt conditions, and per-cell tokens would destroy that control).
 *
 * Base36 of the clock, upper-cased: short, readable in a company name, and monotonic enough
 * that two runs in the same second are the only collision — which the store would then
 * dedup, and `sawDedup()` below reports rather than hides.
 */
const TOKEN = Date.now().toString(36).slice(-4).toUpperCase();

/** The run token, exported so a probe can print it beside its results. */
export function runToken() {
  return TOKEN;
}

/**
 * A per-run company name. `Falkenstein` → `Falkenstein-K7Q2`.
 * The suffix is part of the NAME on purpose: it is what makes the subject new.
 */
export function freshName(base) {
  return `${base}-${TOKEN}`;
}

/**
 * A per-run Swiss UID derived from the token and a caller-supplied index, so two facts in
 * one run never share one. Format only — these are synthetic and resolve to nothing.
 */
export function freshUid(index) {
  const n = [...TOKEN].reduce((a, c) => a * 31 + c.charCodeAt(0), index + 1) >>> 0;
  const d = String(n).padStart(9, '0').slice(-9);
  return `CHE-${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}`;
}

/**
 * Did this write hit the store's dedup path?
 *
 * A TRIPWIRE, not the guarantee. The guarantee is freshness above; this only reports that
 * freshness failed, so a probe marks the cell instead of counting it silently — the honest
 * half of `DEF-dk-xprov-facts-not-fresh-across-runs`'s verify-done.
 *
 * ⚠️ It matches the tool's user-facing string, so a reword in `knowledge.ts` makes this
 * return false and the tripwire goes quiet. That coupling is stated rather than dressed up:
 * the failure mode is a missed warning, never a wrong number, because the number is
 * protected by the fresh subject and not by this check. A probe that reads the capture
 * -telemetry sink (as `capture-fitness-runner.mjs` does) has the structured `outcome` field
 * and should prefer it.
 */
export function sawDedup(result) {
  return String(result ?? '').startsWith('Already recorded');
}
