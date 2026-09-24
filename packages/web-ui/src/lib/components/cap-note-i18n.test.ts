import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The wire between a note code and something the user can read.
 *
 * `capStopNote` (core, eager-persist.ts) emits `turn_limit` and `cost_budget`
 * when a cap stopped a turn mid-tool-call. Both halves have to exist here or the
 * banner renders as nothing — which is the EXACT failure the core change fixes:
 * a cap stopped twenty turns on a prod thread and its explanation reached the
 * run record and no reader. Shipping a note nobody renders would move the
 * silence one layer out rather than end it.
 *
 * Source-level because neither i18n nor ChatView can be imported in vitest (the
 * root config has no svelte plugin), and because the two files must AGREE —
 * a behavioural test of either alone cannot see the disagreement.
 *
 * WHY WHOLE LINES. The first revision of this file checked existence and a
 * minimum length, and a review then walked four separate regressions past it:
 * a key commented OUT (`indexOf` finds it inside the comment just as well), a
 * title commented out, the `isInfoNote` list trimmed back, and a DUPLICATE key
 * added later in the table — which wins at runtime while a `.find()` reads the
 * first. None of those change a length. These are four short sentences that
 * change about once a year, so they are compared whole, the instrument used for
 * a small rarely-edited artefact elsewhere (`trigger-consent-i18n.test.ts`).
 *
 * What that buys: editing any of these means editing this file. That is the
 * point, and it is also the entire cost. What it does not buy is a check that
 * the German and the English say the same thing — that is a reading, and no
 * assertion below claims to make it.
 */
const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8');

const I18N = read('../i18n.svelte.ts');
const CHAT_VIEW = read('./ChatView.svelte');

/** The codes `capStopNote` can return. Kept as literals: this file is the far
 *  side of the wire, and deriving them from core would test core against itself. */
const CAP_NOTE_CODES = ['turn_limit', 'cost_budget'] as const;

/**
 * The one LIVE line that opens with `key`, as written.
 *
 * Anchored at the start of the trimmed line, so a commented-out row is not a
 * match — that is the whole difference from `indexOf`, and it is what let the
 * commented-out key through.
 *
 * EITHER quote style counts. An earlier revision of this helper matched only
 * `'key':`, and its docblock claimed a duplicate-key guard it did not have: a
 * second definition written `"chat.note.cost_budget":` left this file green
 * while `t()` returned the duplicate at runtime. The claim is now true for the
 * form a person actually writes.
 *
 * What it still cannot see, stated rather than implied: a COMPUTED key
 * (`['chat.note.' + 'cost_budget']: …`). No line-based reader can, and
 * `svelte-check` does not flag it either — that one is unguarded, and saying so
 * is worth more than a sentence that sounds like it is covered.
 */
function liveLine(source: string, key: string): string {
  const opener = new RegExp(`^['"]${key.replace(/[.*+?^$()[\]{}|\\]/g, '\\$&')}['"]\\s*:`);
  const hits = source.split('\n').filter((l) => opener.test(l.trim()));
  expect(hits.length, `expected exactly one live '${key}' line, found ${hits.length}`).toBe(1);
  return (hits[0] as string).trim();
}

describe('cap-stop banners are renderable', () => {
  it('read both files, not a prefix of either', () => {
    expect(I18N.length).toBeGreaterThan(100_000);
    expect(CHAT_VIEW).toContain('isInfoNote');
  });

  it('every cap-note string is exactly the one that was reviewed', () => {
    const pinned: Record<string, string> = {
      'chat.note.turn_limit.title':
        "'chat.note.turn_limit.title': { de: 'Rundenlimit erreicht', en: 'Turn limit reached' },",
      'chat.note.turn_limit':
        "'chat.note.turn_limit': { de: 'Der Agent rief noch Werkzeuge auf, als diese Runde ihr Limit erreichte — eine fertige Antwort gibt es deshalb nicht. Lass ihn in kleineren Schritten vorgehen oder grenze die Aufgabe enger ein.', en: 'The agent was still calling tools when this turn hit its limit, so there is no finished answer. Let it work in smaller steps, or narrow the task.' },",
      'chat.note.cost_budget.title':
        "'chat.note.cost_budget.title': { de: 'Kostenbudget erreicht', en: 'Cost budget reached' },",
      'chat.note.cost_budget':
        "'chat.note.cost_budget': { de: 'Diese Runde hat ihr Kostenbudget aufgebraucht, während der Agent noch Werkzeuge aufrief — eine fertige Antwort gibt es deshalb nicht. Das Budget pro Runde ist fest vorgegeben; lass ihn in kleineren Schritten vorgehen oder grenze die Aufgabe enger ein.', en: 'This turn used up its cost budget while the agent was still calling tools, so there is no finished answer. The per-turn budget is fixed; let it work in smaller steps, or narrow the task.' },",
    };
    for (const [key, expected] of Object.entries(pinned)) {
      expect(liveLine(I18N, key), `${key} is not the reviewed sentence`).toBe(expected);
    }
  });

  it('neither banner sends the reader to a control that governs nothing', () => {
    // The first revision said "raise the budget in settings". No settings field
    // feeds `costGuard`: managed takes the ceiling from a clamped CP env while
    // WorkspaceLimitsView renders every spend input `disabled` for managed, and
    // the only other producer of this banner is the worker loop's $15 constant.
    // (The orchestrator's $10/$2 build Agents rather than Sessions, so they
    // never reach this path at all — they are not a third reader, they are no
    // reader.) `getHardLimits()` is read for DISPLAY only. So the advice was
    // wrong for every possible reader, and a length check cannot see that.
    const bodies = CAP_NOTE_CODES.map((c) => liveLine(I18N, `chat.note.${c}`));
    for (const body of bodies) {
      expect(body).not.toMatch(/Einstellungen|settings/i);
    }
    // Positive control on the same search: the advice these lines DO give is
    // found by the identical machinery, so the two nulls above are absences,
    // not a broken matcher.
    expect(bodies.every((b) => /kleineren Schritten/.test(b) && /smaller steps/.test(b))).toBe(true);
  });

  it('both codes render as info notes rather than falling through', () => {
    // ChatView's `isInfoNote` list decides the banner's shape: a code missing
    // from it renders in the error styling, and a cap is not a fault. Pinned
    // WHOLE — a review trimmed the list back to its first four codes and every
    // substring assertion on the survivors still matched, because each one only
    // ever asked about its own code.
    const hits = CHAT_VIEW.split('\n').filter((l) => l.trim().startsWith('{@const isInfoNote'));
    expect(hits.length, `expected exactly one live isInfoNote line, found ${hits.length}`).toBe(1);
    expect((hits[0] as string).trim()).toBe(
      "{@const isInfoNote = msg.note.code === 'context_compacted' || msg.note.code === 'run_interrupted' || msg.note.code === 'tool_loop_break' || msg.note.code === 'continuation_loop' || msg.note.code === 'turn_limit' || msg.note.code === 'cost_budget'}",
    );
  });
});
