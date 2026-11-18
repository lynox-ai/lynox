import { describe, it, expect } from 'vitest';
import { placeholders, replacePlaceholders, solePlaceholder, splitLeadingSpace } from './placeholders.js';
import { resolveInputTemplate, resolveTaskTemplate } from './context.js';
import { templateRefIssue } from './template-refs.js';
import { runStepIds, stepRunNames } from './step-id.js';
import { applyModifications } from './workflow-edit.js';
import { mappedValueOutsideTaskText } from '../core/webhook-verifiers.js';

// The regexes the scanner replaces, kept here only as the reference it must agree with.
const OLD = /\{\{([^}]+)\}\}/g;
const OLD_SOLE = /^\{\{\s*([^}]+)\s*\}\}$/;
const OLD_SPLIT = /\{\{(\s*)([^}]+)\}\}/g;

/** A seeded generator, so a failing case can be named by its seed and rerun. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// White space of every kind `\s` and `trim` know, braces alone and paired, nested opens, Unicode
// (two-unit characters among them) and the parts a path is made of.
const PIECES = ['{', '}', '{{', '}}', '{{{', '}}}', 'a', 'ü', '😀', '.', 'params', 'step-1', ' ', '  ', '\t', '\n', '\r', ' ', ' ', '﻿', '　', '"', '\\'];

function corpus(count: number, seed: number): string[] {
  const next = rng(seed);
  const pick = (): string => PIECES[Math.floor(next() * PIECES.length)]!;
  const out: string[] = [];
  for (let n = 0; n < count; n++) {
    const len = Math.floor(next() * 24);
    let s = '';
    for (let k = 0; k < len; k++) s += pick();
    // Every third text is wrapped in braces, so the whole-text form is hit often.
    out.push(n % 3 === 0 ? `{{${s}}}` : s);
  }
  return out;
}

const FIXED = [
  '', '{{', '}}', '{{}}', '{{ }}', '{{  }}', '{{a}}', '{{ a }}', '{{{a}}}', '{{a}}}', '{{{a}}', '{{a}b}}', '}}{{a}}',
  '{{a}}{{b}}', '{{a}} x {{ b.c }}', '{{ü.😀}}', '{{ x}}', '{{\na}}', '{{a\n}}', '{{{{a}}', '{{a{{b}}', 'x{{', 'x{{a',
  '{{params.x}}', '{{ params . x }}', '{{ }}', '{{﻿a﻿}}',
];

const CASES = [...FIXED, ...corpus(20_000, 424_242)];

describe('placeholders — the same matches as the regexes it replaces', () => {
  it('finds the placeholders /\\{\\{([^}]+)\\}\\}/g finds, at the same places, with the same inner text', () => {
    for (const text of CASES) {
      const want = [...text.matchAll(OLD)].map(m => ({ start: m.index, end: m.index + m[0].length, inner: m[1]! }));
      expect(placeholders(text), JSON.stringify(text)).toEqual(want);
    }
  });

  it('replaces as String.replace with that regex does, passing the same match and inner text', () => {
    const mark = (match: string, inner: string): string => `<${match}|${inner}>`;
    for (const text of CASES) {
      expect(replacePlaceholders(text, mark), JSON.stringify(text)).toBe(text.replace(OLD, mark));
    }
  });

  it('takes a whole-text placeholder exactly where the anchored regex does, with the same trimmed path', () => {
    for (const text of CASES) {
      const want = OLD_SOLE.exec(text);
      const got = solePlaceholder(text);
      expect(got === null, JSON.stringify(text)).toBe(want === null);
      if (want !== null) expect(got!.trim(), JSON.stringify(text)).toBe(want[1]!.trim());
    }
  });

  it('splits white space from the path as /\\{\\{(\\s*)([^}]+)\\}\\}/g captures them', () => {
    for (const text of CASES) {
      const want = [...text.matchAll(OLD_SPLIT)].map(m => [m[1]!, m[2]!]);
      expect(placeholders(text).map(p => splitLeadingSpace(p.inner)), JSON.stringify(text)).toEqual(want);
    }
  });
});

// Two shapes of stored text: `{{` over and over with no `}` (the per-match regex reads to the end
// from every `{{`), and one `{{` before a run of spaces (the anchored regex splits the spaces
// between its two `\s*` and the path every way there is). The old regexes take seconds on these;
// a linear scan takes well under a millisecond. The sizes keep the old ones finishing, so a
// reverted site fails the bound instead of hanging the run.
const REPEATED = '{{'.repeat(20_000);
const SPACES = `{{${' '.repeat(2_500)}`;
const BOUND_MS = 100;

function timed<T>(run: () => T): { value: T; ms: number } {
  const t0 = performance.now();
  const value = run();
  return { value, ms: performance.now() - t0 };
}

describe('every placeholder site stays linear on long stored text', () => {
  for (const [shape, text] of [['repeated {{', REPEATED], ['{{ before spaces', SPACES]] as const) {
    it(`resolveTaskTemplate (${shape})`, () => {
      const { value, ms } = timed(() => resolveTaskTemplate(text, {}));
      expect(value).toBe(text);
      expect(ms).toBeLessThan(BOUND_MS);
    });

    it(`resolveInputTemplate (${shape})`, () => {
      const { value, ms } = timed(() => resolveInputTemplate({ q: text }, {}));
      expect(value).toEqual({ q: text });
      expect(ms).toBeLessThan(BOUND_MS);
    });

    it(`templateRefIssue on a task and on an input template (${shape})`, () => {
      const { value, ms } = timed(() => templateRefIssue([{ id: 'a', task: text, input_template: { q: text } }]));
      expect(value).toBeNull();
      expect(ms).toBeLessThan(BOUND_MS);
    });

    it(`stepRunNames (${shape})`, () => {
      const { value, ms } = timed(() => stepRunNames([{ id: 'a', task: text, input_template: { q: text } }]));
      expect(value.size).toBe(0);
      expect(ms).toBeLessThan(BOUND_MS);
    });

    it(`runStepIds (${shape})`, () => {
      // An id outside the shape, so the run renames and every text is rewritten.
      const names = new Map([['A b', 'step-1']]);
      const { value, ms } = timed(() => runStepIds([{ id: 'A b', task: text, input_template: { q: text } }], names));
      expect(value[0]!.task).toBe(text);
      expect(ms).toBeLessThan(BOUND_MS);
    });

    it(`rename_step (${shape})`, () => {
      // `b` reads `a`, so the rename rewrites both of its texts; a step that does not read it is left alone.
      const steps = [
        { id: 'a', task: 'A' },
        { id: 'b', task: `{{a.result}}${text}`, input_from: ['a'], input_template: { q: `{{ a.result }}${text}` } },
      ];
      const { value, ms } = timed(() => applyModifications(steps, [{ action: 'rename_step', step_id: 'a', value: 'c' }]));
      expect(value).toBeNull();
      expect(steps[1]!.task).toBe(`{{c.result}}${text}`);
      expect(steps[1]!.input_template).toEqual({ q: `{{ c.result }}${text}` });
      expect(ms).toBeLessThan(BOUND_MS);
    });
  }

  it('mappedValueOutsideTaskText (repeated {{, no }} anywhere after)', () => {
    // In an `input_from` entry, the stringified step ends in `"]}`: one `}` and no `}}`.
    const { value, ms } = timed(() => mappedValueOutsideTaskText([{ id: 'a', task: 'A', input_from: [REPEATED] }], []));
    expect(value).toBeNull();
    expect(ms).toBeLessThan(BOUND_MS);
  });
});
