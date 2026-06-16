import { describe, it, expect } from 'vitest';
import { sanitizeLLMTitle } from './session.js';

describe('sanitizeLLMTitle', () => {
  it('passes a clean title through unchanged', () => {
    expect(sanitizeLLMTitle('Quarterly Budget Review')).toBe('Quarterly Budget Review');
  });

  it('strips wrapping double and single quotes', () => {
    expect(sanitizeLLMTitle('"Quarterly Budget Review"')).toBe('Quarterly Budget Review');
    expect(sanitizeLLMTitle("'Hello World'")).toBe('Hello World');
  });

  it('strips trailing punctuation and whitespace', () => {
    expect(sanitizeLLMTitle('Deploy the Release.')).toBe('Deploy the Release');
    expect(sanitizeLLMTitle('  Trimmed Title  ')).toBe('Trimmed Title');
  });

  it('keeps only the first line', () => {
    expect(sanitizeLLMTitle('Database Migration\nSome stray model commentary')).toBe('Database Migration');
  });

  it('preserves internal punctuation', () => {
    expect(sanitizeLLMTitle('"Auth, Billing & Webhooks"')).toBe('Auth, Billing & Webhooks');
  });

  it('caps overlong titles at 80 chars with an ellipsis', () => {
    const result = sanitizeLLMTitle('a'.repeat(120));
    expect(result.length).toBe(80);
    expect(result.endsWith('...')).toBe(true);
  });

  it('returns empty string when nothing usable remains', () => {
    expect(sanitizeLLMTitle('')).toBe('');
    expect(sanitizeLLMTitle('   ')).toBe('');
    expect(sanitizeLLMTitle('""')).toBe('');
  });
});
