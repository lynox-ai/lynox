/**
 * Unit tests — glossary apply step (both core + session paths).
 *
 * Covers the Phase 0 failure modes (Setup-Result → Setup Wizard, Started hier
 * → Starter Tier, etc.), word-boundary correctness with German diacritics,
 * case preservation, and the edit-distance / stop-list guard that keeps
 * session terms from rewriting ordinary words.
 */

import { describe, expect, it } from 'vitest';
import { CORE_GLOSSARY } from './core-terms.js';
import { applyGlossary, applySessionGlossary, DEFAULT_STOP_LIST } from './apply.js';

describe('applyGlossary (core)', () => {
  it('rewrites Phase 0 Setup-Result → Setup Wizard', () => {
    const input = 'Der Setup-Result muss fertig sein.';
    expect(applyGlossary(input, CORE_GLOSSARY)).toBe('Der Setup Wizard muss fertig sein.');
  });

  it('rewrites Phase 0 Started hier → Starter Tier (case-insensitive)', () => {
    const input = 'Die started hier ist okay.';
    expect(applyGlossary(input, CORE_GLOSSARY)).toBe('Die Starter Tier ist okay.');
  });

  it('rewrites Phase 0 Blockierer → Blocker', () => {
    expect(applyGlossary('Das ist ein Blockierer.', CORE_GLOSSARY))
      .toBe('Das ist ein Blocker.');
  });

  it('rewrites Phase 0 Go-Live spelling variants', () => {
    expect(applyGlossary('Das go life ist wichtig.', CORE_GLOSSARY))
      .toBe('Das Go-Live ist wichtig.');
  });

  it('leaves text unchanged when no variants match', () => {
    const input = 'Ich schicke dir morgen einen Bericht per Mail.';
    expect(applyGlossary(input, CORE_GLOSSARY)).toBe(input);
  });

  it('is a no-op on empty text', () => {
    expect(applyGlossary('', CORE_GLOSSARY)).toBe('');
  });

  it('is a no-op when glossary is empty', () => {
    expect(applyGlossary('beliebiger Text', [])).toBe('beliebiger Text');
  });

  it('respects word boundaries — does not rewrite inside a word', () => {
    // Contrived: "Stehging" is a variant of "Staging". A longer word that
    // *contains* the variant as a substring must NOT be rewritten.
    const terms = [{ canonical: 'Staging', variants: ['Stehging'] }];
    expect(applyGlossary('Stehgingdingens', terms)).toBe('Stehgingdingens');
    expect(applyGlossary('auf Stehging pushen', terms)).toBe('auf Staging pushen');
  });

  it('handles German diacritics at word boundaries (ä ö ü ß)', () => {
    const terms = [{ canonical: 'Müller', variants: ['Miller'] }];
    expect(applyGlossary('Herr Miller, äh, grüßt.', terms))
      .toBe('Herr Müller, äh, grüßt.');
    // Substring inside a word that has umlauts must still be boundary-safe
    expect(applyGlossary('Millerstraße', terms)).toBe('Millerstraße');
  });

  it('applies multiple terms in one pass', () => {
    const input = 'Setup-Result und started hier zusammen';
    expect(applyGlossary(input, CORE_GLOSSARY))
      .toBe('Setup Wizard und Starter Tier zusammen');
  });

  it('handles multi-word variants correctly', () => {
    const input = 'Customer Journee heute';
    expect(applyGlossary(input, CORE_GLOSSARY)).toBe('Customer Journey heute');
  });
});

describe('applySessionGlossary (fuzzy)', () => {
  it('rewrites a near-miss to the canonical contact name', () => {
    expect(applySessionGlossary('Roland hat geschrieben', ['Amanda']))
      .toBe('Roland hat geschrieben');
    // "Rolland" (extra l) should normalize to "Roland"
    expect(applySessionGlossary('Rolland hat geschrieben', ['Roland']))
      .toBe('Roland hat geschrieben');
  });

  it('preserves case at the start of the token', () => {
    // Source starts lowercase → replacement is lowercased.
    expect(applySessionGlossary('sprich mal mit rolland', ['Roland']))
      .toBe('sprich mal mit roland');
    // Source starts uppercase → replacement keeps canonical form.
    expect(applySessionGlossary('Sprich mal mit Rolland', ['Roland']))
      .toBe('Sprich mal mit Roland');
  });

  it('does NOT rewrite common-language words that look close to a term', () => {
    // "rund" is in the default stop list and must survive even when
    // "Ron" (edit distance 2) is a session term.
    expect(applySessionGlossary('das ist rund um die uhr', ['Ron']))
      .toBe('das ist rund um die uhr');
  });

  it('honors a custom stop list', () => {
    const customStop = new Set(['staging']);
    expect(applySessionGlossary('auf staging deployen', ['Statin'], { stopList: customStop }))
      .toBe('auf staging deployen');
  });

  it('leaves short tokens untouched (below minTokenLength)', () => {
    expect(applySessionGlossary('ab cd', ['Abc'], { minTokenLength: 4 }))
      .toBe('ab cd');
  });

  it('rewrites exact-match tokens to canonical casing', () => {
    // "roland" exactly matches the session term (after lowercasing) and
    // should be normalized to the term's original form.
    expect(applySessionGlossary('der roland ruft an', ['Roland']))
      .toBe('der Roland ruft an');
  });

  it('does not rewrite when the edit distance exceeds the cap', () => {
    // "Kalle" → "Roland" is edit distance 5, well above default 2.
    expect(applySessionGlossary('Kalle ruft an', ['Roland']))
      .toBe('Kalle ruft an');
  });

  it('does not rewrite when distance >= half the token length (noise guard)', () => {
    // "abc" → "xyz" distance 3, token length 3, would otherwise be within maxDist=3
    // but the half-length guard (3 >= ceil(3/2)=2) blocks this to avoid turning
    // tiny tokens into unrelated terms.
    expect(applySessionGlossary('abcd efgh', ['xyzd'], { maxEditDistance: 3, minTokenLength: 3 }))
      .toBe('abcd efgh');
  });

  it('is a no-op on empty text or empty terms', () => {
    expect(applySessionGlossary('', ['Roland'])).toBe('');
    expect(applySessionGlossary('text', [])).toBe('text');
  });

  it('picks the closest match when multiple terms are near', () => {
    // "Rolanda" is distance 1 to "Roland" and 3 to "Romana". Should pick Roland.
    expect(applySessionGlossary('Rolanda ruft an', ['Romana', 'Roland']))
      .toBe('Roland ruft an');
  });

  it('DEFAULT_STOP_LIST covers common German and English words', () => {
    expect(DEFAULT_STOP_LIST.has('rund')).toBe(true);
    expect(DEFAULT_STOP_LIST.has('und')).toBe(true);
    expect(DEFAULT_STOP_LIST.has('the')).toBe(true);
    expect(DEFAULT_STOP_LIST.has('with')).toBe(true);
  });
});
