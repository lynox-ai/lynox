/**
 * Characters a text can carry that a reader does not see, or that reorder what is shown:
 * invisible format characters, the bidi overrides and isolates, the tag block, the supplementary
 * variation selectors (a run of them carries arbitrary bytes a model can decode), and the control
 * characters but tab, newline and carriage return. The ones a language needs are not here: ZWJ
 * and ZWNJ, the direction marks (LRM, RLM, ALM), the soft hyphen, and the variation selectors
 * U+FE00–FE0F an emoji is drawn by.
 *
 * The bulk pages of the web UI mark the same set (`bulkVisibleText` in
 * `packages/web-ui/src/lib/components/bulk-runs.ts`), which keeps its own copy because the web UI
 * is a package of its own; `tests/hidden-chars-drift.test.ts` holds the two equal, code point by
 * code point.
 */
export const HIDDEN_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u180E\u200B\u2028\u2029\u202A-\u202E\u2060-\u2064\u2066-\u2069\u3164\uFEFF\uFFF9-\uFFFB\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/u;

/** The index of the first hidden character in `text`, or -1. */
export function hiddenCharAt(text: string): number {
  const m = HIDDEN_CHARS.exec(text);
  return m === null ? -1 : m.index;
}
