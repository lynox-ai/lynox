/**
 * The one exception to the Shopify refusal (`shopify-host.ts`): a store pass.
 *
 * Every request to a Shopify store host is refused, by `fetchPinned`, unless the call that
 * sends it carries a pass the engine minted for exactly that request. A pass names one
 * origin, one credential header and a keyed digest of that header's value. It is minted
 * only after the connection behind it was verified (`storePassFor`), and `fetchPinned`
 * checks it on every hop, against the URL as it is finally sent:
 *
 *  - it is a pass this process minted (an object of the same shape is not);
 *  - the hop goes over https to the pass's origin, compared the way DNS reads the host;
 *  - the path is under `/admin/` and carries no `%` and no `;`: an encoded `/`, `\` or `.`,
 *    a double encoding (`%252e`) or a matrix segment (`/admin/..;/apps/`) is something a server
 *    in front of the store could route to another path;
 *  - for a credential pass, the path has the shape of an Admin API call
 *    ({@link credentialPathRefusal}) and stays out of the store's OAuth endpoints;
 *  - for a credential pass, the request names no access token: not in a path segment, not in
 *    the query, not in the body, which is JSON sent as it is ({@link namesAccessToken});
 *  - no header re-targets the request (`Host`, `X-Original-URL`, `X-Forwarded-*`, …), on a
 *    read as on a write;
 *  - exactly one header of the credential set is sent, it is the pass's header, and its
 *    value digests to the pass's digest.
 *
 * So what reaches the store is what was verified: a value written into the slot after the
 * pass was minted, a second credential header, a redirect to another path of the same store,
 * or another store all fail at the send.
 *
 * The token exchange is the other kind (`kind: 'exchange'`, PRD Appendix B4). It sends no
 * credential header: client id, secret and code are in the body. Its pass names the origin and
 * an HMAC of the exact body bytes, and reaches one request: a POST to the store's token
 * endpoint, with no query, no credential header and no header that re-targets it, whose body
 * digests to the pass's digest. It is spent by that request: a redirect keeps method and body on
 * a 307 or 308, so a second request under the same pass is refused, whatever its path.
 *
 * The digest is an HMAC under a key that lives only in this process: a pass carries no
 * token, and its digest is worth nothing outside the boot that made it.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { normalizeHostForMatch } from './shopify-host.js';
import { isRetargetingHeaderName } from './outbound-write.js';

/** Headers that carry a credential, any of which a pass must account for. */
export const STORE_CREDENTIAL_HEADERS: ReadonlySet<string> = new Set([
  'authorization', 'cookie', 'proxy-authorization',
  'x-api-key', 'x-auth-token', 'x-csrf-token',
  'x-shopify-access-token', 'x-shopify-storefront-access-token', 'shopify-storefront-private-token',
]);

/** The only path a pass reaches on its store: the Admin API. */
export const STORE_PASS_PATH_PREFIX = '/admin/';

/** The token endpoint: the one path an exchange pass reaches. */
export const STORE_EXCHANGE_PATH = '/admin/oauth/access_token';

/** The one path under `/admin/oauth/` a credential pass reaches: the read of the token's own scopes. */
export const STORE_SCOPES_PATH = '/admin/oauth/access_scopes.json';

/**
 * Why a credential pass may not reach `path`, or `null` when it may. An allowlist of the path's
 * shape, not a refusal of one prefix: non-empty segments of lowercase letters, digits, `_`, `-`
 * and `.` under `/admin/`, none of which starts with `oauth`, or exactly {@link STORE_SCOPES_PATH}.
 *
 * A refusal of `/admin/oauth/` alone did not hold: `/admin//oauth/access_token` keeps both
 * slashes in `URL.pathname`, and `/admin/OAuth/…` passes a case-sensitive compare. Here a repeated
 * slash and a capital are refused rather than folded, so how the store reads them does not
 * matter. Admin API paths are lowercase; a segment starting with `oauth` is refused anywhere, so
 * neither a versioned spelling nor `oauth.json` reaches the token endpoint.
 */
export function credentialPathRefusal(path: string): string | null {
  if (path === STORE_SCOPES_PATH) return null;
  if (!/^\/admin(?:\/[a-z0-9_.-]+)+$/.test(path)) return 'the request is not for the Admin API';
  if (path.split('/').some((segment) => segment.startsWith('oauth'))) return 'a store pass does not reach the store\'s OAuth endpoints';
  if (path.split('/').some((segment) => segment.includes('access_token'))) return ACCESS_TOKEN_REFUSAL;
  return null;
}

const ACCESS_TOKEN_REFUSAL = 'a store pass does not reach the store\'s access tokens';
const TOKEN_WORD = /access_?token/i;
const PERSISTED_WORD = /persistedquery/i;
/**
 * A `\uXXXX` or `\u{X…}` escape (JSON's and GraphQL's string escapes) with every backslash before
 * it: one left standing would split a word that the escape sits in the middle of. A run of
 * backslashes is matched from its start only, so a long run costs one pass, not one per backslash.
 * GraphQL allows any number of digits in braces (`\u{00000041}`): leading zeros are read past.
 */
const UNICODE_ESCAPE = /(?<!\\)\\+u(?:\{0*([0-9a-fA-F]{1,6})\}|([0-9a-fA-F]{4}))/g;

/**
 * `text` with every unicode escape resolved, again and again until nothing changes (at most eight
 * rounds). A document nested in a GraphQL string literal (`bulkOperationRunQuery(query: "…")`) is
 * decoded once more by the store, so one round of JSON decoding does not show what it names.
 * Resolving an escape that is really an escaped backslash can change the text of a value, but
 * never hides a field name: no escape stands directly before a name.
 */
function resolveEscapes(text: string): string {
  let current = text;
  for (let round = 0; round < 8; round++) {
    const next = current.replace(UNICODE_ESCAPE, (_, braced: string | undefined, plain: string | undefined) => {
      const code = Number.parseInt(braced ?? plain ?? '', 16);
      return code <= 0x10ffff ? String.fromCodePoint(code) : '\uFFFD';
    });
    if (next === current) return current;
    current = next;
  }
  return current;
}

/**
 * Whether `text` names an access token (`accessToken`, `access_token`, any case), with its escapes
 * resolved. A GraphQL field name has no escapes, and an alias or a fragment carries it
 * as written, so a document that selects a token field names it here. The response is not read:
 * a token the store returns under another name is not seen.
 */
export function namesAccessToken(text: string): boolean {
  return TOKEN_WORD.test(resolveEscapes(text));
}

/** Whether `text`, its escapes resolved, asks for a persisted query: a document the store runs without its being sent. */
function asksPersisted(text: string): boolean {
  return PERSISTED_WORD.test(resolveEscapes(text));
}

/** The `Content-Type` values a credential request may send, as `http.ts` lets a connected write send them. */
const JSON_CONTENT_TYPES: ReadonlySet<string> = new Set(['application/json', 'application/json; charset=utf-8']);

/** The `Content-Type` values `headers` sends, any spelling of the name. */
function contentTypesOf(headers: Record<string, string>): string[] {
  return Object.entries(headers).filter(([name]) => name.trim().toLowerCase() === 'content-type').map(([, value]) => value);
}

/**
 * Why a credential request's query or headers may not go out, or `null`. The query is read as
 * the store decodes it, names and values. The body check reads the body as JSON in UTF-8, so a
 * body sent compressed, or as anything other than one of {@link JSON_CONTENT_TYPES}, is refused:
 * a form type would let the store read the same bytes as a query, and a charset as other text.
 */
function credentialRequestRefusal(url: URL, headers: Record<string, string>): string | null {
  if (url.search !== '') {
    const pieces = [...url.searchParams].flat();
    if (pieces.some(namesAccessToken)) return 'the address names an access token: ' + ACCESS_TOKEN_REFUSAL;
    if (pieces.some(asksPersisted)) return 'the address asks for a persisted query';
  }
  for (const [name, value] of Object.entries(headers)) {
    if (name.trim().toLowerCase() === 'content-encoding' && value.trim().toLowerCase() !== 'identity') return 'the body is sent encoded (Content-Encoding)';
  }
  const types = contentTypesOf(headers);
  // Two of them are refused with a body ({@link storePassBodyRefusal}); without one they say nothing.
  if (types.some((type) => !JSON_CONTENT_TYPES.has(type.trim().toLowerCase()))) {
    return 'a request under a store pass sends one Content-Type, application/json';
  }
  return null;
}

const DIGEST_KEY = randomBytes(32);
const minted = new WeakSet<object>();
/** Exchange passes that have sent their request. */
const spent = new WeakSet<object>();

/** A pass for a request that carries the bound token. Only {@link mintStorePass} makes one that counts. */
export interface CredentialStorePass {
  readonly kind: 'credential';
  /** `https://<host>[:port]`, the host as DNS reads it. */
  readonly origin: string;
  /** The credential header, lowercased. */
  readonly headerName: string;
  /** HMAC of the header's value under this process's key. */
  readonly digest: string;
}

/** A pass for the token exchange. Only {@link mintStoreExchangePass} makes one that counts. */
export interface ExchangeStorePass {
  readonly kind: 'exchange';
  /** `https://<host>[:port]`, the host as DNS reads it. */
  readonly origin: string;
  /** HMAC of the body under this process's key. */
  readonly bodyDigest: string;
}

/** A pass. Its fields are readable; only the mint functions make one that counts. */
export type StorePass = CredentialStorePass | ExchangeStorePass;

function digestOf(value: string | Buffer): Buffer {
  const h = createHmac('sha256', DIGEST_KEY);
  return (typeof value === 'string' ? h.update(value, 'utf8') : h.update(value)).digest();
}

function sameDigest(sent: Buffer, hex: string): boolean {
  const expected = Buffer.from(hex, 'hex');
  return sent.length === expected.length && timingSafeEqual(sent, expected);
}

/** `https://<normalized host>[:port]` of a URL, or `null` when it is not https. */
export function storeOriginOf(url: URL): string | null {
  if (url.protocol !== 'https:') return null;
  const host = normalizeHostForMatch(url.hostname);
  return `https://${host}${url.port ? `:${url.port}` : ''}`;
}

/**
 * Mint a pass for one request. Called by `storePassFor` alone, once the connection behind
 * `value` is verified; a source guard holds every other caller out.
 */
export function mintStorePass(origin: string, headerName: string, value: string): CredentialStorePass {
  const pass: CredentialStorePass = Object.freeze({
    kind: 'credential',
    origin,
    headerName: headerName.toLowerCase(),
    digest: digestOf(value).toString('hex'),
  });
  minted.add(pass);
  return pass;
}

/**
 * Mint a pass for one token exchange, over the body it will send. Called by
 * `storeExchangePassFor` alone, in the connect callback; a source guard holds every other
 * caller out.
 */
export function mintStoreExchangePass(origin: string, body: string): ExchangeStorePass {
  const pass: ExchangeStorePass = Object.freeze({ kind: 'exchange', origin, bodyDigest: digestOf(body).toString('hex') });
  minted.add(pass);
  return pass;
}

/** Whether `value` is a pass this process minted. */
export function isStorePass(value: unknown): value is StorePass {
  return typeof value === 'object' && value !== null && minted.has(value);
}

/**
 * Why a hop to a store host may not go out under `pass`, or `null` when it may. `url` is
 * the hop's final URL; `headers` and `method` are what it sends. The body of an exchange is
 * checked after it is materialised, by {@link storePassBodyRefusal}.
 */
export function storePassRefusal(url: URL, headers: Record<string, string>, pass: unknown, method = 'GET'): string | null {
  if (!isStorePass(pass)) return 'no store pass for this request';
  const origin = storeOriginOf(url);
  if (origin === null || origin !== pass.origin) return 'the request does not go to the verified store';
  const path = url.pathname;
  if (pass.kind === 'exchange') {
    // `search` is empty for a bare `?` too, which is still sent: the serialised URL decides.
    if (path !== STORE_EXCHANGE_PATH || url.href.includes('?')) return 'an exchange pass reaches only the store\'s token endpoint';
    if (method.toUpperCase() !== 'POST') return 'an exchange pass sends only the token exchange';
  } else {
    if (!path.startsWith(STORE_PASS_PATH_PREFIX)) return 'the request is not for the Admin API';
    const refused = credentialPathRefusal(path) ?? credentialRequestRefusal(url, headers);
    if (refused !== null) return refused;
  }
  if (path.includes('%') || path.includes(';')) return 'the path carries an encoded character or a matrix segment';
  // `Host` is one of them: `fetchPinned` sets it itself, after this check.
  const retarget = Object.keys(headers).find(isRetargetingHeaderName);
  if (retarget !== undefined) return 'the request carries a header that re-targets it';
  const credentials = Object.entries(headers).filter(([name]) => STORE_CREDENTIAL_HEADERS.has(name.toLowerCase()));
  if (pass.kind === 'exchange') {
    return credentials.length === 0 ? null : 'the token exchange may carry no credential header';
  }
  if (credentials.length !== 1) return 'the request must carry exactly the verified credential';
  const [[name, value]] = credentials as [[string, string]];
  if (name.toLowerCase() !== pass.headerName) return 'the request must carry exactly the verified credential';
  if (!sameDigest(digestOf(value), pass.digest)) return 'the credential sent is not the one that was verified';
  return null;
}

/**
 * Why the body of a hop may not go out under `pass`, or `null` when it may. `body` is what the
 * hop sends, as bytes. An exchange pass is spent here, by the first request that passes. A
 * credential request's body is JSON, and its text, escapes resolved, names no access token and
 * asks for no persisted query. JSON's escapes are the ones resolved, so its keys and strings are
 * read as decoded. A credential body goes with a JSON `Content-Type` ({@link storePassRefusal}
 * refuses any other); `headers` are the hop's.
 */
export function storePassBodyRefusal(pass: StorePass, body: Buffer | undefined, headers: Record<string, string>): string | null {
  if (pass.kind !== 'exchange') {
    if (body === undefined || body.length === 0) return null;
    if (contentTypesOf(headers).length !== 1) return 'a request under a store pass sends one Content-Type, application/json';
    const text = body.toString('utf8');
    try {
      JSON.parse(text);
    } catch {
      return 'a request under a store pass sends its body as JSON';
    }
    if (namesAccessToken(text)) return 'the body names an access token: ' + ACCESS_TOKEN_REFUSAL;
    if (asksPersisted(text)) return 'the body asks for a persisted query';
    return null;
  }
  if (spent.has(pass)) return 'an exchange pass sends one request, and it has sent it';
  if (body === undefined || !sameDigest(digestOf(body), pass.bodyDigest)) return 'the body sent is not the token exchange that was verified';
  spent.add(pass);
  return null;
}
