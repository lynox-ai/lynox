import { createHash } from 'node:crypto';

/**
 * How a failed token-endpoint call is read, for every OAuth path in the engine:
 * the Google integration and the generic `api_setup fetch_token`.
 *
 * One module rather than one copy per path. The Google path had this first, and
 * a second copy for the generic grant would have been the start of two
 * verdicts for the same wire response — the pair these two functions exist to
 * keep apart is exactly the one that drifts when nobody compares them.
 *
 * The codes are the ones RFC 6749 §5.2 defines for a token endpoint, so nothing
 * here is Google-specific. The remedies stay with each path, because only the
 * path knows who can act on them.
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
  // Falsy, not `!== undefined`: every writer gates its stamp on truthiness, so
  // an empty string never means "minted by the empty client" — it means the
  // same as absent, and reading it as a mismatch would keep a dead token.
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
 */
export function revokedGrantMessage(id: string, refreshKey: string, revokedAt: string | undefined): string {
  const since = revokedAt ? ` (recorded ${revokedAt})` : '';
  return `Error: the provider rejected the stored refresh token of api_profile "${id}" as revoked or expired${since}. This is not an expired access token — fetching again with the same refresh token cannot work, and fetch_token will not resend it. The user has to authorize the app again at the provider; store the new refresh token under "${refreshKey}" with ask_secret, then call fetch_token once.`;
}

/**
 * A short, one-way fingerprint of a token, so a record can say WHICH token the
 * provider rejected without holding the token.
 *
 * It lets a revoked verdict refuse to post the same token again, and step aside
 * the moment a different one is in the vault — the user's way back. Sixteen hex
 * characters of SHA-256: the tokens it is taken from are high-entropy, so the
 * prefix identifies without revealing, and collisions between two tokens of one
 * profile are not a practical concern.
 */
export function tokenFingerprint(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex').slice(0, 16);
}
