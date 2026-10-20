/**
 * The untrusted-content epoch of a Session: a counter that moves whenever content the
 * engine did not write enters the conversation, and the write approvals that hold only
 * for the epoch they were given in.
 *
 * An approval for a write remembers the epoch it was given in and holds while that epoch
 * is current. It is keyed by what its question showed (`writeApprovalKey`): the method,
 * the service, the path with its query, and the body. So it covers that write and no
 * other, not another path of the same service and not the same path with another body.
 * Untrusted content moves the epoch (for example a marked tool result, an external-content
 * tool, an upload, any `http_request` answer that reached the network, a sub-agent that saw
 * some, a workflow run), so the next write asks again: the person approved a write before
 * that content was in the conversation, not after.
 *
 * There is no exception for the approved host. An answer from it is content a third party
 * may have written (a record's fields, an object a write echoes back), and it could ask for
 * a write to another path of that host. So an approval holds only until the next answer of
 * any kind, the answer to the approved write itself included: in practice within the batch
 * it was given in, where parallel calls with the same question share it.
 *
 * Content that arrives during a tool batch moves the epoch ONCE, at the batch's end
 * (`BatchSources.resolve`), not per result: the calls of a batch were all decided before
 * any of its answers reached the model, so they check and store their approvals against
 * the epoch the batch started in.
 *
 * Both values live on the Session counters, which a sub-agent and a workflow run from a
 * chat share with the parent. A counter on the Agent would start at 0 again after the
 * Agent is rebuilt, and an old approval could match it again.
 */

import { createHash } from 'node:crypto';

/** Where content in a batch came from: the host that answered, or anything else. Either moves the epoch. */
export type EpochSource = { readonly kind: 'foreign' } | { readonly kind: 'host'; readonly host: string };

/** The part of the Session counters this module reads and writes. */
export interface EpochCounters {
  untrustedEpoch?: number | undefined;
  /** `writeApprovalKey` → the epoch the approval was given in. */
  approvedWrites?: Map<string, number> | undefined;
}

export const FOREIGN: EpochSource = { kind: 'foreign' };

/** Lower-case, no trailing dot: the same host for the key and for a source. */
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

export function currentEpoch(counters: EpochCounters): number {
  return counters.untrustedEpoch ?? 0;
}

export function isApproved(counters: EpochCounters, key: string, epoch: number): boolean {
  return counters.approvedWrites?.get(key) === epoch;
}

export function recordApproval(counters: EpochCounters, key: string, epoch: number): void {
  (counters.approvedWrites ??= new Map()).set(key, epoch);
}

/** Content arrived outside a batch: move the epoch now, keep nothing. */
export function bumpNow(counters: EpochCounters): void {
  counters.untrustedEpoch = currentEpoch(counters) + 1;
}

/** The sources one tool batch saw, decided at the batch's end. */
export class BatchSources {
  readonly #sources: EpochSource[] = [];

  add(source: EpochSource): void {
    this.#sources.push(source);
  }

  /**
   * Decide the batch: nothing arrived, nothing moves; anything arrived, the host that was
   * approved included, the epoch moves and no approval moves with it.
   */
  resolve(counters: EpochCounters): void {
    if (this.#sources.length === 0) return;
    bumpNow(counters);
  }
}
