import { describe, it, expect } from 'vitest';
import { pickVoiceForLanguage } from './voice-for-language.js';
import type { VoiceInfo } from './types.js';

/**
 * ⚠ The fixture's ARRIVAL ORDER is deliberately the reverse of its id order, because
 * that is the only way to tell "first by id" from "first in the catalogue". A fixture
 * where both orders agree cannot see the difference, and the difference is the entire
 * reason the picker sorts: the catalogue arrives in whatever order the provider sent,
 * and nothing promises that is stable between two calls.
 */
const catalogue: VoiceInfo[] = [
  { id: 'en_gb_zoe', language: 'en' },
  { id: 'en_gb_mike', language: 'en' },
  { id: 'en_gb_alice', language: 'en' },
  { id: 'fr_marie_neutral', language: 'fr' },
  { id: 'fr_marie_calm', language: 'fr' },
  { id: 'no_language_at_all' },
];

describe('a voice is picked deterministically, from the catalogue content', () => {
  it('takes the first by ID, not the first that arrived', () => {
    const choice = pickVoiceForLanguage(catalogue, 'en');
    // `en_gb_zoe` arrived first; `en_gb_alice` sorts first. If this ever reads
    // `en_gb_zoe`, the rule has become "whatever the provider happened to send".
    expect(choice.voice).toBe('en_gb_alice');
    expect(choice.matched).toBe(true);
    expect(choice.candidates).toBe(3);
  });

  it('matches on the language HEAD, so a region subtag finds the catalogue entry', () => {
    // The catalogue normalises `en_us` → `en`; a caller passing its UI locale sends
    // `en_GB`. Both have to land on the same voices or the feature is locale-brittle.
    expect(pickVoiceForLanguage(catalogue, 'en_GB').voice).toBe('en_gb_alice');
    expect(pickVoiceForLanguage(catalogue, 'en-gb').voice).toBe('en_gb_alice');
    expect(pickVoiceForLanguage(catalogue, 'EN').voice).toBe('en_gb_alice');
  });

  it('finds the French voices this fix made reachable', () => {
    // The point of the catalogue repair: before it, no `fr_*` voice was in the list at
    // all, so this request could not have been answered.
    const choice = pickVoiceForLanguage(catalogue, 'fr');
    expect(choice.voice).toBe('fr_marie_calm');
    expect(choice.candidates).toBe(2);
  });

  it('reports NO MATCH for a language the catalogue does not have, without throwing', () => {
    // This is the German case, every time, and it is a state rather than an error.
    const choice = pickVoiceForLanguage(catalogue, 'de');
    expect(choice.matched).toBe(false);
    expect(choice.voice).toBeUndefined();
    expect(choice.candidates).toBe(0);
  });

  it('treats an empty or blank language as no selection, not as a match on everything', () => {
    for (const blank of ['', '   ', '\t']) {
      const choice = pickVoiceForLanguage(catalogue, blank);
      expect(choice.matched, `blank ${JSON.stringify(blank)} must not match`).toBe(false);
      expect(choice.voice).toBeUndefined();
    }
  });

  it('a blank request does not match a voice whose language is itself blank', () => {
    // ⚠ This case exists because a mutation showed the early return for a blank request
    // SURVIVING: for every language the Mistral parser can produce it is redundant with
    // the filter below it (`head('')` matches no real tag). The one input that tells the
    // two apart is a voice carrying an empty language — which that parser never emits
    // (`rawLang ? … : undefined`), but another provider's catalogue could. Without this,
    // the guard is a line no test can justify; with it, the guard has a reason.
    const withBlank: VoiceInfo[] = [{ id: 'mystery', language: '' }, ...catalogue];
    expect(pickVoiceForLanguage(withBlank, '').matched).toBe(false);
    expect(pickVoiceForLanguage(withBlank, '  ').voice).toBeUndefined();
    // And a real request still finds a real voice past it.
    expect(pickVoiceForLanguage(withBlank, 'fr').voice).toBe('fr_marie_calm');
  });

  it('skips entries with no language instead of counting them as candidates', () => {
    // `no_language_at_all` sorts before every `en_*` id. If the filter ever lets an
    // entry without a language through, it would win — so this is the assertion that
    // separates "filtered" from "sorted".
    expect(pickVoiceForLanguage(catalogue, 'en').voice).not.toBe('no_language_at_all');
    expect(pickVoiceForLanguage([{ id: 'x' }], 'en').matched).toBe(false);
  });

  it('is stable: the same catalogue in a different order gives the same voice', () => {
    const shuffled = [...catalogue].reverse();
    expect(pickVoiceForLanguage(shuffled, 'en').voice).toBe(
      pickVoiceForLanguage(catalogue, 'en').voice,
    );
  });
});
