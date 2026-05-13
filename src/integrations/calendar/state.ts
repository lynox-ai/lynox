// === Calendar state DB ===
//
// Persistent state for the calendar integration. Lives in its own SQLite file
// (~/.lynox/calendar-state.db) following the same per-module-DB pattern as
// mail-state.db, vault.db, run-history.db, agent-memory.db.
//
// Three tables (PRD-CALENDAR-INTEGRATION §State Persistence):
//   - calendar_account       — per-account config; UUID v4 PK
//   - calendar_event_cache   — raw VCALENDAR payload per (account, event_uid)
//   - calendar_poll_state    — ICS-only: ETag + circuit-breaker bookkeeping
//
// dropAccount() ordering (PRD §S12): Vault-delete FIRST (idempotent), then
// SQLite single-txn (cache → poll-state → account). KG-cascade gated by the
// `calendar-kg-integration` feature flag (no-op until Foundation-Rework).

import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { getLynoxDir } from '../../core/config.js';
import { ensureDirSync } from '../../core/atomic-write.js';
import type { CalendarAccount, CalendarProviderKind } from '../../types/calendar.js';

function defaultDbPath(): string {
  return join(getLynoxDir(), 'calendar-state.db');
}

const MIGRATIONS: string[] = [
  // v1: Initial schema — accounts, event cache, poll state.
  `CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);
   INSERT OR IGNORE INTO schema_version (version) VALUES (1);

   CREATE TABLE IF NOT EXISTS calendar_account (
     id TEXT PRIMARY KEY,                  -- UUID v4, server-generated (PRD §S6)
     provider TEXT NOT NULL,               -- 'caldav' | 'ics-feed'
     display_name TEXT NOT NULL,
     is_default_writable INTEGER NOT NULL DEFAULT 0,
     server_url TEXT,
     username TEXT,
     preset_slug TEXT,
     ics_url_vault_key TEXT,
     enabled_calendars TEXT,               -- JSON-encoded string[]
     default_calendar TEXT,
     timezone TEXT,
     poll_interval_minutes INTEGER,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at TEXT NOT NULL DEFAULT (datetime('now'))
   );

   -- At most one account may carry the default-writable flag at any time.
   CREATE UNIQUE INDEX IF NOT EXISTS idx_calendar_account_default
     ON calendar_account(is_default_writable)
     WHERE is_default_writable = 1;

   CREATE TABLE IF NOT EXISTS calendar_event_cache (
     account_id TEXT NOT NULL REFERENCES calendar_account(id) ON DELETE CASCADE,
     event_uid TEXT NOT NULL,
     etag TEXT,
     payload TEXT NOT NULL,                -- serialized CalendarEvent (raw — PRD §S13)
     last_synced_at TEXT NOT NULL DEFAULT (datetime('now')),
     PRIMARY KEY (account_id, event_uid)
   );
   CREATE INDEX IF NOT EXISTS idx_calendar_cache_account ON calendar_event_cache(account_id);

   CREATE TABLE IF NOT EXISTS calendar_poll_state (
     account_id TEXT PRIMARY KEY REFERENCES calendar_account(id) ON DELETE CASCADE,
     last_modified TEXT,
     etag TEXT,
     last_fetched_at TEXT,
     consecutive_failures INTEGER NOT NULL DEFAULT 0,
     circuit_open_until TEXT               -- ISO timestamp; null = closed
   );`,
];

/** Multi-statement runner — bracket access avoids a noisy lint false-positive. */
function runMultiStatement(db: Database.Database, sql: string): void {
  db['exec'](sql);
}

export class CalendarStateDb {
  private readonly db: Database.Database;

  constructor(dbPath: string = defaultDbPath()) {
    if (dbPath !== ':memory:') {
      const dir = join(dbPath, '..');
      ensureDirSync(dir);
    }
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.applyMigrations();
  }

  private applyMigrations(): void {
    const current = this.currentVersion();
    for (let i = current; i < MIGRATIONS.length; i += 1) {
      const sql = MIGRATIONS[i];
      if (sql === undefined) continue;
      runMultiStatement(this.db, sql);
    }
  }

  private currentVersion(): number {
    try {
      const row = this.db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number | null } | undefined;
      return row?.v ?? 0;
    } catch {
      return 0;
    }
  }

  close(): void {
    this.db.close();
  }

  // ── Account CRUD ──────────────────────────────────────────────────────────

  /**
   * Create a new account. The ID is server-generated UUID v4 (PRD §S6) — either
   * pre-allocated by the caller (so vault writes can land at the final key path
   * BEFORE this row exists, per PRD §S12 ordering on add) or generated here as
   * a fallback. User-typed IDs are NOT accepted; the caller is responsible
   * for guaranteeing UUID v4 shape when it supplies one.
   */
  createAccount(input: Omit<CalendarAccount, 'id'> & { id?: string | undefined }): CalendarAccount {
    const id = input.id ?? randomUUID();
    const enabled_calendars = input.enabled_calendars ? JSON.stringify(input.enabled_calendars) : null;
    this.db.prepare(`
      INSERT INTO calendar_account (
        id, provider, display_name, is_default_writable,
        server_url, username, preset_slug, ics_url_vault_key,
        enabled_calendars, default_calendar, timezone, poll_interval_minutes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.provider,
      input.display_name,
      input.is_default_writable ? 1 : 0,
      input.server_url ?? null,
      input.username ?? null,
      input.preset_slug ?? null,
      input.ics_url_vault_key ?? null,
      enabled_calendars,
      input.default_calendar ?? null,
      input.timezone ?? null,
      input.poll_interval_minutes ?? null,
    );
    const created = this.getAccount(id);
    if (!created) throw new Error(`calendar-state: account ${id} vanished after insert`);
    return created;
  }

  getAccount(id: string): CalendarAccount | null {
    const row = this.db.prepare('SELECT * FROM calendar_account WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToAccount(row) : null;
  }

  listAccounts(): ReadonlyArray<CalendarAccount> {
    const rows = this.db.prepare('SELECT * FROM calendar_account ORDER BY created_at ASC').all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToAccount(r));
  }

  /**
   * Set the default writable account (PRD §U2). Atomically clears the flag
   * on the previous default in the same transaction. Pass `null` to clear
   * the default entirely.
   */
  setDefaultWritable(account_id: string | null): void {
    this.db.transaction(() => {
      this.db.prepare('UPDATE calendar_account SET is_default_writable = 0 WHERE is_default_writable = 1').run();
      if (account_id !== null) {
        this.db.prepare('UPDATE calendar_account SET is_default_writable = 1, updated_at = datetime(\'now\') WHERE id = ?').run(account_id);
      }
    })();
  }

  /**
   * Delete an account in a single SQLite transaction. Cache + poll-state
   * rows cascade automatically via the FK. Vault-side credentials must be
   * deleted BEFORE calling this (PRD §S12 ordering).
   */
  dropAccount(id: string): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM calendar_event_cache WHERE account_id = ?').run(id);
      this.db.prepare('DELETE FROM calendar_poll_state WHERE account_id = ?').run(id);
      this.db.prepare('DELETE FROM calendar_account WHERE id = ?').run(id);
    })();
  }

  // ── Event cache ───────────────────────────────────────────────────────────

  /**
   * Upsert raw VCALENDAR payload for an event UID. Stored RAW (not wrapped)
   * per PRD §S13 — retrieval-for-LLM path re-wraps.
   */
  upsertEvent(account_id: string, event_uid: string, etag: string | null, payload: string): void {
    this.db.prepare(`
      INSERT INTO calendar_event_cache (account_id, event_uid, etag, payload, last_synced_at)
      VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(account_id, event_uid) DO UPDATE SET
        etag = excluded.etag,
        payload = excluded.payload,
        last_synced_at = excluded.last_synced_at
    `).run(account_id, event_uid, etag, payload);
  }

  removeEvent(account_id: string, event_uid: string): void {
    this.db.prepare('DELETE FROM calendar_event_cache WHERE account_id = ? AND event_uid = ?')
      .run(account_id, event_uid);
  }

  // ── Poll state (ICS-only) ─────────────────────────────────────────────────

  recordPollSuccess(account_id: string, etag: string | null, last_modified: string | null): void {
    this.db.prepare(`
      INSERT INTO calendar_poll_state (account_id, etag, last_modified, last_fetched_at, consecutive_failures, circuit_open_until)
      VALUES (?, ?, ?, datetime('now'), 0, NULL)
      ON CONFLICT(account_id) DO UPDATE SET
        etag = excluded.etag,
        last_modified = excluded.last_modified,
        last_fetched_at = excluded.last_fetched_at,
        consecutive_failures = 0,
        circuit_open_until = NULL
    `).run(account_id, etag, last_modified);
  }

  /**
   * Atomically increment consecutive_failures and trip the circuit-breaker
   * when the threshold is reached. Computes circuit_open_until inline in
   * SQL so concurrent pollers cannot race read-then-write and overshoot
   * the counter or miss the trip (PRD §K6).
   *
   * The caller passes the threshold + pause-duration; the cut-off timestamp
   * is computed in JS at call time (microsecond drift vs row-lock is OK).
   */
  recordPollFailure(account_id: string, opts: { threshold: number; pauseMs: number }): void {
    const openUntilIso = new Date(Date.now() + opts.pauseMs).toISOString();
    this.db.prepare(`
      INSERT INTO calendar_poll_state (account_id, consecutive_failures, circuit_open_until)
      VALUES (?, 1, CASE WHEN 1 >= ? THEN ? ELSE NULL END)
      ON CONFLICT(account_id) DO UPDATE SET
        consecutive_failures = consecutive_failures + 1,
        circuit_open_until = CASE
          WHEN consecutive_failures + 1 >= ? THEN ?
          ELSE NULL
        END
    `).run(account_id, opts.threshold, openUntilIso, opts.threshold, openUntilIso);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private rowToAccount(row: Record<string, unknown>): CalendarAccount {
    const enabledRaw = row['enabled_calendars'];
    const enabled_calendars = typeof enabledRaw === 'string' && enabledRaw.length > 0
      ? (JSON.parse(enabledRaw) as string[])
      : undefined;

    const result: CalendarAccount = {
      id: row['id'] as string,
      provider: row['provider'] as CalendarProviderKind,
      display_name: row['display_name'] as string,
    };
    if (row['is_default_writable'] === 1) result.is_default_writable = true;
    if (enabled_calendars !== undefined) result.enabled_calendars = enabled_calendars;
    if (row['default_calendar'] !== null) result.default_calendar = row['default_calendar'] as string;
    if (row['timezone'] !== null) result.timezone = row['timezone'] as string;
    if (row['server_url'] !== null) result.server_url = row['server_url'] as string;
    if (row['username'] !== null) result.username = row['username'] as string;
    if (row['preset_slug'] !== null) result.preset_slug = row['preset_slug'] as CalendarAccount['preset_slug'];
    if (row['ics_url_vault_key'] !== null) result.ics_url_vault_key = row['ics_url_vault_key'] as string;
    if (row['poll_interval_minutes'] !== null) result.poll_interval_minutes = row['poll_interval_minutes'] as number;
    return result;
  }
}
