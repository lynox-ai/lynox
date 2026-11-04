import { describe, expect, it } from 'vitest';
import { cutChars, ruleLine } from './rule-text.js';

describe('ruleLine — what the owner reads is what the model reads', () => {
  const cases: Array<[string, string, string]> = [
    ['the tag block, which spells ASCII invisibly', 'Kunde\u{E0049}\u{E0047}\u{E004E}', 'Kunde'],
    ['variation selectors', 'Re\uFE00tour\uFE0F', 'Re tour'],
    ['soft hyphen, Arabic letter mark, Mongolian vowel separator', 'Be\u00ADle\u061Cge\u180Ex', 'Be le ge x'],
    ['zero-width and joiners', 'a\u200Bb\u200Cc\u200Dd\u2060e\uFEFFf', 'a b c d e f'],
    ['direction overrides and isolates', 'x\u202Eabc\u2066d\u2069', 'x abc d'],
    ['line breaks of every class', 'a\nb\r\nc\u0085d\u2028e\u2029f', 'a b c d e f'],
    ['controls', 'a\u0000b\u001Fc\u007Fd', 'a b c d'],
  ];
  for (const [label, raw, want] of cases) {
    it(`turns ${label} into spaces`, () => {
      expect(ruleLine(raw)).toBe(want);
    });
  }

  it('keeps letters, umlauts and an emoji as they are', () => {
    expect(ruleLine('  Rückfrage   Müller 😀 ')).toBe('Rückfrage Müller 😀');
  });

  it('leaves nothing of a text made only of hidden characters', () => {
    expect(ruleLine('\u200B\u{E0041}\uFEFF')).toBe('');
  });
});

describe('cutChars', () => {
  it('counts code points, so an emoji at the edge is kept whole or left out, never split', () => {
    const cut = cutChars(`${'a'.repeat(79)}😀x`, 80);
    expect(cut).toBe(`${'a'.repeat(79)}😀`);
    expect(Array.from(cut)).toHaveLength(80);
    expect(cut).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
});
