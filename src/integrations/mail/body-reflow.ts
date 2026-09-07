// Mail body reflow — the 2026-08-14 dogfood symptom: a mail authored by the
// agent rendered in Apple Mail with breaks mid-sentence/mid-word. Root cause
// (diagnosed on the wire path, not guessed): lynox sends text/plain with
// whatever line breaks the model emitted, and LLM output is typically
// hard-wrapped at ~76–90 chars. text/plain without format=flowed renders every
// CRLF as a real break, so the recipient sees the model's editing wrap as
// paragraph structure. nodemailer never reflows.
//
// This module reflows BEFORE the wire: consecutive lines of RUNNING TEXT are
// joined with a single space; everything that carries meaning in its line
// shape is preserved verbatim —
//   · empty lines (paragraph boundaries)
//   · quoted lines (`> …`), including the reply chain they open
//   · list items (`- `, `* `, `• `, `1. `, `2) ` …)
//   · code fences (``` / ~~~) and everything between them
//   · the signature delimiter (`-- `, RFC 3676 §4.3) and everything after it
//   · lines with two or more consecutive spaces (column-aligned tables, ASCII
//     art) — joining those would destroy the columns
//
// Deliberately NOT chosen: `format=flowed` (needs space-stuffing, uneven
// client support) and an HTML alternative (changes what the approver consented
// to — the consent preview shows the plain text).

/** A line whose shape carries meaning and must survive reflow verbatim.
 *
 *  Review-hardened (2026-08-14): the false-direction is asymmetric — a line
 *  WRONGLY kept verbatim merely loses its reflow benefit, a line WRONGLY
 *  joined destroys readable structure. So the structural set errs wide:
 *  patch/diff/log/stack shapes (the review collapsed a full unified diff and
 *  a stack trace to one line), indented continuations, `+`-prefixed
 *  changelog entries, and any-width numbering all stay verbatim. */
function isStructuralLine(line: string, inCodeFence: boolean): boolean {
  // Inside a code fence EVERYTHING is verbatim; the fence toggles only on the
  // delimiter itself (checked by the caller before this test runs).
  if (inCodeFence) return true;
  if (line.trim().length === 0) return true; // paragraph boundary (incl. whitespace-only)
  if (line.startsWith('>')) return true; // quoted reply chain
  if (/^\s/.test(line)) return true; // indented continuation / code / nested quote
  if (/^\s*(?:[-*+•]|\d+[.)])\s/.test(line)) return true; // list item / changelog `+`
  if (/^(diff --git |--- |\+\+\+ |@@ )/.test(line)) return true; // unified diff markers
  if (/^[+-]/.test(line)) return true; // patch hunk line (\`-old\` / \`+new\` have no space after the marker)
  if (/^\s*at \S+\s*\(/.test(line)) return true; // stack-trace frame
  if (/^\d{4}-\d{2}-\d{2}[T ]/.test(line)) return true; // timestamped log line
  if (line === '--' || line === '-- ') return true; // signature delimiter
  if (/\S {2,}\S/.test(line)) return true; // column-aligned / ASCII layout
  return false;
}

/**
 * A body whose longest line of running text is shorter than this was never
 * hard-wrapped at all — there is no wrap column to infer, so nothing joins.
 * Below ~40 the "column" would just be the longest signature line.
 */
const MIN_PLAUSIBLE_WRAP = 40;

/**
 * How far under the inferred column a line may sit and still count as wrapped.
 * A greedy wrap breaks as soon as the NEXT word would not fit, so a wrapped
 * line lands between `col - len(nextWord)` and `col`. Ordinary words are 5-10
 * characters; 12 covers those, and the majority rule below absorbs the long
 * German compounds and URLs that overshoot it.
 */
const WRAP_TOLERANCE = 12;

/**
 * Decide whether a RUN of consecutive running-text lines is a hard-wrapped
 * paragraph, using the whole run as evidence.
 *
 * This is deliberately not a per-line-pair test, and the reason is that a pair
 * carries no signal. An address line of 55 characters followed by a 34-character
 * URL and a paragraph line of 55 characters followed by a 34-character compound
 * are geometrically identical; no threshold separates them, because line length
 * is the same measurement in both. What DOES separate them is the company they
 * keep: in a wrapped paragraph nearly every line but the last sits near the wrap
 * column, and in a signature or address block none of them do.
 *
 * The last line is excluded from the vote — it is the remainder and is short by
 * construction.
 */
/**
 * Would the next line's first word still have fitted on this one?
 *
 * This is the definition of a greedy wrap read backwards: a non-final line is
 * short ONLY because the next word did not fit. If it WOULD have fitted, the
 * author ended the line on purpose — a salutation, a sign-off, a list of names
 * — and joining it destroys what they meant.
 *
 * Deliberately used only INSIDE a run already classified as wrapped, never as
 * the classifier. On its own it cannot tell a 55-character address line
 * followed by a 34-character URL from a 55-character paragraph line followed
 * by a 34-character compound; those are the same measurement. The run-level
 * vote answers "is this a paragraph at all", and this answers "where did the
 * author break it".
 */
function nextWordWouldHaveFitted(line: string, next: string, wrapCol: number): boolean {
  const word = next.trimStart().split(/\s+/)[0] ?? '';
  return line.trimEnd().length + 1 + word.length <= wrapCol;
}

function runIsMachineWrapped(run: readonly string[], wrapCol: number): boolean {
  if (run.length < 2) return false;
  if (wrapCol < MIN_PLAUSIBLE_WRAP) return false;
  const candidates = run.slice(0, -1);
  let near = 0;
  for (const l of candidates) {
    if (l.trimEnd().length >= wrapCol - WRAP_TOLERANCE) near++;
  }
  return near * 2 >= candidates.length;
}

/**
 * Reflow hard-wrapped running text into one line per paragraph. Returns the
 * input unchanged when nothing reflows.
 *
 * Two passes, because the decision needs the whole body: the wrap column is
 * INFERRED from the longest line of running text rather than assumed, so a
 * narrow wrap, a wide one, and a body that was never wrapped are all read
 * correctly instead of measured against a constant.
 *
 * IDEMPOTENCY, stated precisely rather than claimed. On a genuinely wrapped
 * body it holds — measured over 172 greedy-wrapped paragraphs across six wrap
 * columns, zero differ on a second pass. It does NOT hold in general, and the
 * reason is inherent to inferring the column: a joined line becomes the longest
 * line, so a body that MIXES machine wrap with a deliberate author break reads
 * differently the second time (pass 1 preserves the break, which is the point;
 * pass 2 sees the joined line as the column and closes it). Both call sites
 * reflow the raw body exactly once, so this is not reachable — and there is a
 * test that fails if either of those two facts stops being true.
 *
 * WIDTH is measured in UTF-16 code units, not display columns. Because the
 * column is inferred from the same text, a CJK body is compared against a CJK
 * column and behaves sensibly, which a fixed Latin-calibrated number could not
 * do. Emoji and decomposed (NFD) text still inflate the count relative to what
 * a reader sees; the majority rule absorbs the usual case, and no normalisation
 * is attempted here.
 */
export function reflowMailBody(body: string): string {
  const lines = body.split(/\r?\n/);

  // Pass 1 — collect the running-text lines to infer the wrap column from. It
  // has to replay the fence/signature state machine, because whether a line is
  // running text depends on what came before it.
  const runningLines: string[] = [];
  {
    let fence = false;
    let afterSig = false;
    for (const line of lines) {
      if (afterSig) continue;
      if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }
      if (line === '--' || line === '-- ') { afterSig = true; continue; }
      if (line.trim().length === 0) continue;
      if (isStructuralLine(line, fence)) continue;
      runningLines.push(line);
    }
  }
  let wrapCol = 0;
  for (const l of runningLines) {
    const n = l.trimEnd().length;
    if (n > wrapCol) wrapCol = n;
  }

  const out: string[] = [];
  let buffer: string[] = [];
  let inCodeFence = false;
  let afterSignature = false;

  // Pass 2 — emit. A run is joined only if it LOOKS machine-wrapped as a whole;
  // otherwise its lines survive exactly as written.
  const flush = (): void => {
    if (buffer.length === 0) return;
    if (!runIsMachineWrapped(buffer, wrapCol)) {
      for (const l of buffer) out.push(l);
      buffer = [];
      return;
    }
    // Wrapped paragraph — but an author's own break can still sit inside it.
    // Segment at every non-final line whose successor's first word would have
    // fitted, since a greedy wrap could not have produced that break.
    let segment: string[] = [];
    for (let i = 0; i < buffer.length; i++) {
      const line = buffer[i]!;
      segment.push(line);
      const next = buffer[i + 1];
      if (next !== undefined && nextWordWouldHaveFitted(line, next, wrapCol)) {
        out.push(segment.join(' ').trimEnd());
        segment = [];
      }
    }
    if (segment.length > 0) out.push(segment.join(' ').trimEnd());
    buffer = [];
  };

  for (const line of lines) {
    if (afterSignature) {
      out.push(line);
      continue;
    }
    const fenceMatch = /^\s*(```|~~~)/.test(line);
    if (fenceMatch) {
      flush();
      inCodeFence = !inCodeFence;
      out.push(line);
      continue;
    }
    if (line === '--' || line === '-- ') {
      flush();
      afterSignature = true;
      out.push(line);
      continue;
    }
    if (line.trim().length === 0) {
      // Paragraph boundary — normalize whitespace-only lines to empty so the
      // wire output has clean paragraph separators (a '   ' line would
      // otherwise survive as a weird blank-with-spaces row).
      flush();
      out.push('');
      continue;
    }
    if (isStructuralLine(line, inCodeFence)) {
      flush();
      out.push(line);
      continue;
    }
    buffer.push(line);
  }
  flush();
  return out.join('\n');
}
