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
import { TriggerStore, bulkPreviewTriggerId } from './trigger-store.js';
import type { ExternalImage, ExternalPlanned } from './bulk-external.js';
import type { CapabilityContract } from '../types/capability-contract.js';

/** Local target systems a run can plan and write. An external run's system is
 *  `http:<host>` ({@link BulkLedger.recordExternalPlan}); it is planned and previewed,
 *  not written yet. Memory and artifacts are not built (PRD §4 D; §3.1 lists the set). */
export type BulkTargetSystem = 'workspace' | 'data_store';

/** The run's lifecycle (PRD §3.1). A local dry run is recorded straight as `previewed`;
 *  an external one is `planned` until its preview effect has read every target. */
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
  | 'bad_key'
  // External targets (`http:<host>`):
  /** not an HTTPS URL on the run's host without port, user info, query or fragment */
  | 'bad_url'
  /** the after-state is not a non-empty JSON object */
  | 'after_not_object'
  /** a field of the after-state or of the target is not a JSON scalar */
  | 'field_not_scalar'
  /** the target lacks a field the run would write, so undo could not restore it */
  | 'field_missing'
  /** the target is not a JSON object */
  | 'before_not_object'
  /** the target does not exist — a PATCH cannot create it */
  | 'not_found'
  /** the target answered with a redirect, which a run never follows */
  | 'redirect'
  /** the target's body is not JSON */
  | 'not_json'
  /** the host refused to serve the target, or failed to */
  | 'read_failed'
  /** the after-state holds something shaped like a credential */
  | 'secret_in_after';

export interface BulkRunStatus {
  id: string;
  createdAt: string;
  /** Wider than {@link BulkTargetSystem} on purpose: the column is meant to hold the
   *  systems not built yet (`http:<host>`, …), and a status read must not break on them. */
  targetSystem: string;
  phase: BulkPhase;
  undo: UndoKind | 'mixed';
  total: number;
  /** Targets of a `planned` external run not read yet. Their change is not known, so
   *  {@link changes} counts them as `update` until the read decides. */
  unread: number;
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
  /** An external run's write verb, from its contract; null for a local run. */
  writeMethod: string | null;
  /** An external run may be approved for more than one target (a probe is confirmed for
   *  its host and verb, or it is local). */
  probeConfirmed: boolean;
  /** `keyed`: the approval checksum is an HMAC under the vault key, so only the engine can
   *  produce one that matches. `unkeyed` (no vault key): plain SHA-256 — it still detects
   *  a run that changed by accident, but whoever can write the engine database can change
   *  the run and recompute it, so it does not bind the approval to what was shown. */
  checksumBinding: 'keyed' | 'unkeyed';
  /** Relayed to the model by `bulk_status`, so only ENGINE-authored text may ever be
   *  written here — a {@link BULK_HALT_REASONS} value, never an API response or error. */
  haltReason: string | null;
}

/** Shown wherever a run is approved or its checksum presented, when the instance has no
 *  vault key: the weaker variant runs, but it says so (the same rule as an unencrypted
 *  backup). */
export const BULK_UNKEYED_CHECKSUM_NOTE =
  'This instance has no vault key, so the approval checksum is a plain SHA-256: it catches a run that ' +
  'changed by accident, but whoever can write the engine database can change the run and recompute it. ' +
  'It does not bind your approval to what you were shown. Set a vault key for a checksum that does.';

/**
 * Why a run stopped short. FIXED texts: `halt_reason` reaches the model through
 * `bulk_status`, and anything else written there — an error message, a file's content
 * — would carry a target's strings into the model's context.
 */
export const BULK_HALT_REASONS = {
  awaitingStart: 'waiting for the owner to start reading the targets',
  failureRate: 'more than 5 % of the targets failed',
  consecutiveFailures: 'three targets in a row failed',
  timeBudget: 'the run used up its time budget',
  expired: 'the approval expired',
  checksum: 'the run no longer matches what was approved',
  maxTargets: 'the approved maximum number of targets is reached',
  atomicRolledBack: 'a target of an atomic run could not be written; the targets written before it were rolled back',
  atomicRollbackIncomplete: 'a target of an atomic run could not be written, and rolling back the ones written before it did not complete',
  unavailable: 'the target system is not available',
  credential: 'the access credential for this host cannot be attached',
  unauthorized: 'the host did not accept the stored credential',
  blocked: 'the network policy does not allow this host',
  contract: 'a target lies outside the run\'s contract',
} as const;
export type BulkHaltReason = (typeof BULK_HALT_REASONS)[keyof typeof BULK_HALT_REASONS];

/** Per-target failure codes. Fixed for the same reason as {@link BULK_HALT_REASONS}.
 *  `redirect`: an external target answered a write with a redirect, which is never followed. */
export type BulkTargetError = 'conflict' | 'write_failed' | 'path_changed' | 'redirect';

/** What an external target held right after the run wrote it, over the fields it wrote.
 *  `estimated`: the read-back failed and this is what was sent — an undo then finds a
 *  target the host normalised as a conflict, the safe direction. */
export interface ActualImage { value: unknown; estimated: boolean }

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
 *  engine.db without bound. Approved runs are not touched — their retention is §3.1's.
 *  Undo previews are not touched either: only the owner's route plans one, and the
 *  model's `bulk_plan` calls must not be able to drop the undo the owner is about to
 *  approve. */
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
  /** External targets: fields the write sends although their value does not change —
   *  because the source named them, or the provider requires them on every edit. Shown so
   *  an owner does not read them as a mistake; the undo writes them back too. */
  sentUnchanged?: string[] | undefined;
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
  contract_json: string | null;
}

/** An external run as its preview effect reads it. Not model-facing. */
export interface BulkRunForPreview {
  id: string;
  kind: BulkRunKind;
  targetSystem: string;
  phase: BulkPhase;
  haltReason: string | null;
  contractJson: string | null;
}

/** The write verb an external run's stored contract grants besides GET, or null. Read
 *  here rather than imported: the ledger must not depend on the writer's module. */
function parseContractMethods(json: string | null): string | null {
  if (json === null) return null;
  try {
    const methods = (JSON.parse(json) as { httpMethods?: unknown }).httpMethods;
    if (!Array.isArray(methods)) return null;
    const writes = methods.filter((m) => m !== 'GET');
    return writes.length === 1 && typeof writes[0] === 'string' ? writes[0] : null;
  } catch {
    return null;
  }
}

/** The kind of resource a target URL path names: the path without its last segment —
 *  `/2.0/article/7` → `/2.0/article/`. One host serves many kinds (bexio: articles and
 *  contacts), and a verb that keeps unsent fields on one may replace the resource on another,
 *  so a probe vouches for its kind only. */
export function resourceKindOf(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed.slice(0, trimmed.lastIndexOf('/') + 1);
}

/** The target paths an external run's stored contract grants. */
function parseContractPaths(json: string | null): string[] {
  if (json === null) return [];
  try {
    const paths = (JSON.parse(json) as { pathPatterns?: unknown }).pathPatterns;
    return Array.isArray(paths) ? paths.filter((p): p is string => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

/** Why a run may not start writing because of an undo — see `BulkLedger.writeBlocked`. */
export type UndoRefusal = 'undo_open' | 'source_running' | 'undo_stale';

/** A run whose own loop has stopped and is not started again unless a human resumes it. */
function isStopped(r: { phase: BulkPhase; halt_reason: string | null }): boolean {
  return r.phase === 'done' || r.phase === 'aborted' || (r.phase === 'writing' && r.halt_reason !== null);
}

/** An external run's target system, `http:<host>`. */
export function externalHostOf(targetSystem: string): string | null {
  return targetSystem.startsWith('http:') ? targetSystem.slice('http:'.length) : null;
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
  /** The contract an external run was planned with; null for a local run. */
  contractJson: string | null;
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

/**
 * The source targets an undo takes back: applied and not taken back since — and, for an
 * external run, a target whose write failed. A request to a host can land although its
 * answer never came back (a timeout after it went out), so such a target may hold what the
 * source wrote. The undo reads it before writing, like every target, and finds out.
 */
function undoEligible(external: boolean): string {
  return `undone_at IS NULL AND change IN ${WRITING_CHANGES} AND (applied_at IS NOT NULL${external ? " OR error = 'write_failed'" : ''})`;
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

/** The (key, after) pairs that make up a rule as planned, in key order, so the same
 *  rule planned twice yields the same sequence. */
function* rulePairs(
  targetSystem: string, scope: string,
  targets: readonly ({ key: string; after: unknown } | { key: string; invalid: BulkInvalidReason })[],
): Generator<string> {
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
      this.pruneUnapproved();
    })();
    return this.getStatus(id)!;
  }

  /**
   * Drop the oldest unapproved apply runs beyond {@link BULK_MAX_PREVIEWED_RUNS}:
   * previewed ones, and `planned` external ones whose preview is still reading. A dropped
   * planned run's preview trigger goes with it, in the caller's transaction (plan §6
   * Q3(b)); an effect already running finds no run on its next target and stops.
   */
  private pruneUnapproved(): void {
    const db = this.engineDb.getDb();
    const doomed = db.prepare(
      `SELECT id FROM bulk_runs WHERE phase IN ('previewed','planned') AND kind = 'apply' AND id NOT IN (
         SELECT id FROM bulk_runs WHERE phase IN ('previewed','planned') AND kind = 'apply'
         ORDER BY created_at DESC, rowid DESC LIMIT ?)`,
    ).all(BULK_MAX_PREVIEWED_RUNS) as { id: string }[];
    const triggers = new TriggerStore(this.engineDb);
    const drop = db.prepare('DELETE FROM bulk_runs WHERE id = ?');
    for (const { id } of doomed) {
      triggers.remove(bulkPreviewTriggerId(id));
      drop.run(id);
    }
  }

  /**
   * Record an external plan (`http:<host>`, plan B §3): the run in phase `planned`, its
   * contract, every target with its after-state and no before-image — in one transaction
   * (plan §6 Q3(a)). Sends nothing, and arms nothing: the run is halted with
   * {@link BULK_HALT_REASONS.awaitingStart} until the owner starts the read through
   * {@link resumePreview}. Every read carries the host's stored credential and may cost
   * money on a per-call profile, so its start is a human step, like an approval — the
   * host budget stays as a second line. While another external run is reading, a second
   * plan is refused: an ordering rule, not a cap.
   */
  recordExternalPlan(params: {
    createdBy: string | undefined;
    host: string;
    targets: readonly ExternalPlanned[];
    contract: CapabilityContract;
  }): { ok: true; status: BulkRunStatus } | { ok: false; reason: 'external_in_progress' } {
    const seen = new Set<string>();
    for (const t of params.targets) {
      if (seen.has(t.key)) throw new Error('A bulk plan names the same target twice.');
      seen.add(t.key);
    }
    const db = this.engineDb.getDb();
    const id = randomUUID();
    const targetSystem = `http:${params.host}`;
    const valid = params.targets.some((t) => !('invalid' in t));
    const insertTarget = db.prepare(
      `INSERT INTO bulk_targets (run_id, seq, target_key, change, undo, before, after_planned, error)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
    );
    const recorded = db.transaction((): boolean => {
      const reading = db.prepare(
        `SELECT COUNT(*) AS n FROM bulk_runs WHERE phase = 'planned' AND halt_reason IS NULL AND target_system LIKE 'http:%'`,
      ).get() as { n: number };
      if (reading.n > 0) return false;
      db.prepare(
        `INSERT INTO bulk_runs (id, created_by, rule_hash, target_system, undo, phase, targets_total, atomic, contract_json, halt_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      ).run(
        id, params.createdBy ?? null,
        this.engineDb.keyedHash(rulePairs(targetSystem, params.host, params.targets)),
        // Nothing valid to read: the run is complete as planned.
        targetSystem, valid ? 'restorable' : 'none', valid ? 'planned' : 'previewed', params.targets.length,
        JSON.stringify(params.contract),
        // The start gate: nothing is read until the owner starts it (resumePreview). A plan
        // is what the model can make; a request with the host's credential is not.
        valid ? BULK_HALT_REASONS.awaitingStart : null,
      );
      params.targets.forEach((t, seq) => {
        const key = this.engineDb.enc(t.key);
        if ('invalid' in t) {
          insertTarget.run(id, seq, key, 'invalid', null, null, t.invalid);
          return;
        }
        // `update` until the preview reads the target; `unread` in the status says so.
        insertTarget.run(id, seq, key, 'update', 'restorable', this.engineDb.enc(JSON.stringify(t.after)), null);
      });
      this.pruneUnapproved();
      return true;
    })();
    if (!recorded) return { ok: false, reason: 'external_in_progress' };
    return { ok: true, status: this.getStatus(id)! };
  }

  private armPreviewTrigger(runId: string, now: number): string {
    return new TriggerStore(this.engineDb).armBulkEffect({
      runId,
      effect: 'bulk_preview',
      // Engine text only: a trigger title is listed to the model by task_list.
      title: `Bulk preview ${runId}`,
      nextRunAt: new Date(now).toISOString(),
    });
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
    const external = externalHostOf(this.runRow(runId)?.target_system ?? '') !== null;
    return rows.map((r) => {
      const before = r.before === null ? null : JSON.parse(this.engineDb.dec(r.before)) as BeforeImage;
      const after: unknown = r.after_planned === null ? null : JSON.parse(this.engineDb.dec(r.after_planned));
      const prior = before !== null && !before.absent ? before.value : null;
      const sentUnchanged = external && prior !== null && typeof prior === 'object' && after !== null && typeof after === 'object'
        ? Object.keys(after).sort().filter((f) => canonicalJson((prior as Record<string, unknown>)[f]) === canonicalJson((after as Record<string, unknown>)[f]))
        : undefined;
      return {
        seq: r.seq, key: this.engineDb.dec(r.target_key), change: r.change, undo: r.undo, before, after,
        diff: before === null ? { kind: 'none' } : diffTarget(before, after),
        error: r.error,
        ...(sentUnchanged !== undefined ? { sentUnchanged } : {}),
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
      `SELECT SUM(error = 'conflict') AS conflicts, SUM(undone_at IS NOT NULL) AS undone,
         SUM(change != 'invalid' AND before IS NULL) AS unread FROM bulk_targets WHERE run_id = ?`,
    ).get(row.id) as { conflicts: number | null; undone: number | null; unread: number | null };
    return {
      id: row.id, createdAt: row.created_at, targetSystem: row.target_system, phase: row.phase, undo: row.undo,
      total: row.targets_total, unread: row.phase === 'planned' ? outcome.unread ?? 0 : 0, changes, invalidReasons,
      applied: row.targets_applied, failed: row.targets_failed,
      conflicts: outcome.conflicts ?? 0, undone: outcome.undone ?? 0,
      kind: row.kind, atomic: row.atomic === 1, sourceRunId: row.source_run_id,
      writeMethod: externalHostOf(row.target_system) === null ? null : parseContractMethods(row.contract_json),
      probeConfirmed: this.probeHolds(row),
      checksumBinding: this.engineDb.hashIsKeyed ? 'keyed' : 'unkeyed',
      haltReason: row.halt_reason,
    };
  }

  private runRow(runId: string): RunRow | undefined {
    return this.engineDb.getDb().prepare('SELECT * FROM bulk_runs WHERE id = ?').get(runId) as RunRow | undefined;
  }

  // ── Approval ────────────────────────────────────────────────────────────────

  /**
   * The approval checksum (PRD §3.1 `approval_checksum`): a digest over everything
   * an apply would do — the run's kind, system, collection, atomicity and source run,
   * and per target its key, change, before-image and planned after-state, in seq order.
   * The owner's view shows it, approving has to present it, and the effect recomputes
   * it before it writes: a ledger that changed after approval is refused, not applied.
   * It binds only with a vault key (HMAC); without one it is plain SHA-256, and the
   * status says so ({@link BulkRunStatus.checksumBinding}).
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
      // Only where there is one, so a local run's digest is what it was before contracts
      // existed — an approved run must not halt on an upgrade.
      if (run!.contract_json !== null) {
        yield 'contract';
        yield run!.contract_json;
      }
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

  /** The key of the run's first writing target, or null. For the approval route's check
   *  that an external run can reach its host — a key only, never a value. */
  firstWritingKey(runId: string): string | null {
    const r = this.engineDb.getDb().prepare(
      `SELECT target_key FROM bulk_targets WHERE run_id = ? AND change IN ${WRITING_CHANGES} ORDER BY seq LIMIT 1`,
    ).get(runId) as { target_key: string } | undefined;
    return r ? this.engineDb.dec(r.target_key) : null;
  }

  /**
   * Whether this run may write more than one target: a local run always; an external one
   * only once its host and write verb have a probe the owner confirmed ({@link confirmProbe}).
   * No provider documents whether its update verb keeps the fields a write does not send.
   * If it does not, every target of a wide run loses them, and the undo cannot bring them
   * back — it knows only the fields it wrote.
   */
  private probeHolds(run: RunRow): boolean {
    const host = externalHostOf(run.target_system);
    if (host === null) return true;
    const method = parseContractMethods(run.contract_json);
    const kinds = [...new Set(parseContractPaths(run.contract_json).map(resourceKindOf))];
    if (method === null || kinds.length === 0) return false;
    // Every kind of resource the run writes needs its own probe.
    const probed = this.engineDb.getDb().prepare('SELECT 1 FROM bulk_host_probes WHERE host = ? AND method = ? AND kind = ?');
    return kinds.every((kind) => probed.get(host, method, kind) !== undefined);
  }

  /**
   * The owner confirms a probe: an external apply run wrote exactly one target with its
   * verb, and the owner checked on the provider's side that the target kept the fields the
   * write did not send. From then on runs to that host with that verb, over targets of that
   * kind ({@link resourceKindOf}), may be approved or resumed for more than one target. A
   * target found already holding its value was not written and proves nothing, so it does
   * not count.
   */
  confirmProbe(runId: string, params: { confirmedBy?: string | undefined; now?: number | undefined } = {}):
    { ok: true } | { ok: false; reason: 'not_found' | 'not_a_probe' } {
    const run = this.runRow(runId);
    if (!run) return { ok: false, reason: 'not_found' };
    const host = externalHostOf(run.target_system);
    const method = parseContractMethods(run.contract_json);
    if (host === null || method === null || run.kind !== 'apply') return { ok: false, reason: 'not_a_probe' };
    const stopped = run.phase === 'done' || (run.phase === 'writing' && run.halt_reason !== null);
    const applied = (this.engineDb.getDb().prepare(
      'SELECT target_key, result FROM bulk_targets WHERE run_id = ? AND applied_at IS NOT NULL',
    ).all(runId) as { target_key: string; result: string | null }[]);
    const only = applied[0];
    if (!stopped || applied.length !== 1 || !only || only.result === null || this.engineDb.dec(only.result) !== 'written') {
      return { ok: false, reason: 'not_a_probe' };
    }
    const kind = resourceKindOf(new URL(this.engineDb.dec(only.target_key)).pathname);
    this.engineDb.getDb().prepare(
      `INSERT INTO bulk_host_probes (host, method, kind, run_id, confirmed_by, confirmed_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (host, method, kind) DO UPDATE SET run_id = excluded.run_id, confirmed_by = excluded.confirmed_by, confirmed_at = excluded.confirmed_at`,
    ).run(host, method, kind, runId, params.confirmedBy ?? null, new Date(params.now ?? Date.now()).toISOString());
    return { ok: true };
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
    | { ok: false; reason: 'not_found' | 'wrong_phase' | 'checksum' | 'nothing_to_apply' | 'bad_max_targets' | 'probe_required' | UndoRefusal } {
    const run = this.runRow(runId);
    if (!run) return { ok: false, reason: 'not_found' };
    if (run.phase !== 'previewed') return { ok: false, reason: 'wrong_phase' };
    if (params.checksum !== this.computeChecksum(runId)) return { ok: false, reason: 'checksum' };
    const writing = this.countWriting(runId);
    if (writing === 0) return { ok: false, reason: 'nothing_to_apply' };
    const maxTargets = params.maxTargets ?? writing;
    if (!Number.isInteger(maxTargets) || maxTargets < 1 || maxTargets > writing) return { ok: false, reason: 'bad_max_targets' };
    if (maxTargets > 1 && !this.probeHolds(run)) return { ok: false, reason: 'probe_required' };
    // An atomic run capped below its size could only ever stop half written.
    if (run.atomic === 1 && maxTargets !== writing) return { ok: false, reason: 'bad_max_targets' };
    const now = params.now ?? Date.now();
    const db = this.engineDb.getDb();
    let triggerId = '';
    const moved = db.transaction((): UndoRefusal | boolean => {
      // In the same transaction as the arming, and an IMMEDIATE one: it takes the write lock
      // before the check, so an approve or resume of another run of the family in another
      // process waits for this one and then sees it, instead of checking a state this one is
      // about to change. (A deferred transaction would let both check, and fail the one that
      // checked first and writes last with SQLITE_BUSY_SNAPSHOT instead of a refusal.)
      const blocked = this.writeBlocked(run);
      if (blocked !== null) return blocked;
      const res = db.prepare(
        `UPDATE bulk_runs SET phase = 'approved', approved_by = ?, approved_at = ?, approval_checksum = ?,
           max_targets = ?, expires_at = ?, halt_reason = NULL
         WHERE id = ? AND phase = 'previewed'`,
      ).run(params.approvedBy ?? null, new Date(now).toISOString(), params.checksum, maxTargets,
        this.approvalWindow(writing, now), runId);
      if (res.changes !== 1) return false;
      // An external run's preview is over once it is approved; its trigger must not fire
      // again into a run that is no longer planned.
      new TriggerStore(this.engineDb).remove(bulkPreviewTriggerId(runId));
      triggerId = this.armTrigger(run, now);
      return true;
    }).immediate();
    if (typeof moved === 'string') return { ok: false, reason: moved };
    if (!moved) return { ok: false, reason: 'wrong_phase' };
    return { ok: true, status: this.getStatus(runId)!, triggerId };
  }

  /**
   * Resume an approved run that stopped (a halt, an expired window, a loop that died):
   * a fresh human confirmation of the same approval. The checksum must still match the
   * one approved; the window restarts, the halt clears, failed and conflicting targets
   * are retried, and the trigger is due again.
   */
  resume(runId: string, params: { checksum: string; maxTargets?: number | undefined; now?: number | undefined }):
    { ok: true; status: BulkRunStatus; triggerId: string }
    | { ok: false; reason: 'not_found' | 'wrong_phase' | 'checksum' | 'bad_max_targets' | 'probe_required' | UndoRefusal } {
    const run = this.runRow(runId);
    if (!run) return { ok: false, reason: 'not_found' };
    if (run.phase !== 'approved' && run.phase !== 'writing') return { ok: false, reason: 'wrong_phase' };
    if (params.checksum !== run.approval_checksum || params.checksum !== this.computeChecksum(runId)) {
      return { ok: false, reason: 'checksum' };
    }
    // A resume may widen the cap — after a confirmed probe, the way from one target to N.
    let maxTargets = run.max_targets;
    if (params.maxTargets !== undefined) {
      const writing = this.countWriting(runId);
      maxTargets = params.maxTargets;
      if (!Number.isInteger(maxTargets) || maxTargets < 1 || maxTargets > writing) return { ok: false, reason: 'bad_max_targets' };
      if (run.atomic === 1 && maxTargets !== writing) return { ok: false, reason: 'bad_max_targets' };
      if (maxTargets > 1 && !this.probeHolds(run)) return { ok: false, reason: 'probe_required' };
    }
    const now = params.now ?? Date.now();
    const db = this.engineDb.getDb();
    let triggerId = '';
    const moved = db.transaction((): UndoRefusal | boolean => {
      const blocked = this.writeBlocked(run);
      if (blocked !== null) return blocked;
      const res = db.prepare(
        `UPDATE bulk_runs SET halt_reason = NULL, expires_at = ?, targets_failed = 0, max_targets = ?
         WHERE id = ? AND phase IN ('approved','writing')`,
      ).run(this.approvalWindow(this.countWriting(runId), now), maxTargets, runId);
      if (res.changes !== 1) return false;
      db.prepare('UPDATE bulk_targets SET error = NULL, claimed_at = NULL WHERE run_id = ? AND applied_at IS NULL AND error IS NOT NULL')
        .run(runId);
      triggerId = this.armTrigger(run, now);
      return true;
    }).immediate();
    if (typeof moved === 'string') return { ok: false, reason: moved };
    if (!moved) return { ok: false, reason: 'wrong_phase' };
    return { ok: true, status: this.getStatus(runId)!, triggerId };
  }

  /**
   * Why a run may not be approved or resumed now, or null. A run, its undos, their undos and
   * so on — one family, linked by `source_run_id` — write the same targets in opposite
   * directions, so no run is started while another of its family may write:
   *  - an undo waits while its source may write (`source_running`), any run while another
   *    run of its family may (`undo_open`);
   *  - an undo whose plan misses a target its source has applied since the planning would
   *    finish, report the source undone, and leave that target written (`undo_stale`). An undo
   *    of a source already undone is refused the same way: there is nothing left for it in the
   *    source's rows, and taking back what an undo of the later undo wrote again is that undo's
   *    job. (A source only partly taken back by another undo is not refused: each target is
   *    still checked against the state the source wrote, so nothing is overwritten unseen.)
   *
   * "May write" means approved or writing and NOT halted. Two states are left out
   * on purpose, and each would look like a gap to a reader who does not know why:
   *  - A previewed undo holds nothing. No route discards a previewed run and the prune takes
   *    only apply runs, so an undo that is never approved would hold its source for good.
   *    The window it leaves closes at its approval: this check runs there, and `undo_stale`
   *    refuses a plan the source has written past.
   *  - A halted undo holds nothing either, for the same reason: it may never be resumed (an
   *    expired window, a checksum halt), and nothing withdraws it. When it is resumed, this
   *    check runs again.
   *
   * A guard whose precondition fails together with the thing it guards against would hold the
   * family still for good after a crash — a live claim left by a dead loop, say. So it reads
   * only states a human can move on (approve, resume), never one only a lost process could.
   *
   * What it does not cover: a second loop on the same run. The product runs one loop per run
   * (one trigger, and a lease across engine processes); a second one exists only when two
   * engines share one data directory, and a halt set by one loop does not stop the other's
   * write in flight.
   */
  private writeBlocked(run: RunRow): UndoRefusal | null {
    const open = this.openInFamily(run.id, run.id);
    if (open !== null) return open === run.source_run_id ? 'source_running' : 'undo_open';
    if (run.kind !== 'undo' || run.source_run_id === null) return null;
    const src = this.runRow(run.source_run_id);
    if (!src) return null;
    if (src.phase === 'undone') return 'undo_stale';
    const missing = this.engineDb.getDb().prepare(
      `SELECT COUNT(*) AS n FROM bulk_targets WHERE run_id = ? AND ${undoEligible(externalHostOf(src.target_system) !== null)}
         AND seq NOT IN (SELECT source_seq FROM bulk_targets WHERE run_id = ? AND source_seq IS NOT NULL)`,
    ).get(src.id, run.id) as { n: number };
    return missing.n > 0 ? 'undo_stale' : null;
  }

  /**
   * A run of `runId`'s family, other than `exceptRunId`, that is approved or writing and not
   * halted — its id, or null. The family is every run reached from the first one of the chain
   * (followed up by `source_run_id`) by following `source_run_id` down.
   */
  private openInFamily(runId: string, exceptRunId: string | null): string | null {
    let root = runId;
    const seen = new Set<string>();
    for (;;) {
      seen.add(root);
      const up = this.runRow(root)?.source_run_id ?? null;
      if (up === null || seen.has(up)) break;
      root = up;
    }
    const row = this.engineDb.getDb().prepare(
      `WITH RECURSIVE fam(id) AS (SELECT ? UNION SELECT r.id FROM bulk_runs r JOIN fam ON r.source_run_id = fam.id)
       SELECT b.id FROM bulk_runs b JOIN fam ON b.id = fam.id
       WHERE b.phase IN ('approved','writing') AND b.halt_reason IS NULL AND b.id IS NOT ? LIMIT 1`,
    ).get(root, exceptRunId) as { id: string } | undefined;
    return row?.id ?? null;
  }

  /**
   * Plan the undo of a run (PRD §3.5): a NEW run, previewed, over the targets the source
   * applied and nobody took back since — for an external run also those whose write failed,
   * see {@link undoEligible} — in reverse order. Each undo target expects the
   * state the source wrote and writes the source's before-image back — or removes what
   * the source created. It is approved like any run (a second approval), and its effect
   * finds a target someone else changed in between by that expectation: a conflict,
   * shown, not overwritten. An undo of an undo is the same mechanism.
   */
  planUndo(sourceRunId: string, params: { createdBy?: string | undefined } = {}):
    { ok: true; status: BulkRunStatus } | { ok: false; reason: 'not_found' | 'not_undoable' | 'nothing_to_undo' | 'atomic_partial' | 'undo_open' } {
    const src = this.runRow(sourceRunId);
    if (!src) return { ok: false, reason: 'not_found' };
    if (!isStopped(src)) return { ok: false, reason: 'not_undoable' };
    // An undo beside another run of the family that may write would write the same targets.
    if (this.openInFamily(sourceRunId, null) !== null) return { ok: false, reason: 'undo_open' };
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
      `SELECT seq, target_key, change, before, after_planned, after_actual FROM bulk_targets
       WHERE run_id = ? AND ${undoEligible(externalHostOf(src.target_system) !== null)}
       ORDER BY seq DESC`,
    ).all(sourceRunId) as { seq: number; target_key: string; change: BulkChange; before: string | null; after_planned: string | null; after_actual: string | null }[];
    if (rows.length === 0) return { ok: false, reason: 'nothing_to_undo' };

    const planned = rows.map((r) => {
      const t = this.toApplyTarget({ ...r, source_seq: null });
      // An external target is expected to hold what the host kept of the write, read back
      // after it — not what was sent (build plan B §2.4). Local targets hold what was sent.
      const actual = r.after_actual === null ? null : JSON.parse(this.engineDb.dec(r.after_actual)) as ActualImage;
      const expected: BeforeImage = actual === null ? t.after : { absent: false, value: actual.value };
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
      // The undo writes the same host and paths as its source, under the same contract.
      db.prepare(
        `INSERT INTO bulk_runs (id, created_by, rule_hash, target_system, undo, phase, targets_total, atomic, kind,
           source_run_id, target_collection, contract_json)
         VALUES (?, ?, ?, ?, ?, 'previewed', ?, ?, 'undo', ?, ?, ?)`,
      ).run(id, params.createdBy ?? null, this.engineDb.keyedHash(hashParts()), src.target_system, runUndo,
        planned.length, src.atomic, sourceRunId, src.target_collection, src.contract_json);
      planned.forEach((t, seq) => {
        insertTarget.run(
          id, seq, this.engineDb.enc(t.key), t.change, undoFor(t.expected),
          this.engineDb.enc(JSON.stringify(t.expected)),
          t.after.absent ? null : this.engineDb.enc(JSON.stringify(t.after.value ?? null)),
          t.sourceSeq,
        );
      });
      this.pruneUnapproved();
    })();
    return { ok: true, status: this.getStatus(id)! };
  }

  // ── The preview effect's reads and writes (bulk-preview.ts) ─────────────────

  getRunForPreview(runId: string): BulkRunForPreview | null {
    const r = this.runRow(runId);
    if (!r) return null;
    return { id: r.id, kind: r.kind, targetSystem: r.target_system, phase: r.phase, haltReason: r.halt_reason, contractJson: r.contract_json };
  }

  /** Targets the preview has still to read, in seq order. A target read before — by an
   *  earlier tick, or another loop — is not read again (plan §6 Q7). */
  listUnread(runId: string): number[] {
    // A target whose read failed once comes last, so it cannot hold up the others.
    return (this.engineDb.getDb().prepare(
      `SELECT seq FROM bulk_targets WHERE run_id = ? AND change != 'invalid' AND before IS NULL
       ORDER BY error IS NOT NULL, seq`,
    ).all(runId) as { seq: number }[]).map((r) => r.seq);
  }

  /** An unread external target: its URL and planned after-state. */
  loadExternalTarget(runId: string, seq: number): { key: string; after: ExternalImage } | null {
    const r = this.engineDb.getDb().prepare(
      `SELECT target_key, after_planned FROM bulk_targets WHERE run_id = ? AND seq = ? AND change != 'invalid' AND before IS NULL`,
    ).get(runId, seq) as { target_key: string; after_planned: string | null } | undefined;
    if (!r || r.after_planned === null) return null;
    return { key: this.engineDb.dec(r.target_key), after: JSON.parse(this.engineDb.dec(r.after_planned)) as ExternalImage };
  }

  /**
   * Record what the preview read for one target: its before-image over F and the change
   * that follows, or why it cannot be planned. Only while the run is still `planned` and
   * the target unread, so a run that was dropped, or a target another loop read, is not
   * written twice.
   */
  recordRead(runId: string, seq: number, read: { before: Record<string, unknown> } | { invalid: BulkInvalidReason }): boolean {
    const db = this.engineDb.getDb();
    const guard = `run_id = ? AND seq = ? AND change != 'invalid' AND before IS NULL
      AND EXISTS (SELECT 1 FROM bulk_runs WHERE id = ? AND phase = 'planned' AND halt_reason IS NULL)`;
    if ('invalid' in read) {
      return db.prepare(`UPDATE bulk_targets SET change = 'invalid', undo = NULL, error = ? WHERE ${guard}`)
        .run(read.invalid, runId, seq, runId).changes === 1;
    }
    const row = db.prepare('SELECT after_planned FROM bulk_targets WHERE run_id = ? AND seq = ?').get(runId, seq) as { after_planned: string | null } | undefined;
    if (!row || row.after_planned === null) return false;
    const before: BeforeImage = { absent: false, value: read.before };
    // The before-image holds exactly F, so comparing whole images compares over F (§6 P4).
    const change = classifyChange(before, JSON.parse(this.engineDb.dec(row.after_planned)) as unknown);
    return db.prepare(`UPDATE bulk_targets SET before = ?, change = ?, error = NULL WHERE ${guard}`)
      .run(this.engineDb.enc(JSON.stringify(before)), change, runId, seq, runId).changes === 1;
  }

  /**
   * A read that failed on the host's side (5xx, a timeout, a broken connection). The first
   * leaves the target unread, marked, to be read again after the others; the second makes
   * it `invalid` (`read_failed`). Returns what it did, or null when the run or target has
   * moved on.
   */
  recordReadFailure(runId: string, seq: number): 'retry' | 'invalid' | null {
    const db = this.engineDb.getDb();
    return db.transaction((): 'retry' | 'invalid' | null => {
      const row = db.prepare(
        `SELECT error FROM bulk_targets WHERE run_id = ? AND seq = ? AND change != 'invalid' AND before IS NULL
           AND EXISTS (SELECT 1 FROM bulk_runs WHERE id = ? AND phase = 'planned' AND halt_reason IS NULL)`,
      ).get(runId, seq, runId) as { error: string | null } | undefined;
      if (!row) return null;
      if (row.error === null) {
        db.prepare(`UPDATE bulk_targets SET error = 'read_failed' WHERE run_id = ? AND seq = ?`).run(runId, seq);
        return 'retry';
      }
      db.prepare(`UPDATE bulk_targets SET change = 'invalid', undo = NULL, error = 'read_failed' WHERE run_id = ? AND seq = ?`).run(runId, seq);
      return 'invalid';
    })();
  }

  /** Halt a preview that is still reading, keeping a reason already set. */
  haltPreview(runId: string, reason: BulkHaltReason): void {
    this.engineDb.getDb().prepare(
      `UPDATE bulk_runs SET halt_reason = ? WHERE id = ? AND phase = 'planned' AND halt_reason IS NULL`,
    ).run(reason, runId);
  }

  /**
   * Close a preview: `planned` → `previewed`, and only when every target that is not
   * invalid holds a before-image (plan §6 Q4). A run approved with a target it never read
   * would compare that target against nothing. False when the run is not ready.
   */
  finishPreview(runId: string): boolean {
    const db = this.engineDb.getDb();
    return db.transaction((): boolean => {
      const unread = db.prepare(
        `SELECT COUNT(*) AS n FROM bulk_targets WHERE run_id = ? AND change != 'invalid' AND before IS NULL`,
      ).get(runId) as { n: number };
      if (unread.n > 0) return false;
      const valid = db.prepare(`SELECT COUNT(*) AS n FROM bulk_targets WHERE run_id = ? AND change != 'invalid'`).get(runId) as { n: number };
      return db.prepare(
        `UPDATE bulk_runs SET phase = 'previewed', undo = ? WHERE id = ? AND phase = 'planned' AND halt_reason IS NULL`,
      ).run(valid.n > 0 ? 'restorable' : 'none', runId).changes === 1;
    })();
  }

  /**
   * Start a planned run's read, or start it again after a halt (plan §6 Q5): the owner's
   * route clears the halt — the start gate included — and the preview trigger is due at
   * once. Targets already read stay read.
   */
  resumePreview(runId: string, now: number = Date.now()):
    { ok: true; status: BulkRunStatus; triggerId: string } | { ok: false; reason: 'not_found' | 'wrong_phase' | 'external_in_progress' } {
    const run = this.runRow(runId);
    if (!run) return { ok: false, reason: 'not_found' };
    if (run.phase !== 'planned' || run.halt_reason === null) return { ok: false, reason: 'wrong_phase' };
    const db = this.engineDb.getDb();
    let triggerId = '';
    const moved = db.transaction((): 'moved' | 'busy' | 'gone' => {
      // The ordering rule is decided here, where a read starts — plans land halted, so
      // at plan time nothing is reading yet.
      const reading = db.prepare(
        `SELECT COUNT(*) AS n FROM bulk_runs WHERE phase = 'planned' AND halt_reason IS NULL
           AND target_system LIKE 'http:%' AND id != ?`,
      ).get(runId) as { n: number };
      if (reading.n > 0) return 'busy';
      const res = db.prepare(`UPDATE bulk_runs SET halt_reason = NULL WHERE id = ? AND phase = 'planned' AND halt_reason IS NOT NULL`).run(runId);
      if (res.changes !== 1) return 'gone';
      triggerId = this.armPreviewTrigger(runId, now);
      return 'moved';
    })();
    if (moved === 'busy') return { ok: false, reason: 'external_in_progress' };
    if (moved !== 'moved') return { ok: false, reason: 'wrong_phase' };
    return { ok: true, status: this.getStatus(runId)!, triggerId };
  }

  // ── The effect loop's reads and writes (bulk-apply.ts) ──────────────────────

  getRunForApply(runId: string): BulkRunForApply | null {
    const r = this.runRow(runId);
    if (!r) return null;
    return {
      id: r.id, kind: r.kind, targetSystem: r.target_system, targetCollection: r.target_collection,
      atomic: r.atomic === 1, phase: r.phase, approvalChecksum: r.approval_checksum, maxTargets: r.max_targets,
      expiresAt: r.expires_at, applied: r.targets_applied, failed: r.targets_failed, haltReason: r.halt_reason,
      sourceRunId: r.source_run_id, contractJson: r.contract_json,
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
  recordApplied(
    run: Pick<BulkRunForApply, 'id' | 'kind' | 'sourceRunId'>, seq: number, result: string, now: number = Date.now(),
    actual: ActualImage | null = null,
  ): void {
    const db = this.engineDb.getDb();
    const at = new Date(now).toISOString();
    db.transaction(() => {
      // `result` through enc() too: for an external target it is the host's own answer
      // class, and nothing about a target is stored in clear.
      const res = db.prepare(
        'UPDATE bulk_targets SET applied_at = ?, result = ?, after_actual = ?, claimed_at = NULL WHERE run_id = ? AND seq = ? AND applied_at IS NULL',
      ).run(at, this.engineDb.enc(result), actual === null ? null : this.engineDb.enc(JSON.stringify(actual)), run.id, seq);
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

  /** Give a claimed target back unwritten, for a loop that stops before writing it. */
  releaseClaim(runId: string, seq: number): void {
    this.engineDb.getDb().prepare('UPDATE bulk_targets SET claimed_at = NULL WHERE run_id = ? AND seq = ? AND applied_at IS NULL')
      .run(runId, seq);
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
   * source becomes `undone` once none of what an undo takes back ({@link undoEligible}) is
   * left standing.
   */
  finish(run: Pick<BulkRunForApply, 'id' | 'kind' | 'sourceRunId'>): void {
    const db = this.engineDb.getDb();
    db.transaction(() => {
      db.prepare(`UPDATE bulk_runs SET phase = 'done' WHERE id = ? AND phase = 'writing'`).run(run.id);
      if (run.kind !== 'undo' || run.sourceRunId === null) return;
      const src = this.runRow(run.sourceRunId);
      if (!src) return;
      // Standing is what an undo takes back and has not: for an external source that includes
      // a failed write the undo could not restore (a conflict, or a failed write of its own) —
      // it may hold what the source wrote, so the source is not reported undone.
      const standing = db.prepare(
        `SELECT COUNT(*) AS n FROM bulk_targets WHERE run_id = ? AND ${undoEligible(externalHostOf(src.target_system) !== null)}`,
      ).get(run.sourceRunId) as { n: number };
      if (standing.n === 0) {
        db.prepare(`UPDATE bulk_runs SET phase = 'undone' WHERE id = ? AND phase IN ('done','aborted','writing')`).run(run.sourceRunId);
      }
    })();
  }
}
