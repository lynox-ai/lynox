/**
 * Heuristic to identify short user inputs that should NOT trigger Knowledge
 * Graph retrieval or memory recall.
 *
 * Background: when a user types a 1-2 word follow-up (e.g. "bexio", "ok",
 * "yes", "ja"), it's almost always a clarification of the previous turn, not
 * a new factual query that needs grounding context. Running KG retrieve on
 * such inputs found zero-relevance matches on the 2026-04-21 incident —
 * stale `status` memory from a prior session was surfaced because the short
 * input had no semantic specificity to anchor the retrieval. The LLM then
 * used that stale memory as its "current session goals" and drifted the
 * entire response off-topic.
 *
 * This heuristic pairs with (a) language re-anchor per turn in the system
 * prompt and (b) sharpened memory_recall tool description. Together they
 * stop the "short input → stale memory → topic switch" cascade.
 *
 * Returns true when the input is best treated as a continuation of the
 * prior turn: no retrieval, no auto tool calls looking for "what to do
 * next" — just respond to the literal message against the visible
 * conversation history.
 */
export function isShortClarification(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return true;
  // Hard ceiling: 20 chars. A real query asking about entities or
  // tasks is virtually always longer than that once punctuation and
  // a predicate are included.
  if (trimmed.length > 20) return false;
  // Word count ceiling: 2 words. "bexio" (1), "use bexio" (2), "the
  // bexio API" (3 — already a query). Strips hyphens/punctuation so
  // "well-designed" counts as one word, not two.
  const words = trimmed.split(/\s+/).filter(Boolean);
  return words.length <= 2;
}
