import { describe, it, expect } from 'vitest';
import { BulkSourceError } from './bulk-plan.js';
import { validateAgainstSchema } from './llm-helper.js';
import {
  JUDGE_MAX_AFTER_BYTES, judgeAfterBound, judgeFields, judgeMaxOutputTokens, judgeTemplate, normalizeJudgeRule,
} from './bulk-judge-rule.js';

const TITLE = { type: 'string', maxLength: 70 };

describe('normalizeJudgeRule — the plan builds the verdict schema, it does not take it as given', () => {
  it('forces every field required and nothing else allowed, defaults the tier to fast', () => {
    const r = normalizeJudgeRule({ rule: 'Write an SEO title.', schema: { properties: { title: TITLE, featured: { type: 'boolean' } } } });
    expect(r.schema).toEqual({
      type: 'object',
      properties: { title: { type: 'string', maxLength: 70 }, featured: { type: 'boolean' } },
      required: ['title', 'featured'],
      additionalProperties: false,
    });
    expect(r.tier).toBe('fast');
    expect(judgeFields(r)).toEqual(['title', 'featured']);
    expect(judgeTemplate(r)).toEqual({ title: null, featured: null });
  });

  it('a verdict with a field the rule does not name is refused by the stored schema', () => {
    const r = normalizeJudgeRule({ rule: 'x', schema: { title: TITLE } });
    expect(() => validateAgainstSchema({ title: 'a', price: 0 }, r.schema)).toThrow();
    expect(() => validateAgainstSchema({}, r.schema)).toThrow();
    expect(() => validateAgainstSchema({ title: 'a' }, r.schema)).not.toThrow();
  });

  it('refuses pattern, even beside maxLength', () => {
    expect(() => normalizeJudgeRule({ rule: 'x', schema: { title: { type: 'string', maxLength: 70, pattern: '(a+)+$' } } }))
      .toThrow(/pattern/);
  });

  it('refuses a text field without maxLength or enum, and one longer than the cap', () => {
    expect(() => normalizeJudgeRule({ rule: 'x', schema: { title: { type: 'string' } } })).toThrow(/maxLength/);
    expect(() => normalizeJudgeRule({ rule: 'x', schema: { title: { type: 'string', maxLength: 2_001 } } })).toThrow(/maxLength/);
    expect(() => normalizeJudgeRule({ rule: 'x', schema: { level: { type: 'string', enum: ['a', 'b'] } } })).not.toThrow();
  });

  it('refuses lists and objects: a target field holds one scalar', () => {
    expect(() => normalizeJudgeRule({ rule: 'x', schema: { tags: { type: 'array', items: { type: 'string', maxLength: 5 } } } })).toThrow(BulkSourceError);
    expect(() => normalizeJudgeRule({ rule: 'x', schema: { o: { type: 'object', properties: {} } } })).toThrow(BulkSourceError);
  });

  it('refuses a rule that decides the list\'s id field', () => {
    expect(() => normalizeJudgeRule({ rule: 'x', schema: { id: { type: 'integer' } } }, { idField: 'id' })).toThrow(/id field/);
    expect(() => normalizeJudgeRule({ rule: 'x', schema: { id: { type: 'integer' } } })).not.toThrow();
  });

  it('refuses an empty rule, a bad tier, a bad field name, no fields', () => {
    expect(() => normalizeJudgeRule({ rule: '  ', schema: { title: TITLE } })).toThrow(/rule/);
    expect(() => normalizeJudgeRule({ rule: 'x', schema: { title: TITLE }, tier: 'turbo' })).toThrow(/tier/);
    expect(normalizeJudgeRule({ rule: 'x', schema: { title: TITLE }, tier: 'balanced' }).tier).toBe('balanced');
    expect(() => normalizeJudgeRule({ rule: 'x', schema: { 'a.b': TITLE } })).toThrow(/field name/);
    expect(() => normalizeJudgeRule({ rule: 'x', schema: {} })).toThrow(/fields/);
    for (const name of ['__proto__', 'constructor', 'prototype']) {
      expect(() => normalizeJudgeRule({ rule: 'x', schema: JSON.parse(`{"${name}":{"type":"boolean"}}`) as Record<string, unknown> })).toThrow(/field name/);
    }
  });

  it('refuses a schema whose verdict could pass the byte cap', () => {
    const wide = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`f${String(i)}`, { type: 'string', maxLength: 2_000 }]));
    expect(() => normalizeJudgeRule({ rule: 'x', schema: wide })).toThrow(/larger/);
  });
});

describe('normalizeJudgeRule — a rule the owner confirms carries no character the owner does not see', () => {
  const ch = (cp: number): string => String.fromCodePoint(cp);
  // One per range of HIDDEN_CHARS, so taking any range out of the set fails a case here.
  const HIDDEN = [
    0x0001, 0x000b, 0x000c, 0x001b, 0x0085, 0x180e, 0x200b, 0x2028, 0x2029, 0x202e, 0x2062, 0x2067, 0x3164, 0xfeff, 0xfffb,
    0xe0041, 0xe0100,
  ];
  // What real text needs: ZWJ in an emoji sequence, ZWNJ, LRM, RLM, ALM, the soft hyphen, an
  // emoji's variation selector, tab, newline, carriage return.
  const KEPT = [0x200d, 0x200c, 0x200e, 0x200f, 0x061c, 0x00ad, 0xfe0f, 0x0009, 0x000a, 0x000d];

  for (const cp of HIDDEN) {
    it(`refuses U+${cp.toString(16).toUpperCase().padStart(4, '0')} in the rule and in an enum value`, () => {
      expect(() => normalizeJudgeRule({ rule: `Write a title.${ch(cp)} Then stop.`, schema: { title: TITLE } }))
        .toThrow(/judge\.rule holds a character a reader does not see .* at position 15\./);
      expect(() => normalizeJudgeRule({ rule: 'x', schema: { level: { type: 'string', enum: ['low', `hi${ch(cp)}gh`] } } }))
        .toThrow(/field level: an enum value holds a character a reader does not see/);
    });
  }

  it('takes the characters real text needs, in the rule and in an enum value', () => {
    const text = `Titel: Ü${KEPT.map(ch).join('')} 👩${ch(0x200d)}💻 ❤${ch(0xfe0f)}`;
    expect(normalizeJudgeRule({ rule: text, schema: { title: TITLE } }).rule).toBe(text);
    expect(normalizeJudgeRule({ rule: 'x', schema: { level: { type: 'string', enum: [text] } } }).schema.properties['level'])
      .toEqual({ type: 'string', enum: [text] });
  });
});

describe('judgeAfterBound — an upper bound in bytes, not a count of characters', () => {
  it('holds for the worst verdict: every character a 6-byte JSON escape', () => {
    const r = normalizeJudgeRule({ rule: 'x', schema: { t: { type: 'string', maxLength: 10 }, n: { type: 'number' }, b: { type: 'boolean' } } });
    const worst = { t: '\u0001'.repeat(10), n: -0.0000012345678901234567, b: false };
    expect(Buffer.byteLength(JSON.stringify(worst), 'utf8')).toBeLessThanOrEqual(judgeAfterBound(r.schema));
    // Several numbers, each the longest a double prints: the last field's spare comma does not
    // cover them all.
    const nums = normalizeJudgeRule({ rule: 'x', schema: { a: { type: 'number' }, b: { type: 'number' }, c: { type: 'number' } } });
    const longest = -0.0000012345678901234567;
    expect(Buffer.byteLength(JSON.stringify({ a: longest, b: longest, c: longest }), 'utf8')).toBeLessThanOrEqual(judgeAfterBound(nums.schema));
    // A 4-byte character holds too (one code point, two UTF-16 units).
    const emoji = { t: '🙂'.repeat(10), n: 0, b: true };
    expect(Buffer.byteLength(JSON.stringify(emoji), 'utf8')).toBeLessThanOrEqual(judgeAfterBound(r.schema));
  });

  it('counts an enum by its longest value', () => {
    const r = normalizeJudgeRule({ rule: 'x', schema: { level: { type: 'string', enum: ['a', 'abcdef'] } } });
    expect(Buffer.byteLength(JSON.stringify({ level: 'abcdef' }), 'utf8')).toBeLessThanOrEqual(judgeAfterBound(r.schema));
    expect(judgeAfterBound(r.schema)).toBeLessThan(40);
  });

  it('output tokens cover the bound up to the cap', () => {
    const r = normalizeJudgeRule({ rule: 'x', schema: { t: { type: 'string', maxLength: 500 } } });
    expect(judgeMaxOutputTokens(r.schema)).toBeGreaterThanOrEqual(judgeAfterBound(r.schema));
    expect(JUDGE_MAX_AFTER_BYTES).toBeGreaterThan(judgeAfterBound(r.schema));
  });
});
