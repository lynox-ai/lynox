/**
 * Token-set ratio (Jaccard) on tokenised strings.
 *
 * Used by the P3 history-preservation matcher to detect entity renames
 * across cycles. Robust to token reordering ('Search_Brand_DE' vs
 * 'Brand_DE_Search' → 1.0) and case/separator differences ('-' vs '_'
 * vs spaces). Symmetric and bounded in [0, 1].
 *
 * Pure utility. No deps. No I/O.
 */

/**
 * Tokenise a string into a set of lowercase, alphanumeric tokens.
 * Splits on every non-alphanumeric character and discards empties.
 * Single-character tokens are kept (unusual but rarely meaningful for
 * Google Ads names; callers can pre-strip if needed).
 */
export function tokenise(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/u).filter(t => t.length > 0);
}

/**
 * Jaccard similarity between two strings' token sets.
 * Returns NaN when both inputs tokenise to the empty set.
 */
export function tokenSetRatio(a: string, b: string): number {
  const setA = new Set(tokenise(a));
  const setB = new Set(tokenise(b));
  if (setA.size === 0 && setB.size === 0) return NaN;
  let intersection = 0;
  for (const tok of setA) if (setB.has(tok)) intersection++;
  const union = setA.size + setB.size - intersection;
  return intersection / union;
}
