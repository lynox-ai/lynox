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
  for (const raw of overrideCandidates(headers, url)) {
    const m = raw.trim().toUpperCase();
    if (m === '') continue;
    if (!KNOWN_METHODS.has(m)) return null;
    if (rank(m) > 0 && rank(m) >= rank(effective)) effective = m;
  }
  return effective;
}

/** Every override value the request carries, raw: the three header names, then `?_method=`. */
function overrideCandidates(headers: Record<string, string>, url: string): string[] {
  const candidates: string[] = [];
  for (const [name, value] of Object.entries(headers)) {
    if (OVERRIDE_HEADERS.has(name.trim().toLowerCase())) candidates.push(value);
  }
  try {
    for (const [name, value] of new URL(url).searchParams) {
      if (name.toLowerCase() === '_method') candidates.push(value);
    }
  } catch { /* an unparsable URL is refused before it is sent */ }
  return candidates;
}

/**
 * Every write a server may run this request as, sorted: the method that is sent and each
 * override, whichever one a server reads. `effectiveWriteMethod` picks the strongest, and among
 * writes of the same rank (POST, PUT, PATCH) that is only the last one named — a server that
 * ignores the overrides runs the sent method, one that reads another header than the last runs
 * that. A check that holds for the gated method alone holds for one of these, not for the
 * request. Call it after `effectiveWriteMethod` has accepted the request: values that are not
 * a method are not repeated here.
 */
export function writeMethodsNamed(method: string, headers: Record<string, string>, url: string): string[] {
  const named = new Set<string>();
  for (const raw of [method, ...overrideCandidates(headers, url)]) {
    const m = raw.trim().toUpperCase();
    if (KNOWN_METHODS.has(m) && rank(m) > 0) named.add(m);
  }
  return [...named].sort();
}

/** Headers a server or a proxy in front of it may route on instead of the URL, by name. */
const RETARGETING_HEADERS = new Set(['host', 'x-host', 'forwarded']);

/**
 * …and by family: a proxy fills the `X-Forwarded-*` set (host, server, prefix, proto, port)
 * and a front end reads `X-Original-*` / `X-Rewrite-*` to route on, so a new member of a
 * family is caught without being named here, the bare family word included. `X-Forwarded-For` names the client, not the
 * target. Not a `*-host` suffix: that would catch `X-RapidAPI-Host`, which does route, but
 * only among the APIs behind the one gateway host the write is approved for, and RapidAPI
 * asks for it on its calls. Left out on purpose, as an accepted exception.
 */
const RETARGETING_FAMILIES = ['x-forwarded', 'x-original', 'x-rewrite'];

function isRetargetingHeaderName(raw: string): boolean {
  const name = raw.trim().toLowerCase();
  if (RETARGETING_HEADERS.has(name)) return true;
  return name !== 'x-forwarded-for' && RETARGETING_FAMILIES.some((family) => name.startsWith(family));
}

/** The first header the request sets that re-targets it away from its URL, by its name. */
export function retargetingHeader(headers: Record<string, string>): string | undefined {
  return Object.keys(headers).find(isRetargetingHeaderName);
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

/** Percent-decode every `%XX` run the way a WHATWG server reads it: the bytes as UTF-8, a byte
 *  that is not valid UTF-8 as U+FFFD, and a malformed `%` (`%zz`) kept as it is. Not
 *  `decodeURIComponent`, which throws on the first invalid byte: a run it gave up on stayed
 *  encoded, so one `%FF` before an encoded secret hid the whole secret from the mask while the
 *  server still read it. `ignoreBOM`, so a leading `%EF%BB%BF` is decoded, not dropped. */
const UTF8_REPLACING = new TextDecoder('utf-8', { ignoreBOM: true });
function lenientDecode(text: string): string {
  return text.replace(/(?:%[0-9a-fA-F]{2})+/g, (run) =>
    UTF8_REPLACING.decode(Uint8Array.from(run.slice(1).split('%'), (hex) => parseInt(hex, 16))));
}

/** The same runs read the way a server that does not assume UTF-8 reads them, in the two
 *  single-byte forms in use: ISO-8859-1, one byte one character (`%E9` is `é`, `%80` is
 *  U+0080), and windows-1252, which is what `TextDecoder('latin1')` really decodes and which
 *  reads `%80` as `€`. They differ only in 0x80-0x9F. */
function latin1Decode(text: string): string {
  return text.replace(/%[0-9a-fA-F]{2}/g, (byte) => String.fromCharCode(parseInt(byte.slice(1), 16)));
}
const WINDOWS_1252 = new TextDecoder('windows-1252');
function windows1252Decode(text: string): string {
  return text.replace(/(?:%[0-9a-fA-F]{2})+/g, (run) =>
    WINDOWS_1252.decode(Uint8Array.from(run.slice(1).split('%'), (hex) => parseInt(hex, 16))));
}

/**
 * The steps a server may take on the way from the bytes it received to the value it uses:
 * percent-decoding as UTF-8 or in a single-byte charset, and `+` as a space, each on its own
 * or after one another. Taken up to three deep, counted from the bytes as sent, so a value
 * encoded up to three times (`%2573…`), or with `+` read only partly, is read the way such a
 * server reads it. A step that changes nothing yields the text itself, so the readings may
 * hold it: callers pass text already masked.
 */
const READING_STEPS: ReadonlyArray<(text: string) => string> = [lenientDecode, latin1Decode, windows1252Decode, (t) => t.replace(/\+/g, ' ')];
const READING_DEPTH = 3;
function serverReadings(text: string): Set<string> {
  const seen = new Set<string>();
  let frontier = [text];
  for (let depth = 0; depth < READING_DEPTH; depth++) {
    const next: string[] = [];
    for (const t of frontier) {
      for (const step of READING_STEPS) {
        const read = step(t);
        seen.add(read);
        next.push(read);
      }
    }
    frontier = next;
  }
  return seen;
}

/** Whether a server reading of `text` holds a secret `mask` knows. Asked of text the mask
 *  already ran over: a secret left after a reading was written in a form the mask did not see. */
function hidesEncodedSecret(text: string, mask: (text: string) => string): boolean {
  for (const read of serverReadings(text)) {
    if (mask(read) !== read) return true;
  }
  return false;
}

/**
 * One piece of a question (a path segment, a query key, a field name). `raw` is the piece as
 * sent, masked once; `read` is the reading the question shows, before its mask. Shown as `***`
 * when another server reading of `raw` (a second decoding, a single-byte charset) holds a secret: the
 * shown text would then hand that secret to whoever reads it, as `%73ecret` or as
 * `caf�-secret`. A secret only the shown reading holds is masked in it.
 */
function shownPiece(raw: string, read: string, mask: (text: string) => string): string {
  for (const other of serverReadings(raw)) {
    if (other !== read && mask(other) !== other) return '***';
  }
  return mask(read);
}

/** The name of one `name=value` pair of a form body or a query the caller masked whole: as
 *  sent (`raw`, masked raw as well as decoded, since `+` decodes to a space and a secret
 *  holding a `+` is then no longer the value the mask knows), and as shown, decoded (`read`). */
function formName(pair: string): { raw: string; read: string } {
  const raw = pair.split('=')[0]!;
  return { raw, read: lenientDecode(raw.replace(/\+/g, ' ')) };
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
  // Each name as sent (`raw`) and as shown (`read`): a form name is shown decoded.
  let names: Array<{ raw: string; read: string }> | undefined;
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      names = Object.keys(parsed).map((n) => ({ raw: mask(n), read: n }));
    }
  } catch {
    // Masked whole before the shape is read and the text split at `&` and `=`, so a secret
    // holding either (base64 padding) is still one value to the mask.
    const masked = mask(body);
    if (/^[^=&\s]+=[^&]*(?:&[^=&\s]+=[^&]*)*$/.test(masked)) names = masked.split('&').map((pair) => formName(pair));
  }
  if (!names) return `body of ${new TextEncoder().encode(body).byteLength} bytes`;
  if (names.length === 0) return 'empty object';
  // Masked whole, before the clip: a name may hold a resolved `secret:NAME`, and a clipped
  // secret is no longer one the mask recognises.
  const shown = names.slice(0, MAX_FIELDS).map((n) => `"${clipName(shownPiece(n.raw, n.read, mask), MAX_FIELD_CHARS)}"`);
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
  // found only in the decoded one, and the decoded form is what is shown. Segment by segment,
  // so another server reading of one (a second decoding, a single-byte charset) that turns it into a secret
  // stars that segment.
  // Masked whole first, so a secret holding a `/` is found before the split.
  const pieces = mask(parsed.pathname).split('/').map((raw) => {
    const read = lenientDecode(raw);
    const shown = shownPiece(raw, read, mask);
    return { left: shown === read ? raw : '', shown };
  });
  // A secret only a reading across segments holds (`%61/b` read twice) stars the whole path.
  const path = hidesEncodedSecret(pieces.map((p) => p.left).join('/'), mask)
    ? '/***'
    : pieces.map((p) => p.shown).join('/');
  // Keys from the query as sent, not `searchParams`: that decodes once as UTF-8 only. Masked
  // whole before the split, like a form body, so a secret holding `&` or `=` is still found.
  const rawKeys = mask(parsed.search).slice(1).split('&').filter((pair) => pair !== '');
  const keys = [...new Set(rawKeys.map((pair) => {
    const { raw, read } = formName(pair);
    return shownPiece(raw, read, mask);
  }))];
  const query = keys.length > 0 ? `?${keys.map((k) => `${k}=…`).join('&')}` : '';
  return clipName(`${path}${query}`, MAX_PATH_CHARS);
}

/**
 * The most of a write's body a question shows whole, in bytes of what is SENT (not of what
 * is shown: masking and indenting change the length of the display, never the decision).
 * Measured against request bodies shaped like real set-up steps (`~/lynox-plans/n12-measure/`:
 * a bexio contact 0.5 KB, an invoice with 15 positions 8.7 KB, an offer with 30 positions
 * 20.7 KB, a Shopify product with 100 variants 33.3 KB); only an inline binary upload went
 * past it. A body above it is never shown cut short.
 */
export const SHOWN_BODY_MAX_BYTES = 64 * 1024;

/** The size of a body as it is sent. */
export function sentBytes(body: string): number {
  return new TextEncoder().encode(body).byteLength;
}

/** Base64 (or a data: URI) long enough to be a file rather than a field. */
const INLINE_BINARY = /^(?:data:[^,]{0,100},)?[A-Za-z0-9+/_-]{1024,}={0,2}$/;

/** Whether a body carries a file inline: base64 as the whole body or as one JSON string. */
export function carriesInlineBinary(body: string): boolean {
  // Line breaks only: base64 is wrapped with them, prose is separated by spaces.
  const compact = (s: string) => s.replace(/[\r\n]+/g, '');
  if (INLINE_BINARY.test(compact(body))) return true;
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return false; }
  const stack: unknown[] = [parsed];
  while (stack.length > 0) {
    const v = stack.pop();
    if (typeof v === 'string' && v.length >= 1024 && INLINE_BINARY.test(compact(v))) return true;
    if (v !== null && typeof v === 'object') stack.push(...Object.values(v));
  }
  return false;
}

/**
 * Characters a reader cannot see, or that break a line where the display shows none, made
 * VISIBLE as `⟨U+XXXX⟩` rather than removed: the display must show what is sent, and a body
 * whose `ad\u200bmin` is shown as `admin` shows something else. Line breaks and tabs stay.
 */
function visible(text: string): string {
  return text.replace(/[\p{Cf}\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/gu,
    (c) => `⟨U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}⟩`);
}

/** A JSON text with the whitespace between tokens removed (strings left as they are). */
function minifyJson(text: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      out += c;
      if (c === '\\') { out += text[i + 1] ?? ''; i++; } else if (c === '"') inString = false;
    } else if (c === '"') { inString = true; out += c; } else if (!/\s/.test(c)) out += c;
  }
  return out;
}

/**
 * The body as the question shows it, every value with each secret the vault knows masked;
 * or why it cannot be shown.
 *
 * A JSON body is indented only when it is CANONICAL — re-serialising the parsed value gives
 * the same text, up to whitespace. Then every string (key and value) is masked as the decoded
 * string, so a secret is matched as the value it is. Any other JSON body (a duplicate key,
 * which a parser keeps one of and a server may read the other; an escape such as `A`)
 * is shown as it is sent, masked as text — and is not showable when a decoded string literal
 * holds a secret, because the escaped form is not one the mask recognises. In either kind, a
 * string whose percent-decoded form holds a secret makes the body not showable: no server may
 * decode it, but the reader of the question can.
 * A body sent as `application/x-www-form-urlencoded` is shown one `name = value` per line,
 * masked whole, then each part decoded and masked again. Any other body is masked as text, and
 * is not showable when its percent-decoded form still holds a secret. Invisible characters are
 * shown as their code point.
 * Whether the body is small enough to show is the caller's decision (`SHOWN_BODY_MAX_BYTES`).
 */
export function bodyForQuestion(body: string, mask: (text: string) => string, contentType = ''): { text: string } | { unshowable: 'escaped-secret' } {
  let parsed: unknown;
  let isJson = true;
  try { parsed = JSON.parse(body); } catch { isJson = false; }
  if (isJson) {
    if (JSON.stringify(parsed) === minifyJson(body)) {
      // A secret percent-encoded INSIDE a string is not shown either: a JSON server does not
      // decode it, but whoever reads the question can. The rule is "never in the display".
      let encodedSecret = false;
      const masked = (s: string): string => {
        const m = mask(s);
        if (hidesEncodedSecret(m, mask)) encodedSecret = true;
        return m;
      };
      const walk = (v: unknown): unknown => {
        if (typeof v === 'string') return masked(v);
        if (Array.isArray(v)) return v.map(walk);
        if (v !== null && typeof v === 'object') {
          return Object.fromEntries(Object.entries(v).map(([k, x]) => [masked(k), walk(x)]));
        }
        return v;
      };
      const text = visible(mask(JSON.stringify(walk(parsed), null, 2)));
      return encodedSecret ? { unshowable: 'escaped-secret' } : { text };
    }
    // Shown as sent, masked as text. Decided on what is LEFT after that mask: every string
    // literal of the masked TEXT, decoded one by one. One still holding a secret was written in
    // a form the text mask did not see (an escape); a secret written plainly is gone. Read from
    // the text, not from a parse, because a parse keeps only the last of two equal keys and the
    // shadowed one is sent all the same.
    const shownRaw = mask(body);
    try { JSON.parse(shownRaw); } catch { return { unshowable: 'escaped-secret' }; }
    for (const [literal] of shownRaw.matchAll(/"(?:[^"\\]|\\.)*"/g)) {
      const decoded = JSON.parse(literal) as string;
      if (mask(decoded) !== decoded || hidesEncodedSecret(decoded, mask)) return { unshowable: 'escaped-secret' };
    }
    return { text: visible(shownRaw) };
  }
  const shown = mask(body);
  // A form body is shown pair by pair only when it is SENT as one (its Content-Type): the same
  // text sent as text/plain is not `x = a b` but `x=a+b`. Masked WHOLE before it is cut at `&`
  // and `=`, so a secret holding either (base64 padding) is still one value to the mask; then
  // each part again once decoded, and starred when another server reading of it holds a
  // secret. A line break inside a decoded part is shown as `\n`, so a value cannot add a
  // `name = value` line of its own.
  if (FORM_CONTENT_TYPE.test(contentType) && /^[^=&\s]+=[^&]*(?:&[^=&\s]+=[^&]*)*$/.test(shown)) {
    const part = (raw: string) => shownPiece(raw, lenientDecode(raw.replace(/\+/g, ' ')), mask).replace(/\r?\n/g, '\\n');
    return {
      text: visible(shown.split('&').map((pair) => {
        const at = pair.indexOf('=');
        return `${part(pair.slice(0, at))} = ${part(pair.slice(at + 1))}`;
      }).join('\n')),
    };
  }
  // Any other body is shown as text, and the server may still read it percent-decoded (a form
  // sent without its Content-Type, or one whose masked secret removed its `=`/`&` structure).
  // A secret left in the decoded form was written in a form the text mask did not see.
  if (hidesEncodedSecret(shown, mask)) return { unshowable: 'escaped-secret' };
  return { text: visible(shown) };
}

/** The form media type alone, parameters allowed; a list of two types is not one form. */
const FORM_CONTENT_TYPE = /^\s*application\/x-www-form-urlencoded\s*(?:;[^,]*)?$/i;
