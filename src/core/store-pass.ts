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
 *  - no header re-targets the request (`Host`, `X-Original-URL`, `X-Forwarded-*`, …), on a
 *    read as on a write;
 *  - exactly one header of the credential set is sent, it is the pass's header, and its
 *    value digests to the pass's digest.
 *
 * So what reaches the store is what was verified: a value written into the slot after the
 * pass was minted, a second credential header, a redirect to another path of the same store,
 * or another store all fail at the send.
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

const DIGEST_KEY = randomBytes(32);
const minted = new WeakSet<object>();

/** A pass. Its fields are readable; only {@link mintStorePass} makes one that counts. */
export interface StorePass {
  /** `https://<host>[:port]`, the host as DNS reads it. */
  readonly origin: string;
  /** The credential header, lowercased. */
  readonly headerName: string;
  /** HMAC of the header's value under this process's key. */
  readonly digest: string;
}

function digestOf(value: string): Buffer {
  return createHmac('sha256', DIGEST_KEY).update(value, 'utf8').digest();
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
export function mintStorePass(origin: string, headerName: string, value: string): StorePass {
  const pass: StorePass = Object.freeze({
    origin,
    headerName: headerName.toLowerCase(),
    digest: digestOf(value).toString('hex'),
  });
  minted.add(pass);
  return pass;
}

/** Whether `value` is a pass this process minted. */
export function isStorePass(value: unknown): value is StorePass {
  return typeof value === 'object' && value !== null && minted.has(value);
}

/**
 * Why a hop to a store host may not go out under `pass`, or `null` when it may. `url` is
 * the hop's final URL; `headers` are the headers it sends.
 */
export function storePassRefusal(url: URL, headers: Record<string, string>, pass: unknown): string | null {
  if (!isStorePass(pass)) return 'no store pass for this request';
  const origin = storeOriginOf(url);
  if (origin === null || origin !== pass.origin) return 'the request does not go to the verified store';
  const path = url.pathname;
  if (!path.startsWith(STORE_PASS_PATH_PREFIX)) return 'the request is not for the Admin API';
  if (path.includes('%') || path.includes(';')) return 'the path carries an encoded character or a matrix segment';
  // `Host` is one of them: `fetchPinned` sets it itself, after this check.
  const retarget = Object.keys(headers).find(isRetargetingHeaderName);
  if (retarget !== undefined) return 'the request carries a header that re-targets it';
  const credentials = Object.entries(headers).filter(([name]) => STORE_CREDENTIAL_HEADERS.has(name.toLowerCase()));
  if (credentials.length !== 1) return 'the request must carry exactly the verified credential';
  const [[name, value]] = credentials as [[string, string]];
  if (name.toLowerCase() !== pass.headerName) return 'the request must carry exactly the verified credential';
  const sent = digestOf(value);
  const expected = Buffer.from(pass.digest, 'hex');
  if (sent.length !== expected.length || !timingSafeEqual(sent, expected)) {
    return 'the credential sent is not the one that was verified';
  }
  return null;
}
