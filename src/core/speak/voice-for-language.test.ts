import { describe, it, expect } from 'vitest';
import { isVoiceLanguageTag, pickVoiceForLanguage } from './voice-for-language.js';
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
  { id: 'aaa_no_language' },
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

  it('PREFERS the provider default when it speaks the language, so nobody\'s voice changes', () => {
    // ⚠⚠ The regression this parameter exists for, measured on the LIVE catalogue shape:
    // 8 `en_us_*` + 16 `en_gb_*`, where "first by id" is a BRITISH voice. Sorting alone was
    // deterministic AND wrong — an English user who had the curated default silently started
    // getting `en_gb_…`. Determinism was what this function needed; not changing anybody's
    // voice unless their language demands it is what the FEATURE needed.
    const live = [
      ...Array.from({ length: 8 }, (_, i) => ({ id: `en_us_voice${String(i)}`, language: 'en' })),
      ...Array.from({ length: 16 }, (_, i) => ({ id: `en_gb_voice${String(i)}`, language: 'en' })),
      { id: 'en_paul_neutral', language: 'en' },
    ];
    expect(pickVoiceForLanguage(live, 'en', 'en_paul_neutral').voice).toBe('en_paul_neutral');
    // Without the preference it is the alphabetically first — the behaviour that was wrong.
    expect(pickVoiceForLanguage(live, 'en').voice).toBe('en_gb_voice0');
    // A preference that does NOT speak the language must not win.
    expect(pickVoiceForLanguage(live, 'en', 'fr_marie_neutral').voice).toBe('en_gb_voice0');
    // And it must not invent a match where the language has none.
    expect(pickVoiceForLanguage(live, 'de', 'en_paul_neutral').matched).toBe(false);
  });

  it('matches on the language HEAD, so a region subtag finds the catalogue entry', () => {
    // The catalogue normalises `en_us` → `en`; a caller passing its UI locale sends
    // `en_GB`. Both have to land on the same voices or the feature is locale-brittle.
    expect(pickVoiceForLanguage(catalogue, 'en_GB').voice).toBe('en_gb_alice');
    expect(pickVoiceForLanguage(catalogue, 'en-gb').voice).toBe('en_gb_alice');
    expect(pickVoiceForLanguage(catalogue, 'EN').voice).toBe('en_gb_alice');
  });

  it('matches on the CATALOGUE side head too, which the test above cannot show', () => {
    // ⚠ This half had no witness, and a mutant proved it: comparing the catalogue's tag
    // WHOLE instead of by its head passed every test in this file, because every language in
    // the fixture is already a bare head — which is what the Mistral parser produces
    // (`fr_fr` → `fr`). `VoiceInfo.language` is a contract, not a Mistral field, so a
    // provider reporting `de-AT` is exactly what this side of the comparison is for. The test
    // above cannot see it: it varies the REQUEST and holds the catalogue fixed.
    const regional: VoiceInfo[] = [{ id: 'de_at_hans', language: 'de-AT' }];
    const choice = pickVoiceForLanguage(regional, 'de');
    expect(choice.voice).toBe('de_at_hans');
    expect(choice.candidates).toBe(1);
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
    // ⚠ The fixture id is `aaa_no_language` and the `aaa_` prefix is load-bearing: it has
    // to sort BEFORE every `en_*` id, so that an entry slipping past the language filter
    // would WIN the pick and this assertion could fail. The first version used
    // `no_language_at_all`, which sorts AFTER `en_gb_alice` — measured — so the
    // `.not.toBe(...)` below could never fail and the comment claiming otherwise was
    // wrong. A fixture that cannot produce the failure it guards against is decoration.
    expect(pickVoiceForLanguage(catalogue, 'en').voice).not.toBe('aaa_no_language');
    expect(pickVoiceForLanguage([{ id: 'x' }], 'en').matched).toBe(false);
  });

  it('accepts the shape bounds exactly, and nothing wider', () => {
    // The bounds are the claimed defence against a long or forged value, and widening
    // `{2,3}` to `{2,30}` or the region to `{2,40}` survived every other test.
    for (const ok of ['de', 'gsw', 'de_ch', 'en-gb', 'zh_hant']) {
      expect(isVoiceLanguageTag(ok), `must accept ${ok}`).toBe(true);
    }
    for (const no of ['d', 'abcd', 'de_', 'de_abcde', 'deu_latn_ch', 'auto', 'AUTO']) {
      expect(isVoiceLanguageTag(no), `must reject ${no}`).toBe(false);
    }
  });

  it('refuses a non-string even when it would STRINGIFY to an accepted tag', () => {
    // ⚠ A survivor's witness, and the reason is simpler than the first version of this
    // comment claimed: before this test, NO test passed a non-string to this predicate at
    // all. The accept and reject lists above are strings throughout.
    //
    // The HTTP route cannot supply one either, and that is why the gap sat here unseen: it
    // narrows `lang` with `typeof b['lang'] === 'string'` before calling, so the route's own
    // `42` case arrives here as `undefined`, never as a number. The guarantee belongs to the
    // function because the function is what other callers hold, and its signature claims
    // `value is string` for an `unknown` argument.
    //
    // Both inputs below stringify to something the pattern ACCEPTS — that is what makes
    // them discriminating. `42` would not be: `'42'` fails the pattern either way.
    expect(isVoiceLanguageTag(['de'])).toBe(false);
    expect(isVoiceLanguageTag({ toString: () => 'de' })).toBe(false);
  });

  it('is stable: the same catalogue in a different order gives the same voice', () => {
    const shuffled = [...catalogue].reverse();
    expect(pickVoiceForLanguage(shuffled, 'en').voice).toBe(
      pickVoiceForLanguage(catalogue, 'en').voice,
    );
  });
});
