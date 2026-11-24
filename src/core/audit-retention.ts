/**
 * How long the actor trail (`audit_log`, see audit-log.ts) keeps what it holds, and the sweep that
 * holds it to that.
 *
 * - Every row is deleted 365 days after its time (`ts`). A day row (below) is deleted 365 days
 *   after the last read it stands for.
 * - Reads on the routes in `FOLDED_POLLS` are folded once their day (UTC) is more than 30 days
 *   past: one row per person, route and day, with the first read's time (`ts`), the last read's
 *   time (`poll_last`) and how many reads it stands for (`poll_count`). Before its day row, no poll
 *   is deleted but by the 365-day rule, and then it counts in the retention row like any row.
 *   Every other read, a read the person made themselves among them, stays a single row.
 * - A sweep that deletes rows leaves one row of its own (`audit:retention`): the time span of what
 *   it deleted and how many rows, nothing of their content. That row is deleted by the same rule,
 *   and deleting only such rows leaves no new one.
 *
 * A day row keeps the id of the first read it stands for, so the trail's order (by id, which the
 * owner's view pages by) does not change. Rows are still never changed: a fold deletes the reads and
 * writes the day row in one transaction, and the trigger that refuses an UPDATE stays.
 *
 * Known edges, accepted: at the 365-day boundary a run whose first rows are deleted shows in the
 * owner's view with what is left of it; a person whose name changed within a folded day keeps one
 * day row per name.
 */
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { TRAIL_FORM } from './audit-log.js';

const DAY_MS = 24 * 60 * 60_000;
/** How long a row is kept, from its time. */
export const AUDIT_RETENTION_MS = 365 * DAY_MS;
/** How long a poll is kept as a single row before it is folded into its day. */
export const POLL_FOLD_AFTER_MS = 30 * DAY_MS;
/** Days folded per sweep at most, so a first sweep over a long history does not hold the engine. */
export const FOLD_DAYS_PER_SWEEP = 7;
/** The action of the row a sweep leaves when it deleted rows. */
export const RETENTION_ACTION = 'audit:retention';
/** The actor of that row: the instance itself, not a person. The owner's view does not read it. */
export const RETENTION_ACTOR = 'retention';

/**
 * The routes whose reads are folded by day: the ones the web UI asks by itself and no person opens
 * to read something (the nav's and the status bar's live-run marks, the providers' status). The
 * other routes on `INTERFACE_POLLS` are also opened on purpose (the Tasks view, the cost history)
 * and the row does not record which it was, so their reads stay single rows.
 * `audit-retention.test.ts` holds this list inside `INTERFACE_POLLS`.
 */
export const FOLDED_POLLS: readonly string[] = ['GET /api/runs/active', 'GET /api/providers/status'];

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

const POLL_IN = FOLDED_POLLS.map(() => '?').join(', ');
/** The reads a fold may take; `idx_audit_log_poll_fold` covers exactly these. */
const FOLDABLE = `phase = 'read' AND poll_count IS NULL AND action IN (${POLL_IN})`;

/**
 * Delete what is past its time, then fold the polls of up to `FOLD_DAYS_PER_SWEEP` past days, oldest
 * first; the rest follows on the next sweeps. Each day is its own transaction, and so is the delete.
 * A day the database refuses is left as it was and reported through `onDayFailed`; the days after it
 * are still folded. A refused delete throws, and nothing of the sweep is applied then.
 */
export function sweepAuditLog(
  db: Database.Database,
  now: number = Date.now(),
  onDayFailed: (day: string, err: unknown) => void = () => {},
): AuditSweepResult {
  const deleted = db.transaction(() => deleteExpired(db, new Date(now - AUDIT_RETENTION_MS).toISOString(), now))();
  // A day before this one has ended more than 30 days ago, so no poll of it can still arrive.
  const foldBeforeDay = new Date(now - POLL_FOLD_AFTER_MS).toISOString().slice(0, 10);
  const days = db.prepare(
    `SELECT DISTINCT substr(ts, 1, 10) AS day FROM audit_log WHERE ${FOLDABLE} AND ts < ? ORDER BY day LIMIT ?`,
  ).all(...FOLDED_POLLS, foldBeforeDay, FOLD_DAYS_PER_SWEEP) as Array<{ day: string }>;
  let folded = 0;
  let dayRows = 0;
  for (const { day } of days) {
    try {
      const r = db.transaction(() => foldDay(db, day))();
      folded += r.folded;
      dayRows += r.dayRows;
    } catch (err) {
      onDayFailed(day, err);
    }
  }
  return { folded, dayRows, deleted };
}

/** The ISO bound of the day after `day` (`YYYY-MM-DD`). */
function nextDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + DAY_MS).toISOString().slice(0, 10);
}

function foldDay(db: Database.Database, day: string): { folded: number; dayRows: number } {
  const end = nextDay(day);
  const groups = db.prepare(
    `SELECT actor_kind, mandate_id, actor_email, actor_display, action, trail_form,
            MIN(id) AS first_id, MIN(ts) AS first_ts, MAX(ts) AS last_ts, COUNT(*) AS n
       FROM audit_log
      WHERE ${FOLDABLE} AND ts >= ? AND ts < ?
      GROUP BY actor_kind, mandate_id, actor_email, actor_display, action, trail_form`,
  ).all(...FOLDED_POLLS, day, end) as FoldGroup[];
  const first = db.prepare('SELECT correlation_id, run_id, request_id, plan_run FROM audit_log WHERE id = ?');
  const remove = db.prepare(
    `DELETE FROM audit_log
      WHERE phase = 'read' AND poll_count IS NULL AND action = ? AND ts >= ? AND ts < ?
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
    const gone = remove.run(g.action, day, end, g.actor_kind, g.mandate_id, g.actor_email, g.actor_display, g.trail_form).changes;
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
  const span = db.prepare(
    `SELECT COUNT(*) AS n, SUM(actor_kind = ?) AS own, MIN(ts) AS from_ts, MAX(COALESCE(poll_last, ts)) AS to_ts FROM audit_log WHERE ${where}`,
  ).get(RETENTION_ACTOR, deleteBefore, deleteBefore) as { n: number; own: number | null; from_ts: string | null; to_ts: string | null };
  if (span.n === 0) return 0;
  const deleted = db.prepare(`DELETE FROM audit_log WHERE ${where}`).run(deleteBefore, deleteBefore).changes;
  // Rows that only recorded earlier deletions go without a row of their own: otherwise each would
  // be replaced by a new one every year, for good.
  if (span.own === span.n) return deleted;
  const at = new Date(now).toISOString();
  db.prepare(
    `INSERT INTO audit_log (ts, actor_kind, actor_email, actor_display, mandate_id, action, target, phase, correlation_id,
                            run_id, request_id, recorded_at, plan_run, trail_form)
     VALUES (?, ?, NULL, NULL, NULL, ?, ?, 'done', ?, NULL, NULL, ?, NULL, ?)`,
  ).run(at, RETENTION_ACTOR, RETENTION_ACTION, `${String(deleted)} rows, ${span.from_ts ?? ''}..${span.to_ts ?? ''}`, randomUUID(), at, TRAIL_FORM);
  return deleted;
}
