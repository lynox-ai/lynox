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
 */
const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8');

const I18N = read('../i18n.svelte.ts');
const CHAT_VIEW = read('./ChatView.svelte');

/** The codes `capStopNote` can return. Kept as literals: this file is the far
 *  side of the wire, and deriving them from core would test core against itself. */
const CAP_NOTE_CODES = ['turn_limit', 'cost_budget'] as const;

describe('cap-stop banners are renderable', () => {
  it('read both files, not a prefix of either', () => {
    expect(I18N.length).toBeGreaterThan(100_000);
    expect(CHAT_VIEW).toContain('isInfoNote');
  });

  for (const code of CAP_NOTE_CODES) {
    it(`${code} has a title in both languages`, () => {
      const line = I18N.split('\n').find((l) => l.includes(`'chat.note.${code}.title'`)) ?? '';
      expect(line, `missing chat.note.${code}.title`).not.toBe('');
      expect(line).toMatch(/de:\s*'[^']{5,}'/);
      expect(line).toMatch(/en:\s*'[^']{5,}'/);
    });

    it(`${code} has a body in both languages that says what to do`, () => {
      const line = I18N.split('\n').find((l) => l.includes(`'chat.note.${code}':`)) ?? '';
      expect(line, `missing chat.note.${code}`).not.toBe('');
      expect(line).toMatch(/de:\s*'[^']{60,}'/);
      expect(line).toMatch(/en:\s*'[^']{60,}'/);
    });

    it(`${code} renders as an info note rather than falling through`, () => {
      // ChatView's `isInfoNote` list decides the banner's shape. A code missing
      // from it renders in the error styling — a cap is not a fault.
      expect(CHAT_VIEW).toMatch(new RegExp(`isInfoNote[^\\n]*'${code}'`));
    });
  }
});
