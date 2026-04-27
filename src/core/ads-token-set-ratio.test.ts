import { describe, it, expect } from 'vitest';
import { tokenise, tokenSetRatio } from './ads-token-set-ratio.js';

describe('tokenise', () => {
  it('splits on non-alphanumerics and lowercases', () => {
    expect(tokenise('DE-Search-Brand-Exact')).toEqual(['de', 'search', 'brand', 'exact']);
    expect(tokenise('Search_Brand_DE')).toEqual(['search', 'brand', 'de']);
    expect(tokenise('foo bar  baz')).toEqual(['foo', 'bar', 'baz']);
  });

  it('discards empty tokens', () => {
    expect(tokenise('---a-b---')).toEqual(['a', 'b']);
    expect(tokenise('')).toEqual([]);
  });

  it('keeps numbers as part of tokens', () => {
    expect(tokenise('Q1-2026-Brand')).toEqual(['q1', '2026', 'brand']);
  });
});

describe('tokenSetRatio', () => {
  it('returns 1.0 for identical token sets regardless of order/separator/case', () => {
    expect(tokenSetRatio('Search_Brand_DE', 'DE-Search-Brand')).toBe(1);
    expect(tokenSetRatio('search brand de', 'SEARCH BRAND DE')).toBe(1);
  });

  it('returns 1.0 for repeated tokens (set semantics)', () => {
    expect(tokenSetRatio('Brand Brand Brand', 'Brand')).toBe(1);
  });

  it('returns Jaccard ratio for partial overlap', () => {
    // {search, brand, old} vs {search, brand, new}
    // intersection = {search, brand} = 2; union = 4 → 0.5
    expect(tokenSetRatio('Search_Brand_Old', 'Search_Brand_New')).toBeCloseTo(0.5, 6);
  });

  it('returns 0 for disjoint token sets', () => {
    expect(tokenSetRatio('foo bar', 'baz qux')).toBe(0);
  });

  it('returns NaN when both inputs tokenise to empty', () => {
    expect(Number.isNaN(tokenSetRatio('---', '..._.'))).toBe(true);
  });

  it('is symmetric', () => {
    const a = 'DE-Search-Brand-Exact';
    const b = 'EN-Search-Brand-Phrase';
    expect(tokenSetRatio(a, b)).toBe(tokenSetRatio(b, a));
  });

  it('passes 0.8 threshold for typical rename patterns', () => {
    // Rename: separator change only → 1.0
    expect(tokenSetRatio('Search_Brand_DE_Exact', 'Search-Brand-DE-Exact')).toBe(1);
    // Rename: token reorder → 1.0
    expect(tokenSetRatio('DE-Search-Brand-Exact', 'Search-DE-Brand-Exact')).toBe(1);
    // Rename: one token swap (e.g. region added)
    // {search, brand, de, exact} vs {search, brand, de, ch, exact}
    // intersection 4, union 5 → 0.8
    expect(tokenSetRatio('Search-Brand-DE-Exact', 'Search-Brand-DE-CH-Exact')).toBeCloseTo(0.8, 6);
  });

  it('falls below 0.8 for substantial renames', () => {
    expect(tokenSetRatio('Search_Brand_Old_Q1', 'Search_Generic_New_Q2')).toBeLessThan(0.8);
  });
});
