/**
 * The provider account an OAuth connection belongs to, as the person who connected it signed in.
 *
 * WHY THIS EXISTS. A profile a helper set up can be connected with the helper's own login at the
 * provider, and its tokens then point at the helper's account, not the customer's. Nothing showed
 * which account that was, so the customer could not tell their shop from someone else's. The
 * account is recorded on the grant when the consent happens, and shown beside the profile.
 *
 * IT IS A LABEL, NOT A KEY. Nothing decides on it: it is what the person reads. What binds a
 * connection is the grant the store mints for each consent. So the label is cut to one line and a
 * bounded length, and it is never guessed: a provider without a source the engine can rely on has
 * no account, which reads as "account unknown".
 *
 * TWO SOURCES, both from the consent itself:
 *  - a store preset: the store the provider signed the callback for (the same origin the token is
 *    bound to);
 *  - an OpenID Connect preset: the `id_token` of the token endpoint's answer. It came over the
 *    direct TLS connection to that endpoint, which OpenID Connect Core 1.0 §3.1.3.7 (6) allows in
 *    place of checking its signature. Its issuer, audience and expiry are still checked, and a
 *    token that fails any of them gives no account.
 */
import { singleLine } from './prompt-value.js';

export type OAuthAccountSource = 'store-origin' | 'id-token';

export interface OAuthAccount {
  readonly label: string;
  readonly source: OAuthAccountSource;
}

/** The longest label kept. A provider's account name is short; anything longer is cut. */
export const ACCOUNT_LABEL_MAX = 200;

/**
 * A provider-supplied name as one line a person can read: format and control characters out
 * (C0 and C1 included), runs of space collapsed, cut to {@link ACCOUNT_LABEL_MAX}. Undefined when
 * nothing readable is left.
 */
export function accountLabel(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const line = singleLine(raw).replace(/[\u0080-\u009f]/gu, '').replace(/ {2,}/gu, ' ').trim();
  if (line === '') return undefined;
  return [...line].slice(0, ACCOUNT_LABEL_MAX).join('');
}

function base64UrlJson(segment: string): unknown {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) return undefined;
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * The account an `id_token` names, when it is one this connection can rely on: three segments,
 * `iss` exactly the preset's issuer, `aud` the client (a string, or an array holding it), `exp`
 * still ahead of `nowSeconds`. The label is `email`, else `preferred_username`; `sub` alone is an
 * id the person does not recognise and gives none.
 */
export function accountFromIdToken(idToken: unknown, issuer: string, clientId: string, nowSeconds: number): OAuthAccount | undefined {
  if (typeof idToken !== 'string') return undefined;
  const parts = idToken.split('.');
  if (parts.length !== 3) return undefined;
  const claims = base64UrlJson(parts[1]!);
  if (claims === null || typeof claims !== 'object' || Array.isArray(claims)) return undefined;
  const c = claims as Record<string, unknown>;
  if (c['iss'] !== issuer) return undefined;
  const aud = c['aud'];
  const forClient = typeof aud === 'string' ? aud === clientId : Array.isArray(aud) && aud.includes(clientId);
  if (!forClient) return undefined;
  const exp = c['exp'];
  if (typeof exp !== 'number' || !(exp > nowSeconds)) return undefined;
  const label = accountLabel(c['email']) ?? accountLabel(c['preferred_username']);
  return label === undefined ? undefined : { label, source: 'id-token' };
}

/** The store a store preset's callback was signed for, by its host. */
export function accountFromStoreOrigin(origin: string): OAuthAccount | undefined {
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return undefined;
  }
  const label = accountLabel(host);
  return label === undefined ? undefined : { label, source: 'store-origin' };
}
