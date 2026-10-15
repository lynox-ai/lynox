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
  });

  it('refuses a schema whose verdict could pass the byte cap', () => {
    const wide = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`f${String(i)}`, { type: 'string', maxLength: 2_000 }]));
    expect(() => normalizeJudgeRule({ rule: 'x', schema: wide })).toThrow(/larger/);
  });
});

describe('judgeAfterBound — an upper bound in bytes, not a count of characters', () => {
  it('holds for the worst verdict: every character a 6-byte JSON escape', () => {
    const r = normalizeJudgeRule({ rule: 'x', schema: { t: { type: 'string', maxLength: 10 }, n: { type: 'number' }, b: { type: 'boolean' } } });
    const worst = { t: '\u0001'.repeat(10), n: -1.7976931348623157e308, b: false };
    expect(Buffer.byteLength(JSON.stringify(worst), 'utf8')).toBeLessThanOrEqual(judgeAfterBound(r.schema));
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
