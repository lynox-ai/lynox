/**
 * Connector egress — the third surface, and the two host sets that admit it.
 *
 * PRD-GOOGLE-CONNECT-STAGE-1 §3.8. Until this module existed, every
 * authenticated call the engine made on behalf of a tenant's Google grant went
 * out through a bare `fetch()` and was invisible to `network_policy`: an
 * operator who set `deny-all` still had Google traffic leaving the box, so the
 * sentence "the policy describes this instance's egress" was false
 * — the sentence was false, not merely imprecise.
 *
 * Two helpers, two host sets, one reason. They are NOT interchangeable:
 *
 *  - `googleFetch` — a Google Workspace API call carrying the tenant's grant.
 *    Admitted by `GOOGLE_API_HOSTS`.
 *  - `cpFetch` — a call to THIS instance's control plane. Admitted by the CP's
 *    own host, resolved per call from the URL.
 *
 * Routing a control-plane call through `googleFetch` would refuse the CP host,
 * and since the brokered token refresh runs through exactly that path, it would
 * break every brokered refresh in the fleet under `guarded` — the one mode
 * Stage 1 exists to serve. That is why the split is load-bearing rather than
 * tidy, and why §6 pins a brokered refresh succeeding under `guarded`.
 *
 * They differ in ONE more way, and it is not symmetry for its own sake:
 * `googleFetch` follows redirects and re-applies the policy per hop, because a
 * Drive download legitimately redirects and a bare check of the first URL would
 * miss a 302 off the constant host set. `cpFetch` follows NONE, because the
 * control-plane request carries `x-instance-secret` — a header that is NOT in
 * `CROSS_ORIGIN_DROP_HEADERS`, so a followed hop would replay the instance
 * secret to whatever the redirect names. Not following is strictly stronger
 * than following-and-checking, and it is what the call site already asked for
 * with `redirect: 'manual'`.
 */
import { fetchWithValidatedRedirects } from '../tools/builtin/http.js';
import { assertHostPolicy, fetchPinned } from './network-guard.js';
import type { HostPolicyContext } from './network-guard.js';

/**
 * The hosts the engine actually FETCHES for a Google grant.
 *
 * Drawn from the fetch targets, not from the word "google": `docs.google.com`
 * and `drive.google.com` appear in this repo only inside strings shown to the
 * user after a document is created, and `accounts.google.com` is the consent
 * URL a browser opens — none of the three is a fetch target, so none belongs
 * here. A host set drawn over "everything Google-looking" would admit reach
 * this code does not need.
 *
 * `oauth2.googleapis.com` covers refresh, revoke, the device-flow poll and the
 * service-account assertion; the service-account `token_uri` is pinned to that
 * exact origin at load time, so the one non-literal target in the module cannot
 * leave the set either.
 *
 * ⚠ This is an EXACT-match set — `assertHostPolicy` does a `Set.has` on the
 * hostname, with no wildcard. If a Google endpoint ever 302s to a content CDN
 * (`*.googleusercontent.com` is the candidate), that hop is refused under
 * `guarded` and the operator floor (`network_allowed_hosts`) is the escape
 * hatch. Whether Google does that on the calls this engine makes is NOT
 * measured here — guessing a host into a security set is worse than naming the
 * gap: the hop is refused, not silently allowed, and the operator floor is a
 * visible lever. Guessing a host into a security set is how the vetted baseline
 * became a list nobody can read any more.
 */
export const GOOGLE_API_HOSTS: ReadonlySet<string> = new Set([
  'www.googleapis.com',      // Drive, Calendar, the Drive half of Sheets, uploads, backup
  'sheets.googleapis.com',   // Sheets values/metadata
  'docs.googleapis.com',     // Docs documents
  'gmail.googleapis.com',    // Gmail over OAuth (mail provider + the profile probe)
  'oauth2.googleapis.com',   // token, device code, revoke, service-account assertion
]);

/**
 * A Google Workspace API call on behalf of the tenant's grant.
 *
 * `ctx` is the live host-policy view. It is OPTIONAL and `undefined` means "no
 * policy configured", which `assertHostPolicy` treats as `allow-all` — the same
 * meaning it has on every other surface. That is deliberate: a self-hosted
 * instance that never set `network_policy` must keep working exactly as before.
 */
export async function googleFetch(
  url: string,
  init: RequestInit,
  ctx: HostPolicyContext | undefined,
): Promise<Response> {
  const { response } = await fetchWithValidatedRedirects(
    url,
    init,
    { surface: 'connector', hosts: GOOGLE_API_HOSTS },
    ctx,
  );
  return response;
}

/**
 * A call to this instance's own control plane.
 *
 * ⚠ It does NOT follow redirects, and that is the reason it is not built on
 * `fetchWithValidatedRedirects` like its sibling. The request carries
 * `x-instance-secret`; `CROSS_ORIGIN_DROP_HEADERS` drops `authorization`,
 * `cookie` and the common api-key spellings on a cross-origin hop but has no
 * entry for that header, so a followed 3xx would replay this instance's secret
 * to whatever host the redirect names. `fetchPinned` returns the 3xx as an
 * ordinary non-`ok` response, which the refresh path already classifies as
 * transient — a control plane that starts redirecting degrades instead of
 * leaking. That was already true of the refresh call via `redirect: 'manual'`;
 * routing it through the redirect-following helper would have silently undone
 * it, and under the DEFAULT `allow-all` policy nothing would have complained.
 *
 * ⚠ The host set is built from `hostname`, NOT from `host`. `assertHostPolicy`
 * matches against `URL.hostname`, which carries no port; `URL.host` carries one
 * whenever the URL has one. A set built from `host` would therefore miss its
 * own target on any CP URL with an explicit port — which is every local and
 * every non-443 deployment — and the failure would be a blocked brokered
 * refresh under `guarded`, i.e. the exact outage this surface exists to avoid.
 *
 * With no hops to re-check, one gate before the single request is the whole of
 * the policy check — `fetchPinned` still does the DNS-resolve + rebind-safe
 * connection pinning underneath it.
 */
export async function cpFetch(
  url: string,
  init: RequestInit,
  ctx: HostPolicyContext | undefined,
): Promise<Response> {
  assertHostPolicy(url, { surface: 'connector', hosts: new Set([new URL(url).hostname]) }, ctx);
  return fetchPinned(url, init);
}
