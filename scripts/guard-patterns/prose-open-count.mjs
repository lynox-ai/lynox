// prose-open-count.mjs — finds an open-findings COUNT in public prose.
//
// Dependency-free on purpose: this directory is vendored byte-identically into the private repo
// (see README.md). No imports, no formatter, no eol normalisation on this path.

/**
 * An open-findings COUNT in the body's PROSE. The record's fields are held to
 * `openFiledCount` below; this is the same rule for the sentences around them, which until now
 * only a manual run of the private repo's text check read. Measured before it existed: a valid
 * record plus the sentence "the security round left 2 findings filed in the register" was green.
 *
 * The pattern starts from the private repo's PROSE pattern, not `OPEN_COUNT`: prose needs the
 * narrower one. Widened here by three shapes a review measured passing — "2 findings were filed",
 * "filed 2 findings", "2 findings remain unresolved" — and re-measured over the last 300 core PR
 * bodies: 0 hits, while 50 of them say "filed" in the number-free form this repo prescribes.
 * What it leaves out, and why, is the calibration:
 *   · `0` — `0 filed` means nothing is open;
 *   · a `#`, `.`, `-` or word character before the number — `core#1274 filed` is a PR that filed,
 *     and with paragraphs joined, a date ending one line must not meet the next (a bare
 *     `step 2` ending one still does — joined, it reads as a count, and nothing says otherwise);
 *   · `deferred` and `issues`, which hit "9 of 17 deferred tools" and "the 3 issues filed by users".
 * ONE source: the private repo's text check vendors this file byte-identically (see README.md
 * here) and runs the same function, so the two cannot drift silently.
 * Bounded, not exact: a count in words ("two remain") passes, as it does in the fields. A count in
 * any other digit script (`٢`, `२`) is read as its ASCII value.
 *
 * Returns the first line of each paragraph that counts, never the text: the refusal goes into a
 * public Actions log.
 */
export const PROSE_OPEN_NOUN = String.raw`(?:findings?|Befunde?|defects?|gaps?|Lücken?)`;
export const PROSE_OPEN_COUNT = new RegExp([
  String.raw`(?<![#\w.-])[1-9]\d*\s+(?:(?:open|security|review|code)\s+)?(?:${PROSE_OPEN_NOUN}\s+)?(?:(?:were|was|are|is|have\s+been|has\s+been|got)\s+)?filed\b`,
  String.raw`\bfiled\s+[1-9]\d*\s+(?:(?:open|security|review|code)\s+)?${PROSE_OPEN_NOUN}`,
  String.raw`(?<![#\w.-])[1-9]\d*\s+(?:open|offene[nr]?)\s+${PROSE_OPEN_NOUN}\b`,
  String.raw`(?<![#\w.-])[1-9]\d*\s+${PROSE_OPEN_NOUN}\s+(?:(?:are|is|sind|ist)\s+)?(?:(?:remain|remains|left|still|stay|stays|bleib\w*|noch)\s+)*(?:open|offen|unresolved|ungelöst)\b`,
].join('|'), 'i');
/** A line that quotes the form on purpose (a PR about this check) opts out, as in public-repo-guard. */
export const PROSE_ALLOW = ['public-repo-guard', 'allow'].join(':');

/** An entity's character; one outside Unicode is a space, never a thrown RangeError. */
const codePoint = (n) => (Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ' ');

export function proseOpenCountLines(body) {
  // NOTHING is skipped as "the record", on purpose. The first version skipped from a
  // record-block opener to the next fence, and a second, unterminated opener — or one inside an
  // HTML comment, which `extractRecord` strips — then hid every sentence after it. The record's own
  // lines need no exemption: a valid one carries no open count, and one that does is refused by
  // the field rule anyway, so the cost of reading it twice is a second message, never a false red.
  const lines = String(body ?? '').normalize('NFKC').split('\n');
  const hits = [];
  // Per PARAGRAPH, not per line: a soft line break renders as a space, so `2` at the end of one
  // line and `findings filed` on the next read as a count. Markdown that renders as plain text
  // around the number (`**2**`, `_2_`, `` `2` ``, a link) is taken out before matching.
  let para = [];
  // A trailing `\` is a hard break; inline HTML and `&nbsp;` render as text around the number;
  // zero-width characters render as nothing. All of them would otherwise split a count.
  // Only what LOOKS like a tag or comment goes: a plain `<` with a later `>` (`p95 < 300ms … ->`)
  // is shown literally by GitHub, and a bare `<[^>]*>` erased the count between them.
  // Any decimal digit to ASCII: Unicode keeps every digit set one contiguous run starting at its
  // zero, so a digit's value is its distance from the run's start, mod 10 (adjacent sets abut).
  const asciiDigit = (ch) => {
    let start = ch.codePointAt(0);
    while (/\p{Nd}/u.test(String.fromCodePoint(start - 1))) start -= 1;
    return String((ch.codePointAt(0) - start) % 10);
  };
  const readable = (raw, fold) => {
    const decoded = raw
      .replace(/<\/?[A-Za-z!][^<>]*>/g, ' ')
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => codePoint(Number.parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => codePoint(Number(d)))
      .replace(/&(?:nbsp|ensp|emsp|thinsp);/gi, ' ');
    // Again after decoding: an entity can name a fullwidth digit, and digits of other scripts go
    // to ASCII. Optional, because the fold can also glue a decoded character onto a count
    // (`2 filed&#xFF12;`), which unfolded still reads.
    return (fold ? decoded.normalize('NFKC').replace(/(?![0-9])\p{Nd}/gu, asciiDigit) : decoded)
      .replace(/[\u200B-\u200D\u2060\uFEFF\u00AD]/g, '')
      .replace(/\]\([^)]*\)/g, '')
      .replace(/[*_`[\]]/g, '');
  };
  const flush = () => {
    const joined = para.map((p) => p.text.replace(/\\\r?$/, '')).join(' ');
    // Read twice. As RENDERED, a comment is a tag and goes — `2 findings <!-- x --> filed` shows
    // the count. As PUBLISHED, its markers go and its text stays — the raw body (API, edit view)
    // is public, so `<!-- 2 findings filed -->` is too. A count in either reading is a hit.
    const views = [joined, joined.replace(/<!--|-->/g, ' ')];
    const hit = views.some((v) => [true, false].some((fold) => PROSE_OPEN_COUNT.test(readable(v, fold))));
    if (para.length > 0 && hit) hits.push(para[0].n);
    para = [];
  };
  for (const [i, line] of lines.entries()) {
    if (line.trim() === '') { flush(); continue; } // `trim` also takes a CRLF body's `\r`
    // A line that quotes the form on purpose opts out, and only that line. It does NOT end the
    // paragraph: a count split across the marker line must still be read as one.
    if (line.includes(PROSE_ALLOW)) continue;
    para.push({ n: i + 1, text: line });
  }
  flush();
  return hits;
}
