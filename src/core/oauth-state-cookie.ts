/**
 * The signed state a profile's OAuth round-trip carries in a cookie.
 *
 * ── Why the profile id lives HERE and not in the callback path ──────────────
 *
 * The callback is unauthenticated by construction: it is a top-level browser
 * redirect arriving from the provider, so the dispatch has to let it through
 * before any session check. That carve-out is an EXACT path comparison
 * (`http-api.ts`, the `/api/google/callback` branch), and keeping it exact is
 * the property that matters: a path with the id in it —
 * `/api/oauth/callback/<id>` — would need a PREFIX match, and a prefix match
 * widens the unauthenticated surface to everything that is ever built under
 * that prefix, without anyone deciding to widen it.
 *
 * So the path stays constant and the id rides in this cookie. Three things
 * follow, and the second is the reason this module exists:
 *
 *  1. The dispatch gains a second exact branch instead of a pattern.
 *  2. The OAuth clause this belongs to owes an obligation — *authenticate
 *     before the profile id is resolved*, because the lookup alone discloses whether the
 *     id exists on this instance. That is an ORDERING, and orderings do not
 *     survive refactors. Here the id is not in the request at all: it arrives
 *     inside a payload whose HMAC is checked before anything touches the
 *     store. An ordering can be lost by moving two lines; an id that is not in
 *     the request cannot be resolved early by anyone.
 *  3. The id never reaches the provider, the referrer, or browser history.
 *
 * ── Why the id is inside the SIGNATURE, not beside it ──────────────────────
 *
 * The payload is signed as one string. A cookie minted for profile `a`
 * therefore cannot be replayed against profile `b` by editing the field: the
 * signature covers the id. Without that, a user who may connect ONE profile
 * could redirect a grant into another.
 *
 * ── Why a separate derivation purpose ──────────────────────────────────────
 *
 * `lynox-profile-oauth-state` is not the Google flow's `lynox-oauth-state`.
 * The two cookies are already separated by name and by `Path`, but those are
 * transport properties and a later edit can collapse them. A different derived
 * key means a Google state cookie CANNOT verify here and vice versa, whatever
 * the transport does — the separation is cryptographic rather than clerical.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/** Mirrors `PROFILE_ID_PATTERN` in `api-store.ts`. Dot-free, which is what lets
 *  the payload be dot-separated without any encoding. */
const PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** A PKCE verifier is unreserved base64url per RFC 7636 §4.1 — dot-free too. */
const VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;

/** The opaque value echoed by the provider. Minted as a UUID, so dot-free. */
const STATE_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

const PURPOSE = 'lynox-profile-oauth-state';

/** Ten minutes: longer than any human flow, shorter than a stolen cookie is useful. */
export const PROFILE_OAUTH_STATE_TTL_SEC = 10 * 60;

/** What the round-trip has to carry across the provider's page. */
export interface ProfileOAuthState {
  /** The `state` parameter the provider echoes back. */
  readonly state: string;
  /** Which profile is being authorized. */
  readonly profileId: string;
  /** PKCE code verifier; the challenge derived from it goes to the provider. */
  readonly verifier: string;
}

/**
 * Sign, or refuse.
 *
 * Every field is validated on the way IN, not only on the way out. A value
 * that cannot round-trip through a dot-separated payload must never be signed:
 * signing it produces a cookie that verifies as a DIFFERENT value, which is
 * worse than one that fails. `null` means the caller built something the
 * format cannot carry, and that is a defect at the mint site.
 */
export function signProfileOAuthState(
  v: ProfileOAuthState,
  secret: string,
  nowSec: number,
): string | null {
  if (!secret) return null;
  if (!STATE_PATTERN.test(v.state)) return null;
  if (!PROFILE_ID_PATTERN.test(v.profileId)) return null;
  if (!VERIFIER_PATTERN.test(v.verifier)) return null;
  if (!Number.isInteger(nowSec) || nowSec < 0) return null;
  // The verifier's own charset admits `.` and `~`; the payload is dot-separated,
  // so a verifier carrying a dot would split into the wrong number of fields.
  // Refused here rather than escaped: the mint site controls this value, and a
  // generator that emits dots is a defect to fix, not input to accommodate.
  if (v.verifier.includes('.')) return null;

  const payload = `${v.state}.${v.profileId}.${v.verifier}.${String(nowSec)}`;
  return `${payload}.${sign(payload, secret)}`;
}

/**
 * Verify and unpack, or `null`.
 *
 * Order is deliberate: arity, then shape, then TTL, then signature. The TTL
 * check reads an UNVERIFIED timestamp, which is safe because forging it
 * forward only reaches the signature check that then fails — and doing it in
 * this order means an expired cookie costs no HMAC.
 *
 * The field patterns are re-checked AFTER the signature as well. A signature
 * proves this engine minted the value; it does not prove the value is still
 * one the store should be asked about, and the id goes into a lookup.
 */
export function verifyProfileOAuthState(
  raw: string,
  secret: string,
  nowSec: number,
): ProfileOAuthState | null {
  if (!secret || !raw) return null;

  const parts = raw.split('.');
  if (parts.length !== 5) return null;
  const [state, profileId, verifier, tsStr, sig] = parts;
  if (!state || !profileId || !verifier || !tsStr || !sig) return null;

  // `parseInt` accepts leading garbage ("12abc" → 12) and a leading `+`/`-`;
  // the pattern is what makes the timestamp a number this engine wrote.
  if (!/^\d{1,15}$/.test(tsStr)) return null;
  const ts = Number(tsStr);
  if (!Number.isInteger(nowSec)) return null;
  // Both directions. A cookie stamped in the future is not a clock skew this
  // needs to tolerate — it is a value this engine did not mint now, and the
  // TTL below would accept it for as long as the skew lasts.
  if (nowSec < ts) return null;
  if (nowSec - ts > PROFILE_OAUTH_STATE_TTL_SEC) return null;

  const expected = sign(`${state}.${profileId}.${verifier}.${tsStr}`, secret);
  const sigBuf = Buffer.from(sig, 'hex');
  const expBuf = Buffer.from(expected, 'hex');
  // `Buffer.from(x, 'hex')` truncates at the first non-hex character rather
  // than throwing, so a short or non-hex signature must be caught by length
  // before `timingSafeEqual`, which throws on a mismatch.
  if (sigBuf.length !== expBuf.length) return null;
  if (!timingSafeEqual(sigBuf, expBuf)) return null;

  if (!STATE_PATTERN.test(state)) return null;
  if (!PROFILE_ID_PATTERN.test(profileId)) return null;
  if (!VERIFIER_PATTERN.test(verifier)) return null;

  return { state, profileId, verifier };
}

function sign(payload: string, secret: string): string {
  const key = createHmac('sha256', PURPOSE).update(secret).digest();
  return createHmac('sha256', key).update(payload).digest('hex');
}
