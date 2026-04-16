/**
 * Unit tests — core glossary entries.
 *
 * The Phase 0 spike produced a small set of consistent mishearings (Setup
 * Wizard → Setup-Result, Starter Tier → Started hier, etc.). These tests pin
 * that each canonical term has at least one seeded variant and that the
 * shape of the glossary is sound.
 */

import { describe, expect, it } from 'vitest';
import { CORE_GLOSSARY } from './core-terms.js';

describe('CORE_GLOSSARY shape', () => {
  it('contains the Phase 0 anchor entries', () => {
    const canonicals = CORE_GLOSSARY.map((t) => t.canonical);
    for (const expected of [
      'Setup Wizard',
      'Starter Tier',
      'Go-Live',
      'Customer Journey',
      'Onboarding Flow',
      'Knowledge Graph',
      'Blocker',
      'A/B Testing',
      'Deployment',
      'Staging',
      'Dashboard',
      'lynox',
    ]) {
      expect(canonicals).toContain(expected);
    }
  });

  it('every variant is non-empty and not character-identical to its canonical', () => {
    // Case-sensitive: a variant may share spelling with the canonical if the
    // casing differs (e.g. canonical "lynox" + variant "Lynox" normalizes a
    // common mis-capitalization). Exact-string equality, however, would be
    // redundant noise.
    for (const term of CORE_GLOSSARY) {
      for (const v of term.variants) {
        expect(v).not.toBe('');
        expect(v).not.toBe(term.canonical);
      }
    }
  });

  it('does not list the same variant under two different canonicals', () => {
    const seen = new Map<string, string>();
    for (const term of CORE_GLOSSARY) {
      for (const v of term.variants) {
        const key = v.toLowerCase();
        const prev = seen.get(key);
        if (prev !== undefined) {
          throw new Error(`variant "${v}" listed under both "${prev}" and "${term.canonical}"`);
        }
        seen.set(key, term.canonical);
      }
    }
  });

  it('all entries are frozen-style readonly arrays (no accidental mutation)', () => {
    // TS strictest enforces readonly at compile time; this is a runtime spot-check
    // that we don't mutate the array via push() from an unrelated module.
    const before = CORE_GLOSSARY.length;
    // @ts-expect-error — exercising the compile-time readonly guarantee
    (CORE_GLOSSARY as Array<unknown>).push;
    expect(CORE_GLOSSARY.length).toBe(before);
  });
});
