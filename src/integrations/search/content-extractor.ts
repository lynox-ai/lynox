import { fetchPinned, assertHostPolicy } from '../../core/network-guard.js';
import {
  extractHtmlText,
  isHtmlContentType,
  MIN_USEFUL_EXTRACT_CHARS,
  DEFAULT_HTML_EXTRACT_THRESHOLD_CHARS,
} from '../../core/html-extract.js';
import type { ToolContext } from '../../core/tool-context.js';

export interface ExtractedContent {
  title: string;
  content: string;
  url: string;
  wordCount: number;
  truncated: boolean;
}

const MAX_HTML_BYTES = 500_000;
const DEFAULT_MAX_CHARS = 50_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

// --- SSRF protection ---
//
// isPrivateIP + the IP-pinning fetch helper come from core/network-guard.ts —
// see that module for the canonical implementation (decodes IPv4-mapped-IPv6
// incl. hex form, and pins the http(s) connection to the validated IP to
// close the DNS-rebinding window between validate + connect).

/**
 * Egress gate for the web_research tool surface — used by BOTH the content/page
 * fetch (below) AND the search-query path (search-provider.ts), so an
 * deny-all / allow-listed policy can't be bypassed by phrasing exfil as a
 * search query. web_research is a DISCOVERY surface: open under `guarded`
 * (credential-free reads) but still SSRF/enforce_https gated and fully blocked
 * under `deny-all`. Delegates to the shared network-guard SSOT so the policy
 * lives in one place. `ToolContext` structurally satisfies HostPolicyContext.
 */
export function assertEgressAllowed(rawUrl: string, ctx?: ToolContext | undefined): void {
  assertHostPolicy(rawUrl, 'discovery', ctx);
}

// --- Fetch with redirect validation ---

/**
 * Returns the final hop alongside the response. The URL matters to the caller,
 * not just the bytes: link extraction resolves relative hrefs against it and
 * filters on its origin, so handing back the REQUESTED url would let one 302
 * to an attacker attribute the attacker's paths to the origin the agent trusts.
 * `response.url` cannot serve here — `fetchPinned` constructs its Responses,
 * so that field is always empty.
 */
async function fetchWithRedirects(
  url: string,
  ctx?: ToolContext | undefined,
): Promise<{ response: Response; finalUrl: string }> {
  let currentUrl = url;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    assertEgressAllowed(currentUrl, ctx);
    // fetchPinned does the DNS-resolve + IP validation + connection-pinning in
    // one shot — no rebind window between validate and connect.
    const response = await fetchPinned(currentUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; lynox/1.0; +https://lynox.ai)',
        Accept: 'text/html,application/xhtml+xml,*/*',
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!REDIRECT_STATUSES.has(response.status)) return { response, finalUrl: currentUrl };
    const location = response.headers.get('location');
    if (!location) throw new Error(`Redirect without location header (${response.status})`);
    if (i === MAX_REDIRECTS) throw new Error(`Too many redirects (>${MAX_REDIRECTS})`);
    currentUrl = new URL(location, currentUrl).toString();
  }
  throw new Error('Redirect handling failed');
}

// --- Streaming body reader ---

async function readBodyLimited(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const remaining = maxBytes - bytes;
      if (remaining <= 0) break;
      if (value.byteLength <= remaining) {
        bytes += value.byteLength;
        text += decoder.decode(value, { stream: true });
      } else {
        bytes += remaining;
        text += decoder.decode(value.subarray(0, remaining), { stream: true });
        break;
      }
    }
    text += decoder.decode();
    try { await reader.cancel(); } catch { /* ignore */ }
    return text;
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
}

// --- Body to text ---
//
// WHY there is no "pick the article" step here: this path used to run Mozilla
// Readability and fall back to tag-stripping only when Readability threw or
// returned nothing. On documentation and JS-rendered sites its article
// heuristic routinely scored a code sample or the nav bar highest and returned
// that alone; a short-but-non-empty wrong answer is truthy, so the fallback
// never fired.
//
// The obvious repair — keep Readability, detect when it underperforms — is not
// buildable: correct and broken extractions overlap on every cheap signal that
// was measured (retained-text ratio, coverage of the page's own heading). So
// this path strips the whole document instead of selecting part of it.
// Stripping cannot silently lose content; it can only carry boilerplate, which
// costs tokens but never fails the task. Measurements are in PR #1081.

/** `''.split(/\s+/)` is `['']`, so a plain `.length` reports 1 word for an empty page. */
function countWords(text: string): number {
  const t = text.trim();
  return t === '' ? 0 : t.split(/\s+/).length;
}

/**
 * Content types whose body is markup and must be stripped to text. Wider than
 * `isHtmlContentType`, which gates the `http_request` tool and is deliberately
 * strict: this function's outer gate already admits anything containing `html`
 * or `text`, so routing on the strict predicate alone handed `text/xml` and
 * `application/html` to the model as raw tags — something the previous
 * tag-stripping path never did.
 */
function isMarkupContentType(contentType: string): boolean {
  const ct = contentType.toLowerCase();
  return isHtmlContentType(ct) || ct.includes('html') || ct.includes('xml');
}

export async function extractContent(url: string, maxChars?: number, ctx?: ToolContext | undefined): Promise<ExtractedContent> {
  const limit = maxChars ?? DEFAULT_MAX_CHARS;

  const { response, finalUrl } = await fetchWithRedirects(url, ctx);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('html') && !contentType.includes('text')) {
    throw new Error(`Unsupported content type: ${contentType}`);
  }

  const body = await readBodyLimited(response, MAX_HTML_BYTES);

  // Markup goes through the extractor; everything else is served as received.
  // Plain text must NOT be extracted: it has no markup, and stripping would eat
  // real prose that merely looks like a tag (`if 3 <b and b> 4`, `<config>` in
  // a log line).
  if (!isMarkupContentType(contentType)) {
    const truncated = body.length > limit;
    const content = truncated ? body.slice(0, limit) : body;
    return { title: new URL(url).hostname, content, url, wordCount: countWords(content), truncated };
  }

  const extracted = extractHtmlText(body, { maxChars: limit, baseUrl: finalUrl });

  // Same keep-raw guard `http_request` applies: a JS-rendered shell, or a body
  // byte-cut at MAX_HTML_BYTES inside an open <script>, extracts to almost
  // nothing — measured 197 characters for a 500 KB news homepage. Handing back
  // that much boilerplate loses what the markup still carries (inline JSON,
  // data attributes) and guarantees the agent refetches, paying twice.
  //
  // The SIZE condition is what makes it a failure signal rather than a
  // description. `http_request` gets it for free by only extracting above the
  // threshold; this path extracts every body, so it must ask explicitly. On a
  // small document a short extraction is simply a short document, and handing
  // back its raw markup instead would be strictly worse.
  if (extracted.bodyChars < MIN_USEFUL_EXTRACT_CHARS && body.length > DEFAULT_HTML_EXTRACT_THRESHOLD_CHARS) {
    const truncated = body.length > limit;
    const content = truncated ? body.slice(0, limit) : body;
    return { title: extracted.title || new URL(url).hostname, content, url, wordCount: countWords(content), truncated };
  }

  return {
    title: extracted.title || new URL(url).hostname,
    content: extracted.text,
    url,
    wordCount: countWords(extracted.text),
    truncated: extracted.truncated,
  };
}
