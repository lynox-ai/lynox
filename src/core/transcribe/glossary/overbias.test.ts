/**
 * Regression tests — STT glossary over-biasing.
 *
 * Bug: the fuzzy session-glossary post-process rewrote ordinary spoken words
 * into proper nouns from the user's context — "bitte" → "Britta" (a contact),
 * "wollen" → "Olten" (a Knowledge-Graph place label). The STT API itself never
 * got these hints; the corruption was entirely app-side post-processing.
 *
 * Fix has three parts, all exercised here:
 *   1. Tighter fuzzy match — maxEditDistance 1 + a stricter ratio guard.
 *   2. A curated ~450-word DE/EN stop list so common words are never rewritten.
 *   3. KG entity labels dropped from the voice session glossary entirely.
 *
 * Genuine corrections (a contact name spoken with a small mishearing, a static
 * product term) must still resolve — covered at the end.
 */

import { describe, expect, it } from 'vitest';
import { applyGlossary, applySessionGlossary } from './apply.js';
import { buildSessionGlossary } from './session-builder.js';
import { CORE_GLOSSARY } from './core-terms.js';

describe('STT glossary over-biasing regression', () => {
  it('does not rewrite common words to a contact name or place', () => {
    // Session as the bug reproduced it: "Britta" a contact, "Olten" /
    // "Maunawai" KG places that used to leak into the glossary.
    const sessionTerms = buildSessionGlossary({
      contactNames: ['Britta'],
      // KG labels are no longer a buildSessionGlossary source; even if a caller
      // tried to sneak them in via another field, the stop list still protects
      // the common words below.
      workflowNames: ['Olten', 'Maunawai'],
    });

    const transcript = 'bitte wollen wir das haben';
    expect(applySessionGlossary(transcript, sessionTerms)).toBe(transcript);
  });

  it('leaves "ich gehe gerne" unchanged', () => {
    const sessionTerms = buildSessionGlossary({
      contactNames: ['Gerda'], // edit distance 2 to "gerne" — must not trigger
    });
    expect(applySessionGlossary('ich gehe gerne', sessionTerms)).toBe('ich gehe gerne');
  });

  it('protects the exact words from the bug report regardless of session', () => {
    // "bitte" ~ "Britta" (distance 1), "wollen" ~ "Olten" (distance 2).
    expect(applySessionGlossary('bitte', ['Britta'])).toBe('bitte');
    expect(applySessionGlossary('wollen', ['Olten'])).toBe('wollen');
    expect(applySessionGlossary('haben', ['Hagen'])).toBe('haben');
    expect(applySessionGlossary('gerne', ['Berne'])).toBe('gerne');
  });

  it('drops KG entity labels from the built session glossary', () => {
    // buildSessionGlossary no longer accepts a kgEntityLabels source. A caller
    // passing only contacts + APIs gets exactly those — no place names.
    const terms = buildSessionGlossary({
      contactNames: ['Roland'],
      apiProfileNames: ['Stripe'],
    });
    expect(terms).toContain('Roland');
    expect(terms).toContain('Stripe');
    expect(terms).not.toContain('Olten');
    expect(terms).not.toContain('Maunawai');
  });

  it('still rewrites a genuine near-miss of a session contact name', () => {
    // "Rolland" (extra l, distance 1) is a real mishearing of the contact
    // "Roland" — this correction must survive the tightened matcher.
    const sessionTerms = buildSessionGlossary({ contactNames: ['Roland'] });
    expect(applySessionGlossary('sprich mit Rolland', sessionTerms))
      .toBe('sprich mit Roland');
  });

  it('still resolves a session term that appears verbatim', () => {
    // Exact-match path: a workflow name spoken as-is normalizes to its canonical
    // casing and is never dropped.
    const sessionTerms = buildSessionGlossary({ workflowNames: ['Hetzner'] });
    expect(applySessionGlossary('deploy auf hetzner', sessionTerms))
      .toBe('deploy auf Hetzner');
  });

  it('keeps the static core product-term corrections working', () => {
    // The core glossary path is unchanged — unconditional product-term fixes
    // must not regress.
    expect(applyGlossary('Der Setup-Result ist fertig.', CORE_GLOSSARY))
      .toBe('Der Setup Wizard ist fertig.');
    expect(applyGlossary('Das ist ein Blockierer.', CORE_GLOSSARY))
      .toBe('Das ist ein Blocker.');
  });
});
