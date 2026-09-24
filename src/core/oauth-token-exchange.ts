/**
 * The hardened POST to an OAuth token endpoint, and nothing else.
 *
 * ── Why this is 71 lines and not the 383 the `fetch_token` block spans ─────
 *
 * The obvious extraction is "move the `fetch_token` action". Measured against
 * the block before cutting: of its 383 lines, **26 are refresh-token
 * semantics** — `classifyRefreshFailure`, `reclassifyForeignGrant`, the
 * revocation stamp, the rotation re-read, `persistGrant`. None of that is
 * about exchanging a code for a token; it is about what a FAILED refresh means
 * for a grant the user once gave. The authorization-code caller has no grant
 * to revoke and no token to have rotated, so every one of those lines would be
 * dead for it.
 *
 * A shared module where half the code is unreachable for half the callers is
 * not sharing, it is a second home for logic that has one owner. So the cut is
 * the part that is genuinely common: build the body, POST it under the egress
 * controls, read a bounded response, hand back the text. **All of the
 * hardening is in here** (the abort timer, the wall-clock race, the bounded
 * read); none of the interpretation is.
 *
 * ── What deliberately stays with the caller ────────────────────────────────
 *
 * - **Which parameters go in.** `grant_type`, `client_id`/`client_secret`,
 *   and whatever the flow adds — `refresh_token` for a refresh, `code` +
 *   `redirect_uri` + `code_verifier` for an authorization code. This function
 *   does not know the flows and must not learn them: a parameter map it built
 *   itself would be a second place where a flow is defined.
 * - **Rate limiting.** The `fetch_token` path charges the session HTTP budget
 *   and consumes the profile's per-host bucket; a route has no session. Both
 *   are the caller's, and `onRequestSent` is the one hook this needs — it
 *   fires after the response arrives, exactly where the tool incremented.
 * - **What a non-2xx MEANS.** A 400 is `invalid_grant` to one caller and a
 *   misconfigured client to another. This returns the status and the text.
 *
 * ── The wall-clock race, which is the reason this is worth sharing ─────────
 *
 * An `AbortController.signal` aborts `fetch()` but NOT
 * `response.body.getReader()` once headers have arrived. A token endpoint that
 * answers 200 and then drips bytes would hold the read open indefinitely, so
 * BOTH the fetch and the body read are raced against a second timer. That is
 * the property a duplicate implementation drops first, because it looks
 * redundant next to the abort timer it is not redundant with.
 */

import { fetchWithValidatedRedirects, readBodyLimited } from '../tools/builtin/http.js';
import { resolveGuardedAckHosts } from './tool-context.js';
import type { ToolContext } from './tool-context.js';

/** 15 s per leg; the wall timer sits one second beyond it. */
export const TOKEN_EXCHANGE_TIMEOUT_MS = 15_000;
/** A token response is small JSON; this is the ceiling a hostile one is read to. */
export const TOKEN_BODY_MAX_BYTES = 64 * 1024;

export interface TokenExchangeRequest {
  /** The provider's token endpoint. Passed through to the egress guard as-is. */
  readonly tokenUrl: string;
  /** Every form field. The caller owns the flow, so the caller owns this map. */
  readonly params: Readonly<Record<string, string>>;
  /** `form` is what the OAuth specification says; `json` is what some providers want. */
  readonly bodyFormat: 'form' | 'json';
}

export type TokenExchangeResult =
  /** The provider answered. `status` may still be an error — that is the caller's to read. */
  | { readonly ok: true; readonly status: number; readonly responseOk: boolean; readonly text: string }
  /** Nothing usable came back. `message` is already the provider's or the transport's. */
  | { readonly ok: false; readonly message: string };

/**
 * POST the parameters and hand back what came out.
 *
 * `toolContext` carries the egress controls — `network_policy` and the HTTPS
 * rule — and is not optional in spirit even though the type allows `undefined`:
 * without it the client secret in the body would be POSTed to whatever URL the
 * caller supplied, regardless of the tenant's policy. That is the
 * credential-exfiltration channel this whole path is shaped around, which is
 * why the surface is declared `full-control`.
 */
export async function exchangeToken(
  req: TokenExchangeRequest,
  toolContext: ToolContext | undefined,
  onRequestSent?: () => void,
): Promise<TokenExchangeResult> {
  const headers: Record<string, string> = { 'Accept': 'application/json' };
  let body: string;
  if (req.bodyFormat === 'json') {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(req.params);
  } else {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = Object.entries(req.params)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
  }

  const ac = new AbortController();
  const timer = setTimeout(() => { ac.abort(); }, TOKEN_EXCHANGE_TIMEOUT_MS);
  let wallTimer: ReturnType<typeof setTimeout> | undefined;
  const wallTimeout = new Promise<never>((_, reject) => {
    wallTimer = setTimeout(() => {
      ac.abort();
      reject(new Error(`token exchange timed out after ${TOKEN_EXCHANGE_TIMEOUT_MS}ms`));
    }, TOKEN_EXCHANGE_TIMEOUT_MS + 1000);
  });

  try {
    const { response } = await Promise.race([
      fetchWithValidatedRedirects(req.tokenUrl, {
        method: 'POST',
        headers,
        body,
        signal: ac.signal,
      }, { surface: 'full-control', ackHosts: resolveGuardedAckHosts(toolContext) }, toolContext),
      wallTimeout,
    ]);
    // After the response, not before it: this is what the tool counted, and a
    // refused egress never reached the provider to be charged for.
    onRequestSent?.();
    const read = await Promise.race([
      readBodyLimited(response, TOKEN_BODY_MAX_BYTES),
      wallTimeout,
    ]);
    return { ok: true, status: response.status, responseOk: response.ok, text: read.text };
  } catch (err) {
    return {
      ok: false,
      message: `token exchange to ${req.tokenUrl} failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    clearTimeout(timer);
    clearTimeout(wallTimer);
  }
}
