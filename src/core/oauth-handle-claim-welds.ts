/**
 * Compile welds for {@link OAuthHandleClaimResponse}.
 *
 * A source file for the reason `google-client-pair-welds.ts` gives: a
 * `@ts-expect-error` in a `*.test.ts` under `src/` is compiled by neither tsc
 * run. `tests/contract-microsoft-oauth.test.ts` imports the function, so
 * deleting the file fails; deleting ONE weld does not, which is why each
 * fixture below can fail for exactly one reason.
 */
import type { OAuthHandleClaimResponse } from '../contract/http.js';

export function handleClaimWelds(): void {
  /** The raw refresh token has no field to land in. */
  const withRawToken: OAuthHandleClaimResponse = {
    provider: 'microsoft',
    access_token: 'a',
    refresh_handle: 'h',
    expires_at: 0,
    scopes: [],
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
  };

  void withRawToken;
  void withoutHandle;
}
