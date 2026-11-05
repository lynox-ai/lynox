import { describe, expect, it } from 'vitest';
import { charCount, cutChars, descriptionProblem, fixedValueProblem, namesRuleLabel, ruleLine, ruleMatchText, SUBJECT_MIN } from './rule-text.js';

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

describe('namesRuleLabel — a rule text must not name a label of the rule check', () => {
  it('finds a label, with case, a space, punctuation around it', () => {
    for (const t of ['R1', 'gehört zu R12.', 'Regel r 7 gilt', '(R999)', 'siehe R2D2']) expect(namesRuleLabel(t)).toBe(true);
  });
  it('leaves words and numbers alone', () => {
    for (const t of ['Rechnung 2026', 'Nr 12', 'Artikel 2210', 'Rabatt 20 %', 'R&D-Abteilung', 'Mahnungen', 'R1000']) expect(namesRuleLabel(t)).toBe(false);
  });
  it('makes descriptionProblem refuse the description', () => {
    expect(descriptionProblem('Kundenmails gehören zu R1')).toBe('must not name a rule label such as R1');
    expect(descriptionProblem('Kundenmails')).toBeNull();
  });
});

describe('fixedValueProblem — a subject phrase is counted as the match compares it', () => {
  const SHORT = 'subject phrase must be at least 3 characters';
  // Each passes the hidden-character check (a direction mark after a letter, a joiner between
  // letters, a variation selector after a symbol), but the match drops it and compares less.
  it.each([
    ['a left-to-right mark between two letters', 'r\u200Ee', 're'],
    ['a narrow no-break space between two letters', 'r\u202Fe', 're'],
    ['a zero-width non-joiner between two letters', 'e\u200Cn', 'en'],
    ['narrow no-break spaces around one letter', 'x\u202F\u202F\u202Fy', 'xy'],
    ['a symbol with its variation selector and a right-to-left mark', '\u2122\uFE0F\u200F ', '\u2122'],
  ])('refuses %s', (_label, value, matched) => {
    expect(charCount(value.trim())).toBeGreaterThanOrEqual(SUBJECT_MIN);
    expect(ruleMatchText(value)).toBe(matched);
    expect(fixedValueProblem(value, 'subject_contains')).toBe(SHORT);
  });

  it.each([['Re: '], ['Rechnung'], ['\u26A0\uFE0F Mahnung'], ['abc']])('accepts %j', (value) => {
    expect(fixedValueProblem(value, 'subject_contains')).toBeNull();
  });

  it('leaves a sender alone, which is compared whole', () => {
    expect(fixedValueProblem('a@b', 'from')).toBeNull();
  });
});

describe('fixedValueProblem — half of a surrogate pair is no character', () => {
  it('refuses a lone high or low surrogate as a hidden character, and takes the pair', () => {
    const HIDDEN = 'matcherValue holds characters a reader does not see';
    expect(fixedValueProblem('ab\uDB40', 'subject_contains')).toBe(HIDDEN);
    expect(fixedValueProblem('\uDC00abc', 'subject_contains')).toBe(HIDDEN);
    expect(fixedValueProblem('ab\uD83D x', 'subject_contains')).toBe(HIDDEN);
    expect(fixedValueProblem('ab\uD83D\uDE00', 'subject_contains')).toBeNull();
  });
});
