/**
 * The untrusted-content epoch of a Session: a counter that moves whenever content the
 * engine did not write enters the conversation, and the write approvals that hold only
 * for the epoch they were given in.
 *
 * An approval for a write (`METHOD host`) remembers the epoch it was given in and holds
 * while that epoch is current. New content from a source the person did not approve
 * moves the epoch, so the next write asks again: the person approved a write before
 * that content was in the conversation, not after.
 *
 * There is no exception for the approved host. An answer from it is content a third party
 * may have written (a record's fields, an object a write echoes back), and it could ask for
 * a write to another path of that host. So an approval holds only until the next answer of
 * any kind, the answer to the approved write itself included: in practice within the batch
 * it was given in, where parallel calls with the same question share it.
 *
 * Content that arrives during a tool batch is collected and decided ONCE at the batch's
 * end (`BatchSources.resolve`), not per result. The calls of a batch run concurrently;
 * a per-result decision would depend on which answer arrived first. A decision over the
 * set of sources does not.
 *
 * Both values live on the Session counters, which a sub-agent and a workflow run from a
 * chat share with the parent. A counter on the Agent would start at 0 again after the
 * Agent is rebuilt, and an old approval could match it again.
 */

/** Where content in a batch came from: the host that answered, or anything else. Either moves the epoch. */
export type EpochSource = { readonly kind: 'foreign' } | { readonly kind: 'host'; readonly host: string };

/** The part of the Session counters this module reads and writes. */
export interface EpochCounters {
  untrustedEpoch?: number | undefined;
  /** `METHOD host` → the epoch the approval was given in. METHOD is every write the request names, sorted and joined by `+` (`PATCH+POST` for a POST that carries a PATCH override). */
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

export function approvalKey(method: string, host: string): string {
  return `${method.toUpperCase()} ${normalizeApprovalHost(host)}`;
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
