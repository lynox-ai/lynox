import { describe, it, expect } from 'vitest';
import { isShortClarification } from './short-input-heuristic.js';

describe('isShortClarification', () => {
  it.each([
    ['bexio', true],
    ['ok', true],
    ['ja', true],
    ['yes please', true],
    ['go on', true],
    ['', true],
    ['   ', true],
  ])('treats short follow-up %j as clarification', (input, expected) => {
    expect(isShortClarification(input)).toBe(expected);
  });

  it.each([
    ['Was kostet bexio im Jahr?', false],
    ['Kannst du die bexio API nutzen?', false],
    ['the bexio API', false],                 // 3 words → real query
    ['twenty-one-chars-long!', false],        // 21 chars → over ceiling
    ['a'.repeat(21), false],                  // exactly 21 chars
  ])('treats longer input %j as real query', (input, expected) => {
    expect(isShortClarification(input)).toBe(expected);
  });

  it('counts hyphenated words as one', () => {
    // 2 words, 16 chars — at the boundary but still counts as short.
    expect(isShortClarification('well-designed ok')).toBe(true);
  });
});
