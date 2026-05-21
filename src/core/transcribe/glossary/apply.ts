/**
 * Deterministic glossary post-process.
 *
 * Two paths:
 *   - applyGlossary(text, terms): substring-based, case-insensitive, word-boundary
 *     safe. Used by the core glossary — each variant is a known mishearing so
 *     the rewrite is unconditional. Unicode-aware word boundaries (German ä/ö/ü/ß
 *     need this — \b is ASCII-only in JavaScript regex without the u flag).
 *   - applySessionGlossary(text, terms, stopList): fuzzy. Scans word tokens and
 *     rewrites ones within edit-distance 1 of a session term, *if* the candidate
 *     isn't a common-language token. The tight distance + a curated stop list of
 *     ~450 high-frequency DE/EN words keep ordinary speech from being rewritten
 *     into proper nouns ("bitte" → "Britta", "wollen" → "Olten").
 *
 * Pure functions — no I/O, no state. O(n·m) where n = tokens and m = terms.
 */

import type { GlossaryTerm } from './core-terms.js';
import { STOP_WORDS } from './stop-words.js';

/** Pattern quoting — keep anchors / metacharacters literal inside RegExp. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Replace all case-insensitive, word-bounded matches of `variants` with `canonical`. */
export function applyGlossary(text: string, terms: readonly GlossaryTerm[]): string {
  if (!text || terms.length === 0) return text;
  let out = text;
  for (const term of terms) {
    for (const variant of term.variants) {
      if (!variant) continue;
      // Unicode-aware word boundaries: require non-letter/digit on either side.
      // \b is ASCII-only; \p{L}/\p{N} with the u flag cover ä ö ü ß é — and
      // they behave correctly at string edges (the negative lookaround is
      // vacuously true there).
      const pattern = new RegExp(
        `(?<![\\p{L}\\p{N}])${escapeRegex(variant)}(?![\\p{L}\\p{N}])`,
        'giu',
      );
      out = out.replace(pattern, term.canonical);
    }
  }
  return out;
}

// ── Session glossary (fuzzy) ────────────────────────────────────────────────

/**
 * Tokens we refuse to rewrite even if they look close to a session term.
 *
 * Backed by the curated `STOP_WORDS` list (~450 high-frequency DE + EN words:
 * function words, modal + auxiliary verbs, common lexical verbs and nouns,
 * numerals, politeness words). Any word here is NEVER rewritten — this is the
 * primary guard against the STT post-process turning ordinary speech into
 * proper nouns from the user's context. Stored lowercase.
 *
 * Re-exported under the historical name for back-compat with existing callers.
 */
export const DEFAULT_STOP_LIST: ReadonlySet<string> = STOP_WORDS;

/** Levenshtein edit distance between two strings (lowercased). */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const prev = new Array<number>(n + 1);
  const curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (curr[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + cost,
      );
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j] ?? 0;
  }
  return prev[n] ?? 0;
}

export interface SessionApplyOptions {
  /** Max Levenshtein distance between a token and a session term to trigger rewrite. Default 1. */
  readonly maxEditDistance?: number;
  /** Minimum token length before the fuzzy path runs (shorter words are ambiguous). Default 4. */
  readonly minTokenLength?: number;
  /** Tokens to never rewrite (lowercased). Defaults to DEFAULT_STOP_LIST. */
  readonly stopList?: ReadonlySet<string>;
}

/**
 * Rewrite tokens in `text` that are within edit-distance of a session term.
 *
 * - Case-preserving: if the input token is capitalized, the term keeps its form.
 * - Skips tokens in the stop list.
 * - Skips tokens shorter than `minTokenLength` (too many false positives).
 * - Never rewrites a token that already matches any session term exactly.
 * - When multiple session terms tie for closest distance, the first wins
 *   (session terms are provided in priority order by the builder).
 */
export function applySessionGlossary(
  text: string,
  sessionTerms: readonly string[],
  opts: SessionApplyOptions = {},
): string {
  if (!text || sessionTerms.length === 0) return text;

  const maxDist = opts.maxEditDistance ?? 1;
  const minLen = opts.minTokenLength ?? 4;
  const stopList = opts.stopList ?? DEFAULT_STOP_LIST;

  const exactLower = new Set(sessionTerms.map((t) => t.toLowerCase()));
  const termsByLower = new Map<string, string>();
  for (const term of sessionTerms) {
    const key = term.toLowerCase();
    if (!termsByLower.has(key)) termsByLower.set(key, term);
  }

  // Split on whitespace + simple punctuation; capture delimiters so we can rejoin.
  return text.replace(/([\p{L}\p{N}’'-]+)/gu, (token) => {
    if (token.length < minLen) return token;
    const lower = token.toLowerCase();
    if (stopList.has(lower)) return token;
    if (exactLower.has(lower)) {
      // Already matches a term — normalize casing to the term's canonical form.
      const term = termsByLower.get(lower);
      return term ?? token;
    }

    let best: { term: string; dist: number } | null = null;
    for (const term of sessionTerms) {
      const dist = editDistance(lower, term.toLowerCase());
      if (dist > maxDist) continue;
      // Don't rewrite when the edit touches a third or more of the token —
      // a tighter ratio guard than before (was half), so short common words
      // can't be nudged into a similar-length proper noun.
      if (dist >= Math.ceil(token.length / 3)) continue;
      if (!best || dist < best.dist) best = { term, dist };
      if (dist === 0) break;
    }
    if (!best) return token;

    return preserveLeadingCase(token, best.term);
  });
}

function preserveLeadingCase(source: string, replacement: string): string {
  if (!source || !replacement) return replacement;
  const first = source[0];
  if (first && first === first.toUpperCase() && first !== first.toLowerCase()) {
    // Source starts uppercase — leave replacement as provided (canonical form).
    return replacement;
  }
  // Source starts lowercase — lowercase the replacement's first char.
  const repFirst = replacement[0];
  if (!repFirst) return replacement;
  return repFirst.toLowerCase() + replacement.slice(1);
}
