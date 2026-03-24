import { promises as dns } from 'node:dns';

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

// --- SSRF protection (copied from tools/builtin/http.ts) ---

function isPrivateIP(ip: string): boolean {
  const mapped = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  const v4Parts = mapped.split('.');
  if (v4Parts.length === 4 && v4Parts.every(p => /^\d{1,3}$/.test(p))) {
    const nums = v4Parts.map(Number);
    if (nums.some(n => n < 0 || n > 255)) return false;
    const [a, b, c] = nums as [number, number, number, number];
    if (a === 127) return true;
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a === 192 && b === 0 && c === 0) return true;
    if (a === 0) return true;
    if (a >= 224) return true;
  }
  const normalized = ip.toLowerCase();
  if (normalized.includes(':')) {
    if (normalized === '::1' || normalized === '::') return true;
    if (/^fe[89ab][0-9a-f]:/.test(normalized)) return true;
    if (/^f[cd][0-9a-f]{2}:/.test(normalized)) return true;
    if (/^ff[0-9a-f]{2}:/.test(normalized)) return true;
  }
  return false;
}

async function validateUrl(rawUrl: string): Promise<void> {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Blocked: unsupported protocol "${parsed.protocol}"`);
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  if (isPrivateIP(hostname)) {
    throw new Error(`Blocked: private IP address "${hostname}"`);
  }
  const resolved = await dns.lookup(hostname, { all: true, verbatim: true }).catch(() => []);
  for (const record of resolved) {
    if (isPrivateIP(record.address)) {
      throw new Error(`Blocked: "${hostname}" resolves to private IP "${record.address}"`);
    }
  }
}

// --- Fetch with redirect validation ---

async function fetchWithRedirects(url: string): Promise<Response> {
  let currentUrl = url;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    await validateUrl(currentUrl);
    const response = await fetch(currentUrl, {
      redirect: 'manual',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Nodyn/1.0; +https://nodyn.dev)',
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

function stripHtmlTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export async function extractContent(url: string, maxChars?: number): Promise<ExtractedContent> {
  const limit = maxChars ?? DEFAULT_MAX_CHARS;

  const response = await fetchWithRedirects(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('html') && !contentType.includes('text')) {
    throw new Error(`Unsupported content type: ${contentType}`);
  }

  const html = await readBodyLimited(response, MAX_HTML_BYTES);

  let title = '';
  let content = '';

  // Try Readability first (dynamic import for tree-shaking)
  try {
    const { parseHTML } = await import('linkedom');
    const { Readability } = await import('@mozilla/readability');
    const { document } = parseHTML(html);
    const article = new Readability(document).parse();
    if (article) {
      title = article.title ?? '';
      content = (article.textContent ?? '').replace(/\s+/g, ' ').trim();
    }
  } catch {
    // Readability failed — fall back to tag stripping
  }

  // Fallback: strip HTML tags
  if (!content) {
    content = stripHtmlTags(html);
    const titleMatch = /<title[^>]*>([^<]+)<\/title>/i.exec(html);
    if (titleMatch?.[1]) title = titleMatch[1].trim();
  }

  const truncated = content.length > limit;
  if (truncated) content = content.slice(0, limit);

  return {
    title: title || new URL(url).hostname,
    content,
    url,
    wordCount: content.split(/\s+/).length,
    truncated,
  };
}
