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
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { getLynoxDir } from '../../core/config.js';
import { ensureDirSync } from '../../core/atomic-write.js';
import type { MailAccountConfig, MailAccountType, MailAuthType, MailAddress, MailEnvelope, MailPresetSlug } from './provider.js';
import { isValidAccountType, isValidAuthType } from './provider.js';

function defaultDbPath(): string {
  return join(getLynoxDir(), 'mail-state.db');
}

/**
 * Reserved id prefixes that must not appear in `mail_accounts.id`. The
 * inbox tables (v9+) treat the same string as a polymorphic discriminator
 * (channel detection in `inbox/watcher-hook.ts`), so a mail account with
 * a reserved prefix would silently misclassify its items.
 */
const RESERVED_ACCOUNT_PREFIXES: ReadonlyArray<string> = ['whatsapp:', 'telegram:'];

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

  // v6: Persisted default mailbox. Before this migration, the default lived
  // in InMemoryMailRegistry and was clobbered on every restart by whichever
  // provider was registered first (created_at order). With multiple
  // mailboxes (OAuth-Gmail + IMAP), that flipped the user's default
  // unpredictably — the visible symptom of the unification bug.
  //
  // Application-level invariant: at most one row has is_default=1.
  // setDefaultAccount() enforces this in a single transaction.
  `INSERT OR IGNORE INTO schema_version (version) VALUES (6);

   ALTER TABLE mail_accounts ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0;`,

  // v7: Unified Inbox foundation (PRD-UNIFIED-INBOX Phase 1a).
  //
  // 5 new tables, channel-aware from day one. tenant_id is present everywhere
  // for forward-compat with team-inbox (Phase 5+); single-user instances use
  // the literal 'default' sentinel. ON DELETE CASCADE chains require the
  // foreign_keys pragma which the constructor enables for new connections.
  //
  // Bucket / channel / actor values are validated at the application layer
  // (consistent with auth_type / preset patterns above) — no CHECK constraints.
  `INSERT OR IGNORE INTO schema_version (version) VALUES (7);

   CREATE TABLE IF NOT EXISTS inbox_items (
     id TEXT PRIMARY KEY,
     tenant_id TEXT NOT NULL DEFAULT 'default',
     account_id TEXT NOT NULL,
     channel TEXT NOT NULL,
     thread_key TEXT NOT NULL,
     bucket TEXT NOT NULL,
     confidence REAL NOT NULL,
     reason_de TEXT NOT NULL,
     classified_at INTEGER NOT NULL,
     classifier_version TEXT NOT NULL,
     user_action TEXT,
     user_action_at INTEGER,
     draft_id TEXT,
     snooze_until INTEGER,
     snooze_condition TEXT,
     unsnooze_on_reply INTEGER NOT NULL DEFAULT 1,
     FOREIGN KEY (account_id) REFERENCES mail_accounts(id) ON DELETE CASCADE
   );

   CREATE INDEX IF NOT EXISTS idx_inbox_items_queue
     ON inbox_items(tenant_id, bucket, classified_at DESC);
   CREATE INDEX IF NOT EXISTS idx_inbox_items_account
     ON inbox_items(tenant_id, account_id);
   CREATE INDEX IF NOT EXISTS idx_inbox_items_thread
     ON inbox_items(account_id, thread_key);
   CREATE INDEX IF NOT EXISTS idx_inbox_items_snooze
     ON inbox_items(snooze_until) WHERE snooze_until IS NOT NULL;

   CREATE TABLE IF NOT EXISTS inbox_audit_log (
     id TEXT PRIMARY KEY,
     tenant_id TEXT NOT NULL DEFAULT 'default',
     item_id TEXT NOT NULL,
     action TEXT NOT NULL,
     actor TEXT NOT NULL,
     payload_json TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     FOREIGN KEY (item_id) REFERENCES inbox_items(id) ON DELETE CASCADE
   );

   CREATE INDEX IF NOT EXISTS idx_inbox_audit_item ON inbox_audit_log(item_id);
   CREATE INDEX IF NOT EXISTS idx_inbox_audit_tenant_created
     ON inbox_audit_log(tenant_id, created_at DESC);

   CREATE TABLE IF NOT EXISTS inbox_drafts (
     id TEXT PRIMARY KEY,
     tenant_id TEXT NOT NULL DEFAULT 'default',
     item_id TEXT NOT NULL,
     body_md TEXT NOT NULL,
     generated_at INTEGER NOT NULL,
     generator_version TEXT NOT NULL,
     user_edits_count INTEGER NOT NULL DEFAULT 0,
     superseded_by TEXT,
     FOREIGN KEY (item_id) REFERENCES inbox_items(id) ON DELETE CASCADE,
     FOREIGN KEY (superseded_by) REFERENCES inbox_drafts(id) ON DELETE SET NULL
   );

   CREATE INDEX IF NOT EXISTS idx_inbox_drafts_item ON inbox_drafts(item_id);

   CREATE TABLE IF NOT EXISTS inbox_rules (
     id TEXT PRIMARY KEY,
     tenant_id TEXT NOT NULL DEFAULT 'default',
     account_id TEXT NOT NULL,
     matcher_kind TEXT NOT NULL,
     matcher_value TEXT NOT NULL,
     bucket TEXT NOT NULL,
     action TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     source TEXT NOT NULL,
     FOREIGN KEY (account_id) REFERENCES mail_accounts(id) ON DELETE CASCADE
   );

   CREATE INDEX IF NOT EXISTS idx_inbox_rules_account
     ON inbox_rules(tenant_id, account_id);
   CREATE INDEX IF NOT EXISTS idx_inbox_rules_matcher
     ON inbox_rules(account_id, matcher_kind, matcher_value);`,

  // v8: Defense-in-depth against the watcher-hook dedup race.
  //
  // The watcher hook checks `findItemByThread` before enqueuing the
  // classifier, but the classify call is async — two mails arriving on the
  // same thread back-to-back can both pass the check before either insert
  // lands. Without a UNIQUE constraint we'd persist duplicate rows for the
  // same (tenant_id, account_id, thread_key) tuple, breaking the Phase-1a
  // "always insert on miss, never re-classify" contract.
  //
  // The matching INSERT-side change in `inbox/state.ts:insertItem` uses
  // ON CONFLICT DO NOTHING and falls back to a SELECT so the runner sees a
  // single canonical id regardless of which racing job won.
  `INSERT OR IGNORE INTO schema_version (version) VALUES (8);

   CREATE UNIQUE INDEX IF NOT EXISTS idx_inbox_items_uniq_thread
     ON inbox_items(tenant_id, account_id, thread_key);`,

  // v9: Relax inbox_items.account_id + inbox_rules.account_id FK on
  // mail_accounts so the same tables can host WhatsApp items (account_id
  // becomes a polymorphic string: real mail-account ids OR pseudo-account
  // ids like 'whatsapp:<phoneNumberId>'). SQLite cannot drop a FK in
  // place, so we use the canonical table-rebuild dance.
  //
  // CASCADE on mail_account delete is now an application invariant: the
  // owning module is responsible for issuing the cleanup queries
  // (deleteAccount cascades via explicit DELETE in this same file).
  //
  // PRAGMA foreign_keys = OFF is required because inbox_audit_log /
  // inbox_drafts reference inbox_items via FK; dropping the table would
  // otherwise trip the integrity check. We restore the pragma at the end
  // of the migration string — the constructor's `foreign_keys = ON` call
  // already runs BEFORE this migration, so the effective end state is on.
  `PRAGMA foreign_keys = OFF;

   INSERT OR IGNORE INTO schema_version (version) VALUES (9);

   CREATE TABLE inbox_items_v9 (
     id TEXT PRIMARY KEY,
     tenant_id TEXT NOT NULL DEFAULT 'default',
     account_id TEXT NOT NULL,
     channel TEXT NOT NULL,
     thread_key TEXT NOT NULL,
     bucket TEXT NOT NULL,
     confidence REAL NOT NULL,
     reason_de TEXT NOT NULL,
     classified_at INTEGER NOT NULL,
     classifier_version TEXT NOT NULL,
     user_action TEXT,
     user_action_at INTEGER,
     draft_id TEXT,
     snooze_until INTEGER,
     snooze_condition TEXT,
     unsnooze_on_reply INTEGER NOT NULL DEFAULT 1
   );
   INSERT INTO inbox_items_v9 SELECT * FROM inbox_items;
   DROP TABLE inbox_items;
   ALTER TABLE inbox_items_v9 RENAME TO inbox_items;

   CREATE INDEX IF NOT EXISTS idx_inbox_items_queue
     ON inbox_items(tenant_id, bucket, classified_at DESC);
   CREATE INDEX IF NOT EXISTS idx_inbox_items_account
     ON inbox_items(tenant_id, account_id);
   CREATE INDEX IF NOT EXISTS idx_inbox_items_thread
     ON inbox_items(account_id, thread_key);
   CREATE INDEX IF NOT EXISTS idx_inbox_items_snooze
     ON inbox_items(snooze_until) WHERE snooze_until IS NOT NULL;
   CREATE UNIQUE INDEX IF NOT EXISTS idx_inbox_items_uniq_thread
     ON inbox_items(tenant_id, account_id, thread_key);

   CREATE TABLE inbox_rules_v9 (
     id TEXT PRIMARY KEY,
     tenant_id TEXT NOT NULL DEFAULT 'default',
     account_id TEXT NOT NULL,
     matcher_kind TEXT NOT NULL,
     matcher_value TEXT NOT NULL,
     bucket TEXT NOT NULL,
     action TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     source TEXT NOT NULL
   );
   INSERT INTO inbox_rules_v9 SELECT * FROM inbox_rules;
   DROP TABLE inbox_rules;
   ALTER TABLE inbox_rules_v9 RENAME TO inbox_rules;

   CREATE INDEX IF NOT EXISTS idx_inbox_rules_account
     ON inbox_rules(tenant_id, account_id);
   CREATE INDEX IF NOT EXISTS idx_inbox_rules_matcher
     ON inbox_rules(account_id, matcher_kind, matcher_value);

   PRAGMA foreign_keys = ON;`,

  // v10: Body cache for the draft-generator (PRD-UNIFIED-INBOX Phase 2).
  // Populated EAGERLY at classify time with the 500-char snippet the
  // classifier already had in memory — `runner.onSuccess` writes the
  // row alongside the audit insert. Generation reads from this cache
  // and pays zero provider round-trips on click. CASCADE on
  // inbox_items delete keeps the row from outliving the item.
  //
  // `source` mirrors the channel that produced the body ('imap',
  // 'gmail', 'whatsapp'). It is informational — the generator reads
  // body_md and does not branch on source — but it gives audit + a
  // future invalidation knob (e.g. refetch when Gmail sync resumes).
  `INSERT OR IGNORE INTO schema_version (version) VALUES (10);

   CREATE TABLE IF NOT EXISTS inbox_item_bodies (
     item_id TEXT PRIMARY KEY,
     body_md TEXT NOT NULL,
     fetched_at INTEGER NOT NULL,
     source TEXT NOT NULL,
     FOREIGN KEY (item_id) REFERENCES inbox_items(id) ON DELETE CASCADE
   );`,

  // v11: UX-Complete inbox foundation (PRD-INBOX-PHASE-3-UX-COMPLETE).
  //
  // v11.1 — Envelope metadata + thread chain on inbox_items. Item cards
  //   showed account_id and classified_at because the envelope was
  //   discarded after classify; the canary surfaced this immediately
  //   (93 cards all reading "21:31", sender invisible). DEFAULT '' on
  //   the NOT NULL strings is a bridge value for pre-v11 rows that the
  //   operator-driven backfill endpoint then fills in place; the
  //   writer-layer (envelopeToItemInputFields) rejects empties going
  //   forward.
  //
  // v11.2 — mail_sent_log: outbound source-of-truth, written from
  //   send-core.ts post-provider.send. Decouples Phase-4 features
  //   (Send Later, reply-watching for follow-up auto-close, outbound
  //   thread context) from re-parsing IMAP Sent folder. body_chars
  //   stores size only — never the body itself (privacy).
  //
  // v11.3 — inbox_user_action_log: 60s-window UNDO stack for bulk
  //   actions. Per-id rows grouped by bulk_id; mutation-allowed (the
  //   `undone_at` flag flips) unlike append-only inbox_audit_log. The
  //   `tasks` cron 'inbox_action_log_prune' drops rows older than 5min.
  //
  // Pattern: pure ALTER TABLE ADD COLUMN — no v9-style rebuild dance.
  // Safe because FKs are INBOUND (inbox_audit_log/inbox_drafts/
  // inbox_item_bodies → inbox_items) and SQLite handles ADD COLUMN as
  // O(1) metadata only.
  `INSERT OR IGNORE INTO schema_version (version) VALUES (11);

   ALTER TABLE inbox_items ADD COLUMN from_address TEXT NOT NULL DEFAULT '';
   ALTER TABLE inbox_items ADD COLUMN from_name TEXT;
   ALTER TABLE inbox_items ADD COLUMN subject TEXT NOT NULL DEFAULT '';
   ALTER TABLE inbox_items ADD COLUMN mail_date INTEGER;
   ALTER TABLE inbox_items ADD COLUMN snippet TEXT;
   ALTER TABLE inbox_items ADD COLUMN message_id TEXT;
   ALTER TABLE inbox_items ADD COLUMN in_reply_to TEXT;

   CREATE INDEX IF NOT EXISTS idx_inbox_items_from
     ON inbox_items(tenant_id, from_address);

   CREATE TABLE IF NOT EXISTS mail_sent_log (
     id TEXT PRIMARY KEY,
     tenant_id TEXT NOT NULL DEFAULT 'default',
     account_id TEXT NOT NULL,
     message_id TEXT NOT NULL,
     in_reply_to TEXT,
     to_json TEXT NOT NULL,
     cc_json TEXT,
     bcc_json TEXT,
     subject TEXT NOT NULL,
     body_chars INTEGER NOT NULL,
     sent_at INTEGER NOT NULL,
     reply_received_at INTEGER,
     followup_id TEXT,
     FOREIGN KEY (account_id) REFERENCES mail_accounts(id) ON DELETE CASCADE
   );

   CREATE INDEX IF NOT EXISTS idx_mail_sent_log_recent
     ON mail_sent_log(tenant_id, sent_at DESC);
   CREATE INDEX IF NOT EXISTS idx_mail_sent_log_message_id
     ON mail_sent_log(message_id);

   CREATE TABLE IF NOT EXISTS inbox_user_action_log (
     id TEXT PRIMARY KEY,
     tenant_id TEXT NOT NULL DEFAULT 'default',
     bulk_id TEXT NOT NULL,
     item_id TEXT NOT NULL,
     prior_user_action TEXT,
     prior_user_action_at INTEGER,
     action TEXT NOT NULL,
     performed_at INTEGER NOT NULL,
     undone_at INTEGER,
     FOREIGN KEY (item_id) REFERENCES inbox_items(id) ON DELETE CASCADE
   );

   CREATE INDEX IF NOT EXISTS idx_user_action_log_bulk
     ON inbox_user_action_log(bulk_id) WHERE undone_at IS NULL;
   CREATE INDEX IF NOT EXISTS idx_user_action_log_active
     ON inbox_user_action_log(performed_at DESC) WHERE undone_at IS NULL;`,

  // v12: Per-message thread storage for the Reading-Pane (PRD-INBOX-PHASE-3
  // §"Reading-Pane + Thread API" reconciliation).
  //
  // The v8 UNIQUE(tenant_id, account_id, thread_key) constraint on
  // `inbox_items` means each thread maps to exactly one row — the
  // "thread = unit of decision" contract from Phase 1a. Thread-history
  // for the Reading-Pane needs a different shape: many rows per thread,
  // one per individual mail. This sibling table provides that. inbox_items
  // stays the decision queue (unchanged); inbox_thread_messages is the
  // per-message log the Reading-Pane reads from.
  //
  // Writers: watcher-hook (rule fast-path, sensitive-skip), runner.onSuccess,
  // runner.onDeadLetter, backfill-metadata, and (Phase 4) send-core after
  // provider.send. `direction` discriminates inbound vs outbound at the
  // row level so the Reading-Pane can render both sides of a thread.
  //
  // FK direction matches v9's inbound pattern (CASCADE on mail_account
  // delete via application-level cleanup; SET NULL on inbox_item delete
  // so the message survives a queue purge but loses its decision-row
  // link — auditable and queryable).
  `INSERT OR IGNORE INTO schema_version (version) VALUES (12);

   CREATE TABLE IF NOT EXISTS inbox_thread_messages (
     id TEXT PRIMARY KEY,
     tenant_id TEXT NOT NULL DEFAULT 'default',
     account_id TEXT NOT NULL,
     thread_key TEXT NOT NULL,
     message_id TEXT NOT NULL,
     in_reply_to TEXT,
     from_address TEXT NOT NULL,
     from_name TEXT,
     to_json TEXT,
     cc_json TEXT,
     subject TEXT NOT NULL,
     body_md TEXT,
     mail_date INTEGER,
     snippet TEXT,
     direction TEXT NOT NULL DEFAULT 'inbound',
     fetched_at INTEGER NOT NULL,
     inbox_item_id TEXT,
     FOREIGN KEY (inbox_item_id) REFERENCES inbox_items(id) ON DELETE SET NULL
   );

   CREATE UNIQUE INDEX IF NOT EXISTS idx_thread_messages_msgid
     ON inbox_thread_messages(tenant_id, account_id, message_id);
   CREATE INDEX IF NOT EXISTS idx_thread_messages_thread
     ON inbox_thread_messages(tenant_id, account_id, thread_key, mail_date DESC);
   CREATE INDEX IF NOT EXISTS idx_thread_messages_item
     ON inbox_thread_messages(inbox_item_id);`,

  // v13: Reminder support on inbox_items.
  //
  // The `notify_on_unsnooze` flag makes a snooze into a reminder — when
  // `snooze_until <= now` AND this flag is set, the reminder poller fires
  // a notification ("Erinnerung: <subject>") and stamps `notified_at` so
  // re-snoozing the same item later doesn't re-fire the stale reminder.
  //
  // Snooze alone stays silent; this column is purely opt-in. Pre-v13
  // rows read as 0/null, preserving the existing silent-snooze semantics.
  `INSERT OR IGNORE INTO schema_version (version) VALUES (13);

   ALTER TABLE inbox_items ADD COLUMN notify_on_unsnooze INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE inbox_items ADD COLUMN notified_at INTEGER;

   CREATE INDEX IF NOT EXISTS idx_inbox_items_reminder_wake
     ON inbox_items(tenant_id, notify_on_unsnooze, snooze_until)
     WHERE notify_on_unsnooze = 1 AND snooze_until IS NOT NULL;`,

  // v14: Send Later — outbound mails queued for future delivery.
  //
  // mail_scheduled rows are written by the API when the user picks
  // "Senden später" + a future timestamp. A 60s poller (mail-scheduled-
  // poller.ts) picks up rows where scheduled_at <= now AND sent_at IS NULL
  // AND failed_at IS NULL, hands them to the same sendMail() pipeline used
  // by immediate sends.
  //
  // Failure semantics: attempts is incremented on every fire; after
  // MAX_SCHEDULED_ATTEMPTS the row is marked failed (failed_at + fail_reason
  // set) and stays in the table for UI visibility. The user can re-queue
  // via UI which inserts a fresh row.
  //
  // No FK to inbox_items on reply_inbox_item_id because compose-fresh
  // (no inbox-thread parent) uses NULL. The partial index makes the
  // poller's hot query O(log n) over due rows only.
  `INSERT OR IGNORE INTO schema_version (version) VALUES (14);

   CREATE TABLE IF NOT EXISTS mail_scheduled (
     id TEXT PRIMARY KEY,
     tenant_id TEXT NOT NULL DEFAULT 'default',
     account_id TEXT NOT NULL,
     to_json TEXT NOT NULL,
     cc_json TEXT,
     bcc_json TEXT,
     subject TEXT NOT NULL,
     body_md TEXT NOT NULL,
     in_reply_to TEXT,
     reply_inbox_item_id TEXT,
     scheduled_at INTEGER NOT NULL,
     created_at INTEGER NOT NULL,
     sent_at INTEGER,
     failed_at INTEGER,
     fail_reason TEXT,
     attempts INTEGER NOT NULL DEFAULT 0
   );
   CREATE INDEX IF NOT EXISTS idx_mail_scheduled_due
     ON mail_scheduled(scheduled_at)
     WHERE sent_at IS NULL AND failed_at IS NULL;
   CREATE INDEX IF NOT EXISTS idx_mail_scheduled_account
     ON mail_scheduled(account_id, created_at DESC);`,
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
  is_default: number;
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

// ── mail_scheduled types (Send Later, v14) ──────────────────────────────

export interface ScheduledSendInput {
  tenantId?: string | undefined;
  accountId: string;
  to: ReadonlyArray<MailAddress>;
  cc?: ReadonlyArray<MailAddress> | undefined;
  bcc?: ReadonlyArray<MailAddress> | undefined;
  subject: string;
  bodyMd: string;
  /** RFC 5322 in-reply-to for thread-replies. Null on compose-fresh. */
  inReplyTo?: string | undefined;
  /** Inbox item the user clicked Send-Later from. Null on compose-fresh. */
  replyInboxItemId?: string | undefined;
  /** When the poller should fire the send. Must be in the future. */
  scheduledAt: Date;
}

export interface ScheduledSend {
  id: string;
  tenantId: string;
  accountId: string;
  to: ReadonlyArray<MailAddress>;
  cc: ReadonlyArray<MailAddress>;
  bcc: ReadonlyArray<MailAddress>;
  subject: string;
  bodyMd: string;
  inReplyTo: string | undefined;
  replyInboxItemId: string | undefined;
  scheduledAt: Date;
  createdAt: Date;
  sentAt: Date | undefined;
  failedAt: Date | undefined;
  failReason: string | undefined;
  attempts: number;
}

interface ScheduledSendRow {
  id: string;
  tenant_id: string;
  account_id: string;
  to_json: string;
  cc_json: string | null;
  bcc_json: string | null;
  subject: string;
  body_md: string;
  in_reply_to: string | null;
  reply_inbox_item_id: string | null;
  scheduled_at: number;
  created_at: number;
  sent_at: number | null;
  failed_at: number | null;
  fail_reason: string | null;
  attempts: number;
}

function rowToScheduledSend(row: ScheduledSendRow): ScheduledSend {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    accountId: row.account_id,
    to: JSON.parse(row.to_json) as MailAddress[],
    cc: row.cc_json ? (JSON.parse(row.cc_json) as MailAddress[]) : [],
    bcc: row.bcc_json ? (JSON.parse(row.bcc_json) as MailAddress[]) : [],
    subject: row.subject,
    bodyMd: row.body_md,
    inReplyTo: row.in_reply_to ?? undefined,
    replyInboxItemId: row.reply_inbox_item_id ?? undefined,
    scheduledAt: new Date(row.scheduled_at),
    createdAt: new Date(row.created_at),
    sentAt: row.sent_at !== null ? new Date(row.sent_at) : undefined,
    failedAt: row.failed_at !== null ? new Date(row.failed_at) : undefined,
    failReason: row.fail_reason ?? undefined,
    attempts: row.attempts,
  };
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
    isDefault: row.is_default === 1,
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
    // ON DELETE CASCADE chains added in v7 (inbox_*) require this. Older
    // tables (mail_accounts, mail_followups) declare no FK constraints, so
    // enabling the pragma is a no-op for them.
    this.db.pragma('foreign_keys = ON');
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
   * Insert or update a mail account. Idempotent on the id. Reserved
   * channel prefixes (`whatsapp:`, `telegram:`) are rejected — those
   * namespaces belong to inbox_items polymorphic account_id values
   * introduced in migration v9 and must not collide with real mail
   * account ids.
   * Returns the persisted shape.
   */
  upsertAccount(account: MailAccountConfig): void {
    if (RESERVED_ACCOUNT_PREFIXES.some((p) => account.id.startsWith(p))) {
      throw new Error(
        `mail_accounts.id '${account.id}' uses a reserved channel prefix; `
        + `those are reserved for inbox_items polymorphic account ids.`,
      );
    }
    this.db
      .prepare(
        `INSERT INTO mail_accounts (id, display_name, address, preset, imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure, type, persona_prompt, auth_type, oauth_provider_key, is_default, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
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
        account.isDefault ? 1 : 0,
      );
  }

  /**
   * Mark `id` as the only default account in a single transaction. Pass null
   * to clear the default entirely (e.g. when the last account is removed).
   * Returns true when the row exists and was set; false otherwise.
   *
   * Existence is checked BEFORE clearing the previous default so a typo on
   * `setDefaultAccount('missing')` no longer wipes out the user's current
   * choice. Either the targeted row exists and we promote it, or nothing
   * changes.
   */
  setDefaultAccount(id: string | null): boolean {
    const txn = this.db.transaction((targetId: string | null) => {
      if (targetId !== null) {
        const exists = this.db.prepare('SELECT 1 FROM mail_accounts WHERE id = ?').get(targetId);
        if (!exists) return false;
      }
      this.db.prepare('UPDATE mail_accounts SET is_default = 0').run();
      if (targetId === null) return true;
      this.db.prepare('UPDATE mail_accounts SET is_default = 1 WHERE id = ?').run(targetId);
      return true;
    });
    return txn(id);
  }

  /** Return the id of the currently-default account, or null if none. */
  defaultAccountId(): string | null {
    const row = this.db
      .prepare<[], { id: string }>('SELECT id FROM mail_accounts WHERE is_default = 1 LIMIT 1')
      .get();
    return row?.id ?? null;
  }

  /**
   * Remove an account row plus its dependent inbox rows. The v9 migration
   * dropped the FK from inbox_items / inbox_rules onto mail_accounts to
   * accommodate WhatsApp pseudo-accounts; cascade is now an application
   * invariant we enforce here. Dedup state (processed_mail_messages,
   * mail_followups) is left intact — caller decides whether to forget it.
   */
  deleteAccount(id: string): boolean {
    const txn = this.db.transaction(() => {
      // Delete inbox-side dependents first so the FK chain
      // (inbox_audit_log + inbox_drafts -> inbox_items, both still
      // ON DELETE CASCADE) cleans up audits and drafts automatically.
      this.db.prepare('DELETE FROM inbox_items WHERE account_id = ?').run(id);
      this.db.prepare('DELETE FROM inbox_rules WHERE account_id = ?').run(id);
      const result = this.db.prepare('DELETE FROM mail_accounts WHERE id = ?').run(id) as { changes: number };
      return result.changes > 0;
    });
    return txn();
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

  // ── mail_scheduled (Send Later, v14) ──────────────────────────────────

  /**
   * Insert a queued send. Returns the row id (UUIDv4-ish slice). Caller
   * has already validated `scheduledAt` is in the future + the payload
   * fields; this layer is pure persistence.
   */
  insertScheduledSend(input: ScheduledSendInput): string {
    const id = randomUUID().slice(0, 12);
    this.db
      .prepare<[string, string, string, string, string | null, string | null, string, string, string | null, string | null, number, number], unknown>(
        `INSERT INTO mail_scheduled (
           id, tenant_id, account_id, to_json, cc_json, bcc_json,
           subject, body_md, in_reply_to, reply_inbox_item_id,
           scheduled_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.tenantId ?? 'default',
        input.accountId,
        JSON.stringify(input.to),
        input.cc ? JSON.stringify(input.cc) : null,
        input.bcc ? JSON.stringify(input.bcc) : null,
        input.subject,
        input.bodyMd,
        input.inReplyTo ?? null,
        input.replyInboxItemId ?? null,
        input.scheduledAt.getTime(),
        Date.now(),
      );
    return id;
  }

  /**
   * Items the poller should fire — `scheduled_at <= now`, not yet sent,
   * not yet permanently failed. Capped per call so a backlog spills to
   * the next tick rather than flooding SMTP.
   */
  listDueScheduledSends(now: Date = new Date(), limit: number = 25): ReadonlyArray<ScheduledSend> {
    const rows = this.db
      .prepare<[number, number], ScheduledSendRow>(
        `SELECT * FROM mail_scheduled
         WHERE scheduled_at <= ?
           AND sent_at IS NULL
           AND failed_at IS NULL
         ORDER BY scheduled_at ASC
         LIMIT ?`,
      )
      .all(now.getTime(), limit);
    return rows.map(rowToScheduledSend);
  }

  /** Mark a scheduled send as delivered. Stamps sent_at + bumps attempts. */
  markScheduledSent(id: string, when: Date = new Date()): boolean {
    const result = this.db
      .prepare<[number, string], unknown>(
        `UPDATE mail_scheduled
         SET sent_at = ?, attempts = attempts + 1
         WHERE id = ? AND sent_at IS NULL AND failed_at IS NULL`,
      )
      .run(when.getTime(), id) as { changes: number };
    return result.changes > 0;
  }

  /**
   * Increment the attempt counter on a transient failure. The poller
   * will retry the row on the next tick. After MAX_SCHEDULED_ATTEMPTS
   * the caller should switch to `markScheduledFailed` instead.
   */
  bumpScheduledAttempt(id: string): number {
    const row = this.db
      .prepare<[string], { attempts: number }>(
        `UPDATE mail_scheduled SET attempts = attempts + 1
         WHERE id = ? AND sent_at IS NULL AND failed_at IS NULL
         RETURNING attempts`,
      )
      .get(id);
    return row?.attempts ?? 0;
  }

  /** Mark a scheduled send permanently failed — no further retries. */
  markScheduledFailed(id: string, reason: string, when: Date = new Date()): boolean {
    const result = this.db
      .prepare<[number, string, string], unknown>(
        `UPDATE mail_scheduled
         SET failed_at = ?, fail_reason = ?
         WHERE id = ? AND sent_at IS NULL AND failed_at IS NULL`,
      )
      .run(when.getTime(), reason, id) as { changes: number };
    return result.changes > 0;
  }

  /** List queued sends for an account — used by the UI to show outbox. */
  listScheduledForAccount(accountId: string, limit: number = 50): ReadonlyArray<ScheduledSend> {
    const rows = this.db
      .prepare<[string, number], ScheduledSendRow>(
        `SELECT * FROM mail_scheduled WHERE account_id = ?
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(accountId, limit);
    return rows.map(rowToScheduledSend);
  }

  /** Cancel a not-yet-sent row — UI delete-from-outbox path. */
  cancelScheduledSend(id: string): boolean {
    const result = this.db
      .prepare<[string], unknown>(
        `DELETE FROM mail_scheduled WHERE id = ? AND sent_at IS NULL`,
      )
      .run(id) as { changes: number };
    return result.changes > 0;
  }

  close(): void {
    this.db.close();
  }

  /**
   * Underlying connection. Exposed so sibling modules in the same
   * mail-state.db (e.g. `inbox/state.ts`) can share the FK-enabled,
   * post-migration connection without re-opening the file. The MailStateDb
   * instance retains lifecycle ownership — callers must not invoke
   * `.close()` on the returned handle.
   */
  getConnection(): Database.Database {
    return this.db;
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
