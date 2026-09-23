/**
 * The one question asked before a user's BROWSER is sent to a provider.
 *
 * It lives here, in its own module, because two callers ask it and they must
 * not answer it differently: the start route decides whether to redirect, and
 * `api_setup connect` decides whether to hand the model a link at all. While
 * only the route asked, `connect` returned a link the route would then refuse —
 * the model told the user to click, and the user arrived at a 403. Two copies of
 * the policy would have the same ending, one release later.
 *
 * What it is NOT: the egress question. `isVettedEgressHost` answers whether this
 * engine may SEND data to a host, and it vouches for `localhost`, `127.0.0.1`
 * and `.local` names because a host inside the operator's own network carries no
 * third-party exposure. Sending a person there to type their provider password
 * is a different question with a different answer, and that difference is the
 * whole reason this file exists.
 */
import type { ApiProfile } from './api-store.js';
import type { PresetEndpoints } from './oauth-presets.js';
import { isVettedEgressHost, isPrivateLanEndpoint, isEndpointAcked } from './llm/endpoint-allowlist.js';
import { isPrivateIP } from './network-guard.js';

/**
 * Two refusals, because they have two different ways out — and one of them has
 * none at all. Merging them produced advice ("save it again and accept") that
 * the inside-network case can never follow: a private host is vouched for by the
 * egress vetting, so it never reaches the prompt that would stamp an acceptance.
 */
export type RedirectRefusal =
  | { readonly kind: 'inside-network'; readonly message: string }
  | { readonly kind: 'no-egress-ack'; readonly message: string };

/** The refusal, or `null` when this browser may be sent to this host. */
export function checkRedirectTarget(
  endpoints: PresetEndpoints,
  ack: ApiProfile['custom_endpoint_ack'],
): RedirectRefusal | null {
  let redirectHost: string;
  try {
    redirectHost = new URL(endpoints.authorizeUrl).hostname;
  } catch {
    redirectHost = '';
  }
  // `isPrivateIP` rather than a hand-written set: the first version here listed
  // five strings and leaned on the private-LAN patterns for the rest, which
  // covers RFC1918 in dotted-quad and `.local`/`.lan`/`.intranet` — and misses
  // the rest of 127/8, link-local (including the cloud metadata address), CGNAT,
  // `fe80::`, `fc00::` and IPv4-mapped loopback. The predicate that already knows
  // all of them lives one import away. Brackets come off first, because a URL
  // hands back an IPv6 hostname wearing them and the predicate takes the address.
  if (redirectHost === ''
    || redirectHost === 'localhost'
    || isPrivateIP(redirectHost.replace(/^\[|\]$/g, ''))
    || isPrivateLanEndpoint(endpoints.authorizeUrl)) {
    return {
      kind: 'inside-network',
      message: 'This profile would send you to a page inside this engine\'s own network to authorize. That is not the provider, and nobody can accept it on your behalf — the profile has to name a provider this engine knows.',
    };
  }

  // What the ack buys, stated exactly: it is the tenant's acceptance of THIS
  // host for THIS profile, taken out of band from a human. It is not the engine
  // vouching for the host, and above it does not stretch to a host inside the
  // operator's network. The save-time prompt discloses the derived authorize
  // host too, so what the human accepted and what happens agree.
  if (!isVettedEgressHost(endpoints.authorizeUrl) && !isEndpointAcked(ack, endpoints.authorizeUrl)) {
    return {
      kind: 'no-egress-ack',
      message: `Nobody has accepted ${endpoints.host} for this profile yet. Save the profile again and accept the provider when asked, then open this link again.`,
    };
  }

  return null;
}
