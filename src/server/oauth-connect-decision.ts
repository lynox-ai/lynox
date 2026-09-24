/**
 * Everything the connect start route decides BEFORE it mints anything.
 *
 * The route's order of checks is part of its design, not an accident of how it
 * was written: every refusal that happens before the `state` and the PKCE
 * verifier exist costs no stored state, no cookie and no nonce, while the same
 * refusal after them leaves litter behind that a later request has to clean up
 * or trip over. Keeping the decision in one pure function is what makes that
 * order testable: the function returns a refusal or a target and touches nothing
 * else, so a test can enumerate the refusals and see that none of them carries a
 * target to mint against — which a handler with its checks sprinkled through it
 * cannot offer. What no test here asserts is that the FUNCTION is pure; that is
 * read off the code, and it is why the code stays this small.
 *
 * The union below is the enumeration. A new refusal means a new member, and a
 * new member breaks the test's fixture table until it has a case — which is
 * the point: a table that is merely exhaustive at compile time and never run
 * proves nothing, so the test iterates it.
 */
import type { ApiProfile } from '../core/api-store.js';
import { derivePresetEndpoints, presetIds, OAUTH_PRESETS, type PresetRegister } from '../core/oauth-presets.js';
import { checkRedirectTarget } from '../core/oauth-redirect-guard.js';

/** Every way the start route refuses before anything is minted. */
export type ConnectRefusalKind =
  | 'no-session'
  | 'no-fetch-metadata'
  | 'cross-site'
  | 'not-a-document'
  | 'unknown-profile'
  | 'not-oauth2'
  | 'no-preset'
  | 'bad-preset-param'
  | 'broken-preset'
  | 'no-egress-ack'
  | 'inside-network'
  | 'no-http-secret';

export interface ConnectRefusal {
  readonly kind: ConnectRefusalKind;
  readonly status: number;
  /** Shown to the person who clicked, so it says what to do, not what failed. */
  readonly message: string;
}

export interface ConnectFacts {
  /**
   * Whether the request carried a valid session of THIS instance.
   *
   * Fetch metadata answers how the request was made, never by whom —
   * `Sec-Fetch-Site: none` is an address-bar open, which anyone can perform. So
   * identity is a fact this function takes, and it is the first thing refused:
   * everything after it discloses something (that a profile exists, which
   * providers are built in, which host one derives).
   */
  readonly authenticated: boolean;
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
 * Measured in a browser rather than read off the specification: a click on a
 * chat link arrives as
 * `same-origin`/`document` even though the link carries `rel="noreferrer"`, an
 * address-bar or messenger open arrives as `none`, a foreign page arrives as
 * `cross-site` — and stays `cross-site` through a redirect on our own origin.
 * Only non-browser clients send no fetch metadata at all, which is why the
 * absence is refused here although the logout precedent treats it as a
 * navigation: a missed logout is harmless, a silent re-connect is not.
 */
export function decideConnect(
  facts: ConnectFacts,
  // The same test seam the register itself carries: a parameter with the frozen
  // constant as its default. Production passes nothing, and a test that needs a
  // provider the shipped register does not have hands in its own rather than
  // reaching around the module.
  register: PresetRegister = OAUTH_PRESETS,
): ConnectRefusal | ConnectTarget {
  if (!facts.authenticated) {
    return {
      kind: 'no-session',
      status: 401,
      message: 'Sign in to this instance first, then open the link again.',
    };
  }
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
  const endpoints = derivePresetEndpoints(profile.auth.oauth?.preset_id ?? '', profile.auth.oauth?.preset_params, register);
  if ('kind' in endpoints) {
    if (endpoints.kind === 'unknown-preset') {
      const known = presetIds(register);
      return {
        kind: 'no-preset',
        status: 400,
        message: known.length > 0
          ? `This profile does not name a provider this engine knows. It knows: ${known.join(', ')}.`
          : 'This engine has no built-in providers yet, so there is nothing to connect to.',
      };
    }
    if (endpoints.kind === 'bad-preset') {
      // Not the profile's fault and not the user's, so the message says so
      // rather than asking them for a value. Nobody standing in front of this
      // page can fix a preset that was compiled in wrong.
      return {
        kind: 'broken-preset',
        status: 500,
        message: 'The built-in provider this profile names is defined wrongly in this engine, so there is no page to send you to. Nothing you can change on the profile fixes it.',
      };
    }
    return {
      kind: 'bad-preset-param',
      status: 400,
      message: `This profile is missing what its provider needs: ${endpoints.param.describe}.`,
    };
  }

  // The one question `api_setup connect` also has to ask, so it is asked in one
  // place for both. Its two refusals are members of the union above, which is
  // what makes this assignment a weld: a third refusal added over there fails to
  // compile here until it is a kind the route can answer with.
  const redirect = checkRedirectTarget(endpoints, profile.custom_endpoint_ack);
  if (redirect) {
    return { kind: redirect.kind, status: 403, message: redirect.message };
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
