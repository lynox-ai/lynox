/**
 * The approval key of a write (`writeApprovalKey`): what its question showed, that is the
 * method, the service, the path with its query, the body and the headers the request sets. An
 * approval covers that write and no other, not another path of the same service and not the same
 * path with another body. It sends that write in its tool batch as many times as its question
 * named (the calls of the batch that are this same call), and nothing in another batch
 * (`approvedInBatch` in `tools/builtin/http.ts`).
 */

import { createHash } from 'node:crypto';

/** Lower-case, no trailing dot: the same host wherever an approval compares hosts. */
export function normalizeApprovalHost(host: string): string {
  return host.toLowerCase().replace(/\.+$/, '');
}

/**
 * The service an approval is for: the normalized host for https on its default port, as before,
 * and `scheme://host:port` for anything else. One host can run another service on another port
 * or scheme, so an approval for one does not cover the other. `URL` drops a default port it was
 * given (`https://h:443` → port `''`), so that form is the same service as `https://h`.
 */
export function approvalOrigin(url: URL): string {
  const host = normalizeApprovalHost(url.hostname);
  return url.protocol === 'https:' && url.port === '' ? host : `${url.protocol}//${host}${url.port === '' ? '' : `:${url.port}`}`;
}

/** `METHOD service`: what a denial in a batch stands for, and the head of `writeApprovalKey`. METHOD
 *  is every write the request names, sorted and joined by `+` (`PATCH+POST` for a POST that carries
 *  a PATCH override). */
export function approvalKey(method: string, host: string): string {
  return `${method.toUpperCase()} ${normalizeApprovalHost(host)}`;
}

/**
 * The key of a remembered write approval, and of the one answer parallel calls of a batch share:
 * the write the question showed. `METHOD service`, the path with its query, a digest of the
 * body, and a digest of the request's headers as `headersForQuestion` keys them. The path is
 * taken as sent, case included: an id in a path can differ in case alone, and some servers
 * route `/a//b` or `/a/` apart from `/a/b` and `/a` (an object store's keys).
 *
 * A redirect hop is compared with this same key, with `emptySegments: 'drop'` on both sides:
 * there the server itself names the target, and `/items` sent to `/items/` is the same write by
 * its own say. `origin` is passed apart from `url` for the hop, which is compared with the
 * service that was asked (`sameServiceOnHost` decides whether the hop's service is that one).
 */
export function writeApprovalKey(
  method: string, origin: string, url: URL, body: unknown,
  headers: ReadonlyArray<readonly [string, string]> = [], emptySegments: 'keep' | 'drop' = 'keep',
): string {
  const path = emptySegments === 'keep' ? url.pathname : `/${url.pathname.split('/').filter((s) => s !== '').join('/')}`;
  // A body that is not a string never reaches the wire (the transport refuses it); its key is its
  // type, so the transport's own refusal is what the caller sees.
  const digest = typeof body === 'string' || body === undefined
    ? createHash('sha256').update(body ?? '').digest('hex')
    : `(${typeof body})`;
  // The headers the question showed, by lower-case name with raw values (`headersForQuestion`).
  const headerDigest = createHash('sha256').update(JSON.stringify(headers)).digest('hex');
  return `${approvalKey(method, origin)}\u0000${path}${url.search}\u0000${digest}\u0000${headerDigest}`;
}
