import type { VoiceInfo } from './types.js';

/**
 * The outcome of asking the catalogue for a voice in a given language.
 *
 * `matched: false` is not an error and not a defect — it is the state the product
 * is in today for German, because the provider has no German voice at all. The
 * caller falls back to the provider's default voice, which is exactly what happens
 * now, and says so.
 */
export interface VoiceChoice {
  /** The chosen voice id, or `undefined` when the catalogue has none for this language. */
  readonly voice: string | undefined;
  readonly matched: boolean;
  /** Voices in the catalogue that carry this language; 0 when `matched` is false. */
  readonly candidates: number;
}

/**
 * Pick a voice for `language` from `voices`, deterministically.
 *
 * ⚠ THE RULE IS "FIRST BY ID", NOT "FIRST IN THE CATALOGUE", and the difference is
 * the whole reason this function sorts. The catalogue arrives in whatever order the
 * provider sent it: `listMistralVoices` pushes entries as they arrive, nothing in
 * the fetch sorts, and no provider document promises an ordering. Whether that order
 * is stable between two calls is **not observable from here** — checking it would
 * mean live calls against someone else's service — so the rule does not depend on it.
 * Sorting by id makes "which of the sixteen `en_gb` voices" answerable from the
 * catalogue's CONTENT instead of from its arrival sequence.
 *
 * An unstable choice would be a surface that changes between two requests with the
 * same input, which is worse than a choice somebody disagrees with.
 */
export function pickVoiceForLanguage(
  voices: readonly VoiceInfo[],
  language: string,
): VoiceChoice {
  const wanted = language.trim().toLowerCase();
  if (!wanted) return { voice: undefined, matched: false, candidates: 0 };
  // The catalogue normalises `en_us` → `en`, so compare on the same granularity:
  // a request for `en` must match `en`, and a request for `en_us` must still find it.
  const head = (tag: string): string => tag.split(/[-_]/)[0] ?? tag;
  const target = head(wanted);
  const matches = voices
    .filter((v) => v.language !== undefined && head(v.language.toLowerCase()) === target)
    .map((v) => v.id)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const first = matches[0];
  if (first === undefined) return { voice: undefined, matched: false, candidates: 0 };
  return { voice: first, matched: true, candidates: matches.length };
}
