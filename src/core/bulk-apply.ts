/**
 * The write half of a bulk run (PRD bulk-changes-reversible §3.4/§3.5): the worker
 * effects `bulk_apply` and `bulk_undo`. Deterministic, no model run — the trigger that
 * starts them is armed only by the approval route (`BulkLedger.approve`/`resume`).
 *
 * One loop, both effects: an undo is its own run whose targets expect the state the
 * source wrote and write the source's before-image back (see `BulkLedger.planUndo`).
 *
 * Per target: claim (one conditional UPDATE), read the target's current state, and write
 * only when it still holds the state the run expects. Anything else is a conflict and
 * is shown, never overwritten. A target that already holds the planned state counts as
 * applied — the loop that wrote it died before recording it.
 */
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { setImmediate as yieldToLoop } from 'node:timers/promises';
import type { DataStore } from './data-store.js';
import type { BulkWriteEffect } from '../types/index.js';
import type { AttachedConnection } from './bulk-connection.js';
import { coercePlainColumnValue } from './data-store.js';
import {
  BULK_HALT_REASONS, BULK_TARGET_BUDGET_MS, bulkFailureLimit, bulkWriteCap, canonicalJson,
  type ActualImage, type ApplyTarget, type BeforeImage, type BulkHaltReason, type BulkLedger, type BulkRunForApply, type BulkTargetError,
} from './bulk-ledger.js';
import { BULK_MAX_TARGET_BYTES, BulkForeignFile, BulkLinkOnTheWay, bulkKeyRel, heldWorkspace, readBulkKey, resolveBulkFilePath } from './bulk-plan.js';
import { processUmask } from './workspace-rel.js';
import { statEntry, unlinkAt, WorkspaceAccessError, writeFileAt } from './workspace-fd.js';

export type BulkEffect = BulkWriteEffect;

/**
 * How the loop reaches a target system. `read` returns the target's current state;
 * `path_changed` when the key no longer names the same confined target, `foreign` when
 * it exists as something the run cannot compare (not a text file, too large). `fields`
 * are the fields the run writes, for a system that compares over them (an external
 * target); a local writer reads the whole target. `write` produces `after` — removing
 * the target when `after` is absent — and returns a short ENGINE-authored result, or
 * that result with what the target held right after ({@link ActualImage}).
 */
export interface TargetWriter {
  /** The target may hold something other than what was sent (an external host
   *  normalises). A write reports what it read back through its return value; this flag
   *  makes a target found already holding the planned state record what it holds, too. */
  readonly readsBack?: boolean | undefined;
  /** The writer calls `write`'s `onSend` right before its request leaves, so a write stopped
   *  before that (a refused credential, a blocked host) does not count as sent. A writer
   *  without it is taken to have sent whenever `write` is called. */
  readonly reportsSend?: boolean | undefined;
  /** A writer whose requests carry a stored credential (an external host): start noting the
   *  connections of what it sends from now on (`ExternalClient.track`). A local writer has none. */
  readonly track?: (() => () => AttachedConnection | null) | undefined;
  read(key: string, fields: readonly string[] | null): Promise<BeforeImage | 'path_changed' | 'foreign'>;
  write(key: string, after: BeforeImage, onSend?: () => void): Promise<string | { result: string; actual: ActualImage }>;
}

/**
 * Thrown by a writer when nothing past this target would be sent any differently — the
 * credential cannot be attached, the host refused it, the policy blocks the host. The run
 * halts with the reason instead of collecting a failure per target.
 */
export class BulkWriterHalt extends Error {
  constructor(readonly reason: BulkHaltReason) {
    super(reason);
    this.name = 'BulkWriterHalt';
  }
}

/** Thrown by a writer for a target that answered with a redirect. */
export class BulkRedirectError extends Error {
  constructor() {
    super('redirect');
    this.name = 'BulkRedirectError';
  }
}

/**
 * Thrown by a writer for a target whose request would carry what looks like a secret. It
 * belongs to the target, not the run: the same target fails the same way on every attempt,
 * so a halt at it would come back on every resume. As a failed target it counts toward the
 * run's failure rules like any other, and a resume does not retry it.
 */
export class BulkSecretError extends Error {
  constructor() {
    super('secret');
    this.name = 'BulkSecretError';
  }
}

/** The fields a target's write names, when its after-state is an object. */
function fieldsOf(t: ApplyTarget): readonly string[] | null {
  const v = t.after.absent ? null : t.after.value;
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v) : null;
}

export interface BulkEffectOutcome {
  /** `pending`: targets are left that another loop holds — try again shortly.
   *  `stopped`: the owner stopped the run between two targets. A non-atomic run is halted
   *  where it stood (a resume carries on, an undo takes back what was written); an atomic
   *  one was rolled back, as on a failed target. */
  status: 'done' | 'halted' | 'refused' | 'aborted' | 'pending' | 'stopped';
  /** Set on a `halted` run that stopped where its approval told it to — its approved maximum
   *  — with no failed write in this pass. The run did what was asked and waits for the owner,
   *  so the trigger records it as `halted`, not as a failure. Every other halt leaves it unset:
   *  a failure halt, an unreachable host, the time budget, a cap reached with a failed write
   *  in this pass, and the probe's cap over a wider approval. A failure from an earlier pass
   *  was announced at that pass's halt; the run's summary still counts it. */
  planned?: true;
  /** Engine-authored, counts only. Recorded as the trigger's run result. */
  summary: string;
}

/** A run left `pending` is tried again after this. */
export const BULK_RETRY_DELAY_MS = 30_000;
/** Floor of a run's time budget, whatever its size. */
const MIN_RUN_BUDGET_MS = 60_000;
/** Halt thresholds (PRD §3.4): whichever comes first — this many failures in a row, or more
 *  than {@link bulkFailureLimit} in the pass. */
const HALT_CONSECUTIVE = 3;

function sameImage(a: BeforeImage, b: BeforeImage): boolean {
  if (a.absent || b.absent) return a.absent === b.absent;
  return canonicalJson(a.value) === canonicalJson(b.value);
}

function summarize(ledger: BulkLedger, runId: string, lead: string): string {
  const s = ledger.getStatus(runId);
  if (!s) return lead;
  return `${lead} Applied ${String(s.applied)}, failed ${String(s.failed)}, conflicts ${String(s.conflicts)}, ` +
    `undone ${String(s.undone)} of ${String(s.total)} targets.`;
}

export interface BulkEffectDeps {
  ledger: BulkLedger;
  /** The writer for the run's target system, or null when it is not available. */
  writerFor: (run: BulkRunForApply) => TargetWriter | null;
  now?: () => number;
  /** The worker's task signal. Read between targets only, never inside a write. */
  signal?: AbortSignal | undefined;
  /**
   * Whether the abort on `signal` is the OWNER'S stop. Three things abort that controller —
   * the owner's stop, the execution deadline and the worker's shutdown — and only the first
   * is an instruction to end the run; the other two leave it writing as before. Without this
   * the signal is not read at all.
   */
  ownerStopped?: (() => boolean) | undefined;
  /**
   * The actor trail of this call of the run, or null for a run that writes none (PRD
   * customer-granted-operator-access §3.9). Required, so no caller leaves it out by accident:
   * the engine builds one for an external run a delegated session planned, and passes null
   * for every other.
   */
  trailFor: (run: BulkRunForApply) => BulkRunTrail | null;
}

/**
 * The trail of one call of a run: a row before the call reads or writes anything, and one when
 * it ends, with how many targets it wrote. A run that is resumed, or waits for targets another
 * loop holds, is written in several calls, and each has its pair, all with the run's id.
 */
export interface BulkRunTrail {
  /** Writes the row before the call. Throws when it cannot be written: the call then sends nothing. */
  begin(): void;
  /**
   * Writes the row after the call. Never throws: a row before stands alone if this one fails.
   * The counts are `null` when the ledger could not be read for them, which is not "none".
   */
  end(outcome: BulkEffectOutcome['status'] | 'error', written: number | null, failed: number | null): void;
}

/**
 * Run the effect for one bulk run. Refuses unless the run is approved or writing, not
 * halted, inside its approval window, and still matching the checksum approved.
 */
export async function runBulkEffect(runId: string, effect: BulkEffect, deps: BulkEffectDeps): Promise<BulkEffectOutcome> {
  // Set once the row before the call is written; every way out of the call then writes the
  // row after it, a thrown error included.
  let opened: { trail: BulkRunTrail; applied: number; failed: number } | null = null;
  let outcome: BulkEffectOutcome | undefined;
  try {
    outcome = await applyRunEffect(runId, effect, deps, (trail, run) => {
      opened = { trail, applied: run.applied, failed: run.failed };
    });
    return outcome;
  } finally {
    const o = opened as { trail: BulkRunTrail; applied: number; failed: number } | null;
    if (o !== null) {
      // The counts are read here, where the ledger may already be failing: a read that throws
      // must neither drop the row nor turn a finished call into an error, and the row then says
      // the counts are unknown rather than zero.
      let after: { applied: number; failed: number } | null;
      try { after = deps.ledger.getRunForApply(runId) ?? null; } catch { after = null; }
      o.trail.end(outcome?.status ?? 'error', after === null ? null : after.applied - o.applied, after === null ? null : after.failed - o.failed);
    }
  }
}

async function applyRunEffect(
  runId: string, effect: BulkEffect, deps: BulkEffectDeps, opened: (trail: BulkRunTrail, run: BulkRunForApply) => void,
): Promise<BulkEffectOutcome> {
  const { ledger } = deps;
  const now = deps.now ?? Date.now;
  const run = ledger.getRunForApply(runId);
  if (!run) return { status: 'refused', summary: 'No bulk run with this id.' };
  if ((effect === 'bulk_undo') !== (run.kind === 'undo')) {
    return { status: 'refused', summary: 'The trigger effect does not match the bulk run.' };
  }
  if (run.phase !== 'approved' && run.phase !== 'writing') {
    return { status: 'refused', summary: summarize(ledger, runId, `Bulk run is ${run.phase}, not approved — nothing written.`) };
  }
  if (run.haltReason !== null) {
    return { status: 'refused', summary: summarize(ledger, runId, 'Bulk run is halted — resume it to continue.') };
  }
  if (run.expiresAt === null || now() > Date.parse(run.expiresAt)) {
    ledger.halt(runId, BULK_HALT_REASONS.expired);
    return { status: 'refused', summary: summarize(ledger, runId, `Bulk run halted: ${BULK_HALT_REASONS.expired}.`) };
  }
  if (run.approvalChecksum === null || ledger.computeChecksum(runId) !== run.approvalChecksum) {
    ledger.halt(runId, BULK_HALT_REASONS.checksum);
    return { status: 'refused', summary: summarize(ledger, runId, `Bulk run halted: ${BULK_HALT_REASONS.checksum}.`) };
  }
  const writer = deps.writerFor(run);
  if (!writer) {
    ledger.halt(runId, BULK_HALT_REASONS.unavailable);
    return { status: 'refused', summary: summarize(ledger, runId, `Bulk run halted: ${BULK_HALT_REASONS.unavailable}.`) };
  }
  // Before anything of this call is read or written: a run whose row cannot be written does
  // not run.
  const trail = deps.trailFor(run);
  if (trail !== null) {
    try {
      trail.begin();
    } catch {
      ledger.halt(runId, BULK_HALT_REASONS.runUnrecorded);
      return { status: 'halted', summary: summarize(ledger, runId, `Bulk run halted: ${BULK_HALT_REASONS.runUnrecorded}.`) };
    }
    opened(trail, run);
  }
  ledger.setPhase(runId, ['approved'], 'writing');

  const writingTotal = ledger.countWriting(runId);
  const pending = ledger.listPending(runId);
  const deadline = now() + Math.max(MIN_RUN_BUDGET_MS, pending.length * BULK_TARGET_BUDGET_MS);
  let consecutive = 0;
  // A target passed over because the maximum is reached: the run then ends halted on it.
  let cappedOut = false;
  // …and the cap was the probe's, not the approval's: the halt names the probe.
  let cappedByProbe = false;
  // The approval and every resume check the probe, but a run approved wide under an earlier
  // rule, or whose probe stopped holding since, would still be written wide: the effect checks
  // it again and writes one target at most without a probe that holds.
  const probeCap = ledger.probeHoldsFor(runId) ? null : 1;

  for (const seq of pending) {
    // Let other work (and another loop on the same ledger) in between targets.
    await yieldToLoop();
    const current = ledger.getRunForApply(runId);
    // Another loop on the same ledger closed the run: nothing is left for this one.
    if (current?.phase === 'done') return { status: 'done', summary: summarize(ledger, runId, 'Bulk run done.') };
    if (!current || current.phase !== 'writing' || current.haltReason !== null) {
      return { status: 'halted', summary: summarize(ledger, runId, 'Bulk run stopped by another loop.') };
    }
    // The owner's stop lands HERE, between targets and never inside a write: a target whose
    // write is under way when the stop arrives is finished and recorded first, so the ledger
    // names every target the host received and an undo or a resume works from it. An atomic
    // run must not stop half written, so it rolls back as it does on a failed target.
    if (ownerStopped()) return endStopped();
    // The approval bounds how many different targets receive the verb, not how many writes
    // landed: a failed write may have reached its target. A retry of a target that already
    // had the verb sends it to no new one, so it is not refused here — and a target never sent
    // to is passed over rather than stopped in front of, so a later retry still runs.
    const cap = bulkWriteCap(current.maxTargets, probeCap === null);
    if (cap !== null && ledger.sentCount(runId) >= cap && !ledger.wasSent(runId, seq)) {
      cappedOut = true;
      if (probeCap !== null && (current.maxTargets === null || current.maxTargets > probeCap)) cappedByProbe = true;
      continue;
    }
    if (now() > deadline) {
      // An atomic run must not stop half written: out of time, it rolls back instead.
      if (run.atomic) return rollBack(ledger, writer, run, now);
      ledger.halt(runId, BULK_HALT_REASONS.timeBudget);
      return { status: 'halted', summary: summarize(ledger, runId, `Bulk run halted: ${BULK_HALT_REASONS.timeBudget}.`) };
    }
    if (!ledger.claimTarget(runId, seq, now())) continue;
    const target = ledger.loadTarget(runId, seq);
    if (!target) continue;

    // The connections of every request this target's write sends, its reads included: one
    // connection and grant per target, since a re-consent can land between two targets.
    const carried = writer.track?.() ?? null;
    const outcome = await writeOne(writer, target, carried);
    const via = carried?.() ?? null;
    if (outcome.kind === 'halt') {
      // The target is released unwritten; a resume takes it again.
      ledger.releaseClaim(runId, seq);
      ledger.halt(runId, outcome.reason);
      return { status: 'halted', summary: summarize(ledger, runId, `Bulk run halted: ${outcome.reason}.`) };
    }
    if (outcome.kind === 'applied') {
      ledger.recordApplied(run, seq, outcome.result, now(), outcome.actual, via);
      consecutive = 0;
      continue;
    }
    ledger.recordFailed(runId, seq, outcome.kind, via);
    if (run.atomic) return rollBack(ledger, writer, run, now);
    if (outcome.kind === 'conflict') {
      // A conflict is not a failure, and it breaks a run of failures.
      consecutive = 0;
      continue;
    }
    consecutive++;
    const failed = ledger.getRunForApply(runId)?.failed ?? 0;
    if (consecutive >= HALT_CONSECUTIVE) {
      ledger.halt(runId, BULK_HALT_REASONS.consecutiveFailures);
      return { status: 'halted', summary: summarize(ledger, runId, `Bulk run halted: ${BULK_HALT_REASONS.consecutiveFailures}.`) };
    }
    if (failed > bulkFailureLimit(writingTotal)) {
      ledger.halt(runId, BULK_HALT_REASONS.failureRate);
      return { status: 'halted', summary: summarize(ledger, runId, `Bulk run halted: ${BULK_HALT_REASONS.failureRate}.`) };
    }
  }

  if (ledger.listPending(runId).length > 0) {
    // Another loop may have written or failed the rest: with no target left to write, the
    // run is finished, not stopped at its maximum.
    if (cappedOut) {
      const reason = cappedByProbe ? BULK_HALT_REASONS.probeRequired : BULK_HALT_REASONS.maxTargets;
      ledger.halt(runId, reason);
      // Planned only when the bound is the approval's own and nothing in this pass failed (a
      // resume sets the count back; an earlier pass's failure was announced then). The
      // cap counts targets SENT, so a failed write uses up a slot: a run whose writes failed
      // under the failure thresholds still ends here, and it is a failure the owner must see.
      // The probe's cap over a wider approval (its probe stopped holding since) is not the
      // approval's bound either: something changed underneath the run.
      const planned = !cappedByProbe && (ledger.getRunForApply(runId)?.failed ?? 0) === 0;
      return { status: 'halted', ...(planned ? { planned: true as const } : {}), summary: summarize(ledger, runId, `Bulk run halted: ${reason}.`) };
    }
    // The stop that came during the loop's last write, with the rest held by another loop:
    // no pass between targets is left to read it, and `pending` would re-arm the trigger and
    // write on behind the owner's stop.
    //
    // ⚠ "Another loop" is a DEAD one here, which is what makes the atomic rollback below safe:
    // a run has one trigger, and its lease (`TriggerStore.claimLease`, renewed by the run's
    // heartbeat) admits one live loop at a time, so the claim this loop passed over belongs to
    // a loop whose lease lapsed. A live loop writing the same atomic run would race the
    // rollback's read of what was applied — that takes two processes on one engine.db.
    if (ownerStopped()) return endStopped();
    return { status: 'pending', summary: summarize(ledger, runId, 'Bulk run waiting for targets another loop holds.') };
  }
  ledger.finish(run);
  return { status: 'done', summary: summarize(ledger, runId, 'Bulk run done.') };

  function ownerStopped(): boolean {
    return deps.signal?.aborted === true && deps.ownerStopped?.() === true;
  }

  /** End the run on the owner's stop: an atomic run rolls back, any other is halted. */
  async function endStopped(): Promise<BulkEffectOutcome> {
    if (run!.atomic) {
      const rolled = await rollBack(ledger, writer!, run!, now, 'stopped');
      return { ...rolled, status: 'stopped' };
    }
    ledger.halt(runId, BULK_HALT_REASONS.stoppedByOwner);
    return { status: 'stopped', summary: summarize(ledger, runId, `Bulk run halted: ${BULK_HALT_REASONS.stoppedByOwner}.`) };
  }

  /** One claimed target: what to record for it. */
  async function writeOne(w: TargetWriter, t: ApplyTarget, carried: (() => AttachedConnection | null) | null):
    Promise<{ kind: 'applied'; result: string; actual: ActualImage | null } | { kind: BulkTargetError } | { kind: 'halt'; reason: BulkHaltReason }> {
    try {
      const cur = await w.read(t.key, fieldsOf(t));
      if (cur === 'path_changed') return { kind: 'path_changed' };
      if (cur !== 'foreign' && sameImage(cur, t.after)) {
        // Found as planned — the loop that wrote it died before recording it. What is
        // there is also what an undo must expect.
        return { kind: 'applied', result: 'already', actual: w.readsBack === true && !cur.absent ? { value: cur.value, estimated: false } : null };
      }
      if (cur === 'foreign' || !sameImage(cur, t.expected)) return { kind: 'conflict' };
      // Marked as it leaves, with the connection it leaves under: a loop that dies before the
      // target is recorded still left a row saying whose credential reached the host.
      const sent = (): void => { ledger.markSent(runId, t.seq, carried?.() ?? null); };
      if (w.reportsSend !== true) sent();
      const out = await w.write(t.key, t.after, sent);
      return typeof out === 'string' ? { kind: 'applied', result: out, actual: null } : { kind: 'applied', result: out.result, actual: out.actual };
    } catch (err: unknown) {
      if (err instanceof BulkWriterHalt) return { kind: 'halt', reason: err.reason };
      if (err instanceof BulkRedirectError) return { kind: 'redirect' };
      if (err instanceof BulkSecretError) return { kind: 'secret' };
      return { kind: 'write_failed' };
    }
  }
}

/**
 * An atomic run hit a target it could not write: take back every target it wrote, newest
 * first, each only while it still holds what the run wrote, and end the run `aborted`.
 * Local only — an external target has no transaction to lean on (PRD §3.4).
 */
async function rollBack(
  ledger: BulkLedger, writer: TargetWriter, run: BulkRunForApply, now: () => number,
  cause: 'failed' | 'stopped' = 'failed',
): Promise<BulkEffectOutcome> {
  let complete = true;
  for (const t of ledger.listAppliedDesc(run.id)) {
    try {
      // Local only (an external run is never atomic), so there are no fields to project on.
      const cur = await writer.read(t.key, null);
      if (cur === 'path_changed' || cur === 'foreign' || !sameImage(cur, t.after)) { complete = false; continue; }
      await writer.write(t.key, t.expected);
      ledger.recordRolledBack(run, t.seq, now());
    } catch {
      complete = false;
    }
  }
  // The reason names the cause: a stopped run that read "could not be written" would tell
  // the owner a target failed when none did.
  const reason = cause === 'stopped'
    ? (complete ? BULK_HALT_REASONS.atomicStoppedRolledBack : BULK_HALT_REASONS.atomicStoppedRollbackIncomplete)
    : (complete ? BULK_HALT_REASONS.atomicRolledBack : BULK_HALT_REASONS.atomicRollbackIncomplete);
  ledger.setPhase(run.id, ['writing'], 'aborted', reason);
  const lead = cause === 'stopped'
    ? (complete ? 'Atomic bulk run stopped and rolled back.' : 'Atomic bulk run stopped; the rollback did not complete.')
    : (complete ? 'Atomic bulk run aborted and rolled back.' : 'Atomic bulk run aborted; the rollback did not complete.');
  return { status: 'aborted', summary: summarize(ledger, run.id, lead) };
}

// ── Target systems ────────────────────────────────────────────────────────────

/**
 * Workspace files. The key is the file's real path as planned; it is resolved again at
 * write time, and a key that no longer resolves to itself (a directory on the way
 * became a symlink, the file left the area) is `path_changed`. Reads refuse a symlink
 * at the leaf; writes go to a fresh temp file beside the target (O_EXCL|O_NOFOLLOW) and
 * are renamed over it, so a crash mid-write leaves the old content, never half of it,
 * and a symlink planted at the leaf is replaced rather than followed.
 */
export function workspaceWriter(
  /** The confinement resolver of the by-name writer. Injected so a test can stand in for the
   *  moment a path is swapped between this check and the file operation after it — a race no
   *  static setup reproduces, and the only case the leaf guards below exist for. Without it, and
   *  with isolation, the writer is {@link anchoredWorkspaceWriter}, which has no such check. */
  resolve?: (target: string) => string | null,
): TargetWriter {
  if (resolve === undefined && heldWorkspace() !== null) return anchoredWorkspaceWriter();
  return workspaceWriterByName(resolve ?? resolveBulkFilePath);
}

/** {@link workspaceWriter} without isolation: by the confined real path, checked before each step. */
function workspaceWriterByName(resolve: (target: string) => string | null): TargetWriter {
  const confined = (key: string): boolean => resolve(key) === key;
  return {
    async read(key) {
      if (!confined(key)) return 'path_changed';
      let fh;
      try {
        fh = await open(key, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') return { absent: true };
        if (code === 'ELOOP') return 'foreign';
        throw err;
      }
      try {
        const st = await fh.stat();
        if (!st.isFile() || st.size > BULK_MAX_TARGET_BYTES) return 'foreign';
        const buf = Buffer.alloc(st.size);
        if (st.size > 0) await fh.read(buf, 0, st.size, 0);
        const value = buf.toString('utf-8');
        if (!Buffer.from(value, 'utf-8').equals(buf)) return 'foreign';
        return { absent: false, value };
      } finally {
        await fh.close();
      }
    },
    async write(key, after) {
      // Checked again right before touching the path: the read's check is a step back.
      if (!confined(key)) throw new Error('path changed');
      if (after.absent) {
        const st = await lstat(key);
        if (!st.isFile()) throw new Error('not a regular file');
        await unlink(key);
        return 'deleted';
      }
      if (typeof after.value !== 'string') throw new Error('not text');
      const dir = dirname(key);
      await mkdir(dir, { recursive: true });
      // mkdir may have created directories the plan did not see; the key must still
      // resolve to itself through them.
      if (!confined(key)) throw new Error('path changed');
      let mode: number | undefined;
      try {
        const st = await lstat(key);
        // Something other than a file at the leaf (a link planted since the read) is not
        // what the run planned for — and a link's mode would be copied onto the new file.
        if (!st.isFile()) throw new Error('not a regular file');
        mode = st.mode & 0o7777;
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        mode = undefined;
      }
      const temp = join(dir, `.${basename(key)}.lynox-bulk-${randomUUID()}`);
      const fh = await open(temp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, mode ?? 0o666);
      try {
        await fh.writeFile(after.value, 'utf-8');
        if (mode !== undefined) await fh.chmod(mode);
        await fh.datasync();
      } catch (err: unknown) {
        await fh.close();
        await unlink(temp).catch(() => {});
        throw err;
      }
      await fh.close();
      try {
        await rename(temp, key);
      } catch (err: unknown) {
        await unlink(temp).catch(() => {});
        throw err;
      }
      return mode === undefined ? 'created' : 'written';
    },
  };
}

/**
 * Workspace files with isolation: every read and write goes through the context workspace's open
 * directory, one component at a time with O_NOFOLLOW, never by name. The key is the file's path
 * relative to the workspace ({@link bulkKeyRel} maps a run's absolute key into it). A
 * link on the way or at the file, or a non-directory on the way, is `path_changed`; a non-file, a
 * file with a second name or one that is not text is `foreign`. Writes are atomic as before: a
 * temp file beside the target, renamed over it. A write refuses anything but a file at the leaf.
 */
export function anchoredWorkspaceWriter(): TargetWriter {
  const relOf = (key: string): { anchor: Parameters<typeof statEntry>[0]; rel: string } | null => {
    const base = heldWorkspace();
    if (base === null) throw new Error('the workspace is not set');
    const rel = bulkKeyRel(key, base.ws);
    return rel === null ? null : { anchor: base.anchor, rel };
  };
  return {
    async read(key) {
      const at = relOf(key);
      if (at === null) return 'path_changed';
      let image: ReturnType<typeof readBulkKey>;
      try {
        image = readBulkKey(key, BULK_MAX_TARGET_BYTES);
      } catch (err: unknown) {
        // A link on the way or at the file was not there when the run was planned (it would have
        // been refused then): the path changed.
        if (err instanceof BulkLinkOnTheWay) return 'path_changed';
        if (err instanceof WorkspaceAccessError) {
          if (err.code === 'SYMLINK' || err.code === 'NOT_DIR') return 'path_changed';
          if (err.code === 'NOT_FILE') return 'foreign';
        }
        if (err instanceof BulkForeignFile) return 'foreign';
        throw err;
      }
      if (image === 'too_large' || image === 'not_text') return 'foreign';
      return image;
    },
    async write(key, after) {
      const at = relOf(key);
      if (at === null) throw new Error('path changed');
      let st: ReturnType<typeof statEntry>;
      try {
        st = statEntry(at.anchor, at.rel);
      } catch (err: unknown) {
        // A missing directory on the way: writeFileAt makes it.
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        st = null;
      }
      if (after.absent) {
        if (st === null) throw new Error('not found');
        if (st.type !== 'file') throw new Error('not a regular file');
        unlinkAt(at.anchor, at.rel);
        return 'deleted';
      }
      if (typeof after.value !== 'string') throw new Error('not text');
      // Something other than a file at the leaf (a link planted since the read) is not what the
      // run planned for — and a link's mode would be copied onto the new file.
      if (st !== null && st.type !== 'file') throw new Error('not a regular file');
      const umask = processUmask();
      writeFileAt(at.anchor, at.rel, after.value, {
        // The new file is the engine's: setuid and setgid are not carried over, as the kernel drops
        // them on a write to the file in place.
        fileMode: st !== null ? st.mode & ~0o6000 : 0o666 & ~umask,
        dirMode: 0o777 & ~umask,
      });
      return st === null ? 'created' : 'written';
    },
  };
}

/**
 * Rows of one data-store collection, addressed by its single-column unique key. Rows are
 * read raw (subject cells as stored ids, like the before-images) and written whole with
 * {@link DataStore.putRowVerbatim}, which does not re-resolve subject cells.
 */
export function dataStoreWriter(store: DataStore, collection: string): TargetWriter | null {
  const info = store.getCollectionInfo(collection);
  if (!info || !info.uniqueKey || info.uniqueKey.length !== 1) return null;
  const keyCol = info.uniqueKey[0]!;
  const keyDef = info.columns.find((c) => c.name === keyCol);
  if (!keyDef) return null;
  const meta = new Set(['_id', '_created_at', '_updated_at']);
  const readRow = (key: string): BeforeImage => {
    const stored = coercePlainColumnValue(key, keyDef);
    const { rows } = store.queryRecords({ collection, filter: { [keyCol]: stored }, limit: 2 });
    const row = rows[0];
    if (!row) return { absent: true };
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) if (!meta.has(k)) clean[k] = v;
    return { absent: false, value: clean };
  };
  return {
    async read(key) {
      return readRow(key);
    },
    async write(key, after) {
      if (after.absent) {
        store.deleteRecords({ collection, filter: { [keyCol]: coercePlainColumnValue(key, keyDef) } });
        return 'deleted';
      }
      const row = after.value;
      if (row === null || typeof row !== 'object' || Array.isArray(row)) throw new Error('not a row');
      return store.putRowVerbatim(collection, row as Record<string, unknown>);
    },
  };
}

/** The writer for a run's target system, or null when it cannot be reached. An external
 *  run's writer comes from `external`, which the worker builds from the engine's stores. */
export function bulkWriterFor(
  run: BulkRunForApply, store: DataStore | null, external: ((run: BulkRunForApply) => TargetWriter | null) | null = null,
): TargetWriter | null {
  if (run.targetSystem.startsWith('http:')) return external ? external(run) : null;
  if (run.targetSystem === 'workspace') return workspaceWriter();
  if (run.targetSystem === 'data_store') {
    if (!store || run.targetCollection === null) return null;
    return dataStoreWriter(store, run.targetCollection);
  }
  return null;
}
