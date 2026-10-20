/**
 * Compile welds for {@link OAuthHandleClaimResponse} and
 * {@link AdminConsentStatusResponse}.
 *
 * A source file for the reason `google-client-pair-welds.ts` gives: a
 * `@ts-expect-error` in a `*.test.ts` under `src/` is compiled by neither tsc
 * run. `tests/contract-microsoft-oauth.test.ts` imports the function, so
 * deleting the file fails; deleting ONE weld does not.
 *
 * `@ts-expect-error` is satisfied by ANY error, so each fixture is complete
 * except for the one thing it tests. A fixture that also missed another
 * required field would stay green with its own check removed.
 */
import type { AdminConsentStatusResponse, OAuthHandleClaimResponse } from '../contract/http.js';

export function handleClaimWelds(): void {
  /** The raw refresh token has no field to land in. */
  const withRawToken: OAuthHandleClaimResponse = {
    provider: 'microsoft',
    access_token: 'a',
    refresh_handle: 'h',
    expires_at: 0,
    scopes: [],
    tid: 't',
    email: 'e',
    // @ts-expect-error — the handle-only claim carries no raw refresh token
    refresh_token: 'r',
  };

  /** The handle is the only way the grant is refreshed, so it is required. */
  // @ts-expect-error — refresh_handle is required
  const withoutHandle: OAuthHandleClaimResponse = {
    provider: 'microsoft',
    access_token: 'a',
    expires_at: 0,
    scopes: [],
    tid: 't',
    email: 'e',
  };

  /** The tenant is required: a claim is never issued without the tenant match. */
  // @ts-expect-error — tid is required
  const withoutTenant: OAuthHandleClaimResponse = {
    provider: 'microsoft',
    access_token: 'a',
    refresh_handle: 'h',
    expires_at: 0,
    scopes: [],
    email: 'e',
  };

  void withRawToken;
  void withoutHandle;
  void withoutTenant;
}

export function adminConsentStatusWelds(): void {
  /** "Nothing reported" is an explicit `null`, so the field is never left out. */
  // @ts-expect-error — reported_at is required
  const withoutTime: AdminConsentStatusResponse = {};

  /** "Nothing reported" is `null`, not a sentinel such as `0`. */
  const never: AdminConsentStatusResponse = { reported_at: null };

  /** Display only: the status names no tenant the card could act on. */
  const withTenant: AdminConsentStatusResponse = {
    reported_at: 0,
    // @ts-expect-error — the status carries no tenant
    tid: 't',
  };

  void withoutTime;
  void never;
  void withTenant;
}
