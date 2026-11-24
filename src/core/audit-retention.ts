/**
 * How long the actor trail (`audit_log`, see audit-log.ts) keeps what it holds, and the sweep that
 * holds it to that.
 *
 * - Every row is deleted 365 days after its time (`ts`). A day row (below) is deleted 365 days
 *   after the last read it stands for.
 * - Reads on the routes the web UI polls by itself (`INTERFACE_POLLS`) are folded once their day is
 *   more than 30 days past: one row per person, route and day, with the first read's time (`ts`),
 *   the last read's time (`poll_last`) and how many reads it stands for (`poll_count`). No poll is
 *   deleted without such a row. A read the person made themselves is never folded.
 * - A sweep that deletes rows leaves one row of its own (`audit:retention`): the time span of what
 *   it deleted and how many rows, nothing of their content. That row is deleted by the same rule.
 *
 * A day row keeps the id of the first read it stands for, so the trail's order (by id, which the
 * owner's view pages by) does not change. Rows are still never changed: a fold deletes the reads and
 * writes the day row in one transaction, and the trigger that refuses an UPDATE stays.
 */
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { TRAIL_FORM } from './audit-log.js';
import { INTERFACE_POLLS } from './audit-trail-view.js';

const DAY_MS = 24 * 60 * 60_000;
/** How long a row is kept, from its time. */
export const AUDIT_RETENTION_MS = 365 * DAY_MS;
/** How long a poll is kept as a single row before it is folded into its day. */
export const POLL_FOLD_AFTER_MS = 30 * DAY_MS;
/** The action of the row a sweep leaves when it deleted rows. */
export const RETENTION_ACTION = 'audit:retention';
/** The actor of that row: the instance itself, not a person. The owner's view does not read it. */
export const RETENTION_ACTOR = 'retention';

export interface AuditSweepResult {
  /** Poll rows folded into day rows. */
  readonly folded: number;
  /** Day rows written for them. */
  readonly dayRows: number;
  /** Rows deleted for their age. */
  readonly deleted: number;
}

interface FoldGroup {
  readonly actor_kind: string;
  readonly mandate_id: string | null;
  readonly actor_email: string | null;
  readonly actor_display: string | null;
  readonly action: string;
  readonly trail_form: number | null;
  readonly day: string;
  readonly first_id: number;
  readonly first_ts: string;
  readonly last_ts: string;
  readonly n: number;
}

interface FirstRow {
  readonly correlation_id: string;
  readonly run_id: string | null;
  readonly request_id: string | null;
  readonly plan_run: string | null;
}

const POLL_ACTIONS = [...INTERFACE_POLLS];
const POLL_IN = POLL_ACTIONS.map(() => '?').join(', ');

/**
 * Fold the polls whose day is past and delete what is past its time, in one transaction. Throws
 * when the database refuses; nothing is then changed.
 */
export function sweepAuditLog(db: Database.Database, now: number = Date.now()): AuditSweepResult {
  // A day before this one has ended more than 30 days ago, so no poll of it can still arrive.
  const foldBeforeDay = new Date(now - POLL_FOLD_AFTER_MS).toISOString().slice(0, 10);
  const deleteBefore = new Date(now - AUDIT_RETENTION_MS).toISOString();
  return db.transaction((): AuditSweepResult => {
    const { folded, dayRows } = foldPolls(db, foldBeforeDay);
    const deleted = deleteExpired(db, deleteBefore, now);
    return { folded, dayRows, deleted };
  })();
}

function foldPolls(db: Database.Database, foldBeforeDay: string): { folded: number; dayRows: number } {
  if (POLL_ACTIONS.length === 0) return { folded: 0, dayRows: 0 };
  const groups = db.prepare(
    `SELECT actor_kind, mandate_id, actor_email, actor_display, action, trail_form, substr(ts, 1, 10) AS day,
            MIN(id) AS first_id, MIN(ts) AS first_ts, MAX(ts) AS last_ts, COUNT(*) AS n
       FROM audit_log
      WHERE phase = 'read' AND poll_count IS NULL AND action IN (${POLL_IN}) AND ts < ?
      GROUP BY actor_kind, mandate_id, actor_email, actor_display, action, trail_form, day`,
  ).all(...POLL_ACTIONS, foldBeforeDay) as FoldGroup[];
  if (groups.length === 0) return { folded: 0, dayRows: 0 };
  const first = db.prepare('SELECT correlation_id, run_id, request_id, plan_run FROM audit_log WHERE id = ?');
  const remove = db.prepare(
    `DELETE FROM audit_log
      WHERE phase = 'read' AND poll_count IS NULL AND action = ? AND substr(ts, 1, 10) = ? AND ts < ?
        AND actor_kind = ? AND mandate_id IS ? AND actor_email IS ? AND actor_display IS ? AND trail_form IS ?`,
  );
  const insert = db.prepare(
    `INSERT INTO audit_log (id, ts, actor_kind, actor_email, actor_display, mandate_id, action, target, phase, correlation_id,
                            run_id, request_id, recorded_at, plan_run, trail_form, poll_count, poll_last)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'read', ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const recordedAt = new Date().toISOString();
  let folded = 0;
  for (const g of groups) {
    const row = first.get(g.first_id) as FirstRow | undefined;
    if (row === undefined) throw new Error(`audit sweep: row ${String(g.first_id)} vanished during the fold`);
    const gone = remove.run(g.action, g.day, foldBeforeDay, g.actor_kind, g.mandate_id, g.actor_email, g.actor_display, g.trail_form).changes;
    // The group was read in this transaction, so anything else means the query and the delete
    // disagree on which rows they mean; a day row would then miscount, so nothing is written.
    if (gone !== g.n) throw new Error(`audit sweep: folding ${String(g.n)} reads deleted ${String(gone)}`);
    insert.run(
      g.first_id, g.first_ts, g.actor_kind, g.actor_email, g.actor_display, g.mandate_id, g.action, row.correlation_id,
      row.run_id, row.request_id, recordedAt, row.plan_run, g.trail_form, g.n, g.last_ts,
    );
    folded += g.n;
  }
  return { folded, dayRows: groups.length };
}

function deleteExpired(db: Database.Database, deleteBefore: string, now: number): number {
  const where = 'ts < ? AND (poll_last IS NULL OR poll_last < ?)';
  const span = db.prepare(`SELECT COUNT(*) AS n, MIN(ts) AS from_ts, MAX(COALESCE(poll_last, ts)) AS to_ts FROM audit_log WHERE ${where}`)
    .get(deleteBefore, deleteBefore) as { n: number; from_ts: string | null; to_ts: string | null };
  if (span.n === 0) return 0;
  const deleted = db.prepare(`DELETE FROM audit_log WHERE ${where}`).run(deleteBefore, deleteBefore).changes;
  const at = new Date(now).toISOString();
  db.prepare(
    `INSERT INTO audit_log (ts, actor_kind, actor_email, actor_display, mandate_id, action, target, phase, correlation_id,
                            run_id, request_id, recorded_at, plan_run, trail_form)
     VALUES (?, ?, NULL, NULL, NULL, ?, ?, 'done', ?, NULL, NULL, ?, NULL, ?)`,
  ).run(at, RETENTION_ACTOR, RETENTION_ACTION, `${String(deleted)} rows, ${span.from_ts ?? ''}..${span.to_ts ?? ''}`, randomUUID(), at, TRAIL_FORM);
  return deleted;
}
