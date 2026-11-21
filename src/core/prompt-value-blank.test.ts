import { describe, it, expect } from 'vitest';
import { singleLine } from './prompt-value.js';
import { isDangerousDetailed } from '../tools/permission-guard.js';
import { dialogToolWord } from '../tools/tool-words.js';

// A value in a confirmation dialog must not pad itself with characters that render blank, nor
// paint over its surroundings with stacked marks: either could push its text visually onto what
// looks like a further line of the dialog. A danger prompt's values reach it through
// `singleLine`, and so does an external tool's name, before its cut.

/** The value a read_file danger prompt shows for `path`. */
function dialogValue(path: string): string {
  const s = isDangerousDetailed('read_file', { path }, 'guided');
  if (s === null) throw new Error('read_file raised no danger — the fixture is wrong');
  const values = s.prompt.segments.filter((g) => g.kind === 'value').map((g) => g.text);
  expect(values).toHaveLength(1);
  return values[0]!;
}

const BLANK: ReadonlyArray<readonly [string, string]> = [
  ['Hangul choseong filler U+115F', '\u115F'],
  ['Hangul jungseong filler U+1160', '\u1160'],
  ['Hangul filler U+3164', '\u3164'],
  ['halfwidth Hangul filler U+FFA0', '\uFFA0'],
  ['combining grapheme joiner U+034F', '\u034F'],
  ['variation selector-16 U+FE0F', '\uFE0F'],
  ['variation selector-1 U+FE00', '\uFE00'],
  ['Mongolian free variation selector U+180B', '\u180B'],
  ['variation selector-17 U+E0100', '\u{E0100}'],
];

describe('singleLine removes what renders blank', () => {
  for (const [name, ch] of BLANK) {
    const run = ch.repeat(40);
    it(`${name}: removed from a value`, () => {
      expect(singleLine(`a${run}b`)).toBe('ab');
    });
    it(`${name}: removed from a dialog value`, () => {
      expect(dialogValue(`/etc/shadow${run}✓ reviewed`)).toBe('/etc/shadow✓ reviewed');
    });
    it(`${name}: removed from an external tool's name`, () => {
      expect(dialogToolWord(`Merge${run}now`)).toBe('External tool "Mergenow"');
    });
  }

  for (const [name, ch] of [['braille blank U+2800', '\u2800'], ['musical null notehead U+1D159', '\u{1D159}']] as const) {
    const run = ch.repeat(40);
    it(`${name}: collapsed to one space in a value`, () => {
      expect(singleLine(`a${run}b`)).toBe('a b');
    });
    it(`${name}: collapsed to one space in a dialog value`, () => {
      expect(dialogValue(`/etc/shadow${run}✓ reviewed`)).toBe('/etc/shadow ✓ reviewed');
    });
    it(`${name}: collapsed to one space in an external tool's name`, () => {
      expect(dialogToolWord(`Merge${run}now`)).toBe('External tool "Merge now"');
    });
  }

  it('braille words stay apart', () => {
    const word = '\u281E\u2811\u2827';
    expect(singleLine(`${word}\u2800${word}`)).toBe(`${word} ${word}`);
  });

  it('a blank character between spaces leaves one space, not two', () => {
    expect(singleLine('a \u3164 b')).toBe('a b');
  });
});

describe('singleLine keeps at most four marks on one base character', () => {
  it('a long run of non-spacing marks is cut to four', () => {
    expect(singleLine(`e${'\u0301'.repeat(30)}x`)).toBe(`e${'\u0301'.repeat(4)}x`);
    expect(dialogValue(`/etc/shadowe${'\u0301'.repeat(30)}`)).toBe(`/etc/shadowe${'\u0301'.repeat(4)}`);
    expect(dialogToolWord(`e${'\u0301'.repeat(30)}`)).toBe(`External tool "e${'\u0301'.repeat(4)}"`);
  });

  it('enclosing marks count as marks', () => {
    expect(singleLine(`a${'\u20DD'.repeat(10)}b`)).toBe(`a${'\u20DD'.repeat(4)}b`);
    expect(dialogValue(`/etc/shadowa${'\u20DD'.repeat(10)}`)).toBe(`/etc/shadowa${'\u20DD'.repeat(4)}`);
    expect(dialogToolWord(`a${'\u20DD'.repeat(10)}`)).toBe(`External tool "a${'\u20DD'.repeat(4)}"`);
  });

  it('a mixed run of non-spacing and enclosing marks is cut to four in all', () => {
    expect(singleLine(`a${'\u0301\u20DD'.repeat(5)}b`)).toBe('a\u0301\u20DD\u0301\u20DDb');
    expect(dialogValue(`/etc/shadowa${'\u0301\u20DD'.repeat(5)}`)).toBe('/etc/shadowa\u0301\u20DD\u0301\u20DD');
    expect(dialogToolWord(`a${'\u0301\u20DD'.repeat(5)}`)).toBe('External tool "a\u0301\u20DD\u0301\u20DD"');
  });

  it('blank characters are removed before the marks are counted', () => {
    expect(singleLine(`e${'\u0301\u3164'.repeat(10)}`)).toBe(`e${'\u0301'.repeat(4)}`);
  });

  it('spacing marks are visible and stay', () => {
    const devanagari = '\u0915' + '\u093E\u093F\u0940\u0949\u094A';
    expect(singleLine(devanagari)).toBe(devanagari);
  });
});

describe('the removal runs before a cut', () => {
  it('blank characters past an external name\'s 64 do not shorten what is shown', () => {
    const name = `${'A'.repeat(60)}${'\u3164'.repeat(50)}BCD`;
    expect(dialogToolWord(name)).toBe(`External tool "${'A'.repeat(60)}BCD"`);
  });
});

describe('real text still reads', () => {
  for (const text of ['안녕하세요', '한국어 텍스트', 'Tiếng Việt có dấu', 'Ngoại hối ưu đãi']) {
    it(`${text} in decomposed form survives`, () => {
      expect(singleLine(text.normalize('NFD')).normalize('NFC')).toBe(text);
      expect(dialogValue(`/etc/shadow ${text.normalize('NFD')}`).normalize('NFC')).toBe(`/etc/shadow ${text}`);
      expect(dialogToolWord(text.normalize('NFD')).normalize('NFC')).toBe(`External tool "${text}"`);
    });
  }
});
