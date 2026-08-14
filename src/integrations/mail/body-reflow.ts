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

/** A line whose shape carries meaning and must survive reflow verbatim. */
function isStructuralLine(line: string, inCodeFence: boolean): boolean {
  // Inside a code fence EVERYTHING is verbatim; the fence toggles only on the
  // delimiter itself (checked by the caller before this test runs).
  if (inCodeFence) return true;
  if (line.length === 0) return true; // paragraph boundary
  if (line.startsWith('>')) return true; // quoted reply chain
  if (/^\s*(?:[-*•]|\d{1,3}[.)])\s/.test(line)) return true; // list item
  if (line === '--' || line === '-- ') return true; // signature delimiter
  if (/\S {2,}\S/.test(line)) return true; // column-aligned / ASCII layout
  return false;
}

/**
 * Reflow hard-wrapped running text into one line per paragraph. Returns the
 * input unchanged when nothing reflows. Idempotent: reflowed output has no
 * joinable line pairs left, so a second pass is a no-op.
 */
export function reflowMailBody(body: string): string {
  const lines = body.split(/\r?\n/);
  const out: string[] = [];
  let buffer: string[] = [];
  let inCodeFence = false;
  let afterSignature = false;

  const flush = (): void => {
    if (buffer.length > 0) {
      out.push(buffer.join(' ').trimEnd());
      buffer = [];
    }
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
