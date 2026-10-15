// prose-open-count.mjs — finds an open-findings COUNT in public prose.
//
// Dependency-free on purpose: this directory is vendored byte-identically into the private repo
// (see README.md). No imports, no formatter, no eol normalisation on this path.

/**
 * An open-findings COUNT in the body's PROSE. The record's fields are held to
 * `openFiledCount` in gate-record.mjs; this is the same rule for the sentences around them, which until now
 * only a manual run of the private repo's text check read. Measured before it existed: a valid
 * record plus the sentence "the security round left <n> findings filed in the register", with a digit for <n>, was green.
 *
 * The pattern starts from the private repo's PROSE pattern, not `OPEN_COUNT`: prose needs the
 * narrower one. Widened here by three shapes a review measured passing — "2 findings were filed",
 * "filed 2 findings", "2 findings remain unresolved" — and re-measured over the last 300 core PR
 * bodies: 0 hits, while 50 of them say "filed" in the number-free form this repo prescribes.
 * What it leaves out, and why, is the calibration:
 *   · `0` — `0 filed` means nothing is open;
 *   · a `#`, `.`, `-` (also the Unicode hyphens U+2010/U+2011) or word character before the number — `core#1274 filed` is a PR that filed,
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
  String.raw`(?<![#\w.\u2010\u2011-])[1-9]\d*\s+(?:(?:open|security|review|code)\s+)?(?:${PROSE_OPEN_NOUN}\s+)?(?:(?:were|was|are|is|have\s+been|has\s+been|got)\s+)?filed\b`,
  String.raw`\bfiled\s+[1-9]\d*\s+(?:(?:open|security|review|code)\s+)?${PROSE_OPEN_NOUN}`,
  String.raw`(?<![#\w.\u2010\u2011-])[1-9]\d*\s+(?:open|offene[nr]?)\s+${PROSE_OPEN_NOUN}\b`,
  String.raw`(?<![#\w.\u2010\u2011-])[1-9]\d*\s+${PROSE_OPEN_NOUN}\s+(?:(?:are|is|sind|ist)\s+)?(?:(?:remain|remains|left|still|stay|stays|bleib\w*|noch)\s+)*(?:open|offen|unresolved|ungelöst)\b`,
].join('|'), 'i');
/** A line that quotes the form on purpose (a PR about this check) opts out, as in public-repo-guard. */
export const PROSE_ALLOW = ['public-repo-guard', 'allow'].join(':');

/**
 * At most 30 combining marks in a row, as in Unicode's stream-safe text format (UAX #15): no
 * script needs more, and a mark run is never part of a count. Applied before every NFKC fold.
 * "Mark" includes the four characters outside \p{M} whose NFKC form begins with one
 * (U+0E33, U+0EB3, U+FF9E, U+FF9F) — the fold turns them into marks.
 */
const streamSafe = (s) => s.replace(/[\p{M}\u0E33\u0EB3\uFF9E\uFF9F]{31,}/gu, (run) => Array.from(run).slice(0, 30).join(''));

/**
 * A markdown link's `](…)` as CommonMark reads it: a target without whitespace (or in `<…>`),
 * then optionally a title in `"…"`, `'…'` or `(…)`, then `)`. A target also ends where the next
 * link begins (`](`), and a `]` inside it is kept. Text in parentheses that does not have this
 * shape is not a link: GitHub shows it, so it is read. The title is in group 1, 2 or 3.
 */
/**
 * The bounded link strip this scan used before reading links as CommonMark: everything from `](`
 * to the next `)` or `](`. Kept as a second reading — where the CommonMark reading does not see a
 * link GitHub still renders as one (a `<` inside a target, a Unicode space NFKC turned into a
 * space), this one does, so no count the scan found before is lost.
 */
const LINK_BOUNDED = /\]\((?:[^)\]]|\](?!\())*\)/g;

const LINK = /\]\((?:<[^<>\n]*>|(?:[^\s)\]<]|\](?!\())*)(?:\s+(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|\(((?:\\.|[^()\\])*)\)))?\s*\)/g;

/**
 * LINK with the target CommonMark also allows: backslash escapes (`\)`), balanced parentheses
 * (`u(a(b))`, here up to five deep) and a `<` anywhere but first. A third reading, so a `)`
 * inside the target is not left in the text between the two halves of a count the link splits.
 */
const PARENS = Array.from({ length: 4 }).reduce(
  (inner) => String.raw`\((?:\\.|[^\s()\\]|${inner})*\)`, String.raw`\((?:\\.|[^\s()\\])*\)`);
const LINK_NESTED = new RegExp(String.raw`\]\((?:<[^<>\n]*>|(?!<)(?:\\.|[^\s()\\\]]|\](?!\()|${PARENS})*)(?:\s+(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|\(((?:\\.|[^()\\])*)\)))?\s*\)`, 'g');

/**
 * LINK_NESTED's first form: escapes and one level of parentheses, `<` excluded. Kept as a fourth
 * reading because the wider form can match a longer span at an earlier `](` and swallow a real
 * link this one strips.
 */
const LINK_ESCAPED = /\]\((?:<[^<>\n]*>|(?:\\.|[^\s()\\\]<]|\](?!\()|\((?:\\.|[^\s()\\])*\))*)(?:\s+(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|\(((?:\\.|[^()\\])*)\)))?\s*\)/g;

/** Numeric entities decoded, as `readable` does before it strips links. */
const decodeNumeric = (s) => s
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => codePoint(Number.parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => codePoint(Number(d)));

/** An entity's character; one outside Unicode is a space, never a thrown RangeError. */
const codePoint = (n) => (Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ' ');

export function proseOpenCountLines(body) {
  // NOTHING is skipped as "the record", on purpose. The first version skipped from a
  // record-block opener to the next fence, and a second, unterminated opener — or one inside an
  // HTML comment, which `extractRecord` strips — then hid every sentence after it. The record's own
  // lines need no exemption: a valid one carries no open count, and one that does is refused by
  // the field rule anyway, so the cost of reading it twice is a second message, never a false red.
  const lines = streamSafe(String(body ?? '')).normalize('NFKC').split('\n');
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
  const readable = (raw, fold, link) => {
    const decoded = decodeNumeric(raw
      .replace(/<\/?[A-Za-z!][^<>]*>/g, ' '))
      .replace(/&(?:nbsp|ensp|emsp|thinsp);/gi, ' ');
    // Again after decoding: an entity can name a fullwidth digit, and digits of other scripts go
    // to ASCII. Optional, because the fold can also glue a decoded character onto a count
    // (`<n> filed&#xFF12;`), which unfolded still reads.
    return (fold ? streamSafe(decoded).normalize('NFKC').replace(/(?![0-9])\p{Nd}/gu, asciiDigit) : decoded)
      .replace(/[\u200B-\u200D\u2060\uFEFF\u00AD]/g, '')
      // A link as rendered: target and title go, the link text stays (see LINK).
      .replace(link, '')
      .replace(/[*_`[\]]/g, '');
  };
  const flush = () => {
    const joined = para.map((p) => p.text.replace(/\\\r?$/, '')).join(' ');
    // Read as rendered and as published. As RENDERED, a comment is a tag and goes — `<n> findings <!-- x --> filed` shows
    // the count. As PUBLISHED, its markers go and its text stays — the raw body (API, edit view)
    // is public, so `<!-- <n> findings filed -->` is too. A count in any view is a hit.
    // A link's title is not shown in the text, but the raw body carries it: each title is a view
    // of its own. Never joined — two titles must not form one count. Titles are also taken after
    // numeric entities are decoded: `readable` decodes before it strips, so a `&#34;`-quoted
    // count would otherwise go as a title no view reads.
    const titles = new Set([joined, decodeNumeric(joined)].flatMap((v) => [LINK, LINK_NESTED, LINK_ESCAPED].flatMap((re) =>
      [...v.matchAll(re)].map((m) => m[1] ?? m[2] ?? m[3]).filter((t) => t))));
    const views = [joined, joined.replace(/<!--|-->/g, ' '), ...titles];
    // Every view is read with every link reading (LINK, LINK_BOUNDED, LINK_NESTED, LINK_ESCAPED),
    // folded and not, and once more with the links stripped BEFORE `readable` decodes entities and
    // turns tags into spaces: `u&#41;` would end the target early, `u(<i>)` would break it.
    const hit = views.some((v) => [true, false].some((fold) => [LINK, LINK_BOUNDED, LINK_NESTED, LINK_ESCAPED].some((link) =>
      PROSE_OPEN_COUNT.test(readable(v, fold, link))
        || PROSE_OPEN_COUNT.test(readable(v.replace(link, ''), fold, link)))));
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
