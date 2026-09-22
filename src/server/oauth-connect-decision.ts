/**
 * Everything the connect start route decides BEFORE it mints anything.
 *
 * The route's order of checks is part of its design, not an accident of how it
 * was written: every refusal that happens before the `state` and the PKCE
 * verifier exist costs no stored state, no cookie and no nonce, while the same
 * refusal after them leaves litter behind that a later request has to clean up
 * or trip over. Keeping the decision in one pure function is what makes that
 * order testable — a test can enumerate the refusals and assert that each one
 * leaves nothing, which a handler with the checks sprinkled through it cannot
 * offer.
 *
 * The union below is the enumeration. A new refusal means a new member, and a
 * new member breaks the test's fixture table until it has a case — which is
 * the point: a table that is merely exhaustive at compile time and never run
 * proves nothing, so the test iterates it.
 */
import type { ApiProfile } from '../core/api-store.js';
import { derivePresetEndpoints, presetIds } from '../core/oauth-presets.js';
import { isVettedEgressHost, isEndpointAcked } from '../core/llm/endpoint-allowlist.js';

/** Every way the start route refuses before anything is minted. */
export type ConnectRefusalKind =
  | 'no-fetch-metadata'
  | 'cross-site'
  | 'not-a-document'
  | 'unknown-profile'
  | 'not-oauth2'
  | 'no-preset'
  | 'bad-preset-param'
  | 'no-egress-ack'
  | 'no-http-secret';

export interface ConnectRefusal {
  readonly kind: ConnectRefusalKind;
  readonly status: number;
  /** Shown to the person who clicked, so it says what to do, not what failed. */
  readonly message: string;
}

export interface ConnectFacts {
  /** `Sec-Fetch-Site`, absent when the client sent none. */
  readonly fetchSite: string | undefined;
  /** `Sec-Fetch-Dest`. */
  readonly fetchDest: string | undefined;
  /** The profile, or undefined when the id names none. */
  readonly profile: ApiProfile | undefined;
  /** Whether `LYNOX_HTTP_SECRET` is set — the state cookie is signed with it. */
  readonly httpSecretSet: boolean;
}

export interface ConnectTarget {
  readonly authorizeUrl: string;
  readonly tokenUrl: string;
  readonly host: string;
}

/**
 * The refusal, or `null` when the route may proceed to mint.
 *
 * Measured, not assumed (see the plan's §11): a click on a chat link arrives as
 * `same-origin`/`document` even though the link carries `rel="noreferrer"`, an
 * address-bar or messenger open arrives as `none`, a foreign page arrives as
 * `cross-site` — and stays `cross-site` through a redirect on our own origin.
 * Only non-browser clients send no fetch metadata at all, which is why the
 * absence is refused here although the logout precedent treats it as a
 * navigation: a missed logout is harmless, a silent re-connect is not.
 */
export function decideConnect(facts: ConnectFacts): ConnectRefusal | ConnectTarget {
  if (facts.fetchSite === undefined || facts.fetchDest === undefined) {
    return {
      kind: 'no-fetch-metadata',
      status: 403,
      message: 'This link has to be opened in a browser, by clicking it. Open the page this link came from and click it there.',
    };
  }
  if (facts.fetchSite !== 'same-origin' && facts.fetchSite !== 'none') {
    return {
      kind: 'cross-site',
      status: 403,
      message: 'This link was opened from another site. Open it from this instance — from the chat where it was offered, or by pasting it into the address bar.',
    };
  }
  if (facts.fetchDest !== 'document') {
    return {
      kind: 'not-a-document',
      status: 403,
      message: 'This link has to be opened as a page, not fetched in the background.',
    };
  }

  const profile = facts.profile;
  if (!profile) {
    return { kind: 'unknown-profile', status: 404, message: 'There is no API profile with that id on this instance.' };
  }
  if (profile.auth?.type !== 'oauth2') {
    return {
      kind: 'not-oauth2',
      status: 400,
      message: 'This profile does not connect through a provider — it carries a credential that was set directly.',
    };
  }

  // Derived here, at the moment of use, from the register and the profile's
  // parameters. The profile's own `token_url` is display only: a profile can
  // enter the store without passing a save, so a host checked at save time is
  // not a boundary.
  const endpoints = derivePresetEndpoints(profile.auth.oauth?.preset_id ?? '', profile.auth.oauth?.preset_params);
  if ('kind' in endpoints) {
    if (endpoints.kind === 'unknown-preset') {
      const known = presetIds();
      return {
        kind: 'no-preset',
        status: 400,
        message: known.length > 0
          ? `This profile does not name a provider this engine knows. It knows: ${known.join(', ')}.`
          : 'This engine has no built-in providers yet, so there is nothing to connect to.',
      };
    }
    return {
      kind: 'bad-preset-param',
      status: 400,
      message: `This profile is missing what its provider needs: ${endpoints.param.describe}.`,
    };
  }

  // The same question `api_setup` asks before it sends a token anywhere: is
  // this host one the engine vouches for, or one the operator accepted for
  // this profile? Asked about the DERIVED host, not a stored one.
  if (!isVettedEgressHost(endpoints.authorizeUrl) && !isEndpointAcked(profile.custom_endpoint_ack, endpoints.authorizeUrl)) {
    return {
      kind: 'no-egress-ack',
      status: 403,
      message: `Nobody has accepted sending data to ${endpoints.host} for this profile yet. Save the profile again and accept the provider when asked.`,
    };
  }

  if (!facts.httpSecretSet) {
    return {
      kind: 'no-http-secret',
      status: 500,
      message: 'This engine cannot sign the state cookie the return trip needs. LYNOX_HTTP_SECRET must be set.',
    };
  }

  return endpoints;
}

/** True when the decision refused; `false` when it produced a target. */
export function isRefusal(d: ConnectRefusal | ConnectTarget): d is ConnectRefusal {
  return 'kind' in d;
}
