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
 * One exception, and it is the reason this is more than a flag: an answer from the
 * approved host itself does not void that host's own approvals. Every `http_request`
 * answer is marked untrusted, so without the exception every write would ask.
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

/** Where content in a batch came from: a host whose approvals it may keep, or anything else. */
export type EpochSource = { readonly kind: 'foreign' } | { readonly kind: 'host'; readonly host: string };

/** The part of the Session counters this module reads and writes. */
export interface EpochCounters {
  untrustedEpoch?: number | undefined;
  /** `METHOD host` → the epoch the approval was given in. */
  approvedWrites?: Map<string, number> | undefined;
}

export const FOREIGN: EpochSource = { kind: 'foreign' };

/** Lower-case, no trailing dot: the same host for the key and for a source. */
export function normalizeApprovalHost(host: string): string {
  return host.toLowerCase().replace(/\.+$/, '');
}

export function approvalKey(method: string, host: string): string {
  return `${method.toUpperCase()} ${normalizeApprovalHost(host)}`;
}

function hostOfKey(key: string): string {
  return key.slice(key.indexOf(' ') + 1);
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
   * Decide the batch. `snapshot` is the epoch at the batch's start, the one the batch's
   * approvals were checked against and stored with.
   *
   * - Nothing arrived: nothing moves.
   * - Only answers from one host H arrived, and nobody else moved the epoch meanwhile (a
   *   sub-agent sharing the counters may have): the epoch moves, and the approvals for H
   *   that were current at the batch's start move with it, including the ones given
   *   during this batch. An approval that was already stale stays stale.
   * - Anything else: the epoch moves and nothing moves with it.
   */
  resolve(counters: EpochCounters, snapshot: number): void {
    if (this.#sources.length === 0) return;
    const hosts = new Set<string>();
    let foreign = false;
    for (const s of this.#sources) {
      if (s.kind === 'foreign') foreign = true;
      else hosts.add(normalizeApprovalHost(s.host));
    }
    const carryHost = !foreign && hosts.size === 1 && currentEpoch(counters) === snapshot
      ? [...hosts][0]
      : undefined;
    bumpNow(counters);
    if (carryHost === undefined || !counters.approvedWrites) return;
    const next = currentEpoch(counters);
    for (const [key, epoch] of counters.approvedWrites) {
      if (epoch === snapshot && hostOfKey(key) === carryHost) counters.approvedWrites.set(key, next);
    }
  }
}
