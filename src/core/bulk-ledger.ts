/**
 * The bulk-run ledger (PRD bulk-changes-reversible §3.1): one row per run that applies
 * a rule to N targets, one row per target holding the before-image read at dry-run
 * time and the after-state the rule would produce.
 *
 * Two surfaces with a hard line between them:
 * - {@link BulkLedger.getStatus} / {@link BulkLedger.listRuns} return COUNTERS and
 *   PHASES only. They are what the model sees (`bulk_status`, the `bulk_plan` result).
 * - {@link BulkLedger.getPreview} returns decrypted before/after/diff per target. It is
 *   the owner's view of a run and must never be wired to a model-facing tool:
 *   before-images are customer data, and a target file may be externally authored.
 *
 * Nothing here writes to a target system either. Approval ({@link BulkLedger.approve}),
 * the per-target claim and outcome, and planning an undo are ledger writes; the effect
 * that touches targets is `bulk-apply.ts`, run by the worker off the trigger the
 * approval arms.
 */
import { randomUUID } from 'node:crypto';
import type { EngineDb } from './engine-db.js';
import type { UndoKind } from '../types/index.js';
import { TriggerStore } from './trigger-store.js';

/** Target systems a run can plan and write today. External (`http:<host>`), memory and
 *  artifacts are not built yet (PRD §4 D; §3.1 lists the full set). */
export type BulkTargetSystem = 'workspace' | 'data_store';

/** The run's lifecycle (PRD §3.1). A dry run is recorded straight as `previewed`;
 *  `planned` is the schema's name for a run not yet imaged, which nothing writes today. */
export type BulkPhase = 'planned' | 'previewed' | 'approved' | 'writing' | 'done' | 'aborted' | 'undone';
/** `delete` is only ever planned by an undo: taking back a created target removes it. */
export type BulkChange = 'update' | 'create' | 'delete' | 'unchanged' | 'invalid';
export type BulkRunKind = 'apply' | 'undo';

/** What was at the target before: absent (the rule would create it) or a value. */
export type BeforeImage = { absent: true } | { absent: false; value: unknown };

/** One target as planned. `invalid` targets carry an `error` category and no after. */
export type PlannedTarget =
  | { key: string; before: BeforeImage; after: unknown }
  | { key: string; invalid: BulkInvalidReason };

/**
 * Why a target could not be planned. A FIXED vocabulary on purpose: the count per
 * reason is what the model is told, and a free-text reason would carry the target's
 * own (possibly externally authored) strings into the model's context.
 */
export type BulkInvalidReason =
  | 'path_outside_workspace'
  /** exists but is not a readable regular file (a directory, a device, no permission) */
  | 'unreadable'
  | 'target_too_large'
  | 'after_not_text'
  /** the file's bytes are not UTF-8, so no text before-image would be its real content */
  | 'not_text'
  | 'unknown_column'
  /** a `subject` column: converting it would create a subject, which a dry run must not */
  | 'subject_column'
  | 'bad_value'
  | 'bad_key';

export interface BulkRunStatus {
  id: string;
  createdAt: string;
  /** Wider than {@link BulkTargetSystem} on purpose: the column is meant to hold the
   *  systems not built yet (`http:<host>`, …), and a status read must not break on them. */
  targetSystem: string;
  phase: BulkPhase;
  undo: UndoKind | 'mixed';
  total: number;
  changes: Record<BulkChange, number>;
  invalidReasons: Partial<Record<BulkInvalidReason, number>>;
  applied: number;
  failed: number;
  /** Targets not written because they no longer held their expected state (§3.5). */
  conflicts: number;
  /** Applied targets taken back since — by an undo run, or an atomic run's rollback. */
  undone: number;
  kind: BulkRunKind;
  atomic: boolean;
  sourceRunId: string | null;
  /** Relayed to the model by `bulk_status`, so only ENGINE-authored text may ever be
   *  written here — a {@link BULK_HALT_REASONS} value, never an API response or error. */
  haltReason: string | null;
}

/**
 * Why a run stopped short. FIXED texts: `halt_reason` reaches the model through
 * `bulk_status`, and anything else written there — an error message, a file's content
 * — would carry a target's strings into the model's context.
 */
export const BULK_HALT_REASONS = {
  failureRate: 'more than 5 % of the targets failed',
  consecutiveFailures: 'three targets in a row failed',
  timeBudget: 'the run used up its time budget',
  expired: 'the approval expired',
  checksum: 'the run no longer matches what was approved',
  maxTargets: 'the approved maximum number of targets is reached',
  atomicRolledBack: 'a target of an atomic run could not be written; the targets written before it were rolled back',
  atomicRollbackIncomplete: 'a target of an atomic run could not be written, and rolling back the ones written before it did not complete',
  unavailable: 'the target system is not available',
} as const;
export type BulkHaltReason = (typeof BULK_HALT_REASONS)[keyof typeof BULK_HALT_REASONS];

/** Per-target failure codes. Fixed for the same reason as {@link BULK_HALT_REASONS}. */
export type BulkTargetError = 'conflict' | 'write_failed' | 'path_changed';

/** Per target, the unit of a run's time budget and of its approval window. */
export const BULK_TARGET_BUDGET_MS = 5_000;
/** A claim older than this is taken to belong to a dead loop. Longer than one target's
 *  budget, so a slow write is not mistaken for a dead one. */
export const BULK_CLAIM_STALE_MS = 30_000;
/** The approval window: N targets × the per-target budget, plus this, capped at a day. */
export const BULK_APPROVAL_SLACK_MS = 15 * 60_000;
export const BULK_APPROVAL_MAX_MS = 24 * 60 * 60_000;

/** Dry runs kept that were never approved. Recording another drops the oldest beyond
 *  this: a preview holds nothing to undo, and without a cap repeated calls would grow
 *  engine.db without bound. Approved runs are not touched — their retention is §3.1's. */
export const BULK_MAX_PREVIEWED_RUNS = 10;

export type TargetDiff =
  | { kind: 'none' }
  /** One hunk: lines [from, from+removed.length) of before become `added`. Common
   *  prefix and suffix are trimmed, so the hunk may be wider than a minimal diff, but
   *  applying it to before always yields after. */
  | { kind: 'text'; from: number; removed: string[]; added: string[] }
  | { kind: 'fields'; fields: { field: string; before: unknown; after: unknown }[] };

export interface PreviewTarget {
  seq: number;
  key: string;
  change: BulkChange;
  undo: UndoKind | null;
  before: BeforeImage | null;
  after: unknown;
  diff: TargetDiff;
  error: string | null;
}

interface RunRow {
  id: string; created_at: string; target_system: string; phase: BulkPhase; undo: UndoKind | 'mixed';
  targets_total: number; targets_applied: number; targets_failed: number; halt_reason: string | null;
  atomic: number; kind: BulkRunKind; source_run_id: string | null; target_collection: string | null;
  rule_hash: string; approval_checksum: string | null; max_targets: number | null; expires_at: string | null;
}

/** A run as the effect loop reads it. Not model-facing. */
export interface BulkRunForApply {
  id: string;
  kind: BulkRunKind;
  targetSystem: string;
  targetCollection: string | null;
  atomic: boolean;
  phase: BulkPhase;
  approvalChecksum: string | null;
  maxTargets: number | null;
  expiresAt: string | null;
  applied: number;
  failed: number;
  haltReason: string | null;
  sourceRunId: string | null;
}

/** One target as the effect loop writes it: the state it must find, the state it writes. */
export interface ApplyTarget {
  seq: number;
  key: string;
  change: 'update' | 'create' | 'delete';
  /** The state the target must hold for the write to go ahead. */
  expected: BeforeImage;
  /** The state the write produces; absent for a `delete`. */
  after: BeforeImage;
  sourceSeq: number | null;
}

/** Changes that write. `unchanged` and `invalid` targets are never touched. */
const WRITING_CHANGES = "('update','create','delete')";

/** Per-target undo class, derived from what is there: creating is compensatable,
 *  overwriting needs the before-image. */
function undoFor(before: BeforeImage): UndoKind {
  return before.absent ? 'compensatable' : 'restorable';
}

/** Canonical JSON: object keys sorted, so equal values hash and compare equal. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

/** What the rule would do to one target. */
export function classifyChange(before: BeforeImage, after: unknown): BulkChange {
  if (before.absent) return 'create';
  return canonicalJson(before.value) === canonicalJson(after) ? 'unchanged' : 'update';
}

/** The diff between a before-image and the planned after-state. Text is diffed by
 *  line; a row (plain object) by field, over the fields the after-state names. */
export function diffTarget(before: BeforeImage, after: unknown): TargetDiff {
  const prior = before.absent ? undefined : before.value;
  if (typeof after === 'string' && (prior === undefined || typeof prior === 'string')) {
    const a = prior === undefined ? [] : prior.split('\n');
    const b = after.split('\n');
    if (prior !== undefined && prior === after) return { kind: 'none' };
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;
    let endA = a.length;
    let endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
    return { kind: 'text', from: start, removed: a.slice(start, endA), added: b.slice(start, endB) };
  }
  if (after !== null && typeof after === 'object' && !Array.isArray(after)) {
    const priorObj = prior !== null && typeof prior === 'object' && !Array.isArray(prior)
      ? prior as Record<string, unknown> : {};
    const fields = Object.keys(after as Record<string, unknown>).sort()
      .filter((f) => canonicalJson(priorObj[f]) !== canonicalJson((after as Record<string, unknown>)[f]))
      .map((f) => ({ field: f, before: priorObj[f], after: (after as Record<string, unknown>)[f] }));
    return fields.length === 0 ? { kind: 'none' } : { kind: 'fields', fields };
  }
  return canonicalJson(prior) === canonicalJson(after)
    ? { kind: 'none' }
    : { kind: 'fields', fields: [{ field: '', before: prior, after }] };
}

/** The (key, after) pairs that make up a rule as planned, in key order, so the same
 *  rule planned twice yields the same sequence. */
function* rulePairs(targetSystem: string, scope: string, targets: readonly PlannedTarget[]): Generator<string> {
  yield targetSystem;
  yield scope;
  const sorted = [...targets].sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
  for (const t of sorted) {
    yield t.key;
    yield 'invalid' in t ? '' : canonicalJson(t.after);
  }
}

export class BulkLedger {
  constructor(private readonly engineDb: EngineDb) {}

  /**
   * Record a dry run: the run in phase `previewed` and every target with its
   * before-image, planned after-state and change class, in one transaction. Writes
   * only the ledger — never a target.
   */
  recordDryRun(params: {
    createdBy: string | undefined;
    targetSystem: BulkTargetSystem;
    scope: string;
    targets: readonly PlannedTarget[];
    /** The data-store collection the run writes; null for workspace runs. */
    targetCollection?: string | null | undefined;
    atomic?: boolean | undefined;
  }): BulkRunStatus {
    // Key uniqueness lives here, not in the schema: `target_key` is stored encrypted
    // (see engine-db v13), so no index could enforce it.
    const seen = new Set<string>();
    for (const t of params.targets) {
      if (seen.has(t.key)) throw new Error('A bulk plan names the same target twice.');
      seen.add(t.key);
    }
    const db = this.engineDb.getDb();
    const id = randomUUID();
    const undoKinds = new Set<UndoKind>();
    for (const t of params.targets) if (!('invalid' in t)) undoKinds.add(undoFor(t.before));
    const runUndo: UndoKind | 'mixed' = undoKinds.size === 1 ? [...undoKinds][0]! : undoKinds.size === 0 ? 'none' : 'mixed';

    const insertRun = db.prepare(
      `INSERT INTO bulk_runs (id, created_by, rule_hash, target_system, undo, phase, targets_total, atomic, target_collection)
       VALUES (?, ?, ?, ?, ?, 'previewed', ?, ?, ?)`,
    );
    const insertTarget = db.prepare(
      `INSERT INTO bulk_targets (run_id, seq, target_key, change, undo, before, after_planned, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const prune = db.prepare(
      `DELETE FROM bulk_runs WHERE phase = 'previewed' AND id NOT IN (
         SELECT id FROM bulk_runs WHERE phase = 'previewed' ORDER BY created_at DESC, rowid DESC LIMIT ?)`,
    );
    db.transaction(() => {
      insertRun.run(
        // Keyed: a plain hash over (key, after) pairs would let a copy of the file confirm
        // guessed keys — the very values `target_key` is encrypted to protect.
        id, params.createdBy ?? null, this.engineDb.keyedHash(rulePairs(params.targetSystem, params.scope, params.targets)),
        params.targetSystem, runUndo, params.targets.length, params.atomic === true ? 1 : 0, params.targetCollection ?? null,
      );
      params.targets.forEach((t, seq) => {
        const key = this.engineDb.enc(t.key);
        if ('invalid' in t) {
          insertTarget.run(id, seq, key, 'invalid', null, null, null, t.invalid);
          return;
        }
        insertTarget.run(
          id, seq, key, classifyChange(t.before, t.after), undoFor(t.before),
          this.engineDb.enc(JSON.stringify(t.before)), this.engineDb.enc(JSON.stringify(t.after ?? null)), null,
        );
      });
      prune.run(BULK_MAX_PREVIEWED_RUNS);
    })();
    return this.getStatus(id)!;
  }

  /** Counters and phase of one run. No target key, value or diff. */
  getStatus(runId: string): BulkRunStatus | null {
    const row = this.engineDb.getDb().prepare('SELECT * FROM bulk_runs WHERE id = ?').get(runId) as RunRow | undefined;
    return row ? this.toStatus(row) : null;
  }

  /** The most recent runs, newest first, as counters. */
  listRuns(limit = 10): BulkRunStatus[] {
    const rows = this.engineDb.getDb()
      .prepare('SELECT * FROM bulk_runs ORDER BY created_at DESC, rowid DESC LIMIT ?')
      .all(Math.max(1, Math.min(limit, 50))) as RunRow[];
    return rows.map((r) => this.toStatus(r));
  }

  /**
   * The owner's view of a run: per target the before-image, the planned after-state and
   * their diff, in plan order. Its one caller is the human-facing route
   * `GET /api/bulk/runs/:id/targets`. NEVER wire this to a model-facing tool (see the
   * module comment).
   */
  getPreview(runId: string, opts: { offset?: number | undefined; limit?: number | undefined } = {}): PreviewTarget[] {
    const rows = this.engineDb.getDb().prepare(
      `SELECT seq, target_key, change, undo, before, after_planned, error FROM bulk_targets
       WHERE run_id = ? ORDER BY seq LIMIT ? OFFSET ?`,
    ).all(runId, Math.max(1, Math.min(opts.limit ?? 500, 500)), Math.max(0, opts.offset ?? 0)) as {
      seq: number; target_key: string; change: BulkChange; undo: UndoKind | null;
      before: string | null; after_planned: string | null; error: string | null;
    }[];
    return rows.map((r) => {
      const before = r.before === null ? null : JSON.parse(this.engineDb.dec(r.before)) as BeforeImage;
      const after: unknown = r.after_planned === null ? null : JSON.parse(this.engineDb.dec(r.after_planned));
      return {
        seq: r.seq, key: this.engineDb.dec(r.target_key), change: r.change, undo: r.undo, before, after,
        diff: before === null ? { kind: 'none' } : diffTarget(before, after),
        error: r.error,
      };
    });
  }

  private toStatus(row: RunRow): BulkRunStatus {
    const db = this.engineDb.getDb();
    const changes: Record<BulkChange, number> = { update: 0, create: 0, delete: 0, unchanged: 0, invalid: 0 };
    for (const c of db.prepare('SELECT change, COUNT(*) AS n FROM bulk_targets WHERE run_id = ? GROUP BY change')
      .all(row.id) as { change: BulkChange; n: number }[]) changes[c.change] = c.n;
    const invalidReasons: Partial<Record<BulkInvalidReason, number>> = {};
    for (const e of db.prepare(
      `SELECT error, COUNT(*) AS n FROM bulk_targets WHERE run_id = ? AND change = 'invalid' GROUP BY error`,
    ).all(row.id) as { error: BulkInvalidReason; n: number }[]) invalidReasons[e.error] = e.n;
    const outcome = db.prepare(
      `SELECT SUM(error = 'conflict') AS conflicts, SUM(undone_at IS NOT NULL) AS undone FROM bulk_targets WHERE run_id = ?`,
    ).get(row.id) as { conflicts: number | null; undone: number | null };
    return {
      id: row.id, createdAt: row.created_at, targetSystem: row.target_system, phase: row.phase, undo: row.undo,
      total: row.targets_total, changes, invalidReasons,
      applied: row.targets_applied, failed: row.targets_failed,
      conflicts: outcome.conflicts ?? 0, undone: outcome.undone ?? 0,
      kind: row.kind, atomic: row.atomic === 1, sourceRunId: row.source_run_id,
      haltReason: row.halt_reason,
    };
  }

  private runRow(runId: string): RunRow | undefined {
    return this.engineDb.getDb().prepare('SELECT * FROM bulk_runs WHERE id = ?').get(runId) as RunRow | undefined;
  }

  // ── Approval ────────────────────────────────────────────────────────────────

  /**
   * The approval checksum (PRD §3.1 `approval_checksum`): a keyed hash over everything
   * an apply would do — the run's kind, system, collection, atomicity and source run,
   * and per target its key, change, before-image and planned after-state, in seq order.
   * The owner's view shows it, approving has to present it, and the effect recomputes
   * it before it writes: a ledger that changed after approval is refused, not applied.
   */
  computeChecksum(runId: string): string | null {
    const run = this.runRow(runId);
    if (!run) return null;
    // Iterated, not loaded: a run's images can reach 32 MB before encryption.
    const rows = this.engineDb.getDb().prepare(
      'SELECT seq, target_key, change, before, after_planned FROM bulk_targets WHERE run_id = ? ORDER BY seq',
    ).iterate(runId) as IterableIterator<{ seq: number; target_key: string; change: string; before: string | null; after_planned: string | null }>;
    const db = this.engineDb;
    function* parts(): Generator<string> {
      yield 'bulk-approval-v1';
      yield run!.kind;
      yield run!.target_system;
      yield run!.target_collection ?? '';
      yield String(run!.atomic);
      yield run!.source_run_id ?? '';
      yield run!.rule_hash;
      for (const r of rows) {
        yield String(r.seq);
        yield db.dec(r.target_key);
        yield r.change;
        yield r.before === null ? '' : db.dec(r.before);
        yield r.after_planned === null ? '' : db.dec(r.after_planned);
      }
    }
    return this.engineDb.keyedHash(parts());
  }

  /** Targets the run writes: `update`, `create`, `delete`. */
  countWriting(runId: string): number {
    return (this.engineDb.getDb().prepare(
      `SELECT COUNT(*) AS n FROM bulk_targets WHERE run_id = ? AND change IN ${WRITING_CHANGES}`,
    ).get(runId) as { n: number }).n;
  }

  private approvalWindow(writing: number, now: number): string {
    return new Date(now + Math.min(writing * BULK_TARGET_BUDGET_MS + BULK_APPROVAL_SLACK_MS, BULK_APPROVAL_MAX_MS)).toISOString();
  }

  private armTrigger(run: RunRow, now: number): string {
    return new TriggerStore(this.engineDb).armBulkEffect({
      runId: run.id,
      effect: run.kind === 'undo' ? 'bulk_undo' : 'bulk_apply',
      // Engine text only: a trigger title is listed to the model by task_list.
      title: run.kind === 'undo' ? `Bulk undo ${run.id}` : `Bulk run ${run.id}`,
      nextRunAt: new Date(now).toISOString(),
    });
  }

  /**
   * Approve a previewed run (PRD §3.4): phase `approved`, the checksum the approver was
   * shown, a target cap and an expiry, and — in the same transaction — the trigger whose
   * effect writes it, due at once. The caller is the human-facing route; nothing
   * model-facing reaches this.
   */
  approve(runId: string, params: {
    checksum: string;
    approvedBy?: string | undefined;
    maxTargets?: number | undefined;
    now?: number | undefined;
  }): { ok: true; status: BulkRunStatus; triggerId: string }
    | { ok: false; reason: 'not_found' | 'wrong_phase' | 'checksum' | 'nothing_to_apply' | 'bad_max_targets' } {
    const run = this.runRow(runId);
    if (!run) return { ok: false, reason: 'not_found' };
    if (run.phase !== 'previewed') return { ok: false, reason: 'wrong_phase' };
    if (params.checksum !== this.computeChecksum(runId)) return { ok: false, reason: 'checksum' };
    const writing = this.countWriting(runId);
    if (writing === 0) return { ok: false, reason: 'nothing_to_apply' };
    const maxTargets = params.maxTargets ?? writing;
    if (!Number.isInteger(maxTargets) || maxTargets < 1 || maxTargets > writing) return { ok: false, reason: 'bad_max_targets' };
    // An atomic run capped below its size could only ever stop half written.
    if (run.atomic === 1 && maxTargets !== writing) return { ok: false, reason: 'bad_max_targets' };
    const now = params.now ?? Date.now();
    const db = this.engineDb.getDb();
    let triggerId = '';
    const moved = db.transaction(() => {
      const res = db.prepare(
        `UPDATE bulk_runs SET phase = 'approved', approved_by = ?, approved_at = ?, approval_checksum = ?,
           max_targets = ?, expires_at = ?, halt_reason = NULL
         WHERE id = ? AND phase = 'previewed'`,
      ).run(params.approvedBy ?? null, new Date(now).toISOString(), params.checksum, maxTargets,
        this.approvalWindow(writing, now), runId);
      if (res.changes !== 1) return false;
      triggerId = this.armTrigger(run, now);
      return true;
    })();
    if (!moved) return { ok: false, reason: 'wrong_phase' };
    return { ok: true, status: this.getStatus(runId)!, triggerId };
  }

  /**
   * Resume an approved run that stopped (a halt, an expired window, a loop that died):
   * a fresh human confirmation of the same approval. The checksum must still match the
   * one approved; the window restarts, the halt clears, failed and conflicting targets
   * are retried, and the trigger is due again.
   */
  resume(runId: string, params: { checksum: string; now?: number | undefined }):
    { ok: true; status: BulkRunStatus; triggerId: string } | { ok: false; reason: 'not_found' | 'wrong_phase' | 'checksum' } {
    const run = this.runRow(runId);
    if (!run) return { ok: false, reason: 'not_found' };
    if (run.phase !== 'approved' && run.phase !== 'writing') return { ok: false, reason: 'wrong_phase' };
    if (params.checksum !== run.approval_checksum || params.checksum !== this.computeChecksum(runId)) {
      return { ok: false, reason: 'checksum' };
    }
    const now = params.now ?? Date.now();
    const db = this.engineDb.getDb();
    let triggerId = '';
    const moved = db.transaction(() => {
      const res = db.prepare(
        `UPDATE bulk_runs SET halt_reason = NULL, expires_at = ?, targets_failed = 0
         WHERE id = ? AND phase IN ('approved','writing')`,
      ).run(this.approvalWindow(this.countWriting(runId), now), runId);
      if (res.changes !== 1) return false;
      db.prepare('UPDATE bulk_targets SET error = NULL, claimed_at = NULL WHERE run_id = ? AND applied_at IS NULL AND error IS NOT NULL')
        .run(runId);
      triggerId = this.armTrigger(run, now);
      return true;
    })();
    if (!moved) return { ok: false, reason: 'wrong_phase' };
    return { ok: true, status: this.getStatus(runId)!, triggerId };
  }

  /**
   * Plan the undo of a run (PRD §3.5): a NEW run, previewed, over the targets the source
   * applied and nobody took back since, in reverse order. Each undo target expects the
   * state the source wrote and writes the source's before-image back — or removes what
   * the source created. It is approved like any run (a second approval), and its effect
   * finds a target someone else changed in between by that expectation: a conflict,
   * shown, not overwritten. An undo of an undo is the same mechanism.
   */
  planUndo(sourceRunId: string, params: { createdBy?: string | undefined } = {}):
    { ok: true; status: BulkRunStatus } | { ok: false; reason: 'not_found' | 'not_undoable' | 'nothing_to_undo' | 'atomic_partial' } {
    const src = this.runRow(sourceRunId);
    if (!src) return { ok: false, reason: 'not_found' };
    const stopped = src.phase === 'done' || src.phase === 'aborted' || (src.phase === 'writing' && src.halt_reason !== null);
    if (!stopped) return { ok: false, reason: 'not_undoable' };
    const db = this.engineDb.getDb();
    if (src.atomic === 1) {
      // Form B's rule (PRD §2.2): an atomic run is taken back whole or not at all.
      const partial = db.prepare(
        `SELECT COUNT(*) AS n FROM bulk_targets WHERE run_id = ? AND change IN ${WRITING_CHANGES}
           AND (applied_at IS NULL OR undone_at IS NOT NULL)`,
      ).get(sourceRunId) as { n: number };
      if (src.phase !== 'done' || partial.n > 0) return { ok: false, reason: 'atomic_partial' };
    }
    const rows = db.prepare(
      `SELECT seq, target_key, change, before, after_planned FROM bulk_targets
       WHERE run_id = ? AND applied_at IS NOT NULL AND undone_at IS NULL AND change IN ${WRITING_CHANGES}
       ORDER BY seq DESC`,
    ).all(sourceRunId) as { seq: number; target_key: string; change: BulkChange; before: string | null; after_planned: string | null }[];
    if (rows.length === 0) return { ok: false, reason: 'nothing_to_undo' };

    const planned = rows.map((r) => {
      const t = this.toApplyTarget({ ...r, source_seq: null });
      const expected = t.after;
      const after = t.expected;
      const change: ApplyTarget['change'] = after.absent ? 'delete' : expected.absent ? 'create' : 'update';
      return { key: t.key, sourceSeq: r.seq, expected, after, change };
    });
    const id = randomUUID();
    const undoKinds = new Set(planned.map((t) => undoFor(t.expected)));
    const runUndo: UndoKind | 'mixed' = undoKinds.size === 1 ? [...undoKinds][0]! : 'mixed';
    function* hashParts(): Generator<string> {
      yield 'undo';
      yield sourceRunId;
      for (const t of planned) { yield String(t.sourceSeq); yield t.key; }
    }
    const insertTarget = db.prepare(
      `INSERT INTO bulk_targets (run_id, seq, target_key, change, undo, before, after_planned, source_seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    db.transaction(() => {
      db.prepare(
        `INSERT INTO bulk_runs (id, created_by, rule_hash, target_system, undo, phase, targets_total, atomic, kind,
           source_run_id, target_collection)
         VALUES (?, ?, ?, ?, ?, 'previewed', ?, ?, 'undo', ?, ?)`,
      ).run(id, params.createdBy ?? null, this.engineDb.keyedHash(hashParts()), src.target_system, runUndo,
        planned.length, src.atomic, sourceRunId, src.target_collection);
      planned.forEach((t, seq) => {
        insertTarget.run(
          id, seq, this.engineDb.enc(t.key), t.change, undoFor(t.expected),
          this.engineDb.enc(JSON.stringify(t.expected)),
          t.after.absent ? null : this.engineDb.enc(JSON.stringify(t.after.value ?? null)),
          t.sourceSeq,
        );
      });
      db.prepare(
        `DELETE FROM bulk_runs WHERE phase = 'previewed' AND id NOT IN (
           SELECT id FROM bulk_runs WHERE phase = 'previewed' ORDER BY created_at DESC, rowid DESC LIMIT ?)`,
      ).run(BULK_MAX_PREVIEWED_RUNS);
    })();
    return { ok: true, status: this.getStatus(id)! };
  }

  // ── The effect loop's reads and writes (bulk-apply.ts) ──────────────────────

  getRunForApply(runId: string): BulkRunForApply | null {
    const r = this.runRow(runId);
    if (!r) return null;
    return {
      id: r.id, kind: r.kind, targetSystem: r.target_system, targetCollection: r.target_collection,
      atomic: r.atomic === 1, phase: r.phase, approvalChecksum: r.approval_checksum, maxTargets: r.max_targets,
      expiresAt: r.expires_at, applied: r.targets_applied, failed: r.targets_failed, haltReason: r.halt_reason,
      sourceRunId: r.source_run_id,
    };
  }

  /** Writing targets not yet applied, failed or taken back, in seq order. */
  listPending(runId: string): number[] {
    return (this.engineDb.getDb().prepare(
      `SELECT seq FROM bulk_targets WHERE run_id = ? AND change IN ${WRITING_CHANGES}
         AND applied_at IS NULL AND error IS NULL AND undone_at IS NULL ORDER BY seq`,
    ).all(runId) as { seq: number }[]).map((r) => r.seq);
  }

  /**
   * Claim one target for writing (PRD §3.4). A single conditional UPDATE,
   * so test and set are one step: it succeeds only while the target is unapplied,
   * unfailed and unclaimed — or claimed longer ago than {@link BULK_CLAIM_STALE_MS}, by
   * a loop that died. Two loops on one ledger (a restart, a retry, a second trigger)
   * therefore never both write a target.
   */
  claimTarget(runId: string, seq: number, now: number = Date.now()): boolean {
    return this.engineDb.getDb().prepare(
      `UPDATE bulk_targets SET claimed_at = ?
       WHERE run_id = ? AND seq = ? AND applied_at IS NULL AND error IS NULL AND undone_at IS NULL
         AND (claimed_at IS NULL OR claimed_at < ?)`,
    ).run(new Date(now).toISOString(), runId, seq, new Date(now - BULK_CLAIM_STALE_MS).toISOString()).changes === 1;
  }

  loadTarget(runId: string, seq: number): ApplyTarget | null {
    const r = this.engineDb.getDb().prepare(
      'SELECT seq, target_key, change, before, after_planned, source_seq FROM bulk_targets WHERE run_id = ? AND seq = ?',
    ).get(runId, seq) as { seq: number; target_key: string; change: BulkChange; before: string | null; after_planned: string | null; source_seq: number | null } | undefined;
    return r ? this.toApplyTarget(r) : null;
  }

  private toApplyTarget(r: { seq: number; target_key: string; change: BulkChange; before: string | null; after_planned: string | null; source_seq: number | null }): ApplyTarget {
    if (r.change !== 'update' && r.change !== 'create' && r.change !== 'delete') throw new Error('not a writing target');
    const expected = r.before === null ? { absent: true as const } : JSON.parse(this.engineDb.dec(r.before)) as BeforeImage;
    const after: BeforeImage = r.change === 'delete' || r.after_planned === null
      ? { absent: true }
      : { absent: false, value: JSON.parse(this.engineDb.dec(r.after_planned)) as unknown };
    return { seq: r.seq, key: this.engineDb.dec(r.target_key), change: r.change, expected, after, sourceSeq: r.source_seq };
  }

  /**
   * Record a written target, releasing its claim, in one transaction with the run's
   * counter — and, for an undo target, the source target it took back.
   */
  recordApplied(run: Pick<BulkRunForApply, 'id' | 'kind' | 'sourceRunId'>, seq: number, result: string, now: number = Date.now()): void {
    const db = this.engineDb.getDb();
    const at = new Date(now).toISOString();
    db.transaction(() => {
      const res = db.prepare(
        'UPDATE bulk_targets SET applied_at = ?, result = ?, claimed_at = NULL WHERE run_id = ? AND seq = ? AND applied_at IS NULL',
      ).run(at, result, run.id, seq);
      if (res.changes !== 1) return;
      db.prepare('UPDATE bulk_runs SET targets_applied = targets_applied + 1 WHERE id = ?').run(run.id);
      if (run.kind === 'undo' && run.sourceRunId !== null) {
        db.prepare(
          `UPDATE bulk_targets SET undone_at = ? WHERE run_id = ?
             AND seq = (SELECT source_seq FROM bulk_targets WHERE run_id = ? AND seq = ?)`,
        ).run(at, run.sourceRunId, run.id, seq);
      }
    })();
  }

  /** Record a target that was not written. A conflict is not counted as a failure: the
   *  target is fine, it just no longer holds the state the run expected. */
  recordFailed(runId: string, seq: number, error: BulkTargetError): void {
    const db = this.engineDb.getDb();
    db.transaction(() => {
      const res = db.prepare(
        'UPDATE bulk_targets SET error = ?, claimed_at = NULL WHERE run_id = ? AND seq = ? AND applied_at IS NULL',
      ).run(error, runId, seq);
      if (res.changes === 1 && error !== 'conflict') {
        db.prepare('UPDATE bulk_runs SET targets_failed = targets_failed + 1 WHERE id = ?').run(runId);
      }
    })();
  }

  /**
   * Mark a target written by this run as taken back (an atomic run's rollback). For an
   * undo run the rollback restores what the source wrote, so the source target stands
   * again: its `undone_at` is cleared in the same transaction.
   */
  recordRolledBack(run: Pick<BulkRunForApply, 'id' | 'kind' | 'sourceRunId'>, seq: number, now: number = Date.now()): void {
    const db = this.engineDb.getDb();
    db.transaction(() => {
      db.prepare('UPDATE bulk_targets SET undone_at = ? WHERE run_id = ? AND seq = ? AND applied_at IS NOT NULL')
        .run(new Date(now).toISOString(), run.id, seq);
      if (run.kind === 'undo' && run.sourceRunId !== null) {
        db.prepare(
          `UPDATE bulk_targets SET undone_at = NULL WHERE run_id = ?
             AND seq = (SELECT source_seq FROM bulk_targets WHERE run_id = ? AND seq = ?)`,
        ).run(run.sourceRunId, run.id, seq);
      }
    })();
  }

  /** Targets this run applied and has not taken back, newest first — a rollback's order. */
  listAppliedDesc(runId: string): ApplyTarget[] {
    const rows = this.engineDb.getDb().prepare(
      `SELECT seq, target_key, change, before, after_planned, source_seq FROM bulk_targets
       WHERE run_id = ? AND applied_at IS NOT NULL AND undone_at IS NULL AND change IN ${WRITING_CHANGES}
       ORDER BY seq DESC`,
    ).all(runId) as { seq: number; target_key: string; change: BulkChange; before: string | null; after_planned: string | null; source_seq: number | null }[];
    return rows.map((r) => this.toApplyTarget(r));
  }

  /** Move the run's phase, only from one of `from`. */
  setPhase(runId: string, from: readonly BulkPhase[], to: BulkPhase, haltReason: BulkHaltReason | null = null): boolean {
    return this.engineDb.getDb().prepare(
      `UPDATE bulk_runs SET phase = ?, halt_reason = COALESCE(?, halt_reason)
       WHERE id = ? AND phase IN (${from.map(() => '?').join(',')})`,
    ).run(to, haltReason, runId, ...from).changes === 1;
  }

  /** Stop the run where it is: the phase stays, the reason is set. */
  halt(runId: string, reason: BulkHaltReason): void {
    this.engineDb.getDb().prepare('UPDATE bulk_runs SET halt_reason = ? WHERE id = ?').run(reason, runId);
  }

  /**
   * Close a run whose loop found nothing left to write: `done`. For an undo run, the
   * source becomes `undone` once none of its applied targets is left standing.
   */
  finish(run: Pick<BulkRunForApply, 'id' | 'kind' | 'sourceRunId'>): void {
    const db = this.engineDb.getDb();
    db.transaction(() => {
      db.prepare(`UPDATE bulk_runs SET phase = 'done' WHERE id = ? AND phase = 'writing'`).run(run.id);
      if (run.kind !== 'undo' || run.sourceRunId === null) return;
      const standing = db.prepare(
        `SELECT COUNT(*) AS n FROM bulk_targets WHERE run_id = ? AND applied_at IS NOT NULL AND undone_at IS NULL
           AND change IN ${WRITING_CHANGES}`,
      ).get(run.sourceRunId) as { n: number };
      if (standing.n === 0) {
        db.prepare(`UPDATE bulk_runs SET phase = 'undone' WHERE id = ? AND phase IN ('done','aborted','writing')`).run(run.sourceRunId);
      }
    })();
  }
}
