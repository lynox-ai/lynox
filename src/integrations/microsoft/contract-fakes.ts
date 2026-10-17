/**
 * Test inputs for the Microsoft broker, welded to the contract.
 *
 * In `src/` on purpose, like `contract/fixtures/mirrors.ts`: test files are
 * outside the root tsc scope (vitest strips types without checking them), so a
 * `satisfies` written in `microsoft-auth.test.ts` would never run. Here, a field
 * the contract renames or makes required fails `tsc` instead of leaving a fake
 * that no longer matches the wire.
 *
 * What this is NOT: the control plane's bytes. There is no golden fixture for
 * the Microsoft claim or refresh yet (`fixtures/README.md`: the CP is the
 * serializer), so these follow the contract's TYPE, not an observed payload.
 *
 * Not imported by any runtime module. Ships compiled in `dist/` — acceptable:
 * every value is an obviously-fake placeholder.
 */
import type { OAuthHandleClaimResponse, OAuthRefreshResponse } from '../../contract/http.js';

/** A claim as the control plane hands it over, with an access token valid for an hour from `now`. */
export function fakeMicrosoftClaim(
  now: number,
  overrides: Partial<OAuthHandleClaimResponse> = {},
): OAuthHandleClaimResponse {
  return {
    provider: 'microsoft',
    access_token: 'ms-access-token-aaaaaaaa',
    refresh_handle: 'sealed-handle-1',
    expires_at: now + 3_600_000,
    scopes: ['https://graph.microsoft.com/Mail.ReadWrite', 'offline_access'],
    tid: '00000000-0000-0000-0000-00000000aaaa',
    email: 'mailbox@example.test',
    ...overrides,
  } satisfies OAuthHandleClaimResponse;
}

/** A refresh answer from the control plane; `refresh_handle` only when the caller passes one. */
export function fakeMicrosoftRefresh(
  accessToken: string,
  expiresAt: number,
  refreshHandle?: string,
): OAuthRefreshResponse {
  return {
    access_token: accessToken,
    expires_at: expiresAt,
    ...(refreshHandle === undefined ? {} : { refresh_handle: refreshHandle }),
  } satisfies OAuthRefreshResponse;
}
