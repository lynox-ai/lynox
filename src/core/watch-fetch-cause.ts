/**
 * Why a watch could not read its page, as the owner is told it: one cause per kind of failure,
 * read from what the fetch threw. The raw error stays with the failure as its `cause` and is not
 * shown.
 */
export type WatchFetchCause =
  | { readonly kind: 'blocked' }
  | { readonly kind: 'refused' }
  | { readonly kind: 'unresolved' }
  | { readonly kind: 'unreachable' }
  | { readonly kind: 'tls' }
  | { readonly kind: 'timeout'; readonly seconds: number }
  | { readonly kind: 'http'; readonly status: number }
  | { readonly kind: 'too-large'; readonly megabytes: number }
  | { readonly kind: 'other' };

/** The page answered with a status that is not a success; the watch reads nothing from it. */
export class WatchHttpStatusError extends Error {
  constructor(readonly status: number, statusText: string) {
    super(`HTTP ${String(status)} ${statusText}`);
    this.name = 'WatchHttpStatusError';
  }
}

/** A connection the server refused. No route to it is told as `other`: the server was never reached. */
const UNREACHABLE_CODES = new Set(['ECONNREFUSED']);
/** A connection that was not made in time. */
const CONNECT_TIMEOUT_CODES = new Set(['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT']);
/**
 * A certificate the TLS handshake could not verify: expired or not yet valid, for another name,
 * self-signed, or from an issuer it could not check. A handshake that failed for another reason
 * (a protocol or cipher mismatch, plain HTTP on the TLS port) is told as `other`.
 */
const TLS_CODE = /^(CERT_|ERR_TLS_CERT_|UNABLE_TO_VERIFY_|UNABLE_TO_GET_ISSUER_CERT|DEPTH_ZERO_SELF_SIGNED_CERT$|SELF_SIGNED_CERT_IN_CHAIN$)/;
/** A refusal of a private or internal address (`network-guard.ts`): the literal, or a host that resolves to one. */
const PRIVATE_ADDRESS = /^Blocked: (private IP address "|"[^"]*" resolves to private IP ")/;
/** A host that did not resolve (`network-guard.ts`). */
const UNRESOLVED = /^Blocked: (hostname "[^"]*" did not resolve to any IP|DNS returned a record without an address for ")/;

/**
 * The cause of a failed watch fetch. `limits` are the ones the watch fetched with, so the sentence
 * can name them; `timedOut` is whether the watch's own deadline fired, which also ends a page
 * whose body was still arriving, with an error that does not say so.
 *
 * The address checks (`network-guard.ts`) refuse with a message that starts with `Blocked:`: a
 * private address and a host that did not resolve are told as such, any other refusal as an
 * address lynox does not read. A socket error is read by its code; anything else is `other`.
 */
export function watchFetchCause(err: unknown, limits: { readonly timeoutSeconds: number; readonly maxBytes: number; readonly timedOut: boolean }): WatchFetchCause {
  if (err instanceof WatchHttpStatusError) return { kind: 'http', status: err.status };
  const message = err instanceof Error ? err.message : '';
  // A refusal first: whatever else happened, an address lynox does not read is told as such.
  if (PRIVATE_ADDRESS.test(message)) return { kind: 'blocked' };
  if (UNRESOLVED.test(message)) return { kind: 'unresolved' };
  if (message.startsWith('Blocked:')) return { kind: 'refused' };
  if (limits.timedOut || (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError'))) return { kind: 'timeout', seconds: limits.timeoutSeconds };
  // `readBodyCapped` (`sanitize.ts`) stops a page past the cap with this message.
  if (message === `response body exceeded ${String(limits.maxBytes)} bytes`) return { kind: 'too-large', megabytes: Math.round(limits.maxBytes / (1024 * 1024)) };
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string') {
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return { kind: 'unresolved' };
    if (UNREACHABLE_CODES.has(code)) return { kind: 'unreachable' };
    if (CONNECT_TIMEOUT_CODES.has(code)) return { kind: 'timeout', seconds: limits.timeoutSeconds };
    if (TLS_CODE.test(code)) return { kind: 'tls' };
  }
  return { kind: 'other' };
}
