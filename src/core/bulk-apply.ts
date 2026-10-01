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
import { coercePlainColumnValue } from './data-store.js';
import {
  BULK_HALT_REASONS, BULK_TARGET_BUDGET_MS, canonicalJson,
  type ActualImage, type ApplyTarget, type BeforeImage, type BulkHaltReason, type BulkLedger, type BulkRunForApply, type BulkTargetError,
} from './bulk-ledger.js';
import { BULK_MAX_TARGET_BYTES, resolveBulkFilePath } from './bulk-plan.js';

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
  read(key: string, fields: readonly string[] | null): Promise<BeforeImage | 'path_changed' | 'foreign'>;
  write(key: string, after: BeforeImage): Promise<string | { result: string; actual: ActualImage }>;
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

/** The fields a target's write names, when its after-state is an object. */
function fieldsOf(t: ApplyTarget): readonly string[] | null {
  const v = t.after.absent ? null : t.after.value;
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v) : null;
}

export interface BulkEffectOutcome {
  /** `pending`: targets are left that another loop holds — try again shortly. */
  status: 'done' | 'halted' | 'refused' | 'aborted' | 'pending';
  /** Engine-authored, counts only. Recorded as the trigger's run result. */
  summary: string;
}

/** A run left `pending` is tried again after this. */
export const BULK_RETRY_DELAY_MS = 30_000;
/** Floor of a run's time budget, whatever its size. */
const MIN_RUN_BUDGET_MS = 60_000;
/** Halt thresholds (PRD §3.4): whichever comes first. */
const HALT_FAILURE_SHARE = 0.05;
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
}

/**
 * Run the effect for one bulk run. Refuses unless the run is approved or writing, not
 * halted, inside its approval window, and still matching the checksum approved.
 */
export async function runBulkEffect(runId: string, effect: BulkEffect, deps: BulkEffectDeps): Promise<BulkEffectOutcome> {
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
  ledger.setPhase(runId, ['approved'], 'writing');

  const writingTotal = ledger.countWriting(runId);
  const pending = ledger.listPending(runId);
  const deadline = now() + Math.max(MIN_RUN_BUDGET_MS, pending.length * BULK_TARGET_BUDGET_MS);
  let consecutive = 0;

  for (const seq of pending) {
    // Let other work (and another loop on the same ledger) in between targets.
    await yieldToLoop();
    const current = ledger.getRunForApply(runId);
    // Another loop on the same ledger closed the run: nothing is left for this one.
    if (current?.phase === 'done') return { status: 'done', summary: summarize(ledger, runId, 'Bulk run done.') };
    if (!current || current.phase !== 'writing' || current.haltReason !== null) {
      return { status: 'halted', summary: summarize(ledger, runId, 'Bulk run stopped by another loop.') };
    }
    if (current.maxTargets !== null && current.applied >= current.maxTargets) {
      // Another loop may have written the rest of this loop's list: then the run is finished,
      // not stopped at its maximum.
      if (ledger.listPending(runId).length === 0) break;
      ledger.halt(runId, BULK_HALT_REASONS.maxTargets);
      return { status: 'halted', summary: summarize(ledger, runId, `Bulk run halted: ${BULK_HALT_REASONS.maxTargets}.`) };
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

    const outcome = await writeOne(writer, target);
    if (outcome.kind === 'halt') {
      // The target is released unwritten; a resume takes it again.
      ledger.releaseClaim(runId, seq);
      ledger.halt(runId, outcome.reason);
      return { status: 'halted', summary: summarize(ledger, runId, `Bulk run halted: ${outcome.reason}.`) };
    }
    if (outcome.kind === 'applied') {
      ledger.recordApplied(run, seq, outcome.result, now(), outcome.actual);
      consecutive = 0;
      continue;
    }
    ledger.recordFailed(runId, seq, outcome.kind);
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
    if (failed > writingTotal * HALT_FAILURE_SHARE) {
      ledger.halt(runId, BULK_HALT_REASONS.failureRate);
      return { status: 'halted', summary: summarize(ledger, runId, `Bulk run halted: ${BULK_HALT_REASONS.failureRate}.`) };
    }
  }

  if (ledger.listPending(runId).length > 0) {
    return { status: 'pending', summary: summarize(ledger, runId, 'Bulk run waiting for targets another loop holds.') };
  }
  ledger.finish(run);
  return { status: 'done', summary: summarize(ledger, runId, 'Bulk run done.') };

  /** One claimed target: what to record for it. */
  async function writeOne(w: TargetWriter, t: ApplyTarget):
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
      const out = await w.write(t.key, t.after);
      return typeof out === 'string' ? { kind: 'applied', result: out, actual: null } : { kind: 'applied', result: out.result, actual: out.actual };
    } catch (err: unknown) {
      if (err instanceof BulkWriterHalt) return { kind: 'halt', reason: err.reason };
      if (err instanceof BulkRedirectError) return { kind: 'redirect' };
      return { kind: 'write_failed' };
    }
  }
}

/**
 * An atomic run hit a target it could not write: take back every target it wrote, newest
 * first, each only while it still holds what the run wrote, and end the run `aborted`.
 * Local only — an external target has no transaction to lean on (PRD §3.4).
 */
async function rollBack(ledger: BulkLedger, writer: TargetWriter, run: BulkRunForApply, now: () => number): Promise<BulkEffectOutcome> {
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
  ledger.setPhase(run.id, ['writing'], 'aborted',
    complete ? BULK_HALT_REASONS.atomicRolledBack : BULK_HALT_REASONS.atomicRollbackIncomplete);
  return {
    status: 'aborted',
    summary: summarize(ledger, run.id, complete ? 'Atomic bulk run aborted and rolled back.' : 'Atomic bulk run aborted; the rollback did not complete.'),
  };
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
  /** The confinement resolver. Injected so a test can stand in for the moment a path is
   *  swapped between this check and the file operation after it — a race no static
   *  setup reproduces, and the only case the leaf guards below exist for. */
  resolve: (target: string) => string | null = resolveBulkFilePath,
): TargetWriter {
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
