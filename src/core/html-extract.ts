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

/**
 * How many same-site links ride along with an extraction.
 *
 * Measured, not guessed: on five documentation pages the link the agent would
 * need NEXT (Stripe -> payments, Resend -> api-reference, Tailwind -> utility
 * classes, Svelte -> $state, Mistral -> capabilities) is inside the first 20 in
 * document order on 5/5. At 10 it is inside on 3/5; at 30 nothing is gained.
 * Cost across 18 real pages: 6.7% of the extraction, worst case 42.8% on a page
 * whose extraction is only 2470 characters — which is exactly where the list
 * carries the most.
 */
export const MAX_EXTRACT_LINKS = 20;

/** Anchor text past this is cut — a nav label is short, a paragraph in an <a> is not. */
const MAX_LINK_TEXT_CHARS = 60;

export interface HtmlExtractResult {
  /** Extracted text: title, meta lines, then heading-marked body text. */
  readonly text: string;
  /**
   * The document `<title>`, decoded and whitespace-collapsed — empty when the
   * page has none. Read from the same CLEANED html as the meta lines, so a
   * commented-out or scripted title can never win (invariant 2 above).
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
// so invariant 1 (no `[^>]` in a tag pattern) is reviewable in one place.
//
// ⚠️ INVARIANT 3, added after PR #1081: no lazy `[\s\S]*?` spanning to a closing
// token. Invariant 1 is about the TAG; this one is about the SPAN, and fixing
// the first did nothing for the second. When the closer is absent the engine
// re-scans to end-of-string from every start position. Measured at 500 KB:
// `<!--` 10 408 ms, `<h1>` 10 413 ms, `<head>` 6 714 ms, against a 10 ms prose
// baseline. That became reachable without a user-supplied URL once web_research
// started extracting search results, and it runs synchronously, so the 10 s
// timeout guarding enrichment cannot interrupt it. Spans are cut by
// `removeSpans`, which only moves forward and cannot backtrack.
const BR_RE = /<br\b[^<>]*>/gi;
const BLOCK_CLOSE_RE = /<\/(?:p|div|li|tr|section|article|header|footer|nav)\s*>/gi;
const TAG_RE = /<[^<>]*>/g;
const META_TAG_RE = /<meta\b[^<>]*>/gi;
const META_KEY_RE = /(?:name|property)\s*=\s*["']([^"']+)["']/i;
const META_CONTENT_RE = /content\s*=\s*["']([^"']*)["']/i;

/**
 * Open/close token pair for a span cut by `removeSpans`. Both patterns must
 * carry `g`.
 *
 * `dropUnterminated` decides what happens when the closer is missing, and it is
 * NOT a detail — getting it wrong silently deletes the rest of the page:
 *
 *  - `true` for script/style/svg/… and for comments. A body byte-cut at the read
 *    limit can end inside an open `<script>`, and leaking raw JS into the text is
 *    worse than losing the tail. For comments it is also what a browser does —
 *    an unterminated `<!--` runs to end of document.
 *  - `false` for `<head>` and `<h1>`–`<h3>`, whose content is PAGE TEXT. Browsers
 *    auto-close both, and unclosed or mismatched headings (`<h1>…</h2>`) are
 *    common in hand-written markup. Dropping to end-of-input there threw away
 *    everything after the first sloppy heading.
 */
interface SpanPattern {
  readonly open: RegExp;
  readonly close: RegExp;
  readonly dropUnterminated: boolean;
}

const COMMENT_SPAN: SpanPattern = { open: /<!--/g, close: /-->/g, dropUnterminated: true };
const HEAD_SPAN: SpanPattern = { open: /<head\b[^<>]*>/gi, close: /<\/head\s*>/gi, dropUnterminated: false };
const TITLE_SPAN: SpanPattern = { open: /<title\b[^<>]*>/gi, close: /<\/title\s*>/gi, dropUnterminated: false };

/** Closing tags allow whitespace — `</script >` is legal HTML. */
const BLOCK_SPANS: SpanPattern[] = BLOCK_ELEMENTS.map(el => ({
  open: new RegExp(`<${el}\\b[^<>]*>`, 'gi'),
  close: new RegExp(`<\\/${el}\\s*>`, 'gi'),
  dropUnterminated: true,
}));

/** Anchors are COLLECTED, not removed — `forEachSpan` walks them in place. */
const ANCHOR_SPAN: SpanPattern = { open: /<a\b[^<>]*>/gi, close: /<\/a\s*>/gi, dropUnterminated: true };
const HREF_RE = /href\s*=\s*["']([^"']*)["']/i;

/**
 * Paths that answer a question nobody asked the agent. Note what is NOT here:
 * `/impressum` and `/about` stay, because on a business site they carry the
 * legal entity, location and history — the onboarding scan's actual target.
 */
const UTILITY_LINK_RE = /\/(privacy|datenschutz|agb|terms|tos|cookies?|legal|login|signin|sign-in|register|signup|sign-up|cart|checkout|account|rss|feed)(\/|$|\?)/i;
/** A binary is not a page the agent can read. */
const ASSET_LINK_RE = /\.(pdf|zip|jpe?g|png|gif|svg|webp|mp4|mp3|dmg|exe|css|js)(\?|$)/i;

const HEADING_SPANS: SpanPattern[] = [1, 2, 3].map(lvl => ({
  open: new RegExp(`<h${lvl}\\b[^<>]*>`, 'gi'),
  close: new RegExp(`<\\/h${lvl}\\s*>`, 'gi'),
  dropUnterminated: false,
}));

/**
 * Cut every `open … close` span out of `input`, replacing each with whatever
 * `render` returns (a single space by default).
 *
 * Linear by construction: both patterns only ever advance via `lastIndex`, so
 * each character is examined a bounded number of times. See invariant 3.
 *
 * An UNTERMINATED span is handled per `dropUnterminated` — see `SpanPattern`.
 */
function removeSpans(
  input: string,
  { open, close, dropUnterminated }: SpanPattern,
  render?: (inner: string) => string,
): string {
  // Both patterns must carry `g`: the scan advances via `lastIndex`, which a
  // non-global regex ignores — `exec` would restart at 0 and never terminate.
  open.lastIndex = 0;
  close.lastIndex = 0;

  let out = '';
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = open.exec(input)) !== null) {
    // `open` can match inside a span already consumed; skip forward instead.
    if (match.index < cursor) {
      open.lastIndex = cursor;
      continue;
    }
    out += input.slice(cursor, match.index);

    const innerStart = match.index + match[0].length;
    close.lastIndex = innerStart;
    const closer = close.exec(input);

    if (closer === null) {
      // No closer. Either drop everything from here, or keep it verbatim and
      // let the generic tag strip deal with the dangling open tag.
      return dropUnterminated ? out : out + input.slice(match.index);
    }

    out += render ? render(input.slice(innerStart, closer.index)) : ' ';
    cursor = closer.index + closer[0].length;
    open.lastIndex = cursor;
  }
  return out + input.slice(cursor);
}

/**
 * Walk every `open … close` span, handing the callback the open TAG and the
 * inner text. Same forward-only scan as `removeSpans`; the input is untouched.
 * Stops early once the callback has taken enough.
 */
function forEachSpan(
  input: string,
  { open, close }: SpanPattern,
  visit: (openTag: string, inner: string) => boolean,
): void {
  open.lastIndex = 0;
  close.lastIndex = 0;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = open.exec(input)) !== null) {
    if (match.index < cursor) {
      open.lastIndex = cursor;
      continue;
    }
    const innerStart = match.index + match[0].length;
    close.lastIndex = innerStart;
    const closer = close.exec(input);
    if (closer === null) return;
    if (!visit(match[0], input.slice(innerStart, closer.index))) return;
    cursor = closer.index + closer[0].length;
    open.lastIndex = cursor;
  }
}

/**
 * Inner text of the FIRST `open … close` span, or `undefined` when there is
 * none. Same linear guarantee as `removeSpans` — used for `<title>`, which is
 * captured rather than removed.
 */
function firstSpanInner(input: string, { open, close }: SpanPattern): string | undefined {
  open.lastIndex = 0;
  const match = open.exec(input);
  if (match === null) return undefined;
  const innerStart = match.index + match[0].length;
  close.lastIndex = innerStart;
  const closer = close.exec(input);
  if (closer === null) return undefined;
  return input.slice(innerStart, closer.index);
}

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
 * invariant 2 above). On a bot-walled page these tags are often the only
 * real content served.
 */
function extractMetaLines(cleanedHtml: string): { lines: string[]; title: string } {
  const lines: string[] = [];
  let pageTitle = '';

  const rawTitle = firstSpanInner(cleanedHtml, TITLE_SPAN);
  if (rawTitle !== undefined) {
    const t = decodeEntities(rawTitle.replace(TAG_RE, ' ')).replace(/\s+/g, ' ').trim();
    if (t) {
      pageTitle = t;
      lines.push(`title: ${t}`);
    }
  }

  // One pass over all <meta> tags; keep the name/property values that describe
  // the page. Attribute order varies across CMSes, so parse each tag's
  // attributes rather than assuming `name` precedes `content`.
  const KEEP = /^(description|keywords|author|og:[a-z_:]+|twitter:[a-z_:]+)$/i;
  // Machine metadata a language model cannot use: image URLs (it cannot see the
  // image), pixel dimensions, card-type and locale hints. On one real docs page
  // these alone were 1.6 KB of a 2.1 KB meta block.
  const DROP = /(^|:)(image|width|height|card|type|locale|url)(:|$)/i;
  // Dedup by VALUE, not by key+value. `title`, `og:title` and `twitter:title`
  // carry the same string on almost every page, and keying on the pair meant
  // they could never collide — the comment that used to sit here claimed the
  // opposite. Measured on a Mintlify docs page the meta block went 2061 -> 116
  // characters, which matters because search enrichment reads only the first 4000.
  const seenValues = new Set<string>();
  if (pageTitle) seenValues.add(pageTitle);
  for (const tag of cleanedHtml.match(META_TAG_RE) ?? []) {
    const key = META_KEY_RE.exec(tag)?.[1]?.trim();
    const val = META_CONTENT_RE.exec(tag)?.[1];
    if (!key || !val || !KEEP.test(key) || DROP.test(key)) continue;
    const clean = decodeEntities(val).replace(/\s+/g, ' ').trim();
    if (!clean || seenValues.has(clean)) continue;
    seenValues.add(clean);
    lines.push(`${key.toLowerCase()}: ${clean}`);
  }
  return { lines, title: pageTitle };
}

/**
 * Collect the same-site links a follow-up read could target.
 *
 * WHY this exists: nothing on any path gave the model a single href. Readability
 * discarded nav wholesale and the tag strip destroys every `<a>`, so an agent
 * asked to look further into a site had to GUESS slugs from priors — measured
 * over 15 runs it produced `/ueber-uns`, `/leistungen`, `/impressum` regardless
 * of what the site actually published, and a miss costs a full round-trip.
 *
 * SAME-SITE ONLY, and same-ORIGIN at that. The job is navigating a domain the
 * agent is already reading; off-site links are mostly social and partner noise,
 * and following them is what `web_research action='search'` is for. A docs
 * subdomain linking to its own marketing site is the known false negative —
 * cheap to widen later, expensive to un-widen.
 *
 * Read from CLEANED html for the same reason meta is (invariant 2): an `<a>`
 * inside a comment or a script string must not become a suggestion.
 */
function collectLinks(cleanedHtml: string, baseUrl: string | undefined): string[] {
  if (baseUrl === undefined) return [];
  let origin: string;
  try {
    origin = new URL(baseUrl).origin;
  } catch {
    return [];
  }

  const seen = new Set<string>([canonicalLink(baseUrl)]); // never suggest the page itself
  const out: string[] = [];

  forEachSpan(cleanedHtml, ANCHOR_SPAN, (openTag, inner) => {
    const href = HREF_RE.exec(openTag)?.[1];
    if (href === undefined || href === '') return true;

    let resolved: URL;
    try {
      resolved = new URL(decodeEntities(href), baseUrl);
    } catch {
      return true;
    }
    if (resolved.origin !== origin) return true;

    const target = resolved.pathname + resolved.search;
    if (UTILITY_LINK_RE.test(target) || ASSET_LINK_RE.test(target)) return true;

    const canonical = canonicalLink(resolved.toString());
    if (seen.has(canonical)) return true;

    // Anchor text is what makes a path decidable — `/x/42` alone tells nothing.
    // Bound the raw slice before any regex work: an <a> wrapping a whole article
    // is 250 KB of text we would clean and then throw away at 60 characters.
    // The headroom leaves room for tags and entities inside the label.
    const label = decodeEntities(inner.slice(0, MAX_LINK_TEXT_CHARS * 8).replace(TAG_RE, ' '))
      .replace(/\s+/g, ' ')
      .trim();
    if (label === '') return true;

    seen.add(canonical);
    out.push(`${target} — ${label.slice(0, MAX_LINK_TEXT_CHARS)}`);
    return out.length < MAX_EXTRACT_LINKS;
  });

  return out;
}

/** Dedup key. The hash is a position in one page; the QUERY is often the identity. */
function canonicalLink(href: string): string {
  try {
    const u = new URL(href);
    u.hash = '';
    return (u.pathname + u.search).replace(/\/$/, '') || '/';
  } catch {
    return href;
  }
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
  baseUrl?: string,
): HtmlExtractResult {
  const beforeChars = html.length;
  const source = html.length > MAX_EXTRACT_INPUT_CHARS ? html.slice(0, MAX_EXTRACT_INPUT_CHARS) : html;

  // Comments first, then whole block elements — BEFORE meta extraction, so
  // hidden markup cannot be promoted into the header lines (invariant 2).
  let cleaned = removeSpans(source, COMMENT_SPAN);
  for (const span of BLOCK_SPANS) {
    cleaned = removeSpans(cleaned, span);
  }

  const meta = extractMetaLines(cleaned);
  const links = collectLinks(cleaned, baseUrl);

  // <head> holds no visible text; its metadata was already captured above.
  let body = removeSpans(cleaned, HEAD_SPAN);

  // Mark headings before the generic tag strip so structure survives as text.
  for (const span of HEADING_SPANS) {
    body = removeSpans(body, span, (inner) => {
      const t = inner.replace(TAG_RE, ' ').replace(/\s+/g, ' ').trim();
      return t ? `\n## ${t}\n` : ' ';
    });
  }
  // Block-level boundaries become newlines so words don't fuse across elements.
  // `<br>` is void, so it needs its own pattern — it has no closing form.
  body = body.replace(BR_RE, '\n').replace(BLOCK_CLOSE_RE, '\n').replace(TAG_RE, ' ');

  body = decodeEntities(body)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // Links go ABOVE the body, next to the meta lines. Two reasons: the body opens
  // with navigation prose on most pages, so structure first is the better read;
  // and search enrichment only ever copies the first 4000 characters, which is
  // where a link list earns its keep.
  const header = [...meta.lines];
  if (links.length > 0) {
    header.push('', `links (same-site, first ${links.length}):`, ...links);
  }

  const composed = header.length > 0 ? `${header.join('\n')}\n\n${body}` : body;
  const truncated = composed.length > maxChars;
  const text = truncated ? composed.slice(0, maxChars) : composed;

  return { text, title: meta.title, beforeChars, afterChars: text.length, truncated };
}
