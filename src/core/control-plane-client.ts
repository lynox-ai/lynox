import type { OAuthRefreshResponse } from '../contract/http.js';

/**
 * The engine's side of its identity toward the control plane, shared by every
 * integration whose credentials the control plane brokers (Google, Microsoft).
 *
 * ONE copy on purpose. These checks decide whether a request carrying the
 * instance secret may be built at all; a second copy per provider is how one of
 * them would end up checking less than the other.
 */

/**
 * The three values a managed instance needs to reach its control plane, or null
 * when any is missing.
 *
 * All three or none, deliberately: a partially configured instance must take
 * the direct path rather than build a half-formed request. Two are checked for
 * presence; the URL is checked for usability, which subsumes presence. The same
 * env names `managed-hook.ts` uses — the engine has exactly one identity toward
 * the control plane.
 */
export function readControlPlaneIdentity(): { url: string; instanceId: string; secret: string } | null {
  const rawUrl = process.env['LYNOX_MANAGED_CONTROL_PLANE_URL'] ?? '';
  const instanceId = process.env['LYNOX_MANAGED_INSTANCE_ID'] ?? '';
  const secret = process.env['LYNOX_HTTP_SECRET'] ?? '';
  // No `!rawUrl` here: `controlPlaneBase` refuses the empty string already
  // (`new URL('')` throws), so a presence check would be a line no test could
  // distinguish from its absence.
  if (!instanceId || !secret) return null;
  const url = controlPlaneBase(rawUrl);
  if (url === null) return null;
  return { url, instanceId, secret };
}

/**
 * Normalise the CP base URL, or null if it cannot carry a secret safely.
 *
 * The value is operator-set, so this is not a trust boundary — it is a
 * concatenation guard. `${base}/internal/...` on a base that carries a query or
 * a fragment does not append a path, it extends the query, and the request
 * would go somewhere else with the instance secret attached. A path PREFIX is
 * kept, because a CP behind one is a legitimate deployment.
 */
export function controlPlaneBase(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  // Refuse on the RAW string, not on `parsed.search`/`parsed.hash`: an empty
  // query parses to `search === ''` while `href` keeps the `?`, so reading the
  // parsed fields let exactly the value through that this guard exists for.
  // Refusing beats silently dropping — an operator's mistake should be loud.
  if (raw.includes('?') || raw.includes('#')) return null;
  // Credentials would authenticate the request somewhere the operator did not
  // mean. Refuse rather than strip: `origin` would drop them silently while the
  // operator still believed the request was authenticated.
  if (parsed.username !== '' || parsed.password !== '') return null;
  // ONE mechanism, deliberately. Building from `origin + pathname` would make
  // the same guarantee structurally — and that is exactly the problem: with the
  // refusals above it can never behave differently, so no test could tell the
  // two apart and the second line would be uncovered by construction.
  return parsed.href.replace(/\/+$/, '');
}

/**
 * The widest access-token lifetime we accept from the control plane. Google's
 * are an hour, Microsoft's about the same; a day is slack for any future change without letting an absurd
 * value pin a stale token for a year.
 */
const MAX_CP_TOKEN_LIFETIME_MS = 24 * 60 * 60 * 1000;

/**
 * Validate a refresh response from the control plane, for any provider whose
 * refresh goes through it (`OAuthRefreshResponse`).
 *
 * `transientRemedy` is the caller's own sentence for "try again, nothing is
 * lost": each provider names its own connection, so the text cannot live here.
 *
 * The direct path runs every Google response through `validateTokenResponse`.
 * This is the equivalent for the other one, and deliberately stricter: the
 * direct path derives `expires_at` from a `expires_in` it has already bounded
 * to be positive, while this value arrives absolute and unchecked. A `typeof`
 * check alone is not enough — `NaN` is a number, and an `expires_at` of `NaN` makes the staleness
 * comparison in `getAccessToken` false forever, so the engine would serve a
 * dead access token and never refresh again. An out-of-range value fails the
 * other way: an always-past expiry turns the CP into a dependency of every
 * provider call rather than of the hourly refresh.
 */
export function validateControlPlaneRefresh(json: unknown, transientRemedy: string): OAuthRefreshResponse {
  const bad = (why: string): never => {
    throw new Error(`Token refresh failed: ${why}.` + transientRemedy);
  };
  if (typeof json !== 'object' || json === null) {
    return bad('the control plane returned no usable token');
  }
  const data = json as Record<string, unknown>;
  const token = data['access_token'];
  if (typeof token !== 'string' || token === '') {
    return bad('the control plane returned no usable token');
  }
  const expiresAt = data['expires_at'];
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
    return bad('the control plane returned no usable expiry');
  }
  const now = Date.now();
  if (expiresAt <= now || expiresAt > now + MAX_CP_TOKEN_LIFETIME_MS) {
    return bad('the control plane returned an expiry outside the plausible range');
  }
  const handle = data['refresh_handle'];
  if (handle !== undefined && (typeof handle !== 'string' || handle === '')) {
    return bad('the control plane returned an unusable refresh handle');
  }
  return {
    access_token: token,
    expires_at: expiresAt,
    ...(typeof handle === 'string' ? { refresh_handle: handle } : {}),
  };
}
