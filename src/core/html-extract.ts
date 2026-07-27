// === HTML → text extraction for oversized `http_request` responses ===
//
// `maybeShapeJson` caps heavy JSON APIs so an unshaped pull can't inject tens of
// KB into the context. HTML had no equivalent: `http.ts` handed a `text/html`
// body straight through (`else { body = text }`), bounded only by the 100KB read
// limit and the agent's 80KB tool-result cap. Both are byte cuts, so a large page
// arrived as raw markup, truncated mid-tag.
//
// Measured on a 204,104-char news/magazine homepage: the agent saw the first
// 80,000 chars (39% of the page, cut mid-tag), and that tool result was 91% of
// the thread's context bytes. On a provider without a cache discount it was
// re-billed on every following turn, so even a follow-up question that made no
// tool call paid for the markup. Extraction takes the same page to 4,817 chars
// (-97.6%) while keeping every finding a page analysis actually needs.
//
// Extraction keeps title, meta/OG description, heading structure and visible
// text; it drops scripts, styles and markup. It runs only ABOVE a threshold,
// mirroring `DEFAULT_SHAPE_THRESHOLD_CHARS`: small pages pass through untouched
// so fetching a snippet of markup still works.
//
// Pure module — no I/O, no LLM. The caller still wraps the result in
// <untrusted_data> (`data-boundary.ts`); dropping <script> shrinks the injection
// surface rather than widening it.
//
// ⚠️ Two invariants this file must keep, both learned from review:
//  1. **No `[^>]` in a tag pattern.** `[^>]` matches `<`, so a run of `<<<<<`
//     makes every start position a viable partial match and the scan goes
//     quadratic: measured 276ms at 25KB, 4.3s at 100KB, 17s at 200KB of `"<"`.
//     This runs synchronously AFTER http.ts's wall-clock race, so nothing else
//     bounds it — one hostile page would freeze the engine's event loop. Every
//     tag pattern below uses `[^<>]` (a stray `<` terminates the class instead
//     of extending it) and the input is length-bounded on top.
//  2. **Meta/title are read from CLEANED html, never raw.** They live in
//     attributes, so it is tempting to read them first — but then a `<meta>` or
//     `<title>` inside a comment or a script string gets promoted into the
//     authoritative header lines, and first-match-wins means a commented-out
//     title BEATS the real one. Comments and script/style blocks come out first.
//
// Accepted limitation (do NOT "fix" it into a regression): a body byte-cut
// mid-comment leaks that comment's text, because the paired comment pattern
// can't match an unterminated `<!--`. The symmetric tail sweep that block
// elements get is deliberately NOT applied to comments — `<!--` also appears
// inside inline scripts (a legacy idiom), and comments are stripped BEFORE
// scripts, so such a sweep would delete the rest of the document on a normal
// page. Leaking a comment's text is the smaller harm, and it stays inside the
// <untrusted_data> wrap either way.

/**
 * Below this size an HTML body is returned raw. Mirrors the JSON safety-net
 * threshold (`DEFAULT_SHAPE_THRESHOLD_CHARS`, http.ts) — the point is to stop
 * a page from swamping the context, not to reshape every small fetch.
 */
export const DEFAULT_HTML_EXTRACT_THRESHOLD_CHARS = 30_000;

/**
 * Cap on the extracted text. Matches `DEFAULT_LARGE_RESPONSE_SHAPE.max_chars`
 * so HTML and JSON land in the same context budget. Real pages extract far
 * below this, so the cap is a backstop for text-heavy documents, not the
 * normal path.
 */
export const DEFAULT_HTML_EXTRACT_MAX_CHARS = 24_000;

/**
 * Hard bound on the markup we will scan, independent of the caller's read
 * limit. `http_response_limit` is user-settable up to 5MB, and the regex work
 * is linear-per-pass but still ~26 passes over the input — a 5MB page would
 * burn real event-loop time for a result that is capped at 24k chars anyway.
 * 512KB comfortably covers any page whose *text* could fill that cap.
 */
export const MAX_EXTRACT_INPUT_CHARS = 512_000;

/**
 * An extraction yielding less than this is treated as a failure and the caller
 * keeps the raw markup. A JS-rendered SPA serves an almost empty shell, and
 * handing back a few dozen chars of boilerplate would lose what the markup still
 * carries (inline JSON payloads, data attributes) — strictly worse than raw.
 */
export const MIN_USEFUL_EXTRACT_CHARS = 200;

export interface HtmlExtractResult {
  /** Extracted text: title, meta lines, then heading-marked body text. */
  readonly text: string;
  /**
   * The document `<title>`, decoded and whitespace-collapsed — empty when the
   * page has none. Read from the same CLEANED html as the meta lines, so a
   * commented-out or scripted title can never win (invariant 2 below).
   */
  readonly title: string;
  readonly beforeChars: number;
  readonly afterChars: number;
  /** True when the extracted text itself hit `maxChars`. */
  readonly truncated: boolean;
}

/**
 * Content-types that carry markup we can extract. XHTML included; `text/plain`
 * and everything else deliberately excluded — a plain-text or CSV body has no
 * tags to strip and must not be mangled.
 */
export function isHtmlContentType(contentType: string): boolean {
  const ct = contentType.toLowerCase();
  return ct.includes('text/html') || ct.includes('application/xhtml');
}

/** Blocks whose CONTENT is noise, not page text — removed wholesale. */
const BLOCK_ELEMENTS = ['script', 'style', 'svg', 'noscript', 'iframe', 'template', 'canvas'] as const;

// All patterns are module-scope so a per-call loop doesn't recompile them, and
// so the `[^<>]`-not-`[^>]` invariant is reviewable in one place.
const COMMENT_RE = /<!--[\s\S]*?-->/g;
const HEAD_RE = /<head\b[^<>]*>[\s\S]*?<\/head>/i;
const BR_RE = /<br\b[^<>]*>/gi;
const HEADING_RE = /<h([1-3])\b[^<>]*>([\s\S]*?)<\/h\1\s*>/gi;
const BLOCK_CLOSE_RE = /<\/(?:p|div|li|tr|section|article|header|footer|nav)\s*>/gi;
const TAG_RE = /<[^<>]*>/g;
const META_TAG_RE = /<meta\b[^<>]*>/gi;
const TITLE_RE = /<title[^<>]*>([\s\S]*?)<\/title\s*>/i;
const META_KEY_RE = /(?:name|property)\s*=\s*["']([^"']+)["']/i;
const META_CONTENT_RE = /content\s*=\s*["']([^"']*)["']/i;

/** Paired removal + an unterminated-tail sweep, per block element. The closing
 *  tag allows whitespace (`</script >` is legal); without that the pair fails to
 *  match and the tail sweep below eats the rest of the document. */
const BLOCK_PAIR_RES: RegExp[] = BLOCK_ELEMENTS.map(
  el => new RegExp(`<${el}\\b[^<>]*>[\\s\\S]*?<\\/${el}\\s*>`, 'gi'),
);
const BLOCK_TAIL_RES: RegExp[] = BLOCK_ELEMENTS.map(
  el => new RegExp(`<${el}\\b[^<>]*>[\\s\\S]*$`, 'i'),
);

/** Named entities worth decoding. Numeric forms are handled separately. */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß',
  eacute: 'é', egrave: 'è', agrave: 'à', ccedil: 'ç', ntilde: 'ñ',
  hellip: '…', mdash: '—', ndash: '–', laquo: '«', raquo: '»',
  ldquo: '"', rdquo: '"', lsquo: "'", rsquo: "'", euro: '€', copy: '©', reg: '®', trade: '™',
};

function decodeEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, name: string) => NAMED_ENTITIES[name] ?? m);
}

/**
 * Guard `fromCodePoint` — a malformed entity must not throw mid-extraction, and
 * must not smuggle a character that breaks a downstream consumer. `&#0;` would
 * put a NUL into the tool result (SQLite TEXT and JSON both choke on it) and
 * `&#xD800;` a lone surrogate (unpaired → invalid UTF-8 on the wire), so both
 * classes are dropped rather than decoded. Tab/newline stay allowed.
 */
function safeCodePoint(cp: number): string {
  if (!Number.isFinite(cp) || cp < 0 || cp > 0x10FFFF) return '';
  if (cp >= 0xD800 && cp <= 0xDFFF) return '';
  if (cp < 0x20 && cp !== 0x09 && cp !== 0x0A) return '';
  return String.fromCodePoint(cp);
}

/**
 * Pull `<title>` plus the meta tags that carry positioning copy. These live in
 * ATTRIBUTES, so they must be read before tag-stripping throws them away — but
 * only from html whose comments and script/style blocks are ALREADY gone (see
 * invariant 2 in the header). On a bot-walled page these tags are often the only
 * real content served.
 */
function extractMetaLines(cleanedHtml: string): { lines: string[]; title: string } {
  const lines: string[] = [];
  let pageTitle = '';

  const title = TITLE_RE.exec(cleanedHtml);
  if (title?.[1]) {
    const t = decodeEntities(title[1].replace(TAG_RE, ' ')).replace(/\s+/g, ' ').trim();
    if (t) {
      pageTitle = t;
      lines.push(`title: ${t}`);
    }
  }

  // One pass over all <meta> tags; keep the name/property values that describe
  // the page. Attribute order varies across CMSes, so parse each tag's
  // attributes rather than assuming `name` precedes `content`.
  const KEEP = /^(description|keywords|author|og:[a-z_:]+|twitter:[a-z_:]+)$/i;
  const seen = new Set<string>();
  for (const tag of cleanedHtml.match(META_TAG_RE) ?? []) {
    const key = META_KEY_RE.exec(tag)?.[1]?.trim();
    const val = META_CONTENT_RE.exec(tag)?.[1];
    if (!key || !val || !KEEP.test(key)) continue;
    const clean = decodeEntities(val).replace(/\s+/g, ' ').trim();
    if (!clean) continue;
    const k = key.toLowerCase();
    // og:title and twitter:title are near-always identical — keep the first.
    const dedupKey = `${k}=${clean}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    lines.push(`${k}: ${clean}`);
  }
  return { lines, title: pageTitle };
}

/**
 * Strip an HTML document to the text an analysis task needs.
 *
 * Output shape: meta lines first (title, description, OG/Twitter), then the
 * body text with `<h1>`–`<h3>` marked as `## heading` so the information
 * architecture survives — headings are what tell you what a site is about.
 */
export function extractHtmlText(
  html: string,
  maxChars: number = DEFAULT_HTML_EXTRACT_MAX_CHARS,
): HtmlExtractResult {
  const beforeChars = html.length;
  const source = html.length > MAX_EXTRACT_INPUT_CHARS ? html.slice(0, MAX_EXTRACT_INPUT_CHARS) : html;

  // Comments first, then whole block elements — BEFORE meta extraction, so
  // hidden markup cannot be promoted into the header lines (invariant 2).
  let cleaned = source.replace(COMMENT_RE, ' ');
  for (let i = 0; i < BLOCK_PAIR_RES.length; i++) {
    cleaned = cleaned.replace(BLOCK_PAIR_RES[i]!, ' ');
    // A body byte-truncated at the read limit can end inside an open block —
    // the paired regex cannot match it, which would leak raw JS/CSS into the
    // text. Drop any such unterminated tail.
    cleaned = cleaned.replace(BLOCK_TAIL_RES[i]!, ' ');
  }

  const meta = extractMetaLines(cleaned);

  // <head> holds no visible text; its metadata was already captured above.
  let body = cleaned.replace(HEAD_RE, ' ');

  // Mark headings before the generic tag strip so structure survives as text.
  body = body.replace(HEADING_RE, (_m, _lvl: string, inner: string) => {
    const t = inner.replace(TAG_RE, ' ').replace(/\s+/g, ' ').trim();
    return t ? `\n## ${t}\n` : ' ';
  });
  // Block-level boundaries become newlines so words don't fuse across elements.
  // `<br>` is void, so it needs its own pattern — it has no closing form.
  body = body.replace(BR_RE, '\n').replace(BLOCK_CLOSE_RE, '\n').replace(TAG_RE, ' ');

  body = decodeEntities(body)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const composed = meta.lines.length > 0 ? `${meta.lines.join('\n')}\n\n${body}` : body;
  const truncated = composed.length > maxChars;
  const text = truncated ? composed.slice(0, maxChars) : composed;

  return { text, title: meta.title, beforeChars, afterChars: text.length, truncated };
}
