/**
 * Releasing a pool uid after a call (PRD 152 v2 §4.1; W1 plan v2.1).
 *
 * Order, each step measured or agreed with sec-infra on 2026-10-14:
 *   1. kill loop — a process under the uid runs `kill(-1, SIGKILL)`, repeated until two
 *      consecutive scans of /proc find no process of the uid. `kill(-1)` reports success
 *      even when nothing is left (measured, dash and node), so its return value is not a
 *      stop condition; a forking process needed 4 passes on rootful Docker.
 *   2. sweep — under the uid itself: its SysV objects, its /dev/mqueue and /dev/shm
 *      entries, and everything it owns at the top of /tmp/calls. Root may not remove any of
 *      these here: it holds only CAP_SETUID/CAP_SETGID.
 *   3. kill loop again — the sweep ran as the uid, so it is itself a process to kill.
 *   4. verify as root — /proc, /proc/sysvipc, /tmp/calls and /dev/mqueue hold nothing of
 *      the uid. Only then is it free.
 *
 * A step that does not converge within its bound quarantines the uid: a uid that cannot
 * be proven empty is never handed to another call.
 */

export interface ReleaseOps {
  /** One `kill(-1, SIGKILL)` pass run AS `uid`. Must not throw on "nothing to kill". */
  killPass(uid: number): Promise<void>;
  /** Number of live processes whose real uid is `uid`. A read error other than ENOENT counts as one. */
  countProcesses(uid: number): Promise<number>;
  /** The sweep, run AS `uid`. */
  sweep(uid: number): Promise<void>;
  /** What root can still see of `uid` outside /proc (IPC objects, queue and call-dir entries). */
  residue(uid: number): Promise<string[]>;
}

export const MAX_KILL_PASSES = 50;

export type ReleaseResult = { ok: true; passes: number } | { ok: false; reason: string };

/** Kill until two consecutive scans are empty. Returns the passes it took, or null past the bound. */
export async function killUntilEmpty(uid: number, ops: ReleaseOps, maxPasses = MAX_KILL_PASSES): Promise<number | null> {
  let emptyInARow = 0;
  for (let pass = 1; pass <= maxPasses; pass++) {
    await ops.killPass(uid);
    const left = await ops.countProcesses(uid);
    emptyInARow = left === 0 ? emptyInARow + 1 : 0;
    if (emptyInARow >= 2) return pass;
  }
  return null;
}

export async function releaseUid(uid: number, ops: ReleaseOps, maxPasses = MAX_KILL_PASSES): Promise<ReleaseResult> {
  const first = await killUntilEmpty(uid, ops, maxPasses);
  if (first === null) return { ok: false, reason: `uid ${uid}: processes left after ${maxPasses} kill passes` };
  await ops.sweep(uid);
  const second = await killUntilEmpty(uid, ops, maxPasses);
  if (second === null) return { ok: false, reason: `uid ${uid}: processes left after the sweep and ${maxPasses} kill passes` };
  const residue = await ops.residue(uid);
  if (residue.length > 0) return { ok: false, reason: `uid ${uid}: residue after the sweep: ${residue.slice(0, 5).join(', ')}` };
  return { ok: true, passes: first + second };
}
