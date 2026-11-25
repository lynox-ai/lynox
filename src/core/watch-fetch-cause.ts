/**
 * Why a watch could not read its page, as the owner is told it: one cause per kind of failure,
 * read from what the fetch threw. The raw error stays with the failure as its `cause` and is not
 * shown.
 */
export type WatchFetchCause =
  | { readonly kind: 'blocked' }
  | { readonly kind: 'unresolved' }
  | { readonly kind: 'unreachable' }
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

/** Connection failures a socket reports by code, on the error or on its cause. */
const UNREACHABLE_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'EPIPE', 'ECONNABORTED', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT']);

function codeOf(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * The cause of a failed watch fetch. The address checks (`network-guard.ts`) refuse with a
 * message that starts with `Blocked:`; one that did not resolve says so. Anything not known
 * is `other`. `limits` are the ones the watch fetched with, so the sentence can name them.
 */
export function watchFetchCause(err: unknown, limits: { readonly timeoutSeconds: number; readonly maxBytes: number }): WatchFetchCause {
  if (err instanceof WatchHttpStatusError) return { kind: 'http', status: err.status };
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) return { kind: 'timeout', seconds: limits.timeoutSeconds };
  const message = err instanceof Error ? err.message : '';
  // `readBodyCapped` (`sanitize.ts`) stops a page past the cap with this message.
  if (message === `response body exceeded ${String(limits.maxBytes)} bytes`) return { kind: 'too-large', megabytes: Math.round(limits.maxBytes / (1024 * 1024)) };
  if (message.startsWith('Blocked:')) {
    return /did not resolve to any IP|DNS returned a record without an address/.test(message) ? { kind: 'unresolved' } : { kind: 'blocked' };
  }
  const code = codeOf(err) ?? codeOf((err as { cause?: unknown } | null)?.cause);
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return { kind: 'unresolved' };
  if (code !== undefined && UNREACHABLE_CODES.has(code)) return { kind: 'unreachable' };
  if (err instanceof TypeError && message === 'fetch failed') return { kind: 'unreachable' };
  return { kind: 'other' };
}
