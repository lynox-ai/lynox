import { promises as dns } from 'node:dns';

/**
 * Reject outbound network targets that point at private / reserved / loopback /
 * cloud-metadata addresses. Used everywhere a hostname or URL comes from a
 * caller we don't fully trust (LLM agent input, third-party API response,
 * customer-configured IMAP/SMTP server, etc.).
 *
 * IPv4 + IPv6 + IPv4-mapped-IPv6 (`::ffff:7f00:1` style) all covered.
 */
export function isPrivateIP(ip: string): boolean {
  // IPv4-mapped IPv6 — strip the prefix and run the v4 checks.
  // Accepts both dotted (`::ffff:127.0.0.1`) and hex (`::ffff:7f00:1`) forms;
  // hex is normalised to dotted by parsing the last two colon-separated groups
  // as the high/low 16 bits of the embedded IPv4.
  const lowered = ip.toLowerCase();
  let mapped = lowered.startsWith('::ffff:') ? lowered.slice(7) : lowered;
  if (!mapped.includes('.') && mapped.includes(':') && lowered.startsWith('::ffff:')) {
    const groups = mapped.split(':');
    if (groups.length === 2) {
      const hi = groups[0] ?? '';
      const lo = groups[1] ?? '';
      if (/^[0-9a-f]{1,4}$/.test(hi) && /^[0-9a-f]{1,4}$/.test(lo)) {
        const hiN = parseInt(hi, 16);
        const loN = parseInt(lo, 16);
        mapped = `${String((hiN >> 8) & 0xff)}.${String(hiN & 0xff)}.${String((loN >> 8) & 0xff)}.${String(loN & 0xff)}`;
      }
    }
  }
  const v4Parts = mapped.split('.');
  if (v4Parts.length === 4 && v4Parts.every(p => /^\d{1,3}$/.test(p))) {
    const nums = v4Parts.map(Number);
    if (nums.some(n => n < 0 || n > 255)) return false;
    const [a, b, c] = nums as [number, number, number, number];
    if (a === 127) return true;                              // loopback
    if (a === 10) return true;                               // RFC1918
    if (a === 172 && b >= 16 && b <= 31) return true;        // RFC1918
    if (a === 192 && b === 168) return true;                 // RFC1918
    if (a === 169 && b === 254) return true;                 // link-local / metadata
    if (a === 100 && b >= 64 && b <= 127) return true;       // CGNAT
    if (a === 198 && (b === 18 || b === 19)) return true;    // benchmarking
    if (a === 192 && b === 0 && c === 0) return true;        // IETF protocol assignments
    if (a === 0) return true;                                // "this network"
    if (a >= 224) return true;                               // multicast + reserved
  }
  const normalized = ip.toLowerCase();
  if (normalized.includes(':')) {
    if (normalized === '::1' || normalized === '::') return true;
    if (/^fe[89ab][0-9a-f]:/.test(normalized)) return true;   // link-local
    if (/^f[cd][0-9a-f]{2}:/.test(normalized)) return true;   // unique local
    if (/^ff[0-9a-f]{2}:/.test(normalized)) return true;      // multicast
  }
  return false;
}

/**
 * Throws if `hostname` is a private/reserved/loopback literal IP or resolves to
 * one. Use before opening any non-HTTP connection (IMAP, SMTP, etc.) where the
 * caller supplied a hostname.
 */
export async function assertPublicHost(hostname: string): Promise<void> {
  const cleaned = hostname.replace(/^\[|\]$/g, '');
  if (isPrivateIP(cleaned)) {
    throw new Error(`Blocked: private IP address "${cleaned}"`);
  }
  const resolved = await dns.lookup(cleaned, { all: true, verbatim: true }).catch(() => []);
  for (const record of resolved) {
    if (isPrivateIP(record.address)) {
      throw new Error(`Blocked: "${cleaned}" resolves to private IP "${record.address}"`);
    }
  }
}

/**
 * Throws unless `rawUrl` is an http/https URL whose hostname is not private /
 * reserved / loopback. Use before any `fetch()` of a URL that came from a
 * caller we don't fully trust.
 */
export async function assertPublicUrl(rawUrl: string): Promise<void> {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Blocked: unsupported protocol "${parsed.protocol}"`);
  }
  await assertPublicHost(parsed.hostname);
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DEFAULT_MAX_REDIRECTS = 5;

/**
 * Fetch a URL after validating that every hop (initial + each redirect) targets
 * a public host. Returns the final non-redirect response. Re-throws the
 * `Blocked: ...` error on any private-IP hit, so callers don't need their own
 * validation.
 *
 * Notes:
 *  - `init.redirect` is always overridden to `'manual'` — the caller cannot
 *    opt out of revalidation.
 *  - 301/302/303 with non-GET methods are rewritten to GET per RFC 9110, body
 *    dropped, to match `fetch()` default-redirect semantics.
 */
export async function fetchWithPublicRedirects(
  url: string,
  init: RequestInit = {},
  opts: { maxRedirects?: number } = {},
): Promise<Response> {
  const max = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  let currentUrl = url;
  let method = (init.method ?? 'GET').toUpperCase();
  let body = init.body;

  for (let i = 0; i <= max; i++) {
    await assertPublicUrl(currentUrl);
    const requestInit: RequestInit = {
      ...init,
      method,
      redirect: 'manual',
    };
    if (body !== undefined) {
      requestInit.body = body;
    }
    const response = await fetch(currentUrl, requestInit);

    if (!REDIRECT_STATUSES.has(response.status)) {
      return response;
    }

    const location = response.headers.get('location');
    if (!location) {
      throw new Error(`Blocked: redirect without location header (${response.status})`);
    }
    if (i === max) {
      throw new Error(`Blocked: too many redirects (>${max})`);
    }

    const nextUrl = new URL(location, currentUrl).toString();
    // 301/302 → GET for non-GET/HEAD; 303 → GET always (per RFC 9110).
    if (response.status === 303 && method !== 'GET' && method !== 'HEAD') {
      method = 'GET';
      body = undefined;
    } else if ((response.status === 301 || response.status === 302) && method !== 'GET' && method !== 'HEAD') {
      method = 'GET';
      body = undefined;
    }
    currentUrl = nextUrl;
  }

  throw new Error('Blocked: redirect handling failed');
}
