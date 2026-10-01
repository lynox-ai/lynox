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
/**
 * The accepted shape of a voice-language tag: 2-3 letters, optionally a separator and a
 * 2-4 character region subtag. At most 8 characters, exactly `[A-Za-z0-9_-]`.
 *
 * ⚠⚠ THIS LIVES HERE, NOT ONLY IN THE HTTP ROUTE, and that placement is the finding it
 * came from. The rule was originally a single `if` in `POST /api/speak`, and everything
 * that made the value safe — no newline so it cannot forge a log line, no quote so it
 * cannot escape its own quoting in a diagnostic, no ESC so it cannot drive an operator's
 * terminal, no bidi override, bounded length — rested on that one call site. The sink
 * applied nothing: no length cap, no charset check, no runtime type guard. A second
 * caller would not have had to be careless, only unaware that one route was carrying the
 * guarantee for the whole module. A rule that must be re-obeyed per call site is the
 * wrong rule.
 *
 * ⚠ Case-INsensitive by `/i`, and the `'auto'` rejection below is case-insensitive to
 * match. The first version paired a case-SENSITIVE `!== 'auto'` with this
 * case-insensitive pattern and claimed to defend a future widening to four letters —
 * measured, after that widening `AUTO` and `aUtO` would both have passed while `auto`
 * was blocked. A half-present protection described as whole is worse than none.
 */
const VOICE_LANGUAGE_TAG = /^[a-z]{2,3}([_-][a-z0-9]{2,4})?$/i;

/**
 * Is this a value the catalogue comparison and the diagnostic can safely receive?
 * `'auto'` is excluded here rather than at the caller: for text preparation it means
 * "detect from the text", and it is not a language the catalogue can hold.
 */
export function isVoiceLanguageTag(value: unknown): value is string {
  return typeof value === 'string' && value.toLowerCase() !== 'auto' && VOICE_LANGUAGE_TAG.test(value);
}

export function pickVoiceForLanguage(
  voices: readonly VoiceInfo[],
  language: string,
  preferred?: string | undefined,
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
  // ⚠ The caller's PREFERRED voice wins when it speaks this language, and "first by
  // id" is only the tie-break. Sorting alone was deterministic and wrong: with the
  // live catalogue (8 `en_us_*`, 16 `en_gb_*`) the first id is a British voice, so
  // selecting by language silently changed which voice every English user hears.
  // Determinism was the property this function needed; changing nobody's voice
  // unless their language demands it is the property the FEATURE needed.
  if (preferred !== undefined && matches.includes(preferred)) {
    return { voice: preferred, matched: true, candidates: matches.length };
  }
  return { voice: first, matched: true, candidates: matches.length };
}
