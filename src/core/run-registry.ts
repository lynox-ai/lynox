/**
 * Run registry — a client-queryable, restart-survivable record of which thread
 * has a live chat run, independent of the SSE connection.
 *
 * Today liveness lives only in the in-memory `runningSessions` map in the HTTP
 * layer, exposed as a bare count (`active_sessions`). On reload the SSE dies and
 * the client goes blind to the still-running run. This registry mirrors run
 * status to SQLite (shared run-history DB) so:
 *   - `GET /api/runs/active` can report per-thread run state (nav indicator),
 *   - a clean boot can mark runs that were live at crash/restart `interrupted`
 *     (a restart kills the in-flight run — there is no cross-restart resume;
 *     the client shows an interrupted banner + Retry).
 *
 * Tier 1 keeps the run executing inside the HTTP handler; the registry is an
 * additive status mirror wired alongside `runningSessions`. Tier 2 moves
 * execution onto a background RunExecutor that owns these same registry calls.
 *
 * No PII is stored — status, seqs and timestamps only. The `*_seq` columns
 * default 0 and are populated once the resumable event buffer lands (Tier 2).
 */

import type Database from 'better-sqlite3';

// ── Types ────────────────────────────────────────────────────────────────────

/** Live (running/awaiting_input) or interrupted. done/error rows are removed
 * from the registry — the durable transcript lives in thread_messages. */
export type RunStatus = 'running' | 'awaiting_input' | 'done' | 'error' | 'interrupted';

/** A registry row. `threadId === sessionId`. */
export interface RunRecord {
  run_id: string;
  thread_id: string;
  status: RunStatus;
  started_at: string;
  last_activity: string;
  last_event_seq: number;
  last_persisted_seq: number;
  updated_at: string;
}

// ── Registry ─────────────────────────────────────────────────────────────────

export class RunRegistry {
  private readonly db: Database.Database;

  private _stmtClearThread: Database.Statement | undefined;
  private _stmtInsert: Database.Statement | undefined;
  private _stmtTouch: Database.Statement | undefined;
  private _stmtRemove: Database.Statement | undefined;
  private _stmtGetActive: Database.Statement | undefined;
  private _stmtGetByRun: Database.Statement | undefined;
  private _stmtSweep: Database.Statement | undefined;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /** Register a fresh run for a thread as `running`. Atomically clears any prior
   * row for the same thread first — Tier 1 is single-run-per-session (the HTTP
   * 409 guard), so a leftover interrupted/stale row for the thread (e.g. the one
   * the user is retrying) must be replaced, not duplicated. The live
   * `awaiting_input` status is derived at read time from a pending prompt, so it
   * is not stored here. */
  start(threadId: string, runId: string): void {
    const tx = this.db.transaction((tid: string, rid: string) => {
      this._getClearThreadStmt().run(tid);
      this._getInsertStmt().run(rid, tid);
    });
    tx(threadId, runId);
  }

  /** Bump last_activity (and optionally the event/persisted seqs) so stale-run
   * detection and replay-checkpoint alignment stay accurate. Called on every
   * emitted event in Tier 2; on coarse events (start/prompt/heartbeat) in Tier 1. */
  touch(runId: string, seqs?: { lastEventSeq?: number; lastPersistedSeq?: number }): void {
    this._getTouchStmt().run(
      seqs?.lastEventSeq ?? null,
      seqs?.lastPersistedSeq ?? null,
      runId,
    );
  }

  /** Remove a run from the registry — used for terminal completion (done/error)
   * and to dismiss an interrupted run once the client has acked/retried it. The
   * transcript persists in thread_messages regardless. Idempotent. */
  remove(runId: string): void {
    this._getRemoveStmt().run(runId);
  }

  /** Mark every run still `running`/`awaiting_input` as `interrupted`. Called
   * once at engine boot: any such row is a run that was live when the previous
   * process died (a restart kills in-flight work). Returns the count swept. */
  sweepInterrupted(): number {
    return this._getSweepStmt().run().changes;
  }

  /** All registry rows for the nav indicator: live runs (running/awaiting_input)
   * plus interrupted runs the client must surface. done/error are already gone. */
  getActive(): RunRecord[] {
    return this._getGetActiveStmt().all() as RunRecord[];
  }

  getByRunId(runId: string): RunRecord | undefined {
    return this._getGetByRunStmt().get(runId) as RunRecord | undefined;
  }

  // ── Prepared statements ─────────────────────────────────────────────────

  private _getClearThreadStmt(): Database.Statement {
    return (this._stmtClearThread ??= this.db.prepare(`DELETE FROM active_runs WHERE thread_id = ?`));
  }

  private _getInsertStmt(): Database.Statement {
    return (this._stmtInsert ??= this.db.prepare(`
      INSERT INTO active_runs (run_id, thread_id, status, started_at, last_activity, updated_at)
      VALUES (?, ?, 'running', datetime('now'), datetime('now'), datetime('now'))
    `));
  }

  private _getTouchStmt(): Database.Statement {
    // COALESCE keeps the existing seq when the caller passes null (Tier-1
    // activity bumps that don't carry a buffer seq yet).
    return (this._stmtTouch ??= this.db.prepare(`
      UPDATE active_runs
      SET last_activity = datetime('now'),
          last_event_seq = COALESCE(?, last_event_seq),
          last_persisted_seq = COALESCE(?, last_persisted_seq),
          updated_at = datetime('now')
      WHERE run_id = ?
    `));
  }

  private _getRemoveStmt(): Database.Statement {
    return (this._stmtRemove ??= this.db.prepare(`DELETE FROM active_runs WHERE run_id = ?`));
  }

  private _getSweepStmt(): Database.Statement {
    return (this._stmtSweep ??= this.db.prepare(`
      UPDATE active_runs
      SET status = 'interrupted', updated_at = datetime('now')
      WHERE status IN ('running', 'awaiting_input')
    `));
  }

  private _getGetActiveStmt(): Database.Statement {
    return (this._stmtGetActive ??= this.db.prepare(`
      SELECT * FROM active_runs ORDER BY started_at DESC
    `));
  }

  private _getGetByRunStmt(): Database.Statement {
    return (this._stmtGetByRun ??= this.db.prepare(`SELECT * FROM active_runs WHERE run_id = ?`));
  }
}
