// === Mail state DB (Phase 0: Message-ID dedup) ===
//
// Persistent state for the mail integration. Phase 0 only stores the
// Message-ID dedup table — the watcher and tools both consult it before
// emitting "new" events so a message is processed exactly once across
// reconnects, restarts, and tenant migrations.
//
// Lives in its own SQLite file (~/.lynox/mail-state.db) following the same
// per-module-DB pattern as vault.db, run-history.db and agent-memory.db.

import Database from 'better-sqlite3';
import { join } from 'node:path';
import { getLynoxDir } from '../../core/config.js';
import { ensureDirSync } from '../../core/atomic-write.js';
import type { MailAccountConfig, MailAccountType, MailAuthType, MailEnvelope, MailPresetSlug } from './provider.js';
import { isValidAccountType, isValidAuthType } from './provider.js';

function defaultDbPath(): string {
  return join(getLynoxDir(), 'mail-state.db');
}

const MIGRATIONS: string[] = [
  // v1: Initial schema — Message-ID dedup table
  `CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);
   INSERT OR IGNORE INTO schema_version (version) VALUES (1);

   CREATE TABLE IF NOT EXISTS processed_mail_messages (
     account_id TEXT NOT NULL,
     message_id TEXT NOT NULL,
     uid INTEGER NOT NULL,
     folder TEXT NOT NULL DEFAULT 'INBOX',
     first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
     last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
     PRIMARY KEY (account_id, message_id)
   );

   CREATE INDEX IF NOT EXISTS idx_processed_mail_account ON processed_mail_messages(account_id);
   CREATE INDEX IF NOT EXISTS idx_processed_mail_first_seen ON processed_mail_messages(first_seen_at);`,

  // v2: Configured accounts table (no secrets — credentials stay in vault)
  `INSERT OR IGNORE INTO schema_version (version) VALUES (2);

   CREATE TABLE IF NOT EXISTS mail_accounts (
     id TEXT PRIMARY KEY,
     display_name TEXT NOT NULL,
     address TEXT NOT NULL,
     preset TEXT NOT NULL,
     imap_host TEXT NOT NULL,
     imap_port INTEGER NOT NULL,
     imap_secure INTEGER NOT NULL DEFAULT 1,
     smtp_host TEXT NOT NULL,
     smtp_port INTEGER NOT NULL,
     smtp_secure INTEGER NOT NULL DEFAULT 1,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at TEXT NOT NULL DEFAULT (datetime('now'))
   );`,

  // v3: Account semantic type + persona prompt. Existing rows default to 'personal'.
  `INSERT OR IGNORE INTO schema_version (version) VALUES (3);

   ALTER TABLE mail_accounts ADD COLUMN type TEXT NOT NULL DEFAULT 'personal';
   ALTER TABLE mail_accounts ADD COLUMN persona_prompt TEXT;`,

  // v4: Follow-up tracking — explicit reminders for sent mails awaiting a reply
  // or user deliverables. No LLM detection in Phase 0.2; this is pure
  // infrastructure that Phase 1 classification will consume.
  `INSERT OR IGNORE INTO schema_version (version) VALUES (4);

   CREATE TABLE IF NOT EXISTS mail_followups (
     id TEXT PRIMARY KEY,
     account_id TEXT NOT NULL,
     sent_message_id TEXT NOT NULL,
     thread_key TEXT NOT NULL,
     recipient TEXT NOT NULL,
     type TEXT NOT NULL,
     reason TEXT NOT NULL,
     reminder_at TEXT NOT NULL,
     expected_by TEXT,
     source TEXT NOT NULL DEFAULT 'user',
     status TEXT NOT NULL DEFAULT 'pending',
     resolved_at TEXT,
     resolved_by TEXT,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at TEXT NOT NULL DEFAULT (datetime('now'))
   );

   CREATE INDEX IF NOT EXISTS idx_followups_account ON mail_followups(account_id);
   CREATE INDEX IF NOT EXISTS idx_followups_thread ON mail_followups(thread_key);
   CREATE INDEX IF NOT EXISTS idx_followups_status_reminder ON mail_followups(status, reminder_at);`,

  // v5: Multi-auth-type foundation. Adds auth_type so OAuth-based mailboxes
  // (Gmail OAuth, Microsoft OAuth in Phase 1b+) can coexist with IMAP/SMTP
  // accounts in the same registry. Existing rows backfill to 'imap'.
  //
  // The IMAP-specific columns stay NOT NULL in this migration — relaxing
  // them requires a full table rebuild and will land alongside the first
  // OAuth provider implementation (PR2).
  `INSERT OR IGNORE INTO schema_version (version) VALUES (5);

   ALTER TABLE mail_accounts ADD COLUMN auth_type TEXT NOT NULL DEFAULT 'imap';
   ALTER TABLE mail_accounts ADD COLUMN oauth_provider_key TEXT;`,
];

export interface MailStateDbOptions {
  /** Override the on-disk path. Tests pass ':memory:' for an isolated DB. */
  path?: string | undefined;
}

export interface DedupPartition {
  /** Envelopes that the dedup table has not seen before. */
  fresh: ReadonlyArray<MailEnvelope>;
  /** Envelopes already recorded — should be skipped. */
  alreadySeen: ReadonlyArray<MailEnvelope>;
}

interface VersionRow { v: number }
interface CountRow { c: number }
interface ExistsRow { c: number }

interface AccountRow {
  id: string;
  display_name: string;
  address: string;
  preset: string;
  imap_host: string;
  imap_port: number;
  imap_secure: number;
  smtp_host: string;
  smtp_port: number;
  smtp_secure: number;
  type: string;
  persona_prompt: string | null;
  auth_type: string;
  oauth_provider_key: string | null;
  created_at: string;
  updated_at: string;
}

// ── Follow-up types and row shape ──────────────────────────────────────────

export type MailFollowupType = 'awaiting_reply' | 'user_deliverable' | 'custom';
export type MailFollowupSource = 'user' | 'agent' | 'autoresp_detect';
export type MailFollowupStatus = 'pending' | 'resolved' | 'cancelled' | 'reminded';
export type MailFollowupResolver = 'reply_received' | 'user_cancelled' | 'timeout';

export interface MailFollowup {
  id: string;
  accountId: string;
  sentMessageId: string;
  threadKey: string;
  recipient: string;
  type: MailFollowupType;
  reason: string;
  reminderAt: Date;
  expectedBy: Date | undefined;
  source: MailFollowupSource;
  status: MailFollowupStatus;
  resolvedAt: Date | undefined;
  resolvedBy: MailFollowupResolver | undefined;
  createdAt: Date;
  updatedAt: Date;
}

export interface MailFollowupInput {
  accountId: string;
  sentMessageId: string;
  threadKey: string;
  recipient: string;
  type: MailFollowupType;
  reason: string;
  reminderAt: Date;
  expectedBy?: Date | undefined;
  source?: MailFollowupSource | undefined;
}

interface FollowupRow {
  id: string;
  account_id: string;
  sent_message_id: string;
  thread_key: string;
  recipient: string;
  type: string;
  reason: string;
  reminder_at: string;
  expected_by: string | null;
  source: string;
  status: string;
  resolved_at: string | null;
  resolved_by: string | null;
  created_at: string;
  updated_at: string;
}

function rowToFollowup(row: FollowupRow): MailFollowup {
  return {
    id: row.id,
    accountId: row.account_id,
    sentMessageId: row.sent_message_id,
    threadKey: row.thread_key,
    recipient: row.recipient,
    type: row.type as MailFollowupType,
    reason: row.reason,
    reminderAt: new Date(row.reminder_at),
    expectedBy: row.expected_by ? new Date(row.expected_by) : undefined,
    source: row.source as MailFollowupSource,
    status: row.status as MailFollowupStatus,
    resolvedAt: row.resolved_at ? new Date(row.resolved_at) : undefined,
    resolvedBy: row.resolved_by as MailFollowupResolver | undefined,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

function rowToAccount(row: AccountRow): MailAccountConfig {
  const type: MailAccountType = isValidAccountType(row.type) ? row.type : 'personal';
  // Older rows (pre-v5) backfill to 'imap' via the migration default; guard
  // against any unexpected value just in case a hand-edited DB exists.
  const authType: MailAuthType = isValidAuthType(row.auth_type) ? row.auth_type : 'imap';
  return {
    id: row.id,
    displayName: row.display_name,
    address: row.address,
    preset: row.preset as MailPresetSlug,
    imap: { host: row.imap_host, port: row.imap_port, secure: row.imap_secure === 1 },
    smtp: { host: row.smtp_host, port: row.smtp_port, secure: row.smtp_secure === 1 },
    authType,
    oauthProviderKey: row.oauth_provider_key ?? undefined,
    type,
    personaPrompt: row.persona_prompt ?? undefined,
  };
}

/** Multi-statement runner — bracket access avoids a noisy lint false-positive. */
function runMultiStatement(db: Database.Database, sql: string): void {
  db['exec'](sql);
}

/**
 * SQLite-backed dedup store for processed mail messages. Per-account scope.
 */
export class MailStateDb {
  private readonly db: Database.Database;

  constructor(options?: MailStateDbOptions) {
    const path = options?.path ?? defaultDbPath();
    if (path !== ':memory:') {
      const dir = join(path, '..');
      ensureDirSync(dir);
    }
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this._migrate();
  }

  /** True if (accountId, messageId) is already in the table. */
  hasSeen(accountId: string, messageId: string): boolean {
    if (!messageId) return false;
    const row = this.db
      .prepare<[string, string], ExistsRow>(
        'SELECT 1 as c FROM processed_mail_messages WHERE account_id = ? AND message_id = ? LIMIT 1',
      )
      .get(accountId, messageId);
    return row !== undefined;
  }

  /**
   * Mark a single envelope as processed. Updates last_seen_at on conflict —
   * first_seen_at is preserved so we can reason about original arrival time.
   */
  markSeen(accountId: string, env: MailEnvelope): void {
    if (!env.messageId) return; // nothing to dedup on
    this.db
      .prepare(
        `INSERT INTO processed_mail_messages (account_id, message_id, uid, folder, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
         ON CONFLICT(account_id, message_id) DO UPDATE SET
           last_seen_at = datetime('now'),
           uid = excluded.uid,
           folder = excluded.folder`,
      )
      .run(accountId, env.messageId, env.uid, env.folder);
  }

  /**
   * Partition a list of envelopes into fresh + alreadySeen.
   * Envelopes without a Message-ID are always treated as fresh — the caller
   * decides whether to mark them seen (which will be a no-op).
   */
  partition(accountId: string, envelopes: ReadonlyArray<MailEnvelope>): DedupPartition {
    if (envelopes.length === 0) return { fresh: [], alreadySeen: [] };

    const fresh: MailEnvelope[] = [];
    const alreadySeen: MailEnvelope[] = [];
    const stmt = this.db.prepare<[string, string], ExistsRow>(
      'SELECT 1 as c FROM processed_mail_messages WHERE account_id = ? AND message_id = ? LIMIT 1',
    );

    for (const env of envelopes) {
      if (!env.messageId) {
        fresh.push(env);
        continue;
      }
      const seen = stmt.get(accountId, env.messageId);
      if (seen) {
        alreadySeen.push(env);
      } else {
        fresh.push(env);
      }
    }

    return { fresh, alreadySeen };
  }

  /**
   * Mark a batch of envelopes as processed in a single transaction. Returns
   * the number of rows actually inserted (excluding skipped no-message-id).
   */
  markSeenBatch(accountId: string, envelopes: ReadonlyArray<MailEnvelope>): number {
    if (envelopes.length === 0) return 0;
    const stmt = this.db.prepare(
      `INSERT INTO processed_mail_messages (account_id, message_id, uid, folder, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
       ON CONFLICT(account_id, message_id) DO UPDATE SET
         last_seen_at = datetime('now'),
         uid = excluded.uid,
         folder = excluded.folder`,
    );
    let count = 0;
    const txn = this.db.transaction((items: ReadonlyArray<MailEnvelope>) => {
      for (const env of items) {
        if (!env.messageId) continue;
        stmt.run(accountId, env.messageId, env.uid, env.folder);
        count++;
      }
    });
    txn(envelopes);
    return count;
  }

  /**
   * Drop entries older than `days` days. Returns the number of rows deleted.
   * Safety net for long-running instances that would otherwise grow forever.
   */
  pruneOlderThan(days: number): number {
    if (days <= 0) return 0;
    const result = this.db
      .prepare(`DELETE FROM processed_mail_messages WHERE first_seen_at < datetime('now', ?)`)
      .run(`-${String(days)} days`);
    return result.changes;
  }

  /** Number of dedup rows for an account. Useful for tests and admin UI. */
  countForAccount(accountId: string): number {
    const row = this.db
      .prepare<[string], CountRow>('SELECT COUNT(*) as c FROM processed_mail_messages WHERE account_id = ?')
      .get(accountId);
    return row?.c ?? 0;
  }

  /** Drop all dedup rows for an account — used when an account is deleted. */
  forgetAccount(accountId: string): number {
    const result = this.db
      .prepare('DELETE FROM processed_mail_messages WHERE account_id = ?')
      .run(accountId);
    return result.changes;
  }

  // ── Account configuration (no secrets) ──────────────────────────────────

  /** List all configured mail accounts. */
  listAccounts(): ReadonlyArray<MailAccountConfig> {
    const rows = this.db
      .prepare<[], AccountRow>('SELECT * FROM mail_accounts ORDER BY created_at ASC')
      .all();
    return rows.map(rowToAccount);
  }

  /** Look up one account by id, or null. */
  getAccount(id: string): MailAccountConfig | null {
    const row = this.db
      .prepare<[string], AccountRow>('SELECT * FROM mail_accounts WHERE id = ?')
      .get(id);
    return row ? rowToAccount(row) : null;
  }

  /**
   * Insert or update a mail account. Idempotent on the id.
   * Returns the persisted shape.
   */
  upsertAccount(account: MailAccountConfig): void {
    this.db
      .prepare(
        `INSERT INTO mail_accounts (id, display_name, address, preset, imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure, type, persona_prompt, auth_type, oauth_provider_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
         ON CONFLICT(id) DO UPDATE SET
           display_name = excluded.display_name,
           address = excluded.address,
           preset = excluded.preset,
           imap_host = excluded.imap_host,
           imap_port = excluded.imap_port,
           imap_secure = excluded.imap_secure,
           smtp_host = excluded.smtp_host,
           smtp_port = excluded.smtp_port,
           smtp_secure = excluded.smtp_secure,
           type = excluded.type,
           persona_prompt = excluded.persona_prompt,
           auth_type = excluded.auth_type,
           oauth_provider_key = excluded.oauth_provider_key,
           updated_at = datetime('now')`,
      )
      .run(
        account.id,
        account.displayName,
        account.address,
        account.preset,
        account.imap.host,
        account.imap.port,
        account.imap.secure ? 1 : 0,
        account.smtp.host,
        account.smtp.port,
        account.smtp.secure ? 1 : 0,
        account.type,
        account.personaPrompt ?? null,
        account.authType,
        account.oauthProviderKey ?? null,
      );
  }

  /** Remove an account row (without touching dedup state — caller decides). */
  deleteAccount(id: string): boolean {
    const result = this.db.prepare('DELETE FROM mail_accounts WHERE id = ?').run(id);
    return result.changes > 0;
  }

  // ── Follow-ups ──────────────────────────────────────────────────────────

  /**
   * Record a new follow-up reminder. Returns the assigned id.
   * The caller (tool or agent) supplies all fields; nothing is inferred.
   */
  recordFollowup(input: MailFollowupInput): string {
    const id = `fu_${String(Date.now())}_${Math.random().toString(36).slice(2, 10)}`;
    this.db
      .prepare(
        `INSERT INTO mail_followups (id, account_id, sent_message_id, thread_key, recipient, type, reason, reminder_at, expected_by, source, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', datetime('now'), datetime('now'))`,
      )
      .run(
        id,
        input.accountId,
        input.sentMessageId,
        input.threadKey,
        input.recipient,
        input.type,
        input.reason,
        input.reminderAt.toISOString(),
        input.expectedBy ? input.expectedBy.toISOString() : null,
        input.source ?? 'user',
      );
    return id;
  }

  /**
   * Mark all pending follow-ups for (accountId, threadKey) as resolved when
   * a reply arrives from one of the original recipients. Returns the list of
   * resolved follow-ups so the caller can fire hooks.
   */
  resolveFollowupsByReply(accountId: string, threadKey: string, replyFrom: string): ReadonlyArray<MailFollowup> {
    const pending = this.db
      .prepare<[string, string], FollowupRow>(
        `SELECT * FROM mail_followups
         WHERE account_id = ? AND thread_key = ? AND status IN ('pending', 'reminded')`,
      )
      .all(accountId, threadKey);

    const resolved: MailFollowup[] = [];
    const replyLc = replyFrom.toLowerCase();
    for (const row of pending) {
      // Only resolve if the reply came from someone we were waiting on
      if (row.recipient.toLowerCase() !== replyLc) continue;
      this.db
        .prepare(
          `UPDATE mail_followups SET status = 'resolved', resolved_at = datetime('now'), resolved_by = 'reply_received', updated_at = datetime('now') WHERE id = ?`,
        )
        .run(row.id);
      resolved.push(rowToFollowup({ ...row, status: 'resolved', resolved_at: new Date().toISOString(), resolved_by: 'reply_received' }));
    }
    return resolved;
  }

  /**
   * List follow-ups whose reminder is due (reminder_at <= asOf) and status
   * is still 'pending' (not yet reminded). Used by the watcher's tick loop.
   */
  dueFollowups(asOf: Date): ReadonlyArray<MailFollowup> {
    const rows = this.db
      .prepare<[string], FollowupRow>(
        `SELECT * FROM mail_followups
         WHERE status = 'pending' AND reminder_at <= ?
         ORDER BY reminder_at ASC`,
      )
      .all(asOf.toISOString());
    return rows.map(rowToFollowup);
  }

  /** Transition a pending follow-up to 'reminded' so the reminder fires only once. */
  markFollowupReminded(id: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE mail_followups SET status = 'reminded', updated_at = datetime('now') WHERE id = ? AND status = 'pending'`,
      )
      .run(id);
    return result.changes > 0;
  }

  /** Cancel a follow-up (user says "I don't care anymore"). */
  cancelFollowup(id: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE mail_followups SET status = 'cancelled', resolved_by = 'user_cancelled', resolved_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND status IN ('pending', 'reminded')`,
      )
      .run(id);
    return result.changes > 0;
  }

  /** Count pending follow-ups for an account. */
  countPendingFollowups(accountId: string): number {
    const row = this.db
      .prepare<[string], CountRow>(
        `SELECT COUNT(*) as c FROM mail_followups WHERE account_id = ? AND status = 'pending'`,
      )
      .get(accountId);
    return row?.c ?? 0;
  }

  /** List all follow-ups for an account (any status). */
  listFollowups(accountId: string): ReadonlyArray<MailFollowup> {
    const rows = this.db
      .prepare<[string], FollowupRow>(
        `SELECT * FROM mail_followups WHERE account_id = ? ORDER BY created_at DESC`,
      )
      .all(accountId);
    return rows.map(rowToFollowup);
  }

  close(): void {
    this.db.close();
  }

  private _migrate(): void {
    const current = this._getVersion();
    for (let i = current; i < MIGRATIONS.length; i++) {
      runMultiStatement(this.db, MIGRATIONS[i]!);
    }
  }

  private _getVersion(): number {
    try {
      const row = this.db
        .prepare<[], VersionRow>('SELECT MAX(version) as v FROM schema_version')
        .get();
      return row?.v ?? 0;
    } catch {
      return 0;
    }
  }
}
