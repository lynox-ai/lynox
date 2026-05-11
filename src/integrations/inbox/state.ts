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

export interface ListItemsOptions {
  tenantId?: string | undefined;
  bucket?: InboxBucket | undefined;
  /** Default 50, capped at 500 to keep one query bounded. */
  limit?: number | undefined;
  offset?: number | undefined;
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
           unsnooze_on_reply
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
   * Queue listing for the UI. Defaults to most-recently-classified-first
   * within a bucket, falling back to all buckets when `bucket` is omitted.
   */
  listItems(opts: ListItemsOptions = {}): ReadonlyArray<InboxItem> {
    const tenantId = opts.tenantId ?? DEFAULT_TENANT_ID;
    const limit = clampLimit(opts.limit ?? 50);
    const offset = Math.max(0, opts.offset ?? 0);
    const rows = opts.bucket
      ? this.db
          .prepare<[string, string, number, number], ItemRow>(
            `SELECT * FROM inbox_items
             WHERE tenant_id = ? AND bucket = ?
             ORDER BY classified_at DESC
             LIMIT ? OFFSET ?`,
          )
          .all(tenantId, opts.bucket, limit, offset)
      : this.db
          .prepare<[string, number, number], ItemRow>(
            `SELECT * FROM inbox_items
             WHERE tenant_id = ?
             ORDER BY classified_at DESC
             LIMIT ? OFFSET ?`,
          )
          .all(tenantId, limit, offset);
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
    const rows = this.db
      .prepare<[string], { bucket: string; c: number }>(
        `SELECT bucket, COUNT(*) as c FROM inbox_items WHERE tenant_id = ? GROUP BY bucket`,
      )
      .all(tenantId);
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
   * The body is clamped to MAX_ITEM_BODY_CHARS as defense-in-depth — the
   * primary caller (the runner) writes a 500-char snippet, but a future
   * full-body refresh path could feed multi-MB messages; the clamp keeps
   * the table size predictable and the downstream prompt bounded.
   */
  saveItemBody(itemId: string, bodyMd: string, source: string, fetchedAt: Date = new Date()): void {
    const clamped = bodyMd.length > MAX_ITEM_BODY_CHARS ? bodyMd.slice(0, MAX_ITEM_BODY_CHARS) : bodyMd;
    this.db
      .prepare(
        `INSERT OR REPLACE INTO inbox_item_bodies (item_id, body_md, fetched_at, source)
         VALUES (?, ?, ?, ?)`,
      )
      .run(itemId, clamped, fetchedAt.getTime(), source);
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
