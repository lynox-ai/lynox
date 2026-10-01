import { describe, it, expect } from 'vitest';
import { isWildcardDomain } from './tool-context.js';

describe('isWildcardDomain', () => {
  it('accepts a domain with one or more non-empty labels', () => {
    expect(isWildcardDomain('example.com')).toBe(true);
    expect(isWildcardDomain('cdn.example.com')).toBe(true);
    expect(isWildcardDomain('internal')).toBe(true);
  });

  it('rejects an empty domain, an empty label, a further wildcard or whitespace', () => {
    expect(isWildcardDomain('')).toBe(false);
    expect(isWildcardDomain('.')).toBe(false);
    expect(isWildcardDomain('.example.com')).toBe(false);
    expect(isWildcardDomain('example.com.')).toBe(false);
    expect(isWildcardDomain('example..com')).toBe(false);
    expect(isWildcardDomain('*.example.com')).toBe(false);
    expect(isWildcardDomain('a*.example.com')).toBe(false);
    expect(isWildcardDomain('example .com')).toBe(false);
  });
});
