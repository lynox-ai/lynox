import { createHash } from 'node:crypto';
import { ISO_TIMESTAMP_SHAPE, shapedForLog, slotNameForModel } from './profile-value-shape.js';

/**
 * How a failed token-endpoint call is read, for every OAuth path in the engine:
 * the Google integration and the generic `api_setup fetch_token`.
 *
 * One module rather than one copy per path. The Google path had this first, and
 * a second copy for the generic grant would have been the start of two
 * verdicts for the same wire response — the pair these two functions exist to
 * keep apart is exactly the one that drifts when nobody compares them.
 *
 * The codes are the ones RFC 6749 §5.2 defines for a token endpoint, plus
 * `deleted_client`, which Google returns for a removed OAuth client; a provider
 * that never sends it loses nothing. The remedies stay with each path, because
 * only the path knows who can act on them.
 */
export type RefreshFailureKind = 'grant-revoked' | 'client-misconfigured' | 'transient';

/**
 * Classify a token-endpoint failure. Anchoring on the `error` field is what
 * every OAuth client library does; the HTTP status alone is ambiguous
 * (`invalid_grant` returns 400 just like a transient billing-limit would).
 *
 * The three kinds exist because two of them used to be one, and the pair that
 * was merged pulled in opposite directions:
 *
 * - `invalid_grant` — the GRANT is gone (revoked or expired). Nothing we
 *   change brings it back, so the stored token is worthless. Google's remedy:
 *   "Authenticate the user again and ask for user consent to obtain new
 *   tokens."
 * - `invalid_client` (and the sibling client-config codes) — OUR credentials
 *   are wrong. The user's grant at the provider is untouched. Google's remedy:
 *   "Review the OAuth client configuration, including the client ID and secret
 *   used for this request." Treating this as a revocation would destroy a
 *   working grant over a condition we can fix ourselves.
 *
 * Quotes read at developers.google.com/identity/protocols/oauth2/web-server on
 * 2026-08-21 — dated because a vendor page is a moving claim.
 *
 * **Scope:** this separates failures by their `error` CODE, not by their cause.
 * A wrong client *secret* surfaces as `invalid_client` and is covered. A
 * syntactically valid but WRONG client *id* authenticates fine and makes the
 * provider reject the token as foreign — reported as `invalid_grant`,
 * indistinguishable *here* from a real revocation, because the body carries
 * nothing that separates them. That case is decided one step later, by
 * {@link reclassifyForeignGrant}. This one stays a pure function of the
 * response, which is what makes it testable against the wire format alone.
 */
export function classifyRefreshFailure(httpStatus: number, body: string): RefreshFailureKind {
  if (httpStatus >= 500 || httpStatus === 429) return 'transient';
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    if (typeof parsed.error === 'string') {
      if (parsed.error === 'invalid_grant') return 'grant-revoked';
      // `unauthorized_client` / `deleted_client` are the same class as
      // `invalid_client`: our app registration is wrong. Telling the user to
      // "retry in a moment" would be a lie — retrying never fixes any of them.
      if (parsed.error === 'invalid_client'
        || parsed.error === 'unauthorized_client'
        || parsed.error === 'deleted_client') return 'client-misconfigured';
    }
  } catch {
    // Non-JSON body — often an HTML error page from a proxy in front of the
    // provider. Don't declare a grant dead on the basis of unparseable output.
    return 'transient';
  }
  // 4xx with a JSON body naming neither code → unknown failure mode.
  // Conservative default: keep the token.
  return 'transient';
}

/**
 * Whether a token-endpoint failure names the requested scope as the problem
 * (`invalid_scope`, RFC 6749 §5.2).
 *
 * {@link classifyRefreshFailure} leaves this `transient`, and for the grant that is
 * right: the token is not shown to be dead and nothing should be recorded. What
 * it gets wrong is the remedy. Retrying never helps, because the request asks for
 * a scope the grant or the client does not cover, and the same request gets the
 * same answer. A separate predicate rather than a fourth kind, because the
 * Google path maps every kind to a remedy and never sends a scope on refresh.
 */
export function isScopeRejection(httpStatus: number, body: string): boolean {
  if (httpStatus >= 500 || httpStatus === 429) return false;
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    return parsed.error === 'invalid_scope';
  } catch {
    return false;
  }
}

/**
 * Separate "the user revoked the grant" from "we presented the token to the
 * wrong client" — the two cases {@link classifyRefreshFailure} cannot tell apart.
 *
 * Providers answer `invalid_grant` to both. A wrong client *secret* fails
 * earlier and louder (`invalid_client`); a wrong client *id* that is
 * syntactically valid authenticates fine, and the provider then rejects the
 * refresh token as foreign to that client. The response is identical to a real
 * revocation, so the only thing that separates them is the id recorded when the
 * token was minted — which is why this takes the ids rather than the body.
 *
 * Three states, and only ONE of them changes the outcome:
 *
 * - **unknown** (either id absent) → unchanged. A token minted before anything
 *   recorded the id lands here. Treating unknown as a mismatch would keep
 *   genuinely revoked grants forever and make reconnecting impossible — the
 *   opposite failure, and the more expensive one.
 * - **equal** → unchanged. The token really is dead.
 * - **different** → `client-misconfigured`. The grant is intact; our
 *   registration is what is wrong.
 *
 * The wrong direction is worth naming because a fix aimed at one failure mode
 * produces the other: being too eager here strands users with a dead token no
 * reconnect clears, being too shy discards living grants.
 */
export function reclassifyForeignGrant(
  failure: RefreshFailureKind,
  mintedBy: string | undefined,
  presentedBy: string | undefined,
): RefreshFailureKind {
  if (failure !== 'grant-revoked') return failure;
  // Falsy, not `!== undefined`: an empty string is treated the same as absent,
  // never as "minted by the empty client" — reading it as a mismatch would keep
  // a dead token.
  if (!mintedBy || !presentedBy) return failure;
  return mintedBy === presentedBy ? failure : 'client-misconfigured';
}

/**
 * What the model is told once an api_profile's grant is revoked — by
 * `fetch_token` when it declines to resend the rejected token, and by the
 * credential attach in `http_request`. One text for both, because the model
 * reads them as one rule. It names the one way back (a new refresh token from
 * the user) and says plainly not to fetch again with the old one: the 401 hint
 * used to send the model round exactly that loop.
 *
 * Two ways back, by how the profile was connected. A profile that names a
 * provider preset was authorized by redirect, so the way back is a new consent
 * link from `api_setup connect`; asking the user to paste a refresh token there
 * would send them looking for a value no provider UI shows. Any other profile
 * holds a token someone stored, and gets a new one the same way.
 *
 * SHAPED HERE, for every caller, because the model reads this in the engine's own
 * voice, outside the untrusted-data wrap, and two of its values come from the profile.
 * `refreshKey` is `auth.oauth.refresh_token_key` when the profile names one, and a
 * name only has to look like a vault key to be saved, so it can spell an imperative;
 * it gets the bound of what it is (`slotNameForModel`: the engine-derived name its own
 * wider bound, any other the vault key's). `revokedAt` is written by the engine as an
 * ISO timestamp, but a profile loaded from a file is not re-validated, so it is
 * checked against that shape. A value that does not fit is printed as
 * `<unprintable>`. The id needs no shaping: every path into the store checks it.
 */
export function revokedGrantMessage(
  id: string,
  refreshKey: string,
  derivedRefreshKey: string,
  revokedAt: unknown,
  viaPreset: boolean,
): string {
  const since = revokedAt === undefined ? '' : ` (recorded ${shapedForLog(revokedAt, ISO_TIMESTAMP_SHAPE, 30)})`;
  const head = `Error: the provider rejected the stored refresh token of api_profile "${id}" as revoked or expired${since}. This is not an expired access token — fetching again with the same refresh token cannot work, and fetch_token will not resend it.`;
  return viaPreset
    ? `${head} The user has to consent again at the provider: call api_setup with action "connect" for this profile and give the user the link it returns. Do not ask the user for a token.`
    : `${head} The user has to authorize the app again at the provider; store the new refresh token under "${slotNameForModel(refreshKey, derivedRefreshKey)}" with ask_secret, then call fetch_token once.`;
}

/**
 * A short, one-way fingerprint, so a record can say WHICH token the provider
 * rejected — or which client minted one — without holding the value.
 *
 * It lets a revoked verdict refuse to post the same token again, and step aside
 * the moment a different one is in the vault — the user's way back. Sixteen hex
 * characters of SHA-256. For a refresh token that identifies without revealing:
 * the value is high-entropy. A client id is often a public identifier and gains
 * no secrecy here; it is fingerprinted because the slot it is read from is named
 * by the profile and could hold anything, and the record is stored in plain text.
 * Only equality is ever asked of it, and a collision between two values one
 * profile sees is not a practical concern.
 */
export function tokenFingerprint(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex').slice(0, 16);
}

/**
 * The verdicts for Microsoft's token endpoint: the three above, plus two that
 * keep the token and name who has to act.
 *
 * - `needs-user` — the user has to sign in again (multi-factor step-up, an
 *   expired password, or a refusal this table does not know). The token stays;
 *   a new sign-in replaces it.
 * - `needs-admin` — only the tenant's admin can fix it (account disabled, user
 *   not assigned to the app, a policy blocking the sign-in, the app removed from
 *   the tenant). The token stays.
 *
 * A separate union rather than two more members of {@link RefreshFailureKind}:
 * that type is read by the Google path and by `api_setup`, neither of which can
 * produce these kinds, and `api_setup` branches on it without an exhaustive
 * check, so a new member would fall through there silently.
 */
export type MicrosoftRefreshFailureKind = RefreshFailureKind | 'needs-user' | 'needs-admin';

/**
 * The `error_codes` (Microsoft Entra "AADSTS" numbers) the classifier acts on.
 *
 * Read from Microsoft's Entra authentication error-code reference on 2026-10-15,
 * dated because a vendor page is a moving claim. Taken from the documentation,
 * not yet observed from a live tenant; which codes a revocation or a policy
 * block actually returns is to be measured, and this table follows.
 *
 * The same page warns that "apps that take a dependency on text or error code
 * numbers will be broken over time". Hence the shape of the rules below: a code
 * may only move a verdict towards KEEPING the token, except for one short list
 * that may delete it. A renumbered code therefore costs the user a sign-in,
 * never a connection lost without a word.
 */
export const MICROSOFT_REFRESH_CODES = {
  /** Only an admin can fix these, whatever `error` says. Checked first. */
  needsAdmin: [
    50057, // UserDisabled: the account is disabled
    50105, // the signed-in user is not assigned to a role for the app
    53003, // BlockedByConditionalAccess
    700016, // the app was not found in the tenant (also: removed by its admin)
  ],
  /** With `invalid_grant`, these alone mean the grant is gone and the token may be deleted. */
  grantRevoked: [
    70008, // the refresh token has expired due to inactivity
    700082, // the refresh token has expired due to inactivity
    50173, // the grant was revoked (fresh auth token needed)
    65001, // DelegationDoesNotExist: consent missing or withdrawn
    50133, // session invalid due to password expiration or recent password change
  ],
} as const satisfies Record<string, readonly number[]>;

/**
 * Classify a failure of Microsoft's token endpoint. The order is the rule:
 *
 * 1. 5xx and 429 are transient, as for every provider; so is a body that is
 *    not JSON.
 * 2. A code in `needsAdmin` → `needs-admin`, whatever the `error`.
 * 3. Otherwise `error` decides: `temporarily_unavailable` → transient;
 *    `invalid_client` / `unauthorized_client` → client-misconfigured, with any
 *    code or none (700016 never gets here, step 2 took it).
 * 4. `invalid_grant` → `grant-revoked` only with a code in `grantRevoked`;
 *    without one, `needs-user`.
 * 5. Anything else (`interaction_required` included) → `needs-user`.
 *
 * `error_description` is never read: Microsoft's reference says not to react to
 * it in code.
 */
export function classifyMicrosoftRefreshFailure(httpStatus: number, body: string): MicrosoftRefreshFailureKind {
  if (httpStatus >= 500 || httpStatus === 429) return 'transient';
  let parsed: { error?: unknown; error_codes?: unknown };
  try {
    parsed = JSON.parse(body) as { error?: unknown; error_codes?: unknown };
  } catch {
    return 'transient';
  }
  if (parsed === null || typeof parsed !== 'object') return 'transient';
  const codes = Array.isArray(parsed.error_codes)
    ? parsed.error_codes.filter((c): c is number => typeof c === 'number')
    : [];
  const has = (list: readonly number[]): boolean => codes.some((c) => list.includes(c));
  if (has(MICROSOFT_REFRESH_CODES.needsAdmin)) return 'needs-admin';
  const error = parsed.error;
  if (error === 'temporarily_unavailable') return 'transient';
  if (error === 'invalid_client' || error === 'unauthorized_client') return 'client-misconfigured';
  if (error === 'invalid_grant' && has(MICROSOFT_REFRESH_CODES.grantRevoked)) return 'grant-revoked';
  return 'needs-user';
}
