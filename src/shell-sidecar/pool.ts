/**
 * The uid pool of the exec daemon (PRD 152 v2 §4.1).
 *
 * A uid belongs to exactly one call at a time. Two concurrent calls on one uid would
 * kill each other at the end, and a leftover of one could read the next. A uid goes back
 * only after the reaper has proved it empty; a uid it could not prove empty is
 * quarantined and never handed out again in this daemon's life. An exhausted pool
 * refuses the call — it never shares.
 */

export const DEFAULT_POOL_FIRST_UID = 20000;
export const DEFAULT_POOL_SIZE = 64;

export class UidPool {
  private readonly free: number[];
  private readonly busy = new Set<number>();
  private readonly quarantined = new Set<number>();

  constructor(readonly first: number = DEFAULT_POOL_FIRST_UID, readonly size: number = DEFAULT_POOL_SIZE) {
    if (!Number.isInteger(first) || first < 1000) throw new Error('pool: first uid must be an integer >= 1000');
    if (!Number.isInteger(size) || size < 1 || size > 4096) throw new Error('pool: size must be 1..4096');
    this.free = Array.from({ length: size }, (_, i) => first + i);
  }

  /** Every uid of the pool, for the start-up sweep. */
  all(): number[] {
    return Array.from({ length: this.size }, (_, i) => this.first + i);
  }

  contains(uid: number): boolean {
    return uid >= this.first && uid < this.first + this.size;
  }

  /** Take a free uid, or `null` when none is free. Lowest first, so runs are reproducible. */
  acquire(): number | null {
    const uid = this.free.shift();
    if (uid === undefined) return null;
    this.busy.add(uid);
    return uid;
  }

  /** Return a uid the reaper proved empty. */
  release(uid: number): void {
    if (!this.busy.delete(uid)) throw new Error(`pool: release of uid ${uid} that is not busy`);
    this.free.push(uid);
    this.free.sort((a, b) => a - b);
  }

  /** Take a busy uid out of circulation for good. */
  quarantine(uid: number): void {
    if (!this.busy.delete(uid)) throw new Error(`pool: quarantine of uid ${uid} that is not busy`);
    this.quarantined.add(uid);
  }

  stats(): { free: number; busy: number; quarantined: number } {
    return { free: this.free.length, busy: this.busy.size, quarantined: this.quarantined.size };
  }
}
