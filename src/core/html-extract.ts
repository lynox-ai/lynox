// === HTML → text extraction for oversized `http_request` responses ===
//
// `maybeShapeJson` caps heavy JSON APIs so an unshaped pull can't inject tens of
// KB into the context. HTML had no equivalent: `http.ts` handed a `text/html`
// body straight through (`else { body = text }`), bounded only by the 100KB read
// limit and the agent's 80KB tool-result cap. Both are byte cuts, so a large page
// arrived as raw markup, truncated mid-tag.
//
// What that costs, measured on the onboarding website scan of amazona.de
// (thread `Amazonas Analyseergebnisse`, 2026-07-27, engine f6481302):
//   raw page          204,104 chars (~51k tokens)
//   agent actually saw 80,000 chars — 39% of the page, cut mid-tag
//   text-extracted      5,161 chars (~1.3k tokens)   -97%
//   meta + H1-H3        2,416 chars (~0.6k tokens)   -98.8%
// The tool result was 91% of the thread's context bytes and, with no cache
// discount on the Mistral path, was re-billed on every following turn — the
// follow-up question "why was that so expensive?" cost $0.078 on its own,
// without making a single tool call.
//
// Extraction keeps what a page-analysis task actually reads — title, meta/OG
// description, heading structure, visible text — and drops scripts, styles and
// markup. It runs only ABOVE a threshold, mirroring `DEFAULT_SHAPE_THRESHOLD_CHARS`:
// small pages pass through untouched so fetching a snippet of markup still works.
//
// Pure module — no I/O, no LLM. The caller still wraps the result in
// <untrusted_data> (`data-boundary.ts`); dropping <script> shrinks the injection
// surface rather than widening it.

/**
 * Below this size an HTML body is returned raw. Mirrors the JSON safety-net
 * threshold (`DEFAULT_SHAPE_THRESHOLD_CHARS`, http.ts) — the point is to stop
 * a page from swamping the context, not to reshape every small fetch.
 */
export const DEFAULT_HTML_EXTRACT_THRESHOLD_CHARS = 30_000;

/**
 * Cap on the extracted text. Matches `DEFAULT_LARGE_RESPONSE_SHAPE.max_chars`
 * so HTML and JSON land in the same context budget. Real pages extract far
 * below this (amazona.de: 5,161 chars), so the cap is a backstop for
 * text-heavy documents, not the normal path.
 */
export const DEFAULT_HTML_EXTRACT_MAX_CHARS = 24_000;

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

/** Guard `fromCodePoint` — a malformed entity must not throw mid-extraction. */
function safeCodePoint(cp: number): string {
  if (!Number.isFinite(cp) || cp < 0 || cp > 0x10FFFF) return '';
  try {
    return String.fromCodePoint(cp);
  } catch {
    return '';
  }
}

/**
 * Pull `<title>` plus the meta tags that carry positioning copy. These live in
 * ATTRIBUTES, so they must be read before tag-stripping throws them away — and
 * on a bot-walled page they are often the only real content served.
 */
function extractMetaLines(html: string): string[] {
  const lines: string[] = [];

  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (title?.[1]) {
    const t = decodeEntities(title[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (t) lines.push(`title: ${t}`);
  }

  // One pass over all <meta> tags; keep the name/property values that describe
  // the page. Attribute order varies across CMSes, so parse each tag's
  // attributes rather than assuming `name` precedes `content`.
  const KEEP = /^(description|keywords|author|og:[a-z_:]+|twitter:[a-z_:]+)$/i;
  const seen = new Set<string>();
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const key = /(?:name|property)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.trim();
    const val = /content\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
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
  return lines;
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

  const metaLines = extractMetaLines(html);

  let body = html;
  for (const el of BLOCK_ELEMENTS) {
    body = body.replace(new RegExp(`<${el}\\b[^>]*>[\\s\\S]*?<\\/${el}>`, 'gi'), ' ');
    // A body byte-truncated at the read limit can end inside an open block —
    // the paired regex above cannot match it, which would leak raw JS/CSS into
    // the text. Drop any such unterminated tail.
    body = body.replace(new RegExp(`<${el}\\b[^>]*>[\\s\\S]*$`, 'i'), ' ');
  }
  body = body.replace(/<!--[\s\S]*?-->/g, ' ');
  // <head> holds no visible text; its metadata was already captured above.
  body = body.replace(/<head\b[^>]*>[\s\S]*?<\/head>/i, ' ');

  // Mark headings before the generic tag strip so structure survives as text.
  body = body.replace(/<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, _lvl: string, inner: string) => {
    const t = inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return t ? `\n## ${t}\n` : ' ';
  });
  // Block-level boundaries become newlines so words don't fuse across elements.
  body = body.replace(/<\/(p|div|li|tr|section|article|header|footer|nav|br)\s*>/gi, '\n');
  body = body.replace(/<[^>]+>/g, ' ');

  body = decodeEntities(body)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const composed = metaLines.length > 0 ? `${metaLines.join('\n')}\n\n${body}` : body;
  const truncated = composed.length > maxChars;
  const text = truncated ? composed.slice(0, maxChars) : composed;

  return { text, beforeChars, afterChars: text.length, truncated };
}
