// === Unified Inbox types ===
//
// Source of truth for the channel-aware Inbox introduced in PRD-UNIFIED-INBOX
// Phase 1a. Schema lives in `core/src/integrations/mail/state.ts` migration v7;
// these types are the in-memory shape exchanged between the classifier worker,
// the `/api/inbox/*` HTTP layer, and the web-ui store.
//
// Single-user instances use the literal 'default' tenant_id. Team-inbox lands
// in Phase 5+ without a schema change.

export type InboxChannel = 'email' | 'whatsapp';

/**
 * Classifier verdict for a thread.
 * - `requires_user`: visible in "Needs You" zone — user must decide/reply
 * - `draft_ready`:   visible in "Drafted for You" — draft generated lazily on click
 * - `auto_handled`:  collapsed "Handled Today" — archived/marked-read; UNDO available
 *
 * `noise` is dropped at the prefilter stage and never persisted as an item.
 */
export type InboxBucket = 'requires_user' | 'draft_ready' | 'auto_handled';

/**
 * Terminal user disposition on an item, or null while still pending.
 * Drives zone membership and undo eligibility.
 */
export type InboxUserAction = 'archived' | 'replied' | 'snoozed' | 'unhandled';

export type InboxAuditAction =
  | 'classified'
  | 'archived'
  | 'replied'
  | 'snoozed'
  | 'undo'
  | 'unsnoozed_on_reply'
  | 'rule_applied'
  | 'generation_requested';

export type InboxAuditActor = 'classifier' | 'user' | 'rule_engine' | 'system';

export type InboxRuleMatcherKind = 'from' | 'subject_contains' | 'list_id';

export type InboxRuleAction = 'archive' | 'mark_read' | 'label' | 'show';

/** How a rule entered the system — proactive threshold suggestion or chat-issued. */
export type InboxRuleSource = 'proactive_threshold' | 'on_demand';

export interface InboxItem {
  id: string;
  tenantId: string;
  accountId: string;
  channel: InboxChannel;
  /** Stable per-channel thread identifier — `gmail:<threadId>` or `imap:<msgid-hash>`. */
  threadKey: string;
  bucket: InboxBucket;
  /** 0–1 classifier confidence. < 0.7 routes to `requires_user`. */
  confidence: number;
  /** One-line German summary of why this item matters. */
  reasonDe: string;
  classifiedAt: Date;
  /** Enables selective re-classify when the prompt or model changes. */
  classifierVersion: string;
  userAction: InboxUserAction | undefined;
  userActionAt: Date | undefined;
  /** FK into `inbox_drafts`. Null until the user clicks "Draft Reply". */
  draftId: string | undefined;
  snoozeUntil: Date | undefined;
  /** Free-form condition snapshot, e.g. `if_no_reply_by:2026-05-15`. */
  snoozeCondition: string | undefined;
  /** When true, sender's reply during a snooze brings the item back immediately. */
  unsnoozeOnReply: boolean;
  // ── v11 envelope metadata (PRD-INBOX-PHASE-3-UX-COMPLETE) ──────────────
  // Pre-v11 rows expose `''` for fromAddress/subject and `undefined` for
  // the optional fields until the operator-driven backfill endpoint
  // re-runs provider.list and fills them in place.
  fromAddress: string;
  fromName: string | undefined;
  subject: string;
  /** envelope.date.getTime() at watcher-hook time. Null for WA items + pre-v11 rows. */
  mailDate: Date | undefined;
  /** ≤200-char preview from envelope.snippet — cheap card preview without body fetch. */
  snippet: string | undefined;
  /** RFC 5322 Message-ID. Enables local SQL thread-walk via in_reply_to. */
  messageId: string | undefined;
  /** Parent Message-ID for sibling reverse-lookup. */
  inReplyTo: string | undefined;
  // ── v13 reminder fields ────────────────────────────────────────────────
  /** When true, the reminder poller fires a notification at unsnooze time
   *  instead of silently resurfacing. Set via setSnooze with the flag. */
  notifyOnUnsnooze: boolean;
  /** Last time the poller emitted a notification for this item. Used so a
   *  re-snooze + unsnooze of the same item doesn't re-fire the stale
   *  reminder — only fires when the current snooze_until > notified_at. */
  notifiedAt: Date | undefined;
}

export interface InboxAuditEntry {
  id: string;
  tenantId: string;
  itemId: string;
  action: InboxAuditAction;
  actor: InboxAuditActor;
  /** Snapshot payload as JSON string — bucket, confidence, llm_call_id, prev_state, etc. */
  payloadJson: string;
  createdAt: Date;
}

export interface InboxDraft {
  id: string;
  tenantId: string;
  itemId: string;
  bodyMd: string;
  generatedAt: Date;
  generatorVersion: string;
  /** Increments on each user keystroke batch — drives the tone-button "edit-loss" guard. */
  userEditsCount: number;
  /** Self-FK forming the regenerate history chain. */
  supersededBy: string | undefined;
}

export interface InboxRule {
  id: string;
  tenantId: string;
  accountId: string;
  matcherKind: InboxRuleMatcherKind;
  matcherValue: string;
  /** Bucket the rule promotes the matched mail into. */
  bucket: Extract<InboxBucket, 'auto_handled' | 'requires_user'>;
  action: InboxRuleAction;
  createdAt: Date;
  source: InboxRuleSource;
}
