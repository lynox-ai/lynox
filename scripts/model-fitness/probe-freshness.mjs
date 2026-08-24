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
 * RANDOM, not clock-derived, and that is the whole point of the choice. The first version
 * took the last four base36 digits of `Date.now()`, i.e. milliseconds mod 36⁴ — a period of
 * **28 minutes**. Two runs half an hour apart drew the same token and dedup'd each other,
 * which is precisely the failure this module exists to prevent, dressed as a fix. Six random
 * base36 characters have no period; the residual is a ~1-in-2·10⁹ birthday collision, and
 * `sawDedup()` below reports it rather than hiding it.
 */
const TOKEN = Math.random().toString(36).slice(2, 8).padEnd(6, '0').toUpperCase();

/** The run token, exported so a probe can print it beside its results. */
export function runToken() {
  return TOKEN;
}

/**
 * A per-run company name. `Falkenstein` → `FalkensteinK7Q2X`.
 *
 * NO SEPARATOR, and this is load-bearing rather than cosmetic. `KnowledgeStore._mentions`
 * matches a subject name when it is not flanked by an ALPHANUMERIC character on either side,
 * so `Talbach-K7Q2` still counts as a mention of a pre-existing subject `Talbach` — a hyphen
 * is not alnum. The old subject can then be re-attached to the write and its rows are back in
 * the dedup candidate set. Joining the token directly puts a letter on the boundary, the
 * match fails, and the escape rests on the candidate set itself instead of on whichever
 * heuristic happened to save it.
 *
 * (Measured before this was understood: a two-word base like `Nordberg Treuhand AG` survived
 * the hyphen anyway, because the nonce lands mid-needle and breaks the full name. Single-word
 * bases — `Talbach`, `Orion`, `Meridian` — did not. A fix that works for one shape of input
 * and not another is not a fix.)
 */
export function freshName(base) {
  return `${base}${TOKEN}`;
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
