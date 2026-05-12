// === Inbox state DB — repository for migration v7 tables ===
//
// Sits on top of the same `mail-state.db` connection as `MailStateDb`
// (per the PRD: tables live alongside mail to keep account FK chains sane).
// Callers wire it as:
//
//   const mail = new MailStateDb({ path });
//   const inbox = new InboxStateDb(mail.getConnection());
//
// Tests follow the same pattern with `:memory:`. The MailStateDb owns the
// connection lifecycle — InboxStateDb never closes it.
//
// The audit-log table is deliberately exposed as append-only: this module
// provides `appendAudit()` but no UPDATE/DELETE method, matching the PRD's
// tamper-evidence requirement (`§Threat Model — Audit-Log Tamper-Evidence`).

import type Database from 'better-sqlite3';
import type {
  InboxAuditAction,
  InboxAuditActor,
  InboxAuditEntry,
  InboxBucket,
  InboxChannel,
  InboxDraft,
  InboxItem,
  InboxRule,
  InboxRuleAction,
  InboxRuleMatcherKind,
  InboxRuleSource,
  InboxUserAction,
} from '../../types/index.js';
import { sanitizeHeader, stripHtmlAndInvisibles } from './classifier/sanitize.js';

/** Sentinel used in single-user instances. Team-inbox lands in Phase 5+. */
export const DEFAULT_TENANT_ID = 'default';

// ── Input shapes ───────────────────────────────────────────────────────────

export interface InboxItemInput {
  tenantId?: string | undefined;
  accountId: string;
  channel: InboxChannel;
  threadKey: string;
  bucket: InboxBucket;
  confidence: number;
  reasonDe: string;
  classifiedAt: Date;
  classifierVersion: string;
  unsnoozeOnReply?: boolean | undefined;
  // ── v11 envelope metadata (PRD-INBOX-PHASE-3) ──────────────────────────
  // Optional so existing tests + dead-letter paths still compile; the
  // writer-layer validation in `envelopeToItemInputFields` logs an
  // audit row when fromAddress/subject are empty but does not block.
  fromAddress?: string | undefined;
  fromName?: string | undefined;
  subject?: string | undefined;
  mailDate?: Date | undefined;
  snippet?: string | undefined;
  messageId?: string | undefined;
  inReplyTo?: string | undefined;
}

/**
 * v11 envelope → InboxItemInput field projection.
 *
 * Single writer-layer shaping function so all four insert sites (rule
 * fast-path, sensitive-skip, runner.onSuccess, runner.onDeadLetter)
 * project the same envelope shape into the same column shape. Snippet
 * is capped to 200 chars at write-time per PRD §Architecture v11.1.
 *
 * Validation is intentionally non-blocking: empty from/subject log an
 * audit-row `classified_with_empty_metadata` upstream but the row still
 * inserts (preserves the user's right to see *every* item, even ones
 * where the provider gave us mangled headers).
 */
export interface EnvelopeShape {
  from: ReadonlyArray<{ name?: string | undefined; address: string }>;
  subject: string;
  date: Date;
  snippet: string;
  messageId: string | undefined;
  inReplyTo: string | undefined;
}

export function envelopeToItemInputFields(
  env: EnvelopeShape,
): Pick<InboxItemInput,
  'fromAddress' | 'fromName' | 'subject' | 'mailDate' | 'snippet' | 'messageId' | 'inReplyTo'
> {
  // Header values are attacker-controlled. sanitizeHeader strips
  // CR/LF, zero-width, bidi-control, TAGS-plane unicode (PRD threat
  // model §"XSS via subject/from in card render"). Caps mirror RFC
  // 5321 (320 for address) + RFC 5322 (998 for subject).
  const primary = env.from[0];
  const fromAddress = sanitizeHeader(primary?.address, 320);
  const fromNameRaw = sanitizeHeader(primary?.name);
  const fromName = fromNameRaw.length > 0 ? fromNameRaw : undefined;
  const subject = sanitizeHeader(env.subject, 998);
  const snippetRaw = sanitizeHeader(env.snippet, 200);
  return {
    fromAddress,
    fromName,
    subject,
    mailDate: env.date,
    snippet: snippetRaw.length > 0 ? snippetRaw : undefined,
    messageId: env.messageId,
    inReplyTo: env.inReplyTo,
  };
}

export interface InboxAuditInput {
  tenantId?: string | undefined;
  itemId: string;
  action: InboxAuditAction;
  actor: InboxAuditActor;
  /** Pre-serialized JSON snapshot of relevant state. */
  payloadJson: string;
  createdAt?: Date | undefined;
}

export interface InboxDraftInput {
  tenantId?: string | undefined;
  itemId: string;
  bodyMd: string;
  generatedAt: Date;
  generatorVersion: string;
  /** Set when this draft replaces an earlier one (regenerate flow). */
  supersededDraftId?: string | undefined;
}

export interface InboxRuleInput {
  tenantId?: string | undefined;
  accountId: string;
  matcherKind: InboxRuleMatcherKind;
  matcherValue: string;
  bucket: InboxRule['bucket'];
  action: InboxRuleAction;
  source: InboxRuleSource;
  createdAt?: Date | undefined;
}

export type ThreadMessageDirection = 'inbound' | 'outbound' | 'unknown';

export interface ThreadMessageInput {
  tenantId?: string | undefined;
  accountId: string;
  threadKey: string;
  messageId: string;
  inReplyTo?: string | undefined;
  fromAddress: string;
  fromName?: string | undefined;
  /** JSON-encoded recipient array — caller stringifies. */
  toJson?: string | undefined;
  ccJson?: string | undefined;
  subject: string;
  bodyMd?: string | undefined;
  mailDate?: Date | undefined;
  snippet?: string | undefined;
  /** 'inbound' (received), 'outbound' (sent), or 'unknown'. Default 'inbound'. */
  direction?: ThreadMessageDirection | undefined;
  fetchedAt?: Date | undefined;
  /** FK into inbox_items.id when this message is the decision row's mail. */
  inboxItemId?: string | undefined;
}

export interface ThreadMessage {
  id: string;
  tenantId: string;
  accountId: string;
  threadKey: string;
  messageId: string;
  inReplyTo: string | undefined;
  fromAddress: string;
  fromName: string | undefined;
  toJson: string | undefined;
  ccJson: string | undefined;
  subject: string;
  bodyMd: string | undefined;
  mailDate: Date | undefined;
  snippet: string | undefined;
  direction: ThreadMessageDirection;
  fetchedAt: Date;
  inboxItemId: string | undefined;
}

export interface ListItemsOptions {
  tenantId?: string | undefined;
  bucket?: InboxBucket | undefined;
  /** Default 50, capped at 500 to keep one query bounded. */
  limit?: number | undefined;
  offset?: number | undefined;
  /**
   * Free-text filter (PRD-INBOX-PHASE-3 §"Search-Bar"). LIKE-match across
   * subject, from_address, snippet, reason_de. Trimmed + lower-bounded at
   * length 1; longer than 200 chars is rejected at the handler layer.
   */
  q?: string | undefined;
}

// ── Row shapes (camelCase mapped from snake_case columns) ──────────────────

interface ItemRow {
  id: string;
  tenant_id: string;
  account_id: string;
  channel: string;
  thread_key: string;
  bucket: string;
  confidence: number;
  reason_de: string;
  classified_at: number;
  classifier_version: string;
  user_action: string | null;
  user_action_at: number | null;
  draft_id: string | null;
  snooze_until: number | null;
  snooze_condition: string | null;
  unsnooze_on_reply: number;
  // v11 envelope columns — DEFAULT '' on NOT NULL, NULL on the rest
  from_address: string;
  from_name: string | null;
  subject: string;
  mail_date: number | null;
  snippet: string | null;
  message_id: string | null;
  in_reply_to: string | null;
}

interface AuditRow {
  id: string;
  tenant_id: string;
  item_id: string;
  action: string;
  actor: string;
  payload_json: string;
  created_at: number;
}

interface DraftRow {
  id: string;
  tenant_id: string;
  item_id: string;
  body_md: string;
  generated_at: number;
  generator_version: string;
  user_edits_count: number;
  superseded_by: string | null;
}

interface RuleRow {
  id: string;
  tenant_id: string;
  account_id: string;
  matcher_kind: string;
  matcher_value: string;
  bucket: string;
  action: string;
  created_at: number;
  source: string;
}

interface ThreadMessageRow {
  id: string;
  tenant_id: string;
  account_id: string;
  thread_key: string;
  message_id: string;
  in_reply_to: string | null;
  from_address: string;
  from_name: string | null;
  to_json: string | null;
  cc_json: string | null;
  subject: string;
  body_md: string | null;
  mail_date: number | null;
  snippet: string | null;
  direction: string;
  fetched_at: number;
  inbox_item_id: string | null;
}

// ── Row → domain mappers ───────────────────────────────────────────────────

function rowToItem(row: ItemRow): InboxItem {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    accountId: row.account_id,
    channel: row.channel as InboxChannel,
    threadKey: row.thread_key,
    bucket: row.bucket as InboxBucket,
    confidence: row.confidence,
    reasonDe: row.reason_de,
    classifiedAt: new Date(row.classified_at),
    classifierVersion: row.classifier_version,
    userAction: (row.user_action as InboxUserAction | null) ?? undefined,
    userActionAt: row.user_action_at !== null ? new Date(row.user_action_at) : undefined,
    draftId: row.draft_id ?? undefined,
    snoozeUntil: row.snooze_until !== null ? new Date(row.snooze_until) : undefined,
    snoozeCondition: row.snooze_condition ?? undefined,
    unsnoozeOnReply: row.unsnooze_on_reply === 1,
    fromAddress: row.from_address,
    fromName: row.from_name ?? undefined,
    subject: row.subject,
    mailDate: row.mail_date !== null ? new Date(row.mail_date) : undefined,
    snippet: row.snippet ?? undefined,
    messageId: row.message_id ?? undefined,
    inReplyTo: row.in_reply_to ?? undefined,
  };
}

function rowToAudit(row: AuditRow): InboxAuditEntry {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    itemId: row.item_id,
    action: row.action as InboxAuditAction,
    actor: row.actor as InboxAuditActor,
    payloadJson: row.payload_json,
    createdAt: new Date(row.created_at),
  };
}

function rowToDraft(row: DraftRow): InboxDraft {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    itemId: row.item_id,
    bodyMd: row.body_md,
    generatedAt: new Date(row.generated_at),
    generatorVersion: row.generator_version,
    userEditsCount: row.user_edits_count,
    supersededBy: row.superseded_by ?? undefined,
  };
}

function rowToThreadMessage(row: ThreadMessageRow): ThreadMessage {
  const directionRaw = row.direction;
  const direction: ThreadMessageDirection =
    directionRaw === 'inbound' || directionRaw === 'outbound' ? directionRaw : 'unknown';
  return {
    id: row.id,
    tenantId: row.tenant_id,
    accountId: row.account_id,
    threadKey: row.thread_key,
    messageId: row.message_id,
    inReplyTo: row.in_reply_to ?? undefined,
    fromAddress: row.from_address,
    fromName: row.from_name ?? undefined,
    toJson: row.to_json ?? undefined,
    ccJson: row.cc_json ?? undefined,
    subject: row.subject,
    bodyMd: row.body_md ?? undefined,
    mailDate: row.mail_date !== null ? new Date(row.mail_date) : undefined,
    snippet: row.snippet ?? undefined,
    direction,
    fetchedAt: new Date(row.fetched_at),
    inboxItemId: row.inbox_item_id ?? undefined,
  };
}

function rowToRule(row: RuleRow): InboxRule {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    accountId: row.account_id,
    matcherKind: row.matcher_kind as InboxRuleMatcherKind,
    matcherValue: row.matcher_value,
    bucket: row.bucket as InboxRule['bucket'],
    action: row.action as InboxRuleAction,
    createdAt: new Date(row.created_at),
    source: row.source as InboxRuleSource,
  };
}

// ── ID generation ──────────────────────────────────────────────────────────

function nextId(prefix: string): string {
  return `${prefix}_${String(Date.now())}_${Math.random().toString(36).slice(2, 10)}`;
}

const MAX_LIST_LIMIT = 500;

/**
 * Defense-in-depth clamp on the cached body. Today's writers are the
 * classifier (snippet, ~500 chars) and the body-refresh adapter (full
 * mail body); the cap keeps single rows bounded. Exported so callers
 * can truncate up-front and keep their reported byte counts honest
 * (rather than discovering after the fact that state silently clipped).
 */
export const MAX_ITEM_BODY_CHARS = 8 * 1024;

export class InboxStateDb {
  constructor(private readonly db: Database.Database) {}

  // ── Items ────────────────────────────────────────────────────────────────

  /**
   * Insert an item. Handles the watcher-hook dedup race (two mails on the
   * same thread classify in parallel): the v8 UNIQUE index on
   * `(tenant_id, account_id, thread_key)` collapses the second insert via
   * ON CONFLICT DO NOTHING; we then return the existing row's id so audit
   * entries still attach to the canonical item. Both racing callers see a
   * single item, with two `classified` audit entries — informative rather
   * than corrupting.
   */
  insertItem(input: InboxItemInput): string {
    const id = nextId('inb');
    const tenantId = input.tenantId ?? DEFAULT_TENANT_ID;
    const unsnoozeOnReply = input.unsnoozeOnReply ?? true;
    const result = this.db
      .prepare(
        `INSERT INTO inbox_items (
           id, tenant_id, account_id, channel, thread_key,
           bucket, confidence, reason_de, classified_at, classifier_version,
           unsnooze_on_reply,
           from_address, from_name, subject, mail_date, snippet,
           message_id, in_reply_to
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (tenant_id, account_id, thread_key) DO NOTHING`,
      )
      .run(
        id,
        tenantId,
        input.accountId,
        input.channel,
        input.threadKey,
        input.bucket,
        input.confidence,
        input.reasonDe,
        input.classifiedAt.getTime(),
        input.classifierVersion,
        unsnoozeOnReply ? 1 : 0,
        input.fromAddress ?? '',
        input.fromName ?? null,
        input.subject ?? '',
        input.mailDate?.getTime() ?? null,
        input.snippet ?? null,
        input.messageId ?? null,
        input.inReplyTo ?? null,
      ) as { changes: number };
    if (result.changes > 0) return id;
    // Race lost — another job inserted first. Return that row's id.
    const existing = this.db
      .prepare<[string, string, string], { id: string }>(
        `SELECT id FROM inbox_items
         WHERE tenant_id = ? AND account_id = ? AND thread_key = ?`,
      )
      .get(tenantId, input.accountId, input.threadKey);
    if (!existing) {
      throw new Error('insertItem: ON CONFLICT fired but no existing row found');
    }
    return existing.id;
  }

  /**
   * Atomic insert-item + append-audit in a single transaction. Halves the
   * SQLite fsync cost on the watcher's hot path (each call previously did
   * two separate prepared-statement runs and two journal flushes per mail).
   * Returns the item id (post-INSERT-OR-IGNORE-fallback, see `insertItem`).
   */
  insertItemWithAudit(item: InboxItemInput, audit: Omit<InboxAuditInput, 'itemId'>): string {
    const txn = this.db.transaction(() => {
      const id = this.insertItem(item);
      this.appendAudit({ ...audit, itemId: id });
      return id;
    });
    return txn();
  }

  getItem(id: string): InboxItem | null {
    const row = this.db
      .prepare<[string], ItemRow>('SELECT * FROM inbox_items WHERE id = ?')
      .get(id);
    return row ? rowToItem(row) : null;
  }

  /**
   * Look up an existing item for `(accountId, threadKey)`. Used by the
   * classifier worker to decide between insert vs re-classify on a known
   * thread (re-classification updates the existing row in a future commit;
   * Phase 1a always inserts).
   */
  findItemByThread(accountId: string, threadKey: string): InboxItem | null {
    const row = this.db
      .prepare<[string, string], ItemRow>(
        'SELECT * FROM inbox_items WHERE account_id = ? AND thread_key = ? ORDER BY classified_at DESC LIMIT 1',
      )
      .get(accountId, threadKey);
    return row ? rowToItem(row) : null;
  }

  /**
   * v11 thread-walk: all items sharing a thread_key, newest-first.
   *
   * PRD-INBOX-PHASE-3 §"Reading-Pane + Thread API" — `MailProvider.search`
   * does not accept `{threadKey}`, so we fall back to local SQL siblings
   * keyed off the v11 `message_id` + `thread_key` columns. Older messages
   * pre-classify-window are not in `inbox_items` at all; callers surface
   * that as `partial: true` to the UI.
   *
   * Capped at 50 per call to keep one query bounded; the Reading-Pane
   * thread block respects the same cap.
   */
  listItemsByThreadKey(
    accountId: string,
    threadKey: string,
    opts: { tenantId?: string | undefined; limit?: number | undefined } = {},
  ): ReadonlyArray<InboxItem> {
    const tenantId = opts.tenantId ?? DEFAULT_TENANT_ID;
    const limit = clampLimit(opts.limit ?? 50);
    const rows = this.db
      .prepare<[string, string, string, number], ItemRow>(
        `SELECT * FROM inbox_items
         WHERE tenant_id = ? AND account_id = ? AND thread_key = ?
         ORDER BY mail_date DESC, classified_at DESC
         LIMIT ?`,
      )
      .all(tenantId, accountId, threadKey, limit);
    return rows.map(rowToItem);
  }

  /**
   * v11 backfill writer: update envelope columns on an existing row,
   * keyed by (tenant_id, account_id, thread_key). Used by the
   * operator-driven backfill endpoint to fill in pre-v11 rows whose
   * NOT NULL columns default to '' until provider.list re-runs.
   *
   * Returns true when exactly one row was updated, false when no row
   * matched the key tuple. The endpoint counts updated vs missed so the
   * operator can see how many threads on the instance pre-date v11.
   */
  updateItemEnvelopeByThreadKey(
    accountId: string,
    threadKey: string,
    fields: {
      fromAddress: string;
      fromName: string | undefined;
      subject: string;
      mailDate: Date | undefined;
      snippet: string | undefined;
      messageId: string | undefined;
      inReplyTo: string | undefined;
    },
    tenantId: string = DEFAULT_TENANT_ID,
  ): boolean {
    this._updateItemEnvelopeStmt ??= this.db.prepare(
      `UPDATE inbox_items
       SET from_address = ?, from_name = ?, subject = ?,
           mail_date = ?, snippet = ?, message_id = ?, in_reply_to = ?
       WHERE tenant_id = ? AND account_id = ? AND thread_key = ?`,
    );
    const result = this._updateItemEnvelopeStmt.run(
      fields.fromAddress,
      fields.fromName ?? null,
      fields.subject,
      fields.mailDate?.getTime() ?? null,
      fields.snippet ?? null,
      fields.messageId ?? null,
      fields.inReplyTo ?? null,
      tenantId,
      accountId,
      threadKey,
    ) as { changes: number };
    return result.changes > 0;
  }
  private _updateItemEnvelopeStmt: Database.Statement | undefined;

  /**
   * Wrap N envelope-metadata UPDATEs in a single SQLite transaction so
   * a 200-row backfill is one fsync instead of 200. Exposed narrowly
   * for the backfill module — keeps the generic `runInTransaction`
   * helper off the public surface until the second caller arrives.
   */
  runBackfillMetadataBatch(fn: () => void): void {
    const txn = this.db.transaction(fn);
    txn();
  }

  /**
   * Queue listing for the UI. Defaults to most-recently-classified-first
   * within a bucket, falling back to all buckets when `bucket` is omitted.
   */
  listItems(opts: ListItemsOptions = {}): ReadonlyArray<InboxItem> {
    const tenantId = opts.tenantId ?? DEFAULT_TENANT_ID;
    const limit = clampLimit(opts.limit ?? 50);
    const offset = Math.max(0, opts.offset ?? 0);
    // Snoozed items re-appear automatically once snooze_until <= now — no
    // waker job required.
    const now = Date.now();
    // PRD §"Search-Bar": LIKE-match across subject/from/snippet/reason.
    // SQLite LIKE is case-insensitive on ASCII (default LIKE collation);
    // diacritic-folding is a Phase 5 improvement when search becomes a
    // hot path. `%` and `_` are wildcards — we escape them via ESCAPE
    // so a user typing "30% off" doesn't match every row.
    const q = opts.q?.trim() ?? '';
    const useSearch = q.length > 0;
    const qPattern = useSearch ? `%${q.replace(/[\\%_]/g, '\\$&')}%` : '';
    type ItemRowQ = ItemRow;
    let rows: ItemRowQ[];
    if (opts.bucket) {
      rows = useSearch
        ? this.db
            .prepare<[string, string, number, string, string, string, string, number, number], ItemRowQ>(
              `SELECT * FROM inbox_items
               WHERE tenant_id = ? AND bucket = ?
                 AND (snooze_until IS NULL OR snooze_until <= ?)
                 AND (subject LIKE ? ESCAPE '\\' OR from_address LIKE ? ESCAPE '\\' OR snippet LIKE ? ESCAPE '\\' OR reason_de LIKE ? ESCAPE '\\')
               ORDER BY classified_at DESC
               LIMIT ? OFFSET ?`,
            )
            .all(tenantId, opts.bucket, now, qPattern, qPattern, qPattern, qPattern, limit, offset)
        : this.db
            .prepare<[string, string, number, number, number], ItemRowQ>(
              `SELECT * FROM inbox_items
               WHERE tenant_id = ? AND bucket = ?
                 AND (snooze_until IS NULL OR snooze_until <= ?)
               ORDER BY classified_at DESC
               LIMIT ? OFFSET ?`,
            )
            .all(tenantId, opts.bucket, now, limit, offset);
    } else {
      rows = useSearch
        ? this.db
            .prepare<[string, number, string, string, string, string, number, number], ItemRowQ>(
              `SELECT * FROM inbox_items
               WHERE tenant_id = ?
                 AND (snooze_until IS NULL OR snooze_until <= ?)
                 AND (subject LIKE ? ESCAPE '\\' OR from_address LIKE ? ESCAPE '\\' OR snippet LIKE ? ESCAPE '\\' OR reason_de LIKE ? ESCAPE '\\')
               ORDER BY classified_at DESC
               LIMIT ? OFFSET ?`,
            )
            .all(tenantId, now, qPattern, qPattern, qPattern, qPattern, limit, offset)
        : this.db
            .prepare<[string, number, number, number], ItemRowQ>(
              `SELECT * FROM inbox_items
               WHERE tenant_id = ?
                 AND (snooze_until IS NULL OR snooze_until <= ?)
               ORDER BY classified_at DESC
               LIMIT ? OFFSET ?`,
            )
            .all(tenantId, now, limit, offset);
    }
    return rows.map(rowToItem);
  }

  /**
   * Per-bucket counts for the queue badges in the header. Buckets without
   * any item are returned as 0 so the consumer never has to special-case.
   */
  /**
   * Cheap existence check used by the cold-start gate: if any item already
   * exists for an account, the backfill iterator has run at least once and
   * a fresh re-credential of the same account should not trigger a second
   * provider.list() pull.
   */
  hasAnyItemForAccount(accountId: string, tenantId: string = DEFAULT_TENANT_ID): boolean {
    const row = this.db
      .prepare<[string, string], { c: number }>(
        `SELECT COUNT(*) AS c FROM inbox_items WHERE tenant_id = ? AND account_id = ? LIMIT 1`,
      )
      .get(tenantId, accountId);
    return (row?.c ?? 0) > 0;
  }

  countItemsByBucket(tenantId: string = DEFAULT_TENANT_ID): Record<InboxBucket, number> {
    // Mirrors listItems' snooze filter so a snoozed item can never make the
    // badge count disagree with the visible list.
    const now = Date.now();
    const rows = this.db
      .prepare<[string, number], { bucket: string; c: number }>(
        `SELECT bucket, COUNT(*) as c FROM inbox_items
         WHERE tenant_id = ?
           AND (snooze_until IS NULL OR snooze_until <= ?)
         GROUP BY bucket`,
      )
      .all(tenantId, now);
    const counts: Record<InboxBucket, number> = {
      requires_user: 0,
      draft_ready: 0,
      auto_handled: 0,
    };
    for (const row of rows) {
      if (row.bucket in counts) {
        counts[row.bucket as InboxBucket] = row.c;
      }
    }
    return counts;
  }

  // ── v11.3 bulk-action UNDO stack ──────────────────────────────────────

  /**
   * Append per-item UNDO log row inside a bulk operation. Caller writes
   * one of these per affected item, all sharing the same `bulkId` so
   * `undoBulkActionLog(bulkId)` can reverse them in one transaction.
   *
   * `priorUserAction` snapshots the row's prior state so UNDO can
   * restore it (an item the user previously archived, then mass-archived,
   * stays archived after UNDO — preserves the audit-meaningful state).
   */
  insertBulkActionLog(input: {
    tenantId?: string | undefined;
    bulkId: string;
    itemId: string;
    priorUserAction: InboxUserAction | null;
    priorUserActionAt: Date | null;
    action: InboxUserAction;
    performedAt?: Date | undefined;
  }): string {
    const id = nextId('iul');
    const tenantId = input.tenantId ?? DEFAULT_TENANT_ID;
    const performedAt = input.performedAt ?? new Date();
    this.db
      .prepare(
        `INSERT INTO inbox_user_action_log (
           id, tenant_id, bulk_id, item_id,
           prior_user_action, prior_user_action_at,
           action, performed_at, undone_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        id,
        tenantId,
        input.bulkId,
        input.itemId,
        input.priorUserAction ?? null,
        input.priorUserActionAt?.getTime() ?? null,
        input.action,
        performedAt.getTime(),
      );
    return id;
  }

  /**
   * Flip `undone_at` on every active row sharing `bulkId` and reverse
   * each `inbox_items.user_action` back to its `prior_user_action`.
   * Returns the count of items reverted. Idempotent — a second call
   * sees `undone_at IS NOT NULL` and is a no-op.
   *
   * `withinMs` enforces the time-window: rows whose `performed_at` is
   * older than `now - withinMs` are NOT reverted; callers surface this
   * as 410 Gone to the UI.
   */
  undoBulkAction(
    bulkId: string,
    now: Date = new Date(),
    withinMs: number = 60_000,
  ): number {
    const earliest = now.getTime() - withinMs;
    const rows = this.db
      .prepare<[string, number], { id: string; item_id: string; prior_user_action: string | null; prior_user_action_at: number | null }>(
        `SELECT id, item_id, prior_user_action, prior_user_action_at
         FROM inbox_user_action_log
         WHERE bulk_id = ? AND undone_at IS NULL AND performed_at >= ?`,
      )
      .all(bulkId, earliest);
    if (rows.length === 0) return 0;
    const undoMs = now.getTime();
    const flipUndone = this.db.prepare(
      `UPDATE inbox_user_action_log SET undone_at = ? WHERE id = ?`,
    );
    const restoreAction = this.db.prepare(
      `UPDATE inbox_items SET user_action = ?, user_action_at = ? WHERE id = ?`,
    );
    const txn = this.db.transaction(() => {
      for (const row of rows) {
        flipUndone.run(undoMs, row.id);
        restoreAction.run(
          row.prior_user_action,
          row.prior_user_action_at,
          row.item_id,
        );
      }
    });
    txn();
    return rows.length;
  }

  /**
   * Recent un-done bulks for the operator's UNDO menu. PRD §"UNDO-Toast
   * UX spec": "Route change → toasts dismiss but bulks stay undoable
   * from `/api/inbox/undo/recent` (the menu in InboxView header)".
   */
  listRecentBulks(
    tenantId: string = DEFAULT_TENANT_ID,
    withinMs: number = 60_000,
    limit: number = 5,
    now: Date = new Date(),
  ): ReadonlyArray<{ bulkId: string; action: InboxUserAction; performedAt: Date; itemCount: number }> {
    const earliest = now.getTime() - withinMs;
    const rows = this.db
      .prepare<[string, number, number], { bulk_id: string; action: string; performed_at: number; item_count: number }>(
        `SELECT bulk_id, action, MAX(performed_at) AS performed_at, COUNT(*) AS item_count
         FROM inbox_user_action_log
         WHERE tenant_id = ? AND undone_at IS NULL AND performed_at >= ?
         GROUP BY bulk_id
         ORDER BY performed_at DESC
         LIMIT ?`,
      )
      .all(tenantId, earliest, limit);
    return rows.map((r) => ({
      bulkId: r.bulk_id,
      action: r.action as InboxUserAction,
      performedAt: new Date(r.performed_at),
      itemCount: r.item_count,
    }));
  }

  /**
   * Cleanup task driven by `tasks` cron `inbox_action_log_prune`
   * (PRD §"Cleanup"). Drops rows older than `olderThanMs` regardless
   * of `undone_at` — they're no longer undoable and have served their
   * audit purpose via the parallel `inbox_audit_log` append-only stream.
   */
  pruneOldBulkActionLog(olderThanMs: number = 5 * 60 * 1000, now: Date = new Date()): number {
    const threshold = now.getTime() - olderThanMs;
    const result = this.db
      .prepare(`DELETE FROM inbox_user_action_log WHERE performed_at < ?`)
      .run(threshold) as { changes: number };
    return result.changes;
  }

  /**
   * Record a user action on an item. Pass `action: null` to revert (the
   * UNDO path) — that also clears `user_action_at`.
   */
  updateUserAction(id: string, action: InboxUserAction | null, at: Date | null = new Date()): boolean {
    const result = this.db
      .prepare<[string | null, number | null, string], unknown>(
        `UPDATE inbox_items SET user_action = ?, user_action_at = ? WHERE id = ?`,
      )
      .run(action, action === null ? null : (at ?? new Date()).getTime(), id) as { changes: number };
    return result.changes > 0;
  }

  /**
   * Set or clear the snooze. Passing `until = null` clears all three snooze
   * fields atomically — used by the auto-unsnooze-on-reply path.
   */
  setSnooze(
    id: string,
    until: Date | null,
    condition: string | null,
    unsnoozeOnReply: boolean = true,
  ): boolean {
    const result = this.db
      .prepare<[number | null, string | null, number, string], unknown>(
        `UPDATE inbox_items
         SET snooze_until = ?, snooze_condition = ?, unsnooze_on_reply = ?
         WHERE id = ?`,
      )
      .run(
        until === null ? null : until.getTime(),
        until === null ? null : condition,
        unsnoozeOnReply ? 1 : 0,
        id,
      ) as { changes: number };
    return result.changes > 0;
  }

  /** Link a draft to its item. Pass `null` to detach. */
  attachDraft(id: string, draftId: string | null): boolean {
    const result = this.db
      .prepare<[string | null, string], unknown>(
        `UPDATE inbox_items SET draft_id = ? WHERE id = ?`,
      )
      .run(draftId, id) as { changes: number };
    return result.changes > 0;
  }

  // ── Audit (append-only) ──────────────────────────────────────────────────

  /** Append an audit entry. There is intentionally no update or delete API. */
  appendAudit(input: InboxAuditInput): string {
    const id = nextId('aud');
    const tenantId = input.tenantId ?? DEFAULT_TENANT_ID;
    const createdAt = (input.createdAt ?? new Date()).getTime();
    this.db
      .prepare(
        `INSERT INTO inbox_audit_log (id, tenant_id, item_id, action, actor, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, tenantId, input.itemId, input.action, input.actor, input.payloadJson, createdAt);
    return id;
  }

  listAuditForItem(itemId: string): ReadonlyArray<InboxAuditEntry> {
    const rows = this.db
      .prepare<[string], AuditRow>(
        'SELECT * FROM inbox_audit_log WHERE item_id = ? ORDER BY created_at ASC',
      )
      .all(itemId);
    return rows.map(rowToAudit);
  }

  // ── Drafts ───────────────────────────────────────────────────────────────

  /**
   * Insert a new draft. When `supersededDraftId` is set, the previous draft
   * is marked superseded in the same transaction — the regenerate flow.
   */
  insertDraft(input: InboxDraftInput): string {
    const id = nextId('drf');
    const tenantId = input.tenantId ?? DEFAULT_TENANT_ID;
    const txn = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO inbox_drafts (id, tenant_id, item_id, body_md, generated_at, generator_version, user_edits_count)
           VALUES (?, ?, ?, ?, ?, ?, 0)`,
        )
        .run(id, tenantId, input.itemId, input.bodyMd, input.generatedAt.getTime(), input.generatorVersion);
      if (input.supersededDraftId) {
        this.db
          .prepare(`UPDATE inbox_drafts SET superseded_by = ? WHERE id = ?`)
          .run(id, input.supersededDraftId);
      }
    });
    txn();
    return id;
  }

  /**
   * Insert + attach in one txn so `inbox_items.draft_id` cannot lag the
   * actual draft row after a partial crash. Without the wrap, a SIGKILL
   * between the two writes would leave the regenerate flow pointing at
   * the prior (now-superseded) draft id forever.
   */
  insertDraftAndAttach(input: InboxDraftInput): string {
    return this.db.transaction(() => {
      const id = this.insertDraft(input);
      this.attachDraft(input.itemId, id);
      return id;
    })();
  }

  getDraftById(id: string): InboxDraft | null {
    const row = this.db
      .prepare<[string], DraftRow>('SELECT * FROM inbox_drafts WHERE id = ?')
      .get(id);
    return row ? rowToDraft(row) : null;
  }

  /** The current (non-superseded) draft for an item, or null. */
  getActiveDraftForItem(itemId: string): InboxDraft | null {
    const row = this.db
      .prepare<[string], DraftRow>(
        `SELECT * FROM inbox_drafts
         WHERE item_id = ? AND superseded_by IS NULL
         ORDER BY generated_at DESC
         LIMIT 1`,
      )
      .get(itemId);
    return row ? rowToDraft(row) : null;
  }

  /** Track keystroke-batches for the tone-change "edit-loss" guard. */
  incrementDraftEdits(id: string): boolean {
    const result = this.db
      .prepare(`UPDATE inbox_drafts SET user_edits_count = user_edits_count + 1 WHERE id = ?`)
      .run(id) as { changes: number };
    return result.changes > 0;
  }

  // ── v12 thread messages (per-message Reading-Pane storage) ─────────────

  /**
   * Insert a per-message thread row. ON CONFLICT DO NOTHING by
   * `(tenant_id, account_id, message_id)` so the same message arriving
   * via classify + backfill (or simultaneous watcher races) collapses
   * to a single row.
   *
   * Returns the inserted (or existing) row's id so callers can wire
   * future references. `inboxItemId` is the FK to `inbox_items` for
   * the row that owns this thread's bucket-decision; null for messages
   * we haven't seen as an inbox_items insert yet (sibling messages).
   */
  insertThreadMessage(input: ThreadMessageInput): string {
    const id = nextId('itm');
    const tenantId = input.tenantId ?? DEFAULT_TENANT_ID;
    // Defense-in-depth body sanitisation (PRD §Threat Model "XSS via
    // body in Reading-Pane"); mirrors saveItemBody's strip pass.
    const sanitizedBody = input.bodyMd !== undefined
      ? stripHtmlAndInvisibles(input.bodyMd)
      : null;
    // ON CONFLICT preserves the existing row but upgrades any field
    // whose new value is more informative (longer body, non-null
    // mail_date, etc.). Defends the snippet-then-fullbody flow where
    // backfill might seed a row before runner.onSuccess gets the
    // classifier body.
    this._insertThreadMessageStmt ??= this.db.prepare(
      `INSERT INTO inbox_thread_messages (
         id, tenant_id, account_id, thread_key,
         message_id, in_reply_to,
         from_address, from_name, to_json, cc_json,
         subject, body_md, mail_date, snippet,
         direction, fetched_at, inbox_item_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (tenant_id, account_id, message_id) DO UPDATE SET
         body_md = CASE
           WHEN excluded.body_md IS NOT NULL
             AND length(excluded.body_md) > length(COALESCE(inbox_thread_messages.body_md, ''))
           THEN excluded.body_md
           ELSE inbox_thread_messages.body_md
         END,
         snippet = COALESCE(NULLIF(excluded.snippet, ''), inbox_thread_messages.snippet),
         mail_date = COALESCE(excluded.mail_date, inbox_thread_messages.mail_date),
         inbox_item_id = COALESCE(excluded.inbox_item_id, inbox_thread_messages.inbox_item_id)`,
    );
    // ON CONFLICT DO UPDATE always reports `changes > 0` (insert or
    // update path), so we drop the result and query for the canonical
    // id by `(tenant_id, account_id, message_id)` — the UNIQUE key
    // that the conflict clause guards.
    this._insertThreadMessageStmt.run(
      id,
      tenantId,
      input.accountId,
      input.threadKey,
      input.messageId,
      input.inReplyTo ?? null,
      input.fromAddress,
      input.fromName ?? null,
      input.toJson ?? null,
      input.ccJson ?? null,
      input.subject,
      sanitizedBody,
      input.mailDate?.getTime() ?? null,
      input.snippet ?? null,
      input.direction ?? 'inbound',
      (input.fetchedAt ?? new Date()).getTime(),
      input.inboxItemId ?? null,
    );
    this._selectThreadMessageIdByMsgIdStmt ??= this.db.prepare<[string, string, string], { id: string }>(
      `SELECT id FROM inbox_thread_messages
       WHERE tenant_id = ? AND account_id = ? AND message_id = ?`,
    );
    const existing = this._selectThreadMessageIdByMsgIdStmt.get(tenantId, input.accountId, input.messageId);
    return existing?.id ?? id;
  }
  private _insertThreadMessageStmt: Database.Statement | undefined;
  private _selectThreadMessageIdByMsgIdStmt: Database.Statement<[string, string, string], { id: string }> | undefined;

  /**
   * All messages in a thread, newest-first. Cap mirrors the Reading-Pane
   * thread-history limit (50) per PRD §"Reading-Pane + Thread API".
   */
  listThreadMessages(
    accountId: string,
    threadKey: string,
    opts: { tenantId?: string | undefined; limit?: number | undefined } = {},
  ): ReadonlyArray<ThreadMessage> {
    const tenantId = opts.tenantId ?? DEFAULT_TENANT_ID;
    const limit = clampLimit(opts.limit ?? 50);
    const rows = this.db
      .prepare<[string, string, string, number], ThreadMessageRow>(
        `SELECT * FROM inbox_thread_messages
         WHERE tenant_id = ? AND account_id = ? AND thread_key = ?
         ORDER BY mail_date DESC, fetched_at DESC
         LIMIT ?`,
      )
      .all(tenantId, accountId, threadKey, limit);
    return rows.map(rowToThreadMessage);
  }

  /**
   * Single-message lookup by message_id. Used when /full needs the
   * body of the specific message an inbox_items row points at.
   */
  getThreadMessageByMessageId(
    accountId: string,
    messageId: string,
    tenantId: string = DEFAULT_TENANT_ID,
  ): ThreadMessage | null {
    const row = this.db
      .prepare<[string, string, string], ThreadMessageRow>(
        `SELECT * FROM inbox_thread_messages
         WHERE tenant_id = ? AND account_id = ? AND message_id = ?`,
      )
      .get(tenantId, accountId, messageId);
    return row ? rowToThreadMessage(row) : null;
  }

  // ── Item bodies (lazy cache for draft generation) ──────────────────────

  /**
   * Fetch the cached mail body for an item, or null when nothing has been
   * cached yet. CASCADE on inbox_items delete keeps the cache row from
   * outliving its owner — see migration v10.
   */
  getItemBody(itemId: string): { bodyMd: string; fetchedAt: Date; source: string } | null {
    const row = this.db
      .prepare<[string], { body_md: string; fetched_at: number; source: string }>(
        `SELECT body_md, fetched_at, source FROM inbox_item_bodies WHERE item_id = ?`,
      )
      .get(itemId);
    return row
      ? { bodyMd: row.body_md, fetchedAt: new Date(row.fetched_at), source: row.source }
      : null;
  }

  /**
   * Upsert the cached body. `INSERT OR REPLACE` so a refetch (user
   * explicitly asks "reload from server") overwrites the stored row
   * without a separate delete step.
   *
   * Defense-in-depth: HTML is stripped + invisible chars removed via
   * sanitizeBody before persistence (PRD-INBOX-PHASE-3 §Threat Model
   * "XSS via body in Reading-Pane"). The classifier prompt path already
   * feeds plaintext; this is the second line of defense for a future
   * full-body refresh path that might forward provider.fetch().html.
   * The body is then clamped to MAX_ITEM_BODY_CHARS so cold-start
   * backfill of multi-MB messages cannot bloat the table.
   */
  saveItemBody(
    itemId: string,
    bodyMd: string,
    source: string,
    fetchedAt: Date = new Date(),
  ): { bodyMd: string; bytesWritten: number; clampedAtCacheLayer: boolean } {
    const sanitized = stripHtmlAndInvisibles(bodyMd);
    const clampedAtCacheLayer = sanitized.length > MAX_ITEM_BODY_CHARS;
    const clamped = clampedAtCacheLayer ? sanitized.slice(0, MAX_ITEM_BODY_CHARS) : sanitized;
    this.db
      .prepare(
        `INSERT OR REPLACE INTO inbox_item_bodies (item_id, body_md, fetched_at, source)
         VALUES (?, ?, ?, ?)`,
      )
      .run(itemId, clamped, fetchedAt.getTime(), source);
    return {
      bodyMd: clamped,
      bytesWritten: Buffer.byteLength(clamped, 'utf8'),
      clampedAtCacheLayer,
    };
  }

  /**
   * Atomic body update + edits counter bump. Single txn so the tone-button
   * "edit-loss" guard (`userEditsCount > 0`) never sees a body change without
   * its matching counter increment.
   */
  updateDraftBody(id: string, bodyMd: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE inbox_drafts
         SET body_md = ?, user_edits_count = user_edits_count + 1
         WHERE id = ?`,
      )
      .run(bodyMd, id) as { changes: number };
    return result.changes > 0;
  }

  // ── Rules ────────────────────────────────────────────────────────────────

  insertRule(input: InboxRuleInput): string {
    const id = nextId('rul');
    const tenantId = input.tenantId ?? DEFAULT_TENANT_ID;
    const createdAt = (input.createdAt ?? new Date()).getTime();
    this.db
      .prepare(
        `INSERT INTO inbox_rules (id, tenant_id, account_id, matcher_kind, matcher_value, bucket, action, created_at, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        tenantId,
        input.accountId,
        input.matcherKind,
        input.matcherValue,
        input.bucket,
        input.action,
        createdAt,
        input.source,
      );
    return id;
  }

  listRulesForAccount(
    accountId: string,
    tenantId: string = DEFAULT_TENANT_ID,
  ): ReadonlyArray<InboxRule> {
    const rows = this.db
      .prepare<[string, string], RuleRow>(
        `SELECT * FROM inbox_rules
         WHERE tenant_id = ? AND account_id = ?
         ORDER BY created_at ASC`,
      )
      .all(tenantId, accountId);
    return rows.map(rowToRule);
  }

  deleteRule(id: string): boolean {
    const result = this.db.prepare('DELETE FROM inbox_rules WHERE id = ?').run(id) as { changes: number };
    return result.changes > 0;
  }
}

function clampLimit(n: number): number {
  if (n <= 0) return 50;
  return Math.min(MAX_LIST_LIMIT, n);
}
