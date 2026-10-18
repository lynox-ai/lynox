/**
 * The engine refuses a judge rule that carries a hidden character (`HIDDEN_CHARS`), and the bulk
 * pages of the web UI mark the same characters in what the owner reads (`BULK_HIDDEN_CHARS`). The
 * web UI is a package of its own and keeps a copy; if the two sets differ, the page marks less
 * than the engine refuses or the other way round. Compared as sets, code point by code point, so a
 * copy written in another notation is still equal and a missing range is named.
 */
import { describe, it, expect } from 'vitest';
import { HIDDEN_CHARS } from '../src/core/hidden-chars.js';
import { BULK_HIDDEN_CHARS } from '../packages/web-ui/src/lib/components/bulk-runs.js';

const hex = (cp: number): string => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;

/** Every code point one set holds and the other does not, both ways. */
function difference(a: RegExp, b: RegExp): { onlyA: string[]; onlyB: string[] } {
  const ra = new RegExp(a.source, 'u');
  const rb = new RegExp(b.source, 'u');
  const onlyA: string[] = [];
  const onlyB: string[] = [];
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    const c = String.fromCodePoint(cp);
    const inA = ra.test(c);
    if (inA !== rb.test(c)) (inA ? onlyA : onlyB).push(hex(cp));
  }
  return { onlyA, onlyB };
}

describe('hidden characters: the web UI marks exactly what the engine refuses', () => {
  it('the two sets hold the same code points', () => {
    expect(difference(HIDDEN_CHARS, BULK_HIDDEN_CHARS)).toEqual({ onlyA: [], onlyB: [] });
  });

  it('the comparison names a code point missing on either side (positive control)', () => {
    // Without U+200B on one side; the comparison must see it from both directions.
    const without = new RegExp(HIDDEN_CHARS.source.replace(String.raw`\u200B`, ''), 'u');
    expect(without.source).not.toBe(HIDDEN_CHARS.source);
    expect(difference(HIDDEN_CHARS, without)).toEqual({ onlyA: ['U+200B'], onlyB: [] });
    expect(difference(without, HIDDEN_CHARS)).toEqual({ onlyA: [], onlyB: ['U+200B'] });
  });
});
