import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The wire between a run's recorded STATUS and a colour the owner can read.
 *
 * `TriggersView` renders the "last run" line with `runStatusColor[status]`, and a
 * missing key yields `''` — no class, which reads as *no verdict* rather than as the
 * verdict it is. So a word added to the engine's vocabulary and not added here is
 * invisible rather than loud, and that is how it happened: `stopped` shipped to the
 * engine, the store and the model-facing listing while this map still had three keys.
 *
 * ⛔ THE EXPECTATION IS DERIVED, NOT RESTATED. A hand-written list of four words here
 * would pass forever and say nothing — it is the same list, written twice, and the
 * second copy goes stale silently. So the statuses come out of the WRITER's own
 * signature (`recordTaskRun` in core's task-manager), which is the only place that
 * decides what can land in the column. Adding a word there and not here fails this
 * test; re-ordering or re-wording anything else does not.
 *
 * Source-level because a Svelte component cannot be imported in vitest (the root config
 * has no svelte plugin) — the same instrument, and for the same reason, as
 * `cap-note-i18n.test.ts` beside it.
 *
 * ⚠ What this does NOT check: that the colour is the right colour. `stopped` is muted
 * rather than red because a stop is the owner's own doing and not a failure, and that is
 * a reading no test can make. It also does not check that the class EXISTS as a utility
 * — `app.css.test.ts` owns the token side, and the one trap there is already paid for:
 * the token is `--color-text-muted`, so the utility is `text-text-muted`, while success
 * and danger are `--color-success`/`--color-danger`. A utility for a token that does not
 * exist compiles and renders nothing, i.e. exactly the silence this file exists to end.
 */
const HERE = fileURLToPath(new URL('.', import.meta.url));
const VIEW = readFileSync(`${HERE}TriggersView.svelte`, 'utf8');
const WRITER = readFileSync(`${HERE}../../../../../src/core/task-manager.ts`, 'utf8');

/** The status words `recordTaskRun` accepts, read off its signature. */
function writtenStatuses(): string[] {
  const sig = /recordTaskRun\(id: string, result: string, status: ([^)]+)\)/.exec(WRITER);
  if (!sig) throw new Error('could not find recordTaskRun\'s signature — the regex, not the vocabulary, is what broke');
  const words = [...sig[1]!.matchAll(/'([a-z_]+)'/g)].map(m => m[1]!);
  // Positive control in the same run: a query that finds nothing must not read as a
  // vocabulary of nothing. Four is what exists today; the assertion is "a plausible
  // union", not "exactly four", so adding a word does not fail HERE — it fails below,
  // which is where the message is useful.
  if (words.length < 3) throw new Error(`parsed only ${String(words.length)} status words — the regex is wrong, not the writer`);
  return words;
}

/** The keys of `runStatusColor`, read off the view. */
function colouredStatuses(): string[] {
  const block = /const runStatusColor: Record<string, string> = \{([\s\S]*?)\};/.exec(VIEW);
  if (!block) throw new Error('could not find runStatusColor in TriggersView — the regex, not the map, is what broke');
  // Keys only, and deliberately not the whole line: the colour is a design decision that
  // changes on its own schedule, and pinning it here would make this test fail for a
  // reason it cannot judge.
  return [...block[1]!.matchAll(/^\s*([a-z_]+):/gm)].map(m => m[1]!);
}

describe('every recorded run status has a colour', () => {
  it('the view covers every word the writer can store', () => {
    const written = writtenStatuses();
    const coloured = colouredStatuses();
    // The real assertion, and its message names the fix rather than the symptom.
    for (const status of written) {
      expect(coloured, `'${status}' can be written to last_run_status and would render with NO class`)
        .toContain(status);
    }
  });

  it('and the fixtures really are the two artefacts, not an empty read', () => {
    // ⛔ The guard against the quiet version of this test passing: two regexes that both
    // miss would make the loop above iterate nothing and succeed. Measured values, so a
    // refactor that empties either side fails here with a sentence that says which.
    expect(writtenStatuses(), 'the writer union').toContain('stopped');
    expect(writtenStatuses()).toContain('success');
    expect(colouredStatuses().length, 'the view map').toBeGreaterThanOrEqual(4);
  });
});
