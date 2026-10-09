/**
 * What an outbound write is, decided once for the two ways a write leaves the engine to an
 * API host: `http_request` and a bulk run's `send()`.
 *
 * - The EFFECTIVE method: the strongest of the request's method and the method-override
 *   forms a server may honour instead of it. An override only ever raises the method.
 * - The normalized path: the form a server may route on, so that a path the table below
 *   names cannot be reached through an encoding of it.
 * - The outbound-effect table: paths that send something to a third party or issue it
 *   bindingly. A write to one is never remembered and never covered by a grant: each one is
 *   asked on its own, like a DELETE.
 *
 * Pure, so the rules are asserted directly; the callers apply them.
 */
import { singleLine } from './prompt-value.js';
import { normalizeApprovalHost } from './untrusted-epoch.js';

/** The two methods this engine reads with; everything else may change something. */
function isRead(method: string): boolean {
  return method === 'GET' || method === 'HEAD';
}

/** DELETE over every other write over the two reads. */
function rank(method: string): number {
  if (isRead(method)) return 0;
  return method === 'DELETE' ? 2 : 1;
}

/** Header names a server may read as the request's method, compared case-insensitively. */
const OVERRIDE_HEADERS = new Set(['x-http-method-override', 'x-http-method', 'x-method-override']);

/**
 * What an override may say: a method name from the registered set (RFC 9110 and the WebDAV
 * family). A shape check is not enough — `my-secret-value` is a valid token — and a value
 * that passes is shown in the question and the refusals. Anything else is refused, never shown.
 */
const KNOWN_METHODS = new Set([
  'GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE', 'CONNECT',
  'PROPFIND', 'PROPPATCH', 'MKCOL', 'COPY', 'MOVE', 'LOCK', 'UNLOCK', 'SEARCH', 'REPORT',
  'MERGE', 'MKACTIVITY', 'CHECKOUT', 'PURGE', 'LINK', 'UNLINK', 'NOTIFY', 'SUBSCRIBE', 'UNSUBSCRIBE', 'M-SEARCH',
]);

/**
 * The method a write is gated as. Every override form the request carries is read — the
 * three header names and a `_method` query parameter — and the strongest one wins over the
 * method when it is at least as strong: POST with an override DELETE is a DELETE, POST with
 * an override PATCH is asked as a PATCH, and POST with an override GET stays a POST. A server
 * that ignores the override loses nothing by this; one that honours it is gated on what it does.
 *
 * `null` when an override carries something that is not a method token: the value would
 * otherwise reach the question, the refusals and the approval key verbatim (any words, or a
 * resolved secret in upper case, which no exact-match mask finds). The caller refuses the
 * request without naming the value.
 */
export function effectiveWriteMethod(method: string, headers: Record<string, string>, url: string): string | null {
  let effective = method.trim().toUpperCase();
  // The schema offers six methods, but nothing below may rely on the model having kept to it.
  if (!KNOWN_METHODS.has(effective)) return null;
  const candidates: string[] = [];
  for (const [name, value] of Object.entries(headers)) {
    if (OVERRIDE_HEADERS.has(name.trim().toLowerCase())) candidates.push(value);
  }
  try {
    for (const [name, value] of new URL(url).searchParams) {
      if (name.toLowerCase() === '_method') candidates.push(value);
    }
  } catch { /* an unparsable URL is refused before it is sent */ }
  for (const raw of candidates) {
    const m = raw.trim().toUpperCase();
    if (m === '') continue;
    if (!KNOWN_METHODS.has(m)) return null;
    if (rank(m) > 0 && rank(m) >= rank(effective)) effective = m;
  }
  return effective;
}

/** Headers a server or a proxy in front of it may route on instead of the URL. */
const RETARGETING_HEADERS = new Set(['host', 'x-host', 'x-forwarded-host', 'forwarded', 'x-original-url', 'x-rewrite-url']);

/** The first header the request sets that re-targets it away from its URL, by its name. */
export function retargetingHeader(headers: Record<string, string>): string | undefined {
  return Object.keys(headers).find((name) => RETARGETING_HEADERS.has(name.trim().toLowerCase()));
}

/**
 * The path as a server may route it: percent-decoded exactly once, split at `/` and at `\`,
 * each segment cut at its first `;` (matrix parameters), lower-case, empty segments dropped
 * (`//`), no trailing slash. `.` and `..` are resolved for a caller that passes a raw path;
 * the WHATWG parser behind `URL.pathname` has already resolved the literal and the `%2e`
 * forms, so one left after the decoding came from an encoded slash.
 *
 * `ambiguous` is set when what the path routes to is not known here, and a caller treats it
 * as a hit: the decoding fails, a `%` is left after it (a double encoding such as `%2573`),
 * a dot segment is left after it, or it holds a control character, a space or a non-ASCII
 * character (a router may strip the first two, and an upper-casing one reads `ſend` as SEND).
 */
export function normalizeWritePath(pathname: string): { path: string; ambiguous: boolean } {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return { path: pathname.toLowerCase(), ambiguous: true };
  }
  let ambiguous = decoded.includes('%') || /[^\x21-\x7e]/u.test(decoded);
  const out: string[] = [];
  for (const raw of decoded.split(/[/\\]/)) {
    const segment = raw.split(';')[0]!.toLowerCase();
    if (segment === '' || segment === '.') { if (segment === '.') ambiguous = true; continue; }
    if (segment === '..') { ambiguous = true; out.pop(); continue; }
    out.push(segment);
  }
  return { path: `/${out.join('/')}`, ambiguous };
}

/**
 * Paths on an API host that send to a third party or issue something bindingly. Keyed by the
 * HOST and not by a connected profile: a call reaches a host with a preset profile, with a
 * token profile or with none, and the table holds for each of them. Matched per segment, for
 * every write method.
 *
 * bexio: `…/send` mails a document to its recipient, `…/issue` issues an invoice. Only these
 * two are named; bexio's full path catalogue was not checked against this list.
 */
export const OUTBOUND_EFFECT_PATHS: readonly { readonly host: string; readonly segments: readonly string[] }[] = [
  { host: 'api.bexio.com', segments: ['send', 'issue'] },
];

/** Whether a write to `url` with `method` is one the table names. A read never is. */
export function isOutboundEffectWrite(url: string, method: string): boolean {
  if (isRead(method.toUpperCase())) return false;
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }
  const host = normalizeApprovalHost(parsed.hostname);
  const entry = OUTBOUND_EFFECT_PATHS.find((e) => e.host === host);
  if (!entry) return false;
  const { path, ambiguous } = normalizeWritePath(parsed.pathname);
  if (ambiguous) return true;
  // A segment matches as itself or with a format suffix (`send.json`).
  return path.split('/').some((segment) => entry.segments.some((s) => segment === s || segment.startsWith(`${s}.`)));
}

/** Percent-decode every well-formed run and keep a malformed `%` as it is. `decodeURIComponent`
 *  throws on the first malformed one, and the WHATWG parser keeps those in a path, so one
 *  `%zz` would otherwise leave the whole path encoded and a secret in it unmasked. */
function lenientDecode(text: string): string {
  return text.replace(/(?:%[0-9a-fA-F]{2})+/g, (run) => {
    try { return decodeURIComponent(run); } catch { return run; }
  });
}

const MAX_FIELDS = 12;
const MAX_FIELD_CHARS = 40;
const MAX_PATH_CHARS = 160;

function clipName(name: string, max: number): string {
  const one = singleLine(name).trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

/**
 * The names a write's body sends, never their values: the top-level keys of a JSON object
 * or of a form-urlencoded body, clipped in number and length and made single-line (the names
 * come from the request, which an injected instruction may have written). A body of another
 * shape is described by its size.
 */
export function bodyFieldNames(body: string | undefined, mask: (text: string) => string = (t) => t): string {
  if (body === undefined || body === '') return 'no body';
  let names: string[] | undefined;
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) names = Object.keys(parsed);
  } catch {
    if (/^[^=&\s]+=[^&]*(?:&[^=&\s]+=[^&]*)*$/.test(body)) {
      // Masked raw as well as decoded: `+` decodes to a space, and a secret holding a `+` is
      // then no longer the value the mask knows.
      names = body.split('&').map((pair) => {
        const name = mask(pair.split('=')[0]!);
        return lenientDecode(name.replace(/\+/g, ' '));
      });
    }
  }
  if (!names) return `body of ${new TextEncoder().encode(body).byteLength} bytes`;
  if (names.length === 0) return 'empty object';
  // Masked whole, before the clip: a name may hold a resolved `secret:NAME`, and a clipped
  // secret is no longer one the mask recognises.
  const shown = names.slice(0, MAX_FIELDS).map((n) => `"${clipName(mask(n), MAX_FIELD_CHARS)}"`);
  const more = names.length > MAX_FIELDS ? ` and ${names.length - MAX_FIELDS} more` : '';
  return `fields ${shown.join(', ')}${more}`;
}

/**
 * The path a question names: the URL's path with the query's KEYS only, never its values,
 * after `mask` replaced every secret value (a `secret:NAME` reference is resolved before the
 * handler runs, so the URL may carry the value). Single-line and clipped.
 */
export function pathForQuestion(url: string, mask: (text: string) => string): string {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return '(unparsable)'; }
  // Masked in both forms, encoded and decoded: a secret with a character the URL encodes is
  // found only in the decoded one, and the decoded keys are what is shown.
  const path = mask(lenientDecode(mask(parsed.pathname)));
  const keys = [...new Set([...parsed.searchParams.keys()])].map((k) => mask(k));
  const query = keys.length > 0 ? `?${keys.map((k) => `${k}=…`).join('&')}` : '';
  return clipName(`${path}${query}`, MAX_PATH_CHARS);
}
