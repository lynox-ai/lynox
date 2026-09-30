/**
 * The bulk-run ledger (PRD bulk-changes-reversible §3.1): one row per run that applies
 * a rule to N targets, one row per target holding the before-image read at dry-run
 * time and the after-state the rule would produce.
 *
 * Two surfaces with a hard line between them:
 * - {@link BulkLedger.getStatus} / {@link BulkLedger.listRuns} return COUNTERS and
 *   PHASES only. They are what the model sees (`bulk_status`, the `bulk_plan` result).
 * - {@link BulkLedger.getPreview} returns decrypted before/after/diff per target. It is
 *   the owner's view of the dry run and must never be wired to a model-facing tool:
 *   before-images are customer data, and a target file may be externally authored.
 *
 * This slice only PLANS: nothing here writes to a target system. Approval, apply and
 * undo are later slices and read the same rows.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { EngineDb } from './engine-db.js';
import type { UndoKind } from '../types/index.js';

/** Target systems the dry-run slice can image. External (`http:<host>`), memory and
 *  artifacts are later slices (PRD §4 D; §3.1 lists the full set). */
export type BulkTargetSystem = 'workspace' | 'data_store';

export type BulkPhase = 'planned' | 'previewed' | 'approved' | 'writing' | 'done' | 'aborted' | 'undone';
export type BulkChange = 'update' | 'create' | 'unchanged' | 'invalid';

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
  | 'unknown_column'
  /** a `subject` column: converting it would create a subject, which a dry run must not */
  | 'subject_column'
  | 'bad_value'
  | 'bad_key';

export interface BulkRunStatus {
  id: string;
  createdAt: string;
  targetSystem: string;
  phase: BulkPhase;
  undo: UndoKind | 'mixed';
  total: number;
  changes: Record<BulkChange, number>;
  invalidReasons: Partial<Record<BulkInvalidReason, number>>;
  applied: number;
  failed: number;
  haltReason: string | null;
}

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
}

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

/** Hash of the rule as planned: target system, scope and every (key, after) pair.
 *  Order-independent, so the same rule planned twice hashes the same. */
export function ruleHash(targetSystem: string, scope: string, targets: readonly PlannedTarget[]): string {
  const pairs = targets
    .map((t) => ('invalid' in t ? [t.key, null] : [t.key, t.after]))
    .sort((x, y) => (String(x[0]) < String(y[0]) ? -1 : String(x[0]) > String(y[0]) ? 1 : 0));
  return createHash('sha256').update(canonicalJson([targetSystem, scope, pairs])).digest('hex');
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
      `INSERT INTO bulk_runs (id, created_by, rule_hash, target_system, undo, phase, targets_total)
       VALUES (?, ?, ?, ?, ?, 'previewed', ?)`,
    );
    const insertTarget = db.prepare(
      `INSERT INTO bulk_targets (run_id, seq, target_key, change, undo, before, after_planned, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    db.transaction(() => {
      insertRun.run(
        id, params.createdBy ?? null, ruleHash(params.targetSystem, params.scope, params.targets),
        params.targetSystem, runUndo, params.targets.length,
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
   * The owner's view of a dry run: per target the before-image, the planned
   * after-state and their diff, in plan order. NEVER wire this to a model-facing tool
   * (see the module comment).
   */
  getPreview(runId: string, opts: { offset?: number | undefined; limit?: number | undefined } = {}): PreviewTarget[] {
    const rows = this.engineDb.getDb().prepare(
      `SELECT seq, target_key, change, undo, before, after_planned, error FROM bulk_targets
       WHERE run_id = ? ORDER BY seq LIMIT ? OFFSET ?`,
    ).all(runId, Math.max(1, Math.min(opts.limit ?? 500, 5000)), Math.max(0, opts.offset ?? 0)) as {
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
    const changes: Record<BulkChange, number> = { update: 0, create: 0, unchanged: 0, invalid: 0 };
    for (const c of db.prepare('SELECT change, COUNT(*) AS n FROM bulk_targets WHERE run_id = ? GROUP BY change')
      .all(row.id) as { change: BulkChange; n: number }[]) changes[c.change] = c.n;
    const invalidReasons: Partial<Record<BulkInvalidReason, number>> = {};
    for (const e of db.prepare(
      `SELECT error, COUNT(*) AS n FROM bulk_targets WHERE run_id = ? AND change = 'invalid' GROUP BY error`,
    ).all(row.id) as { error: BulkInvalidReason; n: number }[]) invalidReasons[e.error] = e.n;
    return {
      id: row.id, createdAt: row.created_at, targetSystem: row.target_system, phase: row.phase, undo: row.undo,
      total: row.targets_total, changes, invalidReasons,
      applied: row.targets_applied, failed: row.targets_failed, haltReason: row.halt_reason,
    };
  }
}
