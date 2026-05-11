// === Inbox cold-start tracker ===
//
// In-memory book-keeping for cold-start runs so the UI can render a
// progress banner without scraping logs. The tracker is a thin layer on
// top of `runColdStart`'s `onProgress` callback — it stores the latest
// snapshot per account and retains completed reports for a short TTL so
// a freshly-loaded UI tab can still show "Imported N threads · est. $X".
//
// State is process-local. A restart loses in-flight progress, which is
// acceptable: the actual classifier queue is durable (SQLite) and a
// dropped banner only costs the user one re-render.

import type { ColdStartProgress, ColdStartReport } from './cold-start.js';

/** How long completed reports linger in `getSnapshot().recent`. */
const DEFAULT_RECENT_TTL_MS = 5 * 60_000;

export type ColdStartStatus = 'running' | 'completed' | 'failed';

export interface ColdStartActiveEntry {
  accountId: string;
  status: Extract<ColdStartStatus, 'running'>;
  startedAt: string;
  progress: ColdStartProgress | null;
}

export interface ColdStartRecentEntry {
  accountId: string;
  status: Extract<ColdStartStatus, 'completed' | 'failed'>;
  startedAt: string;
  finishedAt: string;
  report: ColdStartReport | null;
  error: string | null;
}

export interface ColdStartSnapshot {
  active: ColdStartActiveEntry[];
  recent: ColdStartRecentEntry[];
}

export interface ColdStartTrackerOptions {
  /** Override the 5-minute retention for completed reports. */
  recentTtlMs?: number;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}

interface ActiveRow {
  startedAt: number;
  progress: ColdStartProgress | null;
}

interface RecentRow {
  status: 'completed' | 'failed';
  startedAt: number;
  finishedAt: number;
  report: ColdStartReport | null;
  error: string | null;
}

export class ColdStartTracker {
  private readonly active = new Map<string, ActiveRow>();
  private readonly recent = new Map<string, RecentRow>();
  private readonly recentTtlMs: number;
  private readonly now: () => number;

  constructor(opts: ColdStartTrackerOptions = {}) {
    this.recentTtlMs = opts.recentTtlMs ?? DEFAULT_RECENT_TTL_MS;
    this.now = opts.now ?? (() => Date.now());
  }

  /** Mark a run as started. Idempotent — re-starting overwrites the row. */
  start(accountId: string): void {
    this.active.set(accountId, { startedAt: this.now(), progress: null });
    this.recent.delete(accountId);
  }

  /**
   * Record a progress snapshot. Lazy-starts the row if `start()` was not
   * called explicitly (e.g. when a caller wires the tracker straight into
   * `runColdStart`'s `onProgress` callback without a wrapper).
   */
  progress(snapshot: ColdStartProgress): void {
    const existing = this.active.get(snapshot.accountId);
    if (existing) {
      existing.progress = snapshot;
    } else {
      this.active.set(snapshot.accountId, {
        startedAt: this.now(),
        progress: snapshot,
      });
    }
  }

  /** Finalize a successful run. Moves the row from active to recent. */
  complete(report: ColdStartReport): void {
    const startedAt = this.active.get(report.accountId)?.startedAt ?? this.now();
    this.active.delete(report.accountId);
    this.recent.set(report.accountId, {
      status: 'completed',
      startedAt,
      finishedAt: this.now(),
      report,
      error: null,
    });
  }

  /** Finalize a failed run. */
  fail(accountId: string, error: string): void {
    const startedAt = this.active.get(accountId)?.startedAt ?? this.now();
    this.active.delete(accountId);
    this.recent.set(accountId, {
      status: 'failed',
      startedAt,
      finishedAt: this.now(),
      report: null,
      error,
    });
  }

  /**
   * Build a JSON-shaped snapshot for the API. Expires completed entries
   * past TTL inline so a stale long-lived tracker self-cleans.
   */
  getSnapshot(): ColdStartSnapshot {
    const cutoff = this.now() - this.recentTtlMs;
    const recent: ColdStartRecentEntry[] = [];
    for (const [accountId, row] of this.recent) {
      if (row.finishedAt < cutoff) {
        this.recent.delete(accountId);
        continue;
      }
      recent.push({
        accountId,
        status: row.status,
        startedAt: new Date(row.startedAt).toISOString(),
        finishedAt: new Date(row.finishedAt).toISOString(),
        report: row.report,
        error: row.error,
      });
    }
    const active: ColdStartActiveEntry[] = [];
    for (const [accountId, row] of this.active) {
      active.push({
        accountId,
        status: 'running',
        startedAt: new Date(row.startedAt).toISOString(),
        progress: row.progress,
      });
    }
    return { active, recent };
  }
}
