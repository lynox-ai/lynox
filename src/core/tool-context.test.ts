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

  it('rejects a domain whose last label is all digits, and accepts digits elsewhere', () => {
    expect(isWildcardDomain('4')).toBe(false);
    expect(isWildcardDomain('3.4')).toBe(false);
    expect(isWildcardDomain('1.2.3.4')).toBe(false);
    expect(isWildcardDomain('123.example.com')).toBe(true);
    expect(isWildcardDomain('example.c0m')).toBe(true);
  });
});
