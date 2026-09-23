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
import { isPrivateLanEndpoint, isRedirectAcked } from './llm/endpoint-allowlist.js';
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
  // all of them lives one import away. Two normalisations first, and both are
  // the parser's leavings rather than defensive habit: a URL hands back an IPv6
  // hostname wearing brackets, and it preserves a trailing FQDN-root dot byte
  // for byte — so `localhost.` and `shop.local.` reach here as names that no
  // string comparison and no suffix pattern below matches. The derivation
  // refuses that spelling too; this line is what makes the exported function
  // right for a caller that did not derive, which its argument type cannot
  // promise.
  const rootedHost = redirectHost.replace(/\.$/, '');
  const bareHost = rootedHost.replace(/^\[|\]$/g, '');
  if (redirectHost === ''
    || bareHost === 'localhost'
    || isPrivateIP(bareHost)
    // The brackets stay on for this one: it takes a URL, and an IPv6 address
    // without them does not parse. Only the dot comes off here.
    || isPrivateLanEndpoint(`https://${rootedHost}/`)) {
    return {
      kind: 'inside-network',
      message: 'This profile would send you to a page inside this engine\'s own network to authorize. That is not the provider, and nobody can accept it on your behalf — the profile has to name a provider this engine knows.',
    };
  }

  // ONE question, and it is the one about this act: did a human agree to be sent
  // to this host in their browser to authorize?
  //
  // Not `isEndpointAcked`, and not `isVettedEgressHost` either — both answer
  // where DATA may go, and this file exists because that is a different
  // question. The egress ack's own text says the user accepts controller
  // responsibility for a data-processing relationship; it never mentions being
  // redirected anywhere, so reading it as permission for a redirect takes a
  // consent for one act as consent for another. The vetted list is the same
  // mistake with a different author: it records hosts lynox vouches for as
  // sub-processors, which says nothing about handing a person to that site to
  // type a provider password.
  //
  // The advice below is followable because the save path now asks this question
  // for EVERY preset profile, vetted or not — so the prompt it points at is
  // always reachable. That is the whole reason the acceptance is collected
  // there rather than only for non-vetted hosts.
  if (!isRedirectAcked(ack, endpoints.authorizeUrl)) {
    return {
      kind: 'no-egress-ack',
      message: `Nobody has agreed to be sent to ${endpoints.host} to authorize this profile. Save the profile again and accept when asked where you will be sent, then open this link again.`,
    };
  }

  return null;
}
