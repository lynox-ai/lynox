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

/**
 * The two methods this engine reads with; everything else may change something. The one
 * answer to "does this request only read?": every outbound gate calls it, and
 * `tests/read-method-one-source.test.ts` lists each remaining line that compares a method with GET or HEAD
 * with the other question it asks.
 *
 * An exact match, on purpose: no trim, no case fold. Each caller normalises the way its own
 * question needs (the effective method, the upper-cased input, or the raw one the exfiltration
 * check reads), and folding here would change what those callers decide. `null` and
 * `undefined` (an override that is not a method, no method at all) are not reads.
 */
export function isReadMethod(method: string | null | undefined): method is 'GET' | 'HEAD' {
  return method === 'GET' || method === 'HEAD';
}

/** DELETE over every other write over the two reads. */
function rank(method: string): number {
  if (isReadMethod(method)) return 0;
  return method === 'DELETE' ? 2 : 1;
}

/** Header names a server may read as the request's method, compared as `headerKey` reads them. */
const OVERRIDE_HEADERS = new Set(['x-http-method-override', 'x-http-method', 'x-method-override']);

/**
 * A header name the way a server may read it: trimmed, lower-case, and with `_` read as `-`.
 * A CGI-style server (PHP-FPM, and Symfony and Laravel behind it) maps both to the same
 * `HTTP_X_…` variable, so `X_HTTP_Method_Override` reaches it as the override header.
 */
function headerKey(raw: string): string {
  return raw.trim().toLowerCase().replace(/_/g, '-');
}

/**
 * What an override may say: a method name from the registered set (RFC 9110 and the WebDAV
 * family). A shape check is not enough — `my-secret-value` is a valid token — and a value
 * that passes is shown in the question and the refusals. Anything else is refused, never shown.
 * Which of them only read is answered by `isReadMethod` above, never by this set.
 */
const KNOWN_METHODS = new Set([
  'GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE', 'CONNECT',
  'PROPFIND', 'PROPPATCH', 'MKCOL', 'COPY', 'MOVE', 'LOCK', 'UNLOCK', 'SEARCH', 'REPORT',
  'MERGE', 'MKACTIVITY', 'CHECKOUT', 'PURGE', 'LINK', 'UNLINK', 'NOTIFY', 'SUBSCRIBE', 'UNSUBSCRIBE', 'M-SEARCH',
]);

/** A value no override may hold: a `_method` field in a JSON body that is not a string. */
const NOT_A_METHOD = '\0';

/**
 * Whether a form, query or multipart name (after its `%XX` escapes) may reach some server as a
 * method override. Parsers disagree, so this reads the name every way a common one does and
 * counts it when any reading names the override. That reads more names than any one parser,
 * never fewer:
 * - it ends at a NUL (PHP `parse_str`, measured on PHP 8.3);
 * - leading brackets and whitespace are dropped (Rack 2's nested-query parser, Express's `qs`
 *   for `[_method]`; PHP drops leading spaces);
 * - it ends at the first bracket (`_method[]`, `_method[0]`, `_method[x]y` in PHP and `qs`;
 *   `_method]` in Rack 2; `_method[` on purpose, though no parser named here reads it so), so
 *   a name whose brackets follow another one, such as `data[_method]`, stays that other field;
 * - `.` and whitespace read as `_` (PHP: `.method` reaches Laravel as `_method`); a name that
 *   starts with a dot is read once more with its leading dots dropped and cut at the next dot
 *   (`qs` with `allowDots` reads `._method` and `._method.` as `_method`);
 * - the case is dropped, and the override header names count as field names too (ASP.NET MVC
 *   reads `X-HTTP-Method-Override` from the form and the query).
 */
function isOverrideFieldName(key: string): boolean {
  const name = key.split('\0', 1)[0]!.replace(/^[\s[\]]+/, '');
  const base = name.split(/[[\]]/, 1)[0]!;
  const dotted = base.startsWith('.') ? [base.replace(/^\.+/, '').split('.', 1)[0]!] : [];
  return [base, ...dotted].some((reading) => {
    const read = reading.replace(/[.\s]/g, '_').toLowerCase();
    return read === '_method' || OVERRIDE_HEADERS.has(read);
  });
}

/** `text` with its `%XX` escapes read, the way a form or multipart parser reads a name. */
function percentDecoded(text: string): string {
  return text.replace(/%([0-9a-f]{2})/gi, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

/**
 * Whether a body that does not parse as JSON holds `_method` as a key: `"_method":`, once its
 * `\uXXXX` escapes are read. A value or a longer name that only contains the word is not one.
 */
function namesMethodKey(body: string): boolean {
  return methodKeysWritten(body) > 0;
}

/**
 * How many times the text writes a `_method` key in any case, `"_method"` followed by a colon
 * after optional whitespace, once its `\uXXXX` escapes are read.
 */
function methodKeysWritten(body: string): number {
  const unescaped = body.replace(/\\u([0-9a-f]{4})/gi, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  return unescaped.match(/"_method"\s*:/gi)?.length ?? 0;
}

/** How many keys named `_method` (any case) the parsed value holds, at any depth. */
function methodKeysParsed(value: unknown): number {
  if (value === null || typeof value !== 'object') return 0;
  let count = 0;
  for (const [name, inner] of Object.entries(value)) {
    if (name.toLowerCase() === '_method') count++;
    count += methodKeysParsed(inner);
  }
  return count;
}

/**
 * Whether the request names a `Content-Encoding` other than `identity`. A server that inflates
 * the body reads a field this module, which reads the body as written, cannot see.
 */
function encodedBody(headers: Record<string, string>): boolean {
  return Object.entries(headers)
    .filter(([name]) => headerKey(name) === 'content-encoding')
    .some(([, value]) => value.split(',').some((coding) => !['', 'identity'].includes(coding.trim().toLowerCase())));
}

/**
 * Charsets a server decodes the body's UTF-8 bytes in without turning any of them into ASCII the
 * gate did not read: UTF-8 itself, and single-byte supersets of ASCII whose bytes above 0x7F all
 * decode to characters above 0x7F. Not `ascii`: a decoder may drop the high bit.
 */
const ASCII_READING_CHARSETS = new Set(['utf-8', 'utf8', 'iso-8859-1', 'latin1', 'windows-1252']);

/**
 * Whether the Content-Type names a charset this module cannot read the body in. The body goes out
 * as UTF-8; a server that decodes it as UTF-16 (or UTF-32, UTF-7) reads other characters,
 * a `_method` field among them, than the ones written.
 */
function foreignCharset(contentType: string): boolean {
  // Every `charset` parameter counts, wherever it stands: one parser takes the last, another
  // finds the first by searching for the word, and the RFC 2231 forms (`charset*=`, `charset*0=`)
  // are ones too.
  for (const match of contentType.matchAll(/charset\s*(?:\*\d+)?\*?\s*=\s*("?)([^";,\s]*)\1/g)) {
    if (!ASCII_READING_CHARSETS.has(match[2]!)) return true;
  }
  return false;
}

/**
 * Whether a multipart body has a part whose name a server may read as `_method`. Folded header
 * lines are joined first. Each `name` parameter counts on its own, plain, quoted (with its
 * backslash escapes read) or in its RFC 2231 form (`name*=utf-8''_%6Dethod`), and so do the
 * numbered pieces of one (`name*0`, `name*1`) put together in their order. `filename` is not a name.
 */
function multipartNamesMethod(body: string): boolean {
  const unfolded = body.replace(/\r?\n[ \t]+/g, ' ');
  for (const line of unfolded.split(/\r?\n/)) {
    if (!/^\s*content-disposition\s*:/i.test(line)) continue;
    const names: string[] = [];
    const pieces: [number, string][] = [];
    for (const match of line.matchAll(/;\s*name(\*(\d+)?\*?)?\s*=\s*("(?:[^"\\]|\\.)*"|[^;]*)/gi)) {
      let value = match[3]!.trim();
      if (value.startsWith('"')) value = value.slice(1, -1).replace(/\\(.)/g, '$1');
      if (match[1]?.endsWith('*')) value = value.replace(/^[^']*'[^']*'/, '');
      value = percentDecoded(value);
      if (match[2] === undefined) names.push(value);
      else pieces.push([Number(match[2]), value]);
    }
    if (pieces.length > 0) names.push(pieces.sort(([a], [b]) => a - b).map(([, piece]) => piece).join(''));
    if (names.some(isOverrideFieldName)) return true;
  }
  return false;
}

/**
 * The `_method` fields of a request body, as a server that parses the body may read them
 * (Rack's MethodOverride and Laravel read the form or the JSON body; Express's method-override
 * reads whatever its body parser produced). Only top-level fields are read as overrides: a field
 * of that name inside a nested object, or a form key such as `data[_method]`, is ordinary data.
 *
 * Servers do not agree on which parser a Content-Type selects, so the body is read both as JSON
 * and as a form. A value from a parser the Content-Type names is `declared`, and one that is not
 * a method is refused like any other override; a value only the other parser finds counts when
 * it is a method. The form reading is left out only for a body declared as JSON alone that parses
 * as JSON: no server reads that as a form. `unreadable` is set when a server may read an
 * override this module cannot: a body that looks like JSON (by its type or its first character),
 * does not parse and holds a `"_method":` key; JSON that names the same `_method` key twice (in
 * any case, at any depth); a body under a multipart type with a part named `_method`; or a body
 * sent with a `Content-Encoding` other than `identity`, or in a charset outside a fixed list of
 * UTF-8 and single-byte ASCII supersets.
 * The caller gates such a request as the strongest method.
 */
function bodyOverrides(body: string, headers: Record<string, string>): { declared: string[]; other: string[]; unreadable: boolean } {
  const contentType = Object.entries(headers)
    .filter(([name]) => name.trim().toLowerCase() === 'content-type')
    .map(([, value]) => value).join(', ').toLowerCase();
  let json: string[] | null;
  // A key JSON names twice: `JSON.parse` keeps the last one, and a parser that keeps the first
  // one reads another method. The parsed value holds fewer `_method` keys than the text writes.
  let duplicateKey = false;
  try {
    const parsed: unknown = JSON.parse(body);
    duplicateKey = methodKeysWritten(body) > methodKeysParsed(parsed);
    json = parsed === null || typeof parsed !== 'object'
      ? []
      : Object.entries(parsed)
        .filter(([name]) => name.toLowerCase() === '_method')
        .map(([, value]) => (typeof value === 'string' ? value : NOT_A_METHOD));
  } catch {
    json = null;
  }
  const jsonDeclared = contentType.includes('json');
  const formDeclared = contentType.includes('application/x-www-form-urlencoded');
  const form = jsonDeclared && !formDeclared && json !== null
    ? []
    : [...new URLSearchParams(body)].filter(([name]) => isOverrideFieldName(name)).map(([, value]) => value);
  const looksJson = jsonDeclared || /^\s*[[{"]/.test(body);
  return {
    declared: [...(jsonDeclared ? json ?? [] : []), ...(formDeclared ? form : [])],
    other: [...(jsonDeclared ? [] : json ?? []), ...(formDeclared ? [] : form)],
    // A multipart type may follow a form type (`application/x-www-form-urlencoded, multipart/…`),
    // and a server that takes the first one reads the form: the multipart check is added to the
    // two readings, not put in their place.
    unreadable: (looksJson && json === null && namesMethodKey(body)) || duplicateKey ||
      (contentType.includes('multipart/') && multipartNamesMethod(body)) ||
      (body !== '' && (encodedBody(headers) || foreignCharset(contentType))),
  };
}

/**
 * The method a write is gated as. Every override form the request carries is read — the
 * three header names, a `_method` query parameter and a top-level `_method` field of the body —
 * and the strongest one wins over the method when it is at least as strong: POST with an
 * override DELETE is a DELETE, POST with an override PATCH is asked as a PATCH, and POST with an
 * override GET stays a POST. A server that ignores the override loses nothing by this; one that
 * honours it is gated on what it does. A body whose override a server may read but this module
 * cannot is gated as a DELETE (see `bodyOverrides`).
 *
 * `null` when an override carries something that is not a method token: the value would
 * otherwise reach the question, the refusals and the approval key verbatim (any words, or a
 * resolved secret in upper case, which no exact-match mask finds). The caller refuses the
 * request without naming the value.
 */
export function effectiveWriteMethod(method: string, headers: Record<string, string>, url: string, body?: BodyReadings): string | null {
  let effective = method.trim().toUpperCase();
  // The schema offers six methods, but nothing below may rely on the model having kept to it.
  if (!KNOWN_METHODS.has(effective)) return null;
  for (const raw of overrideCandidates(method, headers, url, body)) {
    const m = raw.trim().toUpperCase();
    if (m === '') continue;
    if (!KNOWN_METHODS.has(m)) return null;
    if (rank(m) > 0 && rank(m) >= rank(effective)) effective = m;
  }
  return effective;
}

/**
 * The body as the gate reads it: one string, or several readings of it. When the sender rewrites
 * the body after the gate (a repair of malformed JSON), the body as given and the body as sent
 * are both passed, and each override either names counts.
 */
export type BodyReadings = string | readonly string[];

/**
 * Every override value the request carries, raw: the three header names, then each query
 * parameter a server may read as an override (`isOverrideFieldName`), then each body reading's
 * (see `bodyOverrides`) unless the sent method is one that sends no body.
 */
function overrideCandidates(method: string, headers: Record<string, string>, url: string, body?: BodyReadings): string[] {
  const candidates: string[] = [];
  for (const [name, value] of Object.entries(headers)) {
    if (OVERRIDE_HEADERS.has(headerKey(name))) candidates.push(value);
  }
  try {
    for (const [name, value] of new URL(url).searchParams) {
      if (isOverrideFieldName(name)) candidates.push(value);
    }
  } catch { /* an unparsable URL is refused before it is sent */ }
  // A GET or HEAD sends no body, so nothing in one can override it.
  if (body !== undefined && !isReadMethod(method.trim().toUpperCase())) {
    for (const reading of typeof body === 'string' ? [body] : body) {
      const fromBody = bodyOverrides(reading, headers);
      candidates.push(...fromBody.declared);
      candidates.push(...fromBody.other.filter((value) => KNOWN_METHODS.has(value.trim().toUpperCase())));
      if (fromBody.unreadable) candidates.push('DELETE');
    }
  }
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
export function writeMethodsNamed(method: string, headers: Record<string, string>, url: string, body?: BodyReadings): string[] {
  const named = new Set<string>();
  for (const raw of [method, ...overrideCandidates(method, headers, url, body)]) {
    const m = raw.trim().toUpperCase();
    if (KNOWN_METHODS.has(m) && rank(m) > 0) named.add(m);
  }
  return [...named].sort();
}

/**
 * Everything the write gates read off a request's headers, as they read it: the method it is
 * gated as, every write it names, and a header that re-targets it. A sender that adds headers
 * after the gates ran (the engine attaching a profile's credential) compares this before and
 * after, and refuses on any difference. The slot-name denylist (`isRequestShapingHeaderName`)
 * keeps such a slot from being attached, and today it refuses every name this reading reacts
 * to; the comparison is what still holds when the two drift apart. A gate that starts to read a
 * header through another function belongs in here too.
 */
export function gateReading(method: string, headers: Record<string, string>, url: string, body?: BodyReadings): string {
  return JSON.stringify([
    effectiveWriteMethod(method, headers, url, body),
    writeMethodsNamed(method, headers, url, body),
    retargetingHeader(headers) ?? null,
  ]);
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

export function isRetargetingHeaderName(raw: string): boolean {
  const name = headerKey(raw);
  if (RETARGETING_HEADERS.has(name)) return true;
  return name !== 'x-forwarded-for' && RETARGETING_FAMILIES.some((family) => name.startsWith(family));
}

/**
 * Whether a header name changes how a server reads the request rather than who sent it: a
 * method override, a header that re-targets it, or the `Content-Type` and `Content-Encoding`
 * that decide how its body is read. The gate reads all three before the engine attaches a profile's credential, so a
 * credential slot of one of these names would change the request after it was checked.
 */
export function isRequestShapingHeaderName(raw: string): boolean {
  const name = headerKey(raw);
  return OVERRIDE_HEADERS.has(name) || isRetargetingHeaderName(name) || name === 'content-type' || name === 'content-encoding';
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
 * Whether a URL is a GraphQL endpoint, read from the URL alone: a path segment `graphql`
 * (`GRAPHQL_SEGMENT`, as `normalizeWritePath` routes it), or a host label that starts with
 * `graphql`. A path whose routing is not known here (`ambiguous`, a decoding error included)
 * counts when any way of decoding it names `graphql`, and a URL that does not parse counts.
 *
 * Only the URL, so that every caller can ask it, those that never see a body included. A
 * GraphQL API on another path (`/api`, `/v2`) is not recognised and is handled as any POST is.
 */
/**
 * A path segment a server routes to its GraphQL endpoint: `graphql`, with format suffixes a
 * router strips or matches on (`graphql.json`, Rails' `(.:format)`, `graphql.tar.gz`, Spring's
 * `graphql..json`), and with trailing dots, which IIS drops. Read from the decoded, lower-cased
 * segment.
 */
const GRAPHQL_SEGMENT = /^graphql(?:\.[a-z0-9]*)*$/i;

export function isGraphqlEndpoint(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return true;
  }
  if (parsed.hostname.toLowerCase().split('.').some((label) => label.startsWith('graphql'))) return true;
  const { path, ambiguous } = normalizeWritePath(parsed.pathname);
  // A path whose routing is not known here (a double encoding, an escape that does not decode,
  // a character a router may strip) is read every way a server may decode it, and any reading
  // that names `graphql` anywhere counts. Not every such path: an encoded space is a REST path.
  if (ambiguous) return [parsed.pathname, ...serverReadings(parsed.pathname)].some((reading) => reading.toLowerCase().includes('graphql'));
  // A decoded `?` or `#` in a segment (`/graphql%3Fquery=…`) is where a proxy that splits the
  // URL again ends the path, so the segment is read up to it as well.
  if (path.split('/').some((segment) => GRAPHQL_SEGMENT.test(segment) || GRAPHQL_SEGMENT.test(segment.split(/[?#]/)[0]!))) return true;
  // WPGraphQL answers on any path that carries the query key `graphql` (`/?graphql`,
  // `/index.php?graphql`), with or without a value.
  return [...parsed.searchParams.keys()].some((key) => key.toLowerCase() === 'graphql');
}

/** An operation that writes: `mutation` or `subscription` as a GraphQL name anywhere in the document. */
const GRAPHQL_WRITE_OPERATION = /\b(?:mutation|subscription)\b/i;

const GRAPHQL_BODY_KEYS = new Set(['query', 'operationName', 'variables', 'extensions']);

const GRAPHQL_CONTENT_TYPE = /^\s*application\/json\s*(?:;\s*charset\s*=\s*(?:"utf-8"|utf-8)\s*)?$/i;

/**
 * Whether any object in a JSON text names one key twice, keys compared as decoded (`"query"` and
 * `"qu\u0065ry"` are the same key). `JSON.parse` keeps the last of them; a server's parser may
 * keep the first, and then it runs a document the gate never read. The text must already parse.
 * A loop, not a recursion: nesting depth costs no stack.
 */
function jsonRepeatsAKey(text: string): boolean {
  const frames: { keys: Set<string> | null; expectKey: boolean }[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '"') {
      let j = i + 1;
      while (text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      const top = frames[frames.length - 1];
      if (top?.keys && top.expectKey) {
        const key = JSON.parse(text.slice(i, j + 1)) as string;
        if (top.keys.has(key)) return true;
        top.keys.add(key);
        top.expectKey = false;
      }
      i = j + 1;
      continue;
    }
    if (c === '{') frames.push({ keys: new Set(), expectKey: true });
    else if (c === '[') frames.push({ keys: null, expectKey: false });
    else if (c === '}' || c === ']') frames.pop();
    else if (c === ',') { const top = frames[frames.length - 1]; if (top?.keys) top.expectKey = true; }
    i++;
  }
  return false;
}

/**
 * A write to a GraphQL endpoint, read as the server will run it — or refused when that cannot be
 * told from the request. Refused: a media type other than `application/json` (a missing one and
 * two headers that differ only in case included), a body that is not exactly one JSON object, a
 * key named twice in any object, a top-level key other than `query`, `operationName`,
 * `variables` and `extensions`, an `extensions.persistedQuery` (the server may run a stored
 * document instead of `query`), and a `query` that is not a string. Anything that throws while
 * reading is a refusal too.
 *
 * `mutates` is the word `mutation` or `subscription` anywhere in `query`, as a GraphQL name.
 * Searched in the whole document, not in its first operation: `query A{…} mutation B{…}` with
 * `operationName: "B"` runs B. A false hit (the word in a string or a field name) only means the
 * write is asked again.
 */
export function graphqlWrite(headers: Readonly<Record<string, string>>, body: unknown): { refusal: string } | { mutates: boolean } {
  const types = Object.entries(headers).filter(([name]) => name.trim().toLowerCase() === 'content-type');
  if (types.length !== 1 || !GRAPHQL_CONTENT_TYPE.test(types[0]![1])) {
    return { refusal: 'a write to a GraphQL endpoint must send one Content-Type header, application/json' };
  }
  if (typeof body !== 'string') return { refusal: 'a write to a GraphQL endpoint must send a JSON object body' };
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { refusal: 'a write to a GraphQL endpoint must send exactly one JSON object, not a batch' };
    }
    if (jsonRepeatsAKey(body)) return { refusal: 'the body names a key twice' };
    const fields = parsed as Record<string, unknown>;
    const other = Object.keys(fields).find((key) => !GRAPHQL_BODY_KEYS.has(key));
    if (other !== undefined) return { refusal: 'the body carries a field other than query, operationName, variables and extensions' };
    const extensions = fields['extensions'];
    if (extensions !== undefined && (typeof extensions !== 'object' || extensions === null || Array.isArray(extensions) || Object.hasOwn(extensions, 'persistedQuery'))) {
      return { refusal: 'the body asks for a persisted query, which the server runs instead of the document it shows' };
    }
    const query = fields['query'];
    if (typeof query !== 'string') return { refusal: 'the body has no query string' };
    return { mutates: GRAPHQL_WRITE_OPERATION.test(query) };
  } catch {
    return { refusal: 'the body is not JSON this check can read' };
  }
}

/**
 * Whether a request that is not a write carries a GraphQL write in its URL: any `query`
 * parameter that names `mutation` or `subscription`. Some servers run a document sent this way;
 * the question could not show it, so such a request is refused rather than asked.
 */
export function graphqlUrlWrites(url: string): boolean {
  try {
    return new URL(url).searchParams.getAll('query').some((query) => GRAPHQL_WRITE_OPERATION.test(query));
  } catch {
    return true;
  }
}

/**
 * Paths on an API host that send to a third party or issue something bindingly. Keyed by the
 * HOST and not by a connected profile: a call reaches a host with a preset profile, with a
 * token profile or with none, and the table holds for each of them. Matched per segment, for
 * every write method.
 *
 * bexio, read from its OpenAPI specification 3.0.0 (every documented write, each judged by what
 * it sets off): `send` mails an invoice, reminder or quote to its recipient; `issue`, `reissue`,
 * `revert_issue` / `revertIssue` and `cancel` issue, re-issue, withdraw or cancel a binding
 * document; `bookings/{status}` books a bill or an expense or sets it back to draft; `accept`
 * and `reject` decide a quote; `mark_as_sent` marks an invoice, reminder or quote as sent and
 * `mark_as_unsent` a reminder as not sent, neither sending anything; `payments` and
 * `outgoing-payments` create, edit, cancel or delete a payment out to a recipient. Not named:
 * the writes that create or copy a draft (`copy`, `invoice`, `order`, `delivery` from a quote or
 * order), record an incoming payment (`kb_invoice/{id}/payment`), archive, reactivate or restore,
 * and the `actions` of bills and expenses, whose only action in the specification is
 * `DUPLICATE`. An order's `repetition`, a payment in the body of a bill and an employee's `iban`
 * and `email` are held from a bulk run by {@link OUTBOUND_EFFECT_FIELDS}; a write note still
 * treats them as ordinary writes, and on this host a connected account asks for every write.
 */
export const OUTBOUND_EFFECT_PATHS: readonly { readonly host: string; readonly segments: readonly string[] }[] = [
  {
    host: 'api.bexio.com',
    segments: [
      'send', 'issue', 'reissue', 'revert_issue', 'revertissue', 'cancel', 'accept', 'reject',
      'bookings', 'mark_as_sent', 'mark_as_unsent', 'payments', 'outgoing-payments',
    ],
  },
];

/** Whether a write to `url` with `method` is one the table names. A read never is. */
export function isOutboundEffectWrite(url: string, method: string): boolean {
  if (isReadMethod(method.toUpperCase())) return false;
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }
  const host = normalizeApprovalHost(parsed.hostname);
  const entry = OUTBOUND_EFFECT_PATHS.find((e) => e.host === host);
  if (!entry) return false;
  const { path, ambiguous } = normalizeWritePath(parsed.pathname);
  if (ambiguous) return true;
  // A segment is cut into its runs of letters and digits, and it matches when consecutive runs,
  // written together, spell an action without its separators: `send.json`, `send:x`, `_send`,
  // `x.send`, `mark-as-sent`, `markAsSent`, `outgoing_payments`. Which of these a provider's
  // router still reads as the action is not documented, so every such form counts. `sender`,
  // `send2` and `resend` do not: a run is never cut. Spelling stops past the longest action, so a
  // long segment costs linear time, not cubic.
  const actions = new Set(entry.segments.map((s) => s.replace(/[^a-z0-9]/gu, '')));
  const longest = Math.max(...[...actions].map((a) => a.length));
  return path.split('/').some((segment) => {
    const runs = segment.split(/[^a-z0-9]+/u);
    for (let i = 0; i < runs.length; i++) {
      let spelled = '';
      for (let j = i; j < runs.length; j++) {
        spelled += runs[j];
        if (spelled.length > longest) break;
        if (actions.has(spelled)) return true;
      }
    }
    return false;
  });
}

/** What a field of {@link OUTBOUND_EFFECT_FIELDS} sets off at the provider. */
export type OutboundEffectClass = 'third_party_mail' | 'money' | 'credential' | 'data_to_third_party';

interface OutboundEffectField {
  /** Bound to a host, or `undefined` for software that runs on the customer's own host. */
  readonly host?: string;
  /** Tested against the path as {@link normalizeWritePath} gives it. */
  readonly path: RegExp;
  /** The top-level body fields that set it off, lower-case, or `any` for every write. */
  readonly fields: readonly string[] | 'any';
  readonly effect: OutboundEffectClass;
  /** What it does, in the refusal. A fixed text: it reaches the model. */
  readonly says: string;
}

// WooCommerce runs on the customer's host and WordPress may serve its REST API under another
// prefix (`rest_url_prefix`) or behind `/index.php`, so its entries match the route's own
// segments anywhere in the path: every `wc` namespace, versioned (`wc/v3`; `wc/v4` exists
// behind a flag) or not (`wc-analytics` inherits the orders controller with its write route).
// A path WordPress may decode once more than this does, or read up to a trailing newline, does
// not normalize cleanly; a bulk run never plans one (`externalTargetKey`).
const WOO = (resource: string): RegExp => new RegExp(`/wc(?:-[a-z0-9]+)?(?:/v\\d+)?/${resource}/\\d+$`);

/**
 * Fields whose VALUE sets off an effect at the provider that reaches someone else, moves
 * money or changes access — where the path is an ordinary resource, so
 * {@link OUTBOUND_EFFECT_PATHS} cannot see it. Read from the providers' sources and
 * specifications (WooCommerce 11.1.2, bexio OpenAPI 3.0.0), measured where the register row
 * says so. A bulk run never writes one; there is no one to ask.
 */
export const OUTBOUND_EFFECT_FIELDS: readonly OutboundEffectField[] = [
  { path: WOO('orders'), fields: ['status'], effect: 'third_party_mail', says: 'WooCommerce emails the customer and the shop when an order changes status' },
  { path: WOO('orders'), fields: ['set_paid'], effect: 'money', says: 'WooCommerce completes the payment, reduces stock and emails the customer' },
  { path: WOO('orders'), fields: ['customer_id'], effect: 'data_to_third_party', says: 'WooCommerce moves the order, with its addresses, into another customer\'s account' },
  { path: WOO('customers'), fields: ['password', 'email'], effect: 'credential', says: 'WooCommerce changes how the customer signs in; a changed email address also receives the password reset' },
  { path: WOO('webhooks'), fields: 'any', effect: 'data_to_third_party', says: 'a WooCommerce webhook decides where the shop sends its order and customer data' },
  { host: 'api.bexio.com', path: /^\/4\.0\/banking\/payments\/[^/]+$/, fields: 'any', effect: 'money', says: 'bexio pays this amount out on this date' },
  { host: 'api.bexio.com', path: /^\/2\.0\/kb_order\/\d+\/repetition$/, fields: 'any', effect: 'money', says: 'bexio invoices this order again on this schedule' },
  // The specification does not say whether a bill's payment runs when the bill is created or
  // when it is booked, nor what bexio does with an employee's email address; both count.
  { host: 'api.bexio.com', path: /^\/4\.0\/purchase\/bills(?:\/[^/]+)?$/, fields: ['payment'], effect: 'money', says: 'bexio pays this bill: from which account, how much, when and to whom' },
  { host: 'api.bexio.com', path: /^\/4\.0\/payroll\/employees(?:\/[^/]+)?$/, fields: ['iban'], effect: 'money', says: 'bexio payroll pays this employee\'s salary into this account' },
  { host: 'api.bexio.com', path: /^\/4\.0\/payroll\/employees(?:\/[^/]+)?$/, fields: ['email'], effect: 'data_to_third_party', says: 'bexio payroll reaches this employee at this address' },
];

/**
 * What a write of `body` to `url` would set off ({@link OUTBOUND_EFFECT_FIELDS}), or null.
 * Field names are compared in lower case, and `field` is the table's name for it (null where
 * every write to the path counts), never the caller's text. A path that does not normalize
 * cleanly counts as a hit for the entries bound to its host, as in {@link isOutboundEffectWrite}.
 */
export function outboundEffectField(url: string, body: unknown): { field: string | null; effect: OutboundEffectClass; says: string } | null {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  const host = normalizeApprovalHost(parsed.hostname);
  const { path, ambiguous } = normalizeWritePath(parsed.pathname);
  const keys = body !== null && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body) : [];
  for (const entry of OUTBOUND_EFFECT_FIELDS) {
    if (entry.host !== undefined && entry.host !== host) continue;
    if (!entry.path.test(path) && !(ambiguous && entry.host !== undefined)) continue;
    const fields = entry.fields;
    if (fields === 'any') return { field: null, effect: entry.effect, says: entry.says };
    const field = fields.find((f) => keys.some((k) => k.toLowerCase() === f));
    if (field !== undefined) return { field, effect: entry.effect, says: entry.says };
  }
  return null;
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

/** `%uXXXX` read as the UTF-16 code unit it names, the way IIS and JavaScript's `unescape` read
 *  it; a surrogate pair written as two escapes becomes the one character. Hex digits in either
 *  case. A `%u` without four hex digits after it is kept as it is. */
function percentUDecode(text: string): string {
  return text.replace(/%u([0-9a-fA-F]{4})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

/**
 * The steps a server may take on the way from the bytes it received to the value it uses:
 * percent-decoding as UTF-8 or in a single-byte charset, `%uXXXX`, and `+` as a space, each on
 * its own or after one another. Taken up to three deep, counted from the bytes as sent, so a
 * value encoded up to three times (`%2573…`), or with `+` read only partly, is read the way such
 * a server reads it. A step that changes nothing yields the text itself, so the readings may
 * hold it: callers pass text already masked.
 *
 * Only readings a server takes on its own are here. An encoding a sender chooses and no server
 * undoes by itself (base64, HTML entities, a fourth layer) is not: for those the mask is a hurdle,
 * not a boundary, and the boundary is the question showing the value that is sent.
 */
const READING_STEPS: ReadonlyArray<(text: string) => string> = [lenientDecode, latin1Decode, windows1252Decode, percentUDecode, (t) => t.replace(/\+/g, ' ')];
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
    // The same text read again gives the same readings: each is taken once.
    frontier = [...new Set(next)];
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
  const shown = pathShown(url, mask);
  return shown === undefined ? '(unparsable)' : clipName(shown, MAX_PATH_CHARS);
}

/**
 * Whether the path a request sends holds a secret `mask` knows, in any reading the question
 * masks or stars: the question's path read once masked and once with nothing masked, before it
 * is clipped, so a secret past the clip still counts.
 */
export function pathHoldsSecret(url: string, mask: (text: string) => string): boolean {
  return pathShown(url, mask) !== pathShown(url, (text) => text);
}

/** {@link pathForQuestion} before it is clipped; `undefined` for a URL that does not parse. */
function pathShown(url: string, mask: (text: string) => string): string | undefined {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return undefined; }
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
  return `${path}${query}`;
}

/**
 * The most of a write's body a question shows whole, in bytes of what is SENT (not of what
 * is shown: masking and indenting change the length of the display, never the decision).
 * Measured against request bodies shaped like real set-up steps (a local measurement:
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

/** The longest header line the question shows (`name: value`), measured as shown: masked, with
 *  invisible characters and tabs spelled out. */
export const SHOWN_HEADER_MAX_CHARS = 200;

/** Why a request's headers cannot be shown: the header named, and what is wrong with it. */
export type UnshowableHeader =
  | { reason: 'duplicate'; name: string }
  | { reason: 'too-long'; name: string; length: number }
  | { reason: 'escaped-secret'; name: string }
  | { reason: 'secret-name'; name: string };

/** What the question does with one header: show it, leave it out but key it, or leave it out. */
export type HeaderShowing = 'show' | 'key' | 'omit';

/**
 * The headers a write sends, as its approval question shows them, and as its approval key holds
 * them. `headers` is the set that goes out (the engine's credential included); `showing` says
 * what the question does with each: the engine's credential and a header the transport sets
 * itself are left out (`omit`), a `content-type` or `accept` the question need not show is keyed
 * but not shown (`key`). A value that is not a string is never sent and is left out.
 *
 * Shown whole or not at all, like the body: one `name: value` line per header, the value masked,
 * invisible characters and tabs as their code point. Not shown, so the write is refused: two
 * names that differ only in case or spacing (a server reads one, the question would show the
 * other), a line longer than `SHOWN_HEADER_MAX_CHARS` as shown, a value whose decoded form still
 * holds a secret, and a name that holds one. The key gets the raw values, by lower-case name,
 * sorted: two secrets that mask alike are still two writes.
 */
export function headersForQuestion(
  headers: Readonly<Record<string, unknown>>,
  mask: (text: string) => string,
  showing: (name: string, value: string) => HeaderShowing,
): { lines: string[]; names: string[]; keyed: Array<[string, string]> } | { unshowable: UnshowableHeader } {
  const seen = new Set<string>();
  for (const k of Object.keys(headers)) {
    const name = k.trim().toLowerCase();
    if (seen.has(name)) return { unshowable: { reason: 'duplicate', name } };
    seen.add(name);
  }
  const sent = Object.entries(headers)
    .filter((e): e is [string, string] => typeof e[1] === 'string')
    .map(([k, v]) => ({ k, v, how: showing(k.trim().toLowerCase(), v) }))
    .filter((h) => h.how !== 'omit')
    .sort((a, b) => (a.k.trim().toLowerCase() < b.k.trim().toLowerCase() ? -1 : 1));
  const shown = sent.filter((h) => h.how === 'show');
  const spelled = (text: string): string => visible(text).replace(/\t/g, '⟨U+0009⟩');
  const lines: string[] = [];
  for (const { k, v } of shown) {
    if (mask(k) !== k || hidesEncodedSecret(k, mask)) return { unshowable: { reason: 'secret-name', name: k } };
    const masked = mask(v);
    const line = `${spelled(k)}: ${spelled(masked)}`;
    if (line.length > SHOWN_HEADER_MAX_CHARS) return { unshowable: { reason: 'too-long', name: k, length: line.length } };
    if (hidesEncodedSecret(masked, mask)) return { unshowable: { reason: 'escaped-secret', name: k } };
    lines.push(line);
  }
  return {
    lines,
    names: shown.map(({ k }) => spelled(k)),
    keyed: sent.map(({ k, v }) => [k.trim().toLowerCase(), v]),
  };
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
 *
 * `escapedSecret` is about what is SENT, not about how it is shown: a secret the mask did not
 * see as sent, found only in another server reading. A form body shows such a part masked in the
 * reading it shows, or starred, and stays showable, so a caller that refuses such a body asks
 * this as well as `unshowable` (which implies it).
 */
export function bodyForQuestion(body: string, mask: (text: string) => string, contentType = ''): { text: string; escapedSecret: boolean } | { unshowable: 'escaped-secret' } {
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
      return encodedSecret ? { unshowable: 'escaped-secret' } : { text, escapedSecret: false };
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
    return { text: visible(shownRaw), escapedSecret: false };
  }
  const shown = mask(body);
  // A form body is shown pair by pair only when it is SENT as one (its Content-Type): the same
  // text sent as text/plain is not `x = a b` but `x=a+b`. Masked WHOLE before it is cut at `&`
  // and `=`, so a secret holding either (base64 padding) is still one value to the mask; then
  // each part again once decoded, and starred when another server reading of it holds a
  // secret. A line break inside a decoded part is shown as `\n`, so a value cannot add a
  // `name = value` line of its own.
  if (FORM_CONTENT_TYPE.test(contentType) && /^[^=&\s]+=[^&]*(?:&[^=&\s]+=[^&]*)*$/.test(shown)) {
    return {
      text: visible(shown.split('&').map((pair) => {
        const at = pair.indexOf('=');
        return `${formPart(pair.slice(0, at), mask)} = ${formPart(pair.slice(at + 1), mask)}`;
      }).join('\n')),
      escapedSecret: hidesEncodedSecret(shown, mask),
    };
  }
  // Any other body is shown as text, and the server may still read it percent-decoded (a form
  // sent without its Content-Type, or one whose masked secret removed its `=`/`&` structure).
  // A secret left in the decoded form was written in a form the text mask did not see.
  if (hidesEncodedSecret(shown, mask)) return { unshowable: 'escaped-secret' };
  return { text: visible(shown), escapedSecret: false };
}

/** One side of a `name=value` pair of a form body or a query that the caller masked whole: shown
 *  decoded, `+` read as a space, masked again, and starred when another server reading of it
 *  holds a secret (`shownPiece`). A line break is shown as `\n`, so a value cannot add a
 *  `name = value` line of its own. */
function formPart(raw: string, mask: (text: string) => string): string {
  return shownPiece(raw, lenientDecode(raw.replace(/\+/g, ' ')), mask).replace(/\r?\n/g, '\\n');
}

/**
 * The query as a write's question shows it, by the rule of a form body: masked whole, then one
 * `name = value` per line, each side decoded and masked again (`formPart`); a pair without `=` is
 * shown as its name. `search` is the query as sent, `URL.search` of the serialized URL, so what is
 * shown is what goes on the wire. Whether it is small enough to show is the caller's decision
 * (`SHOWN_BODY_MAX_BYTES`, on the bytes sent).
 *
 * `secret`: the query sends a value the vault knows, so the question says so. `escaped`: one is
 * found only in another server reading of the query (percent-encoded, or `+` for a space), which
 * the mask did not see as sent; a mandate's session and a connected account refuse such a query
 * (`http.ts`).
 */
export function queryForQuestion(search: string, mask: (text: string) => string): { text: string; secret: boolean; escaped: boolean } {
  const sent = search.startsWith('?') ? search.slice(1) : search;
  const shown = mask(sent);
  const escaped = hidesEncodedSecret(shown, mask);
  const lines = shown.split('&').filter((pair) => pair !== '').map((pair) => {
    const at = pair.indexOf('=');
    return at < 0 ? formPart(pair, mask) : `${formPart(pair.slice(0, at), mask)} = ${formPart(pair.slice(at + 1), mask)}`;
  });
  return { text: visible(lines.join('\n')), secret: escaped || shown !== sent, escaped };
}

/** The form media type alone, parameters allowed; a list of two types is not one form. */
const FORM_CONTENT_TYPE = /^\s*application\/x-www-form-urlencoded\s*(?:;[^,]*)?$/i;
