import { fetchPinned, assertHostPolicy } from '../../core/network-guard.js';
import { extractHtmlText, isHtmlContentType } from '../../core/html-extract.js';
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
 * air-gapped / allow-listed policy can't be bypassed by phrasing exfil as a
 * search query. web_research is a DISCOVERY surface: open under `guarded`
 * (credential-free reads) but still SSRF/enforce_https gated and fully blocked
 * under `deny-all`. Delegates to the shared network-guard SSOT so the policy
 * lives in one place. `ToolContext` structurally satisfies HostPolicyContext.
 */
export function assertEgressAllowed(rawUrl: string, ctx?: ToolContext | undefined): void {
  assertHostPolicy(rawUrl, 'discovery', ctx);
}

// --- Fetch with redirect validation ---

async function fetchWithRedirects(url: string, ctx?: ToolContext | undefined): Promise<Response> {
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
    if (!REDIRECT_STATUSES.has(response.status)) return response;
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

// --- HTML to text extraction ---
//
// This path used to run Mozilla Readability first and only strip tags when
// Readability THREW. Measured on 30 real pages (2026-07-28), that lost 70-93% of
// the page on documentation and JS-rendered sites — Readability's article
// heuristic routinely picked a code sample or the nav bar as "the article":
// docs.stripe.com/payments/quickstart returned 237 characters, all of them
// navigation labels; the GitHub REST reference returned a JSON example payload;
// a Resend API reference returned parameter DESCRIPTIONS with the parameter
// names dropped. The fallback could not save any of them, because it only fires
// on `!content` and a 237-char miss is truthy.
//
// No cheap signal separates "Readability did its job" from "Readability grabbed
// the wrong element": retention ratio overlaps across the two (a correct
// svelte.dev extraction scores 0.25, a failed stripe one 0.24), and so does
// heading coverage. So there is nothing to gate on — the selection step is gone
// and every page goes through the shared extractor, which strips rather than
// selects and therefore cannot silently lose the content. It costs boilerplate
// on prose articles (measured 1.10-1.42x) and buys 4-14x on the pages that
// return nothing usable today.

/** `''.split(/\s+/)` is `['']`, so a plain `.length` reports 1 word for an empty page. */
function countWords(text: string): number {
  const t = text.trim();
  return t === '' ? 0 : t.split(/\s+/).length;
}

export async function extractContent(url: string, maxChars?: number, ctx?: ToolContext | undefined): Promise<ExtractedContent> {
  const limit = maxChars ?? DEFAULT_MAX_CHARS;

  const response = await fetchWithRedirects(url, ctx);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('html') && !contentType.includes('text')) {
    throw new Error(`Unsupported content type: ${contentType}`);
  }

  const body = await readBodyLimited(response, MAX_HTML_BYTES);

  // The content-type check above also admits `text/plain`. Plain text has no
  // markup to strip, and running the extractor over it would eat any real text
  // that merely LOOKS like a tag (`a <b` in prose, `<config>` in a log). Only
  // markup goes through the extractor.
  if (!isHtmlContentType(contentType)) {
    const truncated = body.length > limit;
    const content = truncated ? body.slice(0, limit) : body;
    return { title: new URL(url).hostname, content, url, wordCount: countWords(content), truncated };
  }

  const extracted = extractHtmlText(body, limit);

  return {
    title: extracted.title || new URL(url).hostname,
    content: extracted.text,
    url,
    wordCount: countWords(extracted.text),
    truncated: extracted.truncated,
  };
}
