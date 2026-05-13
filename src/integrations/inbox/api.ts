// === Inbox HTTP handlers (pure) ===
//
// Framework-free async handlers for the `/api/inbox/*` surface. Each one
// takes a `deps` object and a parsed input shape and returns a JSON-ready
// `{status, body}` envelope. Keeping them off any HTTP framework means
// tests don't need to spin up a server, and the same handlers can back
// REST or an MCP-tool surface unchanged.
//
// Validation is shallow on purpose: the route adapter parses bodies
// before calling these. Handlers only check the shape they cannot
// ignore — invalid bucket strings, out-of-range pagination, missing
// required fields.

import type {
  InboxBucket,
  InboxRuleAction,
  InboxRuleMatcherKind,
  InboxRuleSource,
  InboxUserAction,
} from '../../types/index.js';
import type { ColdStartTracker } from './cold-start-tracker.js';
import type { InboxContactResolver } from './contact-resolver.js';
import type { InboxRulesLoader } from './rules-loader.js';
import type { InboxStateDb, ListItemsOptions } from './state.js';

export interface InboxApiDeps {
  state: InboxStateDb;
  contactResolver?: InboxContactResolver | undefined;
  /**
   * When wired, rule-mutation handlers invalidate the loader's cache so the
   * next inbound mail picks up the change without restarting the runtime.
   */
  rules?: InboxRulesLoader | undefined;
  /** Surfaces cold-start progress to the UI banner; absent until wired. */
  coldStartTracker?: ColdStartTracker | undefined;
  /**
   * Resolves the account address + display name. The generator prompt needs
   * the receiving mailbox identity to write a proper signature placeholder.
   * Same shape as `AccountResolver` in watcher-hook.ts — kept structural so
   * the http-api layer can pass a thin function-bound wrapper without
   * importing the watcher's interface.
   */
  accountResolver?: import('./watcher-hook.js').AccountResolver | undefined;
  /** Inbox LLM caller — when absent, `handleGenerateDraft` returns 503. */
  llm?: import('./classifier/index.js').LLMCaller | undefined;
  /**
   * Resolves an accountId to a live MailProvider. Used by
   * `handleRefreshItemBody` to pull the full mail body on demand for
   * email items. Absent on instances without a mail context.
   */
  providerResolver?: ((accountId: string) => import('../mail/provider.js').MailProvider | null) | undefined;
  /**
   * WhatsApp message store. Used by `handleRefreshItemBody` to
   * concatenate recent thread messages for WA items. Absent when the
   * `whatsapp-inbox` flag is off — handler then returns 503 for WA.
   */
  whatsappStore?: import('./body-refresh.js').WhatsAppMessageStore | undefined;
  /**
   * Full mail context — `handleSendInboxReply` needs the registry +
   * follow-up state-db that `sendMail` reaches through. Absent on
   * instances without a vault/mail account; send then 503s.
   */
  mailContext?: import('../mail/context.js').MailContext | undefined;
  /**
   * Operator-driven cold-start backfill. Resolves the provider from
   * `providerResolver` internally and hands it to the runtime's bound
   * runner. Absent when either the inbox runtime or the mail context is
   * unwired — handler then returns 503.
   */
  coldStartRunner?: (
    accountId: string,
    runOpts?: { force?: boolean },
  ) => Promise<void>;
  /**
   * v11 envelope-metadata backfill runner. Pulls a fresh provider.list()
   * batch and UPDATEs the v11 columns on existing items keyed by
   * thread_key. Single-concurrent at the instance level — the handler
   * enforces a 409 if one is already running.
   */
  backfillMetadataRunner?: (accountId: string) => Promise<import('./backfill-metadata.js').BackfillMetadataReport>;
  /**
   * Sensitive-content mode for body-refresh paths. Without this the
   * classifier's redaction guarantees would not apply to the refreshed
   * full body. Defaults to 'allow' when absent — bootstrap.ts threads the
   * env-driven value through.
   */
  sensitiveMode?: import('./sensitive-content.js').SensitiveMode | undefined;
  /** Per-account rate limiter for /draft/generate. Absent → no rate limit. */
  generateRateLimiter?: import('./generate-rate-limit.js').GenerateRateLimiter | undefined;
}

export interface ApiResponse<T = unknown> {
  status: number;
  body: T;
}

const VALID_BUCKETS: ReadonlyArray<InboxBucket> = ['requires_user', 'draft_ready', 'auto_handled'];
const VALID_USER_ACTIONS: ReadonlyArray<InboxUserAction> = ['archived', 'replied', 'snoozed', 'unhandled'];
const VALID_MATCHER_KINDS: ReadonlyArray<InboxRuleMatcherKind> = ['from', 'subject_contains', 'list_id'];
const VALID_RULE_ACTIONS: ReadonlyArray<InboxRuleAction> = ['archive', 'mark_read', 'label', 'show'];
const VALID_RULE_SOURCES: ReadonlyArray<InboxRuleSource> = ['proactive_threshold', 'on_demand'];
const VALID_RULE_BUCKETS: ReadonlyArray<'requires_user' | 'auto_handled'> = ['requires_user', 'auto_handled'];

function bad(message: string): ApiResponse {
  return { status: 400, body: { error: message } };
}

function notFound(message = 'not found'): ApiResponse {
  return { status: 404, body: { error: message } };
}

// ── Items ────────────────────────────────────────────────────────────────

export interface ListItemsQuery {
  bucket?: string | undefined;
  limit?: string | number | undefined;
  offset?: string | number | undefined;
  tenantId?: string | undefined;
  /** Free-text search across subject/from/snippet/reason_de (zone-scoped). */
  q?: string | undefined;
  /**
   * When 'true' (string from query param), returns ONLY items still snoozed
   * (snooze_until > now), ordered by wake time ASC. Mutually exclusive with
   * `bucket` — snoozed items live in the dedicated Snoozed zone regardless
   * of their original classifier bucket.
   */
  snoozedOnly?: string | undefined;
}

/** PRD §"Search-Bar" caps user input at 200 chars to keep one LIKE query bounded. */
const MAX_SEARCH_QUERY_LENGTH = 200;

function parseInt32(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = typeof value === 'number' ? value : parseInt(value, 10);
  return Number.isFinite(n) ? n : undefined;
}

export function handleListItems(deps: InboxApiDeps, query: ListItemsQuery): ApiResponse {
  const opts: ListItemsOptions = {};
  const snoozedOnly = query.snoozedOnly === 'true';
  if (snoozedOnly) {
    opts.snoozedOnly = true;
  } else if (query.bucket !== undefined) {
    if (!VALID_BUCKETS.includes(query.bucket as InboxBucket)) {
      return bad(`invalid bucket: ${query.bucket}`);
    }
    opts.bucket = query.bucket as InboxBucket;
  }
  const limit = parseInt32(query.limit);
  if (limit !== undefined) opts.limit = limit;
  const offset = parseInt32(query.offset);
  if (offset !== undefined) opts.offset = offset;
  if (query.tenantId !== undefined) opts.tenantId = query.tenantId;
  if (query.q !== undefined && query.q.length > 0) {
    if (query.q.length > MAX_SEARCH_QUERY_LENGTH) {
      return bad(`q exceeds ${MAX_SEARCH_QUERY_LENGTH} chars`);
    }
    opts.q = query.q;
  }
  return { status: 200, body: { items: deps.state.listItems(opts) } };
}

export function handleGetItem(deps: InboxApiDeps, id: string): ApiResponse {
  const item = deps.state.getItem(id);
  return item ? { status: 200, body: { item } } : notFound('item');
}

/**
 * Reading-pane backing endpoint (PRD-INBOX-PHASE-3 §Reading-Pane).
 *
 * Body resolution prefers the v12 `inbox_thread_messages` row matching
 * the item's `messageId`; falls back to the v10 `inbox_item_bodies`
 * cache for pre-v12 rows. `source: 'missing'` covers the
 * sensitive-skip path that leaves both empty — UI surfaces an "ask
 * the assistant" hint instead of triggering a provider fetch (round-2
 * review dropped `/body/fetch` as a DoS vector).
 */
export function handleGetItemFull(deps: InboxApiDeps, id: string): ApiResponse {
  const item = deps.state.getItem(id);
  if (!item) return notFound('item');
  let body: { md: string; source: 'cache' | 'missing'; fetchedAt?: string };
  const tm = item.messageId !== undefined && item.messageId.length > 0
    ? deps.state.getThreadMessageByMessageId(item.accountId, item.messageId, item.tenantId)
    : null;
  if (tm !== null && tm.bodyMd !== undefined && tm.bodyMd.length > 0) {
    body = { md: tm.bodyMd, source: 'cache', fetchedAt: tm.fetchedAt.toISOString() };
  } else {
    const legacy = deps.state.getItemBody(id);
    body = legacy
      ? { md: legacy.bodyMd, source: 'cache', fetchedAt: legacy.fetchedAt.toISOString() }
      : { md: '', source: 'missing' };
  }
  return { status: 200, body: { item, body } };
}

/**
 * Thread-history endpoint (PRD-INBOX-PHASE-3 §Reading-Pane + Thread API).
 *
 * Reads from v12 `inbox_thread_messages` (one row per mail, many per
 * thread). Order is newest-first by `mail_date`. `partial: true` when
 * the item's `in_reply_to` references a parent message we do not have
 * a row for — the UI shows a follow-up hint instead of pretending the
 * thread is complete.
 */
export function handleGetItemThread(
  deps: InboxApiDeps,
  id: string,
  opts: { limit?: number | undefined } = {},
): ApiResponse {
  const item = deps.state.getItem(id);
  if (!item) return notFound('item');
  const messages = deps.state.listThreadMessages(item.accountId, item.threadKey, {
    tenantId: item.tenantId,
    ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
  });
  // partial=true when in_reply_to references a parent message we have
  // no thread_messages row for — the UI shows a follow-up hint. Look
  // the parent up directly so a limit-truncated message list never
  // false-positives partial.
  let partial = false;
  if (item.inReplyTo !== undefined && item.inReplyTo.length > 0) {
    const parent = deps.state.getThreadMessageByMessageId(item.accountId, item.inReplyTo, item.tenantId);
    partial = parent === null;
  }
  return { status: 200, body: { messages, partial } };
}

/**
 * Notification preferences (v15). One envelope, one PATCH endpoint —
 * keeps the UI simple. All keys live in `inbox_settings` so adding a
 * new pref means another key, not a new column.
 *
 * - `inboxPushEnabled` — master gate for new-mail pushes
 * - `quietHours` — local-time window during which we silently skip
 * - `perMinute` / `perHour` — user-tunable throttle (defaults 1/10)
 * - `accounts` — per-account mute list; mailContext supplies the names
 */
export function handleGetNotificationPrefs(deps: InboxApiDeps): ApiResponse {
  const enabled = deps.state.getSetting('push.inbox_enabled', 'true') !== 'false';
  const quietEnabled = deps.state.getSetting('push.quiet_hours_enabled', 'false') === 'true';
  const start = deps.state.getSetting('push.quiet_hours_start', '22:00') ?? '22:00';
  const end = deps.state.getSetting('push.quiet_hours_end', '07:00') ?? '07:00';
  const tz = deps.state.getSetting('push.quiet_hours_tz', 'UTC') ?? 'UTC';
  const perMinute = parsePositiveInt(deps.state.getSetting('push.per_minute'), 1);
  const perHour = parsePositiveInt(deps.state.getSetting('push.per_hour'), 10);

  const accountList = deps.mailContext
    ? deps.mailContext.stateDb.listAccounts().map((a) => ({
        id: a.id,
        displayName: a.displayName,
        address: a.address,
        muted: deps.state.getSetting(`push.account.${a.id}.muted`, 'false') === 'true',
      }))
    : [];

  return {
    status: 200,
    body: {
      inboxPushEnabled: enabled,
      quietHours: { enabled: quietEnabled, start, end, tz },
      perMinute,
      perHour,
      accounts: accountList,
    },
  };
}

function parsePositiveInt(raw: string | null, fallback: number): number {
  if (raw === null) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export interface NotificationPrefsBody {
  inboxPushEnabled?: boolean | undefined;
  quietHours?: {
    enabled?: boolean | undefined;
    start?: string | undefined;
    end?: string | undefined;
    tz?: string | undefined;
  } | undefined;
  perMinute?: number | undefined;
  perHour?: number | undefined;
  /** Map of accountId → muted boolean. Only listed ids are touched. */
  accounts?: Record<string, boolean> | undefined;
}

const HHMM_RE = /^([0-2]?\d):([0-5]\d)$/;
/** Throttle ranges keep a buggy UI from setting absurd values. */
const THROTTLE_MIN = 1;
const THROTTLE_MAX_PER_MINUTE = 10;
const THROTTLE_MAX_PER_HOUR = 60;

export function handleUpdateNotificationPrefs(
  deps: InboxApiDeps,
  body: NotificationPrefsBody,
): ApiResponse {
  if (typeof body.inboxPushEnabled === 'boolean') {
    deps.state.setSetting('push.inbox_enabled', body.inboxPushEnabled ? 'true' : 'false');
  }
  if (body.quietHours) {
    if (typeof body.quietHours.enabled === 'boolean') {
      deps.state.setSetting('push.quiet_hours_enabled', body.quietHours.enabled ? 'true' : 'false');
    }
    if (typeof body.quietHours.start === 'string' && HHMM_RE.test(body.quietHours.start)) {
      deps.state.setSetting('push.quiet_hours_start', body.quietHours.start);
    }
    if (typeof body.quietHours.end === 'string' && HHMM_RE.test(body.quietHours.end)) {
      deps.state.setSetting('push.quiet_hours_end', body.quietHours.end);
    }
    if (
      typeof body.quietHours.tz === 'string'
      && body.quietHours.tz.length > 0
      && body.quietHours.tz.length < 64
      && isValidIanaTz(body.quietHours.tz)
    ) {
      deps.state.setSetting('push.quiet_hours_tz', body.quietHours.tz);
    }
  }
  if (typeof body.perMinute === 'number' && Number.isFinite(body.perMinute)) {
    const clamped = Math.min(Math.max(Math.floor(body.perMinute), THROTTLE_MIN), THROTTLE_MAX_PER_MINUTE);
    deps.state.setSetting('push.per_minute', String(clamped));
  }
  if (typeof body.perHour === 'number' && Number.isFinite(body.perHour)) {
    const clamped = Math.min(Math.max(Math.floor(body.perHour), THROTTLE_MIN), THROTTLE_MAX_PER_HOUR);
    deps.state.setSetting('push.per_hour', String(clamped));
  }
  if (body.accounts && typeof body.accounts === 'object' && !Array.isArray(body.accounts)) {
    for (const [accountId, muted] of Object.entries(body.accounts)) {
      // Defensive: only allow alnum-ish account ids so a crafted key
      // can't collide with another setting namespace.
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(accountId)) continue;
      // Boolean guard — `"false"` (string) is truthy and would silently
      // flip mute=true under naive coercion.
      if (typeof muted !== 'boolean') continue;
      deps.state.setSetting(`push.account.${accountId}.muted`, muted ? 'true' : 'false');
    }
  }
  return handleGetNotificationPrefs(deps);
}

function isValidIanaTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function handleListItemAudit(deps: InboxApiDeps, id: string): ApiResponse {
  if (!deps.state.getItem(id)) return notFound('item');
  return { status: 200, body: { entries: deps.state.listAuditForItem(id) } };
}

/**
 * Mail-Context-Sidebar backing endpoint (PRD-INBOX-PHASE-4 §Mail-Context-
 * Sidebar). Deterministic, no LLM. All four sections come from local
 * state: same-sender items, open follow-ups by recipient, outbound
 * history (mail_sent_log), and active mail-anchored reminders.
 *
 * Sections are independent — a missing mail-context (older instance,
 * no outbound writes yet) returns empty arrays rather than failing the
 * whole envelope. UI hides empty sections inline (PRD §"per-section
 * empty states").
 */
export function handleGetItemContext(deps: InboxApiDeps, id: string): ApiResponse {
  const item = deps.state.getItem(id);
  if (!item) return notFound('item');
  // RFC 5321 §4.5.3 caps the local + domain at 320 chars; anything longer
  // is either malformed envelope data or a crafted DoS amplifier feeding
  // the LIKE-over-JSON path. Reject the lookup but still return the
  // (capped) sender so the UI renders something rather than 500.
  const fromValid = item.fromAddress.length > 0 && item.fromAddress.length <= 320;
  const recentThreads = fromValid
    ? deps.state.listRecentByFromAddress(item.fromAddress, {
        excludeItemId: id,
        tenantId: item.tenantId,
        limit: 5,
      })
    : [];
  const reminders = fromValid
    ? deps.state.listActiveRemindersByFromAddress(item.fromAddress, {
        excludeItemId: id,
        tenantId: item.tenantId,
        limit: 5,
      })
    : [];
  const openFollowups = fromValid && deps.mailContext
    ? deps.mailContext.stateDb.listOpenFollowupsForRecipient(item.fromAddress, 5)
    : [];
  const outboundHistory = fromValid && deps.mailContext
    ? deps.mailContext.stateDb.listOutboundForAddress(item.fromAddress, {
        tenantId: item.tenantId,
        limit: 5,
      })
    : [];
  return {
    status: 200,
    body: {
      sender: { address: item.fromAddress, name: item.fromName ?? null },
      recentThreads,
      openFollowups,
      outboundHistory,
      reminders,
    },
  };
}

export function handleGetCounts(deps: InboxApiDeps, query: { tenantId?: string | undefined } = {}): ApiResponse {
  // `counts` keeps its three-zone shape for back-compat with the existing
  // smoke spec and clients reading the contract. `snoozed` rides alongside
  // as a top-level field so the new Snoozed tab can render its badge.
  const counts = deps.state.countItemsByBucket(query.tenantId);
  const snoozed = deps.state.countSnoozedItems(query.tenantId);
  return { status: 200, body: { counts, snoozed } };
}

// ── Cold start ───────────────────────────────────────────────────────────

export function handleGetColdStart(deps: InboxApiDeps): ApiResponse {
  // Absence of the tracker is degraded-but-safe: an older runtime build
  // serving a newer UI gets an empty snapshot and the banner stays hidden.
  if (!deps.coldStartTracker) {
    return { status: 200, body: { active: [], recent: [] } };
  }
  return { status: 200, body: deps.coldStartTracker.getSnapshot() };
}

export interface RunColdStartBody {
  accountId: string;
  /**
   * Re-run for an account that already has items (default false). Needed
   * when the unified-inbox flag was enabled after the account was already
   * connected — `onAccountAdded` had no inbox runtime to dispatch to at
   * that point, so the historical mail was never backfilled.
   */
  force?: boolean | undefined;
}

/**
 * Operator-driven cold-start backfill. Fire-and-forget at the HTTP layer:
 * returns 202 once the runner has been scheduled. Progress shows up on
 * `GET /api/inbox/cold-start` as usual.
 */
export async function handleRunColdStart(
  deps: InboxApiDeps,
  body: RunColdStartBody,
): Promise<ApiResponse> {
  if (!deps.coldStartRunner) return unavailable('cold-start runner not wired');
  if (!deps.providerResolver) return unavailable('mail provider registry not wired');
  if (typeof body.accountId !== 'string' || body.accountId.length === 0) {
    return bad('accountId is required');
  }
  if (!deps.providerResolver(body.accountId)) {
    return unprocessable(`account "${body.accountId}" is not registered`, 'not_registered');
  }
  // Schedule the run without awaiting it — backfill can take many seconds
  // for a 200-envelope batch and the UI polls /cold-start for progress
  // already. Errors are surfaced through the tracker.
  void deps.coldStartRunner(body.accountId, body.force !== undefined ? { force: body.force } : {}).catch(() => {});
  return { status: 202, body: { ok: true, accountId: body.accountId } };
}

// ── Bulk actions (PRD-INBOX-PHASE-3 §"Bulk Actions") ────────────────────

export type BulkAction = Extract<InboxUserAction, 'archived' | 'snoozed' | 'unhandled'>;
const VALID_BULK_ACTIONS: ReadonlyArray<BulkAction> = ['archived', 'snoozed', 'unhandled'];

export interface BulkActionBody {
  ids: ReadonlyArray<string>;
  action: BulkAction;
}

/**
 * Apply one action to many items in a single transaction. Per-id rows
 * are written to `inbox_audit_log` (append-only) AND
 * `inbox_user_action_log` (mutation-allowed via `undone_at`). The
 * returned `bulkId` keys both the UNDO call and the in-UI toast.
 *
 * Items that don't exist or are already in the target state are
 * recorded in `skipped` rather than failing the whole batch — bulk
 * archive of 47 items still reports 45-applied + 2-skipped instead of
 * an all-or-nothing 500.
 */
export function handleBulkAction(deps: InboxApiDeps, body: BulkActionBody): ApiResponse {
  if (!Array.isArray(body.ids) || body.ids.length === 0) {
    return bad('ids: non-empty array required');
  }
  if (!VALID_BULK_ACTIONS.includes(body.action)) {
    return bad(`invalid action: ${String(body.action)}`);
  }
  const bulkId = `bulk_${String(Date.now())}_${Math.random().toString(36).slice(2, 10)}`;
  const performedAt = new Date();
  const applied: string[] = [];
  const skipped: { id: string; reason: string }[] = [];
  for (const id of body.ids) {
    const item = deps.state.getItem(id);
    if (item === null) {
      skipped.push({ id, reason: 'not_found' });
      continue;
    }
    if (item.userAction === body.action) {
      skipped.push({ id, reason: 'already_in_state' });
      continue;
    }
    deps.state.insertBulkActionLog({
      tenantId: item.tenantId,
      bulkId,
      itemId: id,
      priorUserAction: item.userAction ?? null,
      priorUserActionAt: item.userActionAt ?? null,
      action: body.action,
      performedAt,
    });
    deps.state.updateUserAction(id, body.action, performedAt);
    // 'unhandled' is a soft revert and is not in InboxAuditAction —
    // the inbox_user_action_log row already records the per-id state
    // change with the shared bulk_id, so we skip the audit row for it.
    if (body.action === 'archived' || body.action === 'snoozed') {
      deps.state.appendAudit({
        tenantId: item.tenantId,
        itemId: id,
        action: body.action,
        actor: 'user',
        payloadJson: JSON.stringify({ bulk_id: bulkId, at: performedAt.toISOString() }),
        createdAt: performedAt,
      });
    }
    applied.push(id);
  }
  return { status: 200, body: { bulkId, applied, skipped } };
}

/**
 * Reverse a bulk action within the UNDO window (default 60s). Returns
 * 410 once expired. The per-id `undone_at` flag on `inbox_user_action_log`
 * is the undo audit trail; we do NOT write per-item rows into
 * `inbox_audit_log` for the undo path (the FK there is per-item, and
 * the row's prior state is already snapshot in user_action_log).
 */
export function handleUndoBulk(deps: InboxApiDeps, bulkId: string): ApiResponse {
  const reverted = deps.state.undoBulkAction(bulkId);
  if (reverted === 0) {
    return { status: 410, body: { error: 'undo window expired or bulk_id unknown', reason: 'undo_expired' } };
  }
  return { status: 200, body: { ok: true, reverted } };
}

/** Last 5 undoable bulks within the UNDO window (PRD §"UNDO-Toast UX"). */
export function handleListRecentBulks(deps: InboxApiDeps): ApiResponse {
  const recent = deps.state.listRecentBulks();
  return { status: 200, body: { recent: recent.map((r) => ({
    bulkId: r.bulkId,
    action: r.action,
    performedAt: r.performedAt.toISOString(),
    itemCount: r.itemCount,
  })) } };
}

export interface RunBackfillMetadataBody {
  accountId: string;
}

/**
 * Module-level mutex for the v11 metadata backfill. PRD-3 requires
 * "rate-limited 1 concurrent per instance" so the IMAP load stays
 * bounded; subsequent requests get 409 until the in-flight run finishes.
 * Exported for tests that need to inspect/reset the flag.
 */
let _backfillInFlight = false;
export function _resetBackfillMutex(): void { _backfillInFlight = false; }

/**
 * Operator-driven envelope-metadata backfill. Fills the v11 columns
 * (from_address, from_name, subject, mail_date, snippet, message_id,
 * in_reply_to) on rows created before migration v11 landed. Sync from
 * the operator's perspective — the request blocks until the
 * provider.list() pass completes and the report is returned. The
 * tracker channel is intentionally NOT reused; backfill is a one-off
 * per-account operator action and the report shape (scanned / updated
 * / unmatched) is the operator's confirmation that the job succeeded.
 */
export async function handleRunBackfillMetadata(
  deps: InboxApiDeps,
  body: RunBackfillMetadataBody,
): Promise<ApiResponse> {
  if (!deps.backfillMetadataRunner) return unavailable('backfill runner not wired');
  if (!deps.providerResolver) return unavailable('mail provider registry not wired');
  if (typeof body.accountId !== 'string' || body.accountId.length === 0) {
    return bad('accountId is required');
  }
  if (!deps.providerResolver(body.accountId)) {
    return unprocessable(`account "${body.accountId}" is not registered`, 'not_registered');
  }
  if (_backfillInFlight) {
    return { status: 409, body: { error: 'backfill already in progress', reason: 'concurrent_backfill' } };
  }
  _backfillInFlight = true;
  try {
    const report = await deps.backfillMetadataRunner(body.accountId);
    return { status: 200, body: { ok: true, ...report } };
  } finally {
    _backfillInFlight = false;
  }
}

export interface SetActionBody {
  action: InboxUserAction | null;
  at?: string | undefined;
}

export function handleSetAction(deps: InboxApiDeps, id: string, body: SetActionBody): ApiResponse {
  if (body.action !== null && !VALID_USER_ACTIONS.includes(body.action)) {
    return bad(`invalid action: ${String(body.action)}`);
  }
  const at = body.at ? new Date(body.at) : null;
  if (body.at && Number.isNaN(at?.getTime())) return bad('invalid at: not an ISO date');
  const ok = deps.state.updateUserAction(id, body.action, at);
  if (!ok) return notFound('item');
  // Audit the user action so the UNDO + GDPR-export trails are complete.
  // 'unhandled' is the user actively un-marking a verdict; the audit
  // schema does not have a matching action so we record it as 'undo' with
  // the original intent preserved in the payload.
  if (body.action === null) {
    deps.state.appendAudit({
      itemId: id,
      action: 'undo',
      actor: 'user',
      payloadJson: JSON.stringify({ reverted_at: new Date().toISOString() }),
    });
  } else if (body.action === 'unhandled') {
    deps.state.appendAudit({
      itemId: id,
      action: 'undo',
      actor: 'user',
      payloadJson: JSON.stringify({
        intent: 'unhandled',
        at: (at ?? new Date()).toISOString(),
      }),
    });
  } else {
    deps.state.appendAudit({
      itemId: id,
      action: body.action,
      actor: 'user',
      payloadJson: JSON.stringify({ at: (at ?? new Date()).toISOString() }),
    });
  }
  return { status: 200, body: { ok: true } };
}

export type SnoozePreset = 'later_today' | 'tomorrow_morning' | 'monday_9am' | 'next_week';
const VALID_SNOOZE_PRESETS: ReadonlyArray<SnoozePreset> = [
  'later_today',
  'tomorrow_morning',
  'monday_9am',
  'next_week',
];

export interface SetSnoozeBody {
  /** Null clears the snooze. */
  until: string | null;
  /**
   * Optional named preset (PRD-INBOX-PHASE-3 §"Snooze Presets"). When set,
   * the server resolves to a deterministic timezone-aware `until` value
   * and ignores `until`. Pass `null` to fall back to the explicit `until`.
   */
  preset?: SnoozePreset | null | undefined;
  /**
   * Session timezone (IANA name, e.g. 'Europe/Zurich'). Server uses this
   * to anchor the preset resolution to the user's wall clock. Default
   * 'UTC' when absent — preset values will land at local UTC, which is
   * acceptable for `next_week`-grade granularity but not for the
   * `later_today` window.
   */
  timezone?: string | undefined;
  condition?: string | null | undefined;
  unsnoozeOnReply?: boolean | undefined;
  /**
   * When true, the reminder poller fires a notification at unsnooze time
   * instead of silently resurfacing the item. The flag is auto-cleared on
   * un-snooze (until=null). Defaults to false — preserves silent-snooze
   * semantics for callers that don't opt in.
   */
  notifyOnUnsnooze?: boolean | undefined;
}

/**
 * Resolve a named preset to a deterministic Date using the session
 * timezone (PRD-INBOX-PHASE-3 §"Snooze Presets"):
 *   - later_today      = +3h, capped at 23:00 local
 *   - tomorrow_morning = next 09:00 local
 *   - monday_9am       = next Monday 09:00 local (today if already past)
 *   - next_week        = +7d 09:00 local
 *
 * Implemented via Intl.DateTimeFormat to avoid pulling in a tz library
 * for a handful of midnight-aligned calculations.
 */
export function resolveSnoozePreset(
  preset: SnoozePreset,
  now: Date,
  timezone: string,
): Date {
  // Get the wall-clock components in the target timezone.
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(now).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  const year = Number.parseInt(parts['year']!, 10);
  const month = Number.parseInt(parts['month']!, 10);
  const day = Number.parseInt(parts['day']!, 10);
  const hour = Number.parseInt(parts['hour']!, 10);
  // Build a UTC date that *represents* the requested local wall-clock,
  // then re-anchor it to the timezone via offset math. For the
  // simple-granularity presets (09:00 etc.) we can construct the target
  // as if it were UTC and let the offset math correct it.
  const offsetMs = _timezoneOffsetMs(now, timezone);
  const buildLocal = (y: number, mo: number, d: number, h: number, mi: number): Date => {
    // Components are interpreted as the target-tz wall-clock; converting
    // to UTC means subtracting the timezone offset.
    return new Date(Date.UTC(y, mo - 1, d, h, mi, 0) - offsetMs);
  };
  if (preset === 'later_today') {
    const cap = buildLocal(year, month, day, 23, 0);
    const plus3h = new Date(now.getTime() + 3 * 60 * 60 * 1000);
    return plus3h.getTime() > cap.getTime() ? cap : plus3h;
  }
  if (preset === 'tomorrow_morning') {
    const tomorrow = buildLocal(year, month, day, 9, 0);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    return tomorrow;
  }
  if (preset === 'monday_9am') {
    // Compute "next Monday" in target tz. We need the local weekday;
    // Intl.DateTimeFormat doesn't expose it directly, derive via Date.
    const localNow = new Date(now.getTime() + offsetMs);
    const localWeekday = localNow.getUTCDay(); // 0=Sun ... 6=Sat
    let daysUntilMonday = (1 - localWeekday + 7) % 7;
    if (daysUntilMonday === 0 && hour >= 9) daysUntilMonday = 7;
    const target = buildLocal(year, month, day, 9, 0);
    target.setUTCDate(target.getUTCDate() + daysUntilMonday);
    return target;
  }
  // next_week
  const nextWeek = buildLocal(year, month, day, 9, 0);
  nextWeek.setUTCDate(nextWeek.getUTCDate() + 7);
  return nextWeek;
}

/**
 * Compute the offset (ms) between the given moment as observed in `timezone`
 * and UTC. Returns positive ms when the timezone is ahead of UTC.
 */
function _timezoneOffsetMs(at: Date, timezone: string): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(at).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  const utcTime = Date.UTC(
    Number.parseInt(parts['year']!, 10),
    Number.parseInt(parts['month']!, 10) - 1,
    Number.parseInt(parts['day']!, 10),
    Number.parseInt(parts['hour']!, 10),
    Number.parseInt(parts['minute']!, 10),
    Number.parseInt(parts['second']!, 10),
  );
  return utcTime - at.getTime();
}

export function handleSetSnooze(deps: InboxApiDeps, id: string, body: SetSnoozeBody): ApiResponse {
  let until: Date | null = null;
  // Preset wins over explicit `until` (PRD: "Body shape stays
  // backwards-compatible … `until` wins if preset null").
  if (body.preset !== null && body.preset !== undefined) {
    if (!VALID_SNOOZE_PRESETS.includes(body.preset)) {
      return bad(`invalid preset: ${String(body.preset)}`);
    }
    const tz = body.timezone ?? 'UTC';
    // `tz` ends up in `new Intl.DateTimeFormat({ timeZone })` which throws
    // RangeError on invalid IANA names. Validate up-front so a client
    // typo (or hostile input) returns 400 instead of an uncaught 500.
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
    } catch {
      return bad(`invalid timezone: ${tz}`);
    }
    until = resolveSnoozePreset(body.preset, new Date(), tz);
  } else if (body.until !== null) {
    until = new Date(body.until);
    if (Number.isNaN(until.getTime())) return bad('invalid until: not an ISO date');
  }
  const condition = body.condition ?? null;
  const unsnoozeOnReply = body.unsnoozeOnReply ?? true;
  const notifyOnUnsnooze = body.notifyOnUnsnooze ?? false;
  const ok = deps.state.setSnooze(id, until, condition, unsnoozeOnReply, notifyOnUnsnooze);
  if (!ok) return notFound('item');
  // Clearing the snooze is logically an undo; logging 'snoozed' on a clear
  // would corrupt the audit trail's meaning. Carry the prior intent in the
  // payload so downstream consumers can distinguish set vs unsnooze.
  deps.state.appendAudit({
    itemId: id,
    action: until === null ? 'undo' : 'snoozed',
    actor: 'user',
    payloadJson: JSON.stringify({
      intent: until === null ? 'unsnooze' : 'snooze',
      until: until?.toISOString() ?? null,
      condition,
      unsnooze_on_reply: unsnoozeOnReply,
      notify_on_unsnooze: notifyOnUnsnooze,
    }),
  });
  return { status: 200, body: { ok: true } };
}

// ── Drafts ───────────────────────────────────────────────────────────────
//
// LLM generation + send-via-mail live in separate slices — these handlers
// only persist + read against `inbox_drafts`.

/**
 * Per-field cap on `bodyMd`. The global request cap is 30 MB; without a
 * tighter per-field bound an authed client can persist 30 MB markdown
 * rows and bump `user_edits_count` per PATCH (disk-of-DOS via repeated
 * updates). 256 KB comfortably covers the largest real mail bodies plus
 * KG-context blocks while keeping a single draft row under one page.
 */
const MAX_BODY_MD_BYTES = 256 * 1024;

export interface CreateDraftBody {
  bodyMd: string;
  generatorVersion: string;
  /**
   * When set, marks the named draft as superseded in the same transaction
   * (the regenerate flow). The classifier-suggested draft and any
   * tone-button regenerations chain via this field.
   */
  supersededDraftId?: string | undefined;
  generatedAt?: string | undefined;
}

function tooLarge(message: string): ApiResponse {
  return { status: 413, body: { error: message } };
}

function checkBodyMd(bodyMd: unknown): ApiResponse | null {
  if (typeof bodyMd !== 'string' || bodyMd.length === 0) {
    return bad('bodyMd is required');
  }
  if (Buffer.byteLength(bodyMd, 'utf8') > MAX_BODY_MD_BYTES) {
    return tooLarge(`bodyMd exceeds ${MAX_BODY_MD_BYTES} bytes`);
  }
  return null;
}

export function handleGetItemDraft(deps: InboxApiDeps, itemId: string): ApiResponse {
  if (!deps.state.getItem(itemId)) return notFound('item');
  const draft = deps.state.getActiveDraftForItem(itemId);
  return { status: 200, body: { draft } };
}

export function handleGetDraft(deps: InboxApiDeps, id: string): ApiResponse {
  const draft = deps.state.getDraftById(id);
  return draft ? { status: 200, body: { draft } } : notFound('draft');
}

export function handleCreateDraft(
  deps: InboxApiDeps,
  itemId: string,
  body: CreateDraftBody,
): ApiResponse {
  const bodyErr = checkBodyMd(body.bodyMd);
  if (bodyErr) return bodyErr;
  if (typeof body.generatorVersion !== 'string' || body.generatorVersion.length === 0) {
    return bad('generatorVersion is required');
  }
  const generatedAt = body.generatedAt ? new Date(body.generatedAt) : new Date();
  if (body.generatedAt && Number.isNaN(generatedAt.getTime())) {
    return bad('invalid generatedAt: not an ISO date');
  }
  const item = deps.state.getItem(itemId);
  if (!item) return notFound('item');
  // Supersede target must belong to the same item — otherwise a bug in the
  // UI could supersede a draft from an unrelated thread.
  if (body.supersededDraftId !== undefined) {
    const prior = deps.state.getDraftById(body.supersededDraftId);
    if (!prior) return bad('supersededDraftId not found');
    if (prior.itemId !== itemId) return bad('supersededDraftId belongs to a different item');
  }
  // Inherit tenant from the parent item — never from the wire — so the
  // route can't be used to write a draft into a different tenant's scope
  // once Phase-5 team-inbox lifts the single-tenant assumption.
  const input: Parameters<typeof deps.state.insertDraftAndAttach>[0] = {
    itemId,
    bodyMd: body.bodyMd,
    generatedAt,
    generatorVersion: body.generatorVersion,
    tenantId: item.tenantId,
  };
  if (body.supersededDraftId !== undefined) input.supersededDraftId = body.supersededDraftId;
  const id = deps.state.insertDraftAndAttach(input);
  const draft = deps.state.getDraftById(id);
  return { status: 201, body: { draft } };
}

function unavailable(message: string): ApiResponse {
  return { status: 503, body: { error: message } };
}

function unprocessable(message: string, reason?: string): ApiResponse {
  return { status: 422, body: reason ? { error: message, reason } : { error: message } };
}

function tooManyRequests(retryAt: Date): ApiResponse {
  // Date header in the body so clients can render a localised "retry in
  // X" hint without parsing an HTTP-only Retry-After header (the route
  // adapter could echo it via headers too — kept body-only for shape
  // symmetry with the other handlers' responses).
  return {
    status: 429,
    body: {
      error: 'rate limit exceeded for draft generation',
      reason: 'rate_limit',
      retryAt: retryAt.toISOString(),
    },
  };
}

/**
 * Minimum cached-body length below which generation is short-circuited.
 * A 5-character snippet ("yes." or "ok thx") cannot drive a meaningful
 * reply and would still spend ~5K tokens of LLM cost — the gate trades
 * a 422 for an unproductive call.
 */
const MIN_BODY_FOR_GENERATION = 20;

const VALID_TONES = ['shorter', 'formal', 'warmer', 'regenerate'] as const;
type ValidTone = typeof VALID_TONES[number];
function isValidTone(value: unknown): value is ValidTone {
  return typeof value === 'string' && (VALID_TONES as ReadonlyArray<string>).includes(value);
}

/** Same defense-in-depth ceiling the per-field cap uses; rewrite prompts must not exceed it. */
const MAX_PREVIOUS_BODY_BYTES = 256 * 1024;

export interface GenerateDraftBody {
  /** Tone modifier — only honoured together with `previousBodyMd`. */
  tone?: 'shorter' | 'formal' | 'warmer' | 'regenerate' | undefined;
  /** Caller-supplied previous draft (typically the live editor buffer). */
  previousBodyMd?: string | undefined;
}

/**
 * Generate a draft body via the inbox LLM. Does NOT persist — the UI
 * follows up with `handleCreateDraft` to commit the resulting bodyMd
 * into `inbox_drafts`. This split lets the UI show a "regenerate"
 * affordance without polluting the supersede chain.
 *
 * When `body.tone` + `body.previousBodyMd` are both set, the generator
 * rewrites the previous draft using the chosen tone modifier (the
 * "Kürzer / Förmlicher / Wärmer / Regenerate" flow). Either field
 * alone falls back to first-time generation.
 *
 * Returns 503 when the LLM caller is not wired (e.g. flag on but no
 * provider credentials). Returns 422 when the cached body is missing
 * or too short — historical items predating migration v10 may not have
 * one; sensitive-mode='skip' items intentionally cache nothing.
 */
export async function handleGenerateDraft(
  deps: InboxApiDeps,
  itemId: string,
  body: GenerateDraftBody = {},
): Promise<ApiResponse> {
  if (!deps.llm) return unavailable('draft generator not configured');
  if (body.tone !== undefined && !isValidTone(body.tone)) {
    return bad(`invalid tone: ${String(body.tone)}`);
  }
  if (body.previousBodyMd !== undefined) {
    if (typeof body.previousBodyMd !== 'string') return bad('previousBodyMd must be a string');
    if (Buffer.byteLength(body.previousBodyMd, 'utf8') > MAX_PREVIOUS_BODY_BYTES) {
      return tooLarge(`previousBodyMd exceeds ${MAX_PREVIOUS_BODY_BYTES} bytes`);
    }
  }
  const item = deps.state.getItem(itemId);
  if (!item) return notFound('item');
  // Rate-limit check fires AFTER existence + shape validation so 400/404
  // can't be used as a probing oracle that bypasses the limit.
  if (deps.generateRateLimiter) {
    const gate = deps.generateRateLimiter.check(item.accountId);
    if (!gate.ok && gate.retryAt) return tooManyRequests(gate.retryAt);
  }
  // Both email and WA items have a cached body — the classifier writes
  // the snippet for either channel and Reload optionally fetches the
  // full body. KNOWN LIMITATION: `buildGeneratorPrompt` still emits
  // email-flavoured labels ("Antwortendes Postfach", "Betreff …") for
  // WA items; channel-aware prompt branching is a follow-up. WA-pilot
  // v1 produces usable drafts via the LLM picking the channel up from
  // the transcript format in the body.
  const cached = deps.state.getItemBody(itemId);
  if (!cached || cached.bodyMd.length < MIN_BODY_FOR_GENERATION) {
    return unprocessable('cached body too short to draft from — refetch the mail first');
  }
  const account = deps.accountResolver?.resolve(item.accountId);
  if (!account) return unprocessable('account not resolvable — cannot build a signature');
  const { generateDraft } = await import('./generator.js');
  // Best-effort sender extraction: the classifier prompt input we cached
  // does not preserve the From header on inbox_items; for v1 the prompt
  // surfaces a generic greeting via empty fromAddress and relies on the
  // cached body's leading text. A future schema enhancement can
  // preserve From and feed it here.
  const input: Parameters<typeof generateDraft>[0] = {
    item: { id: item.id, reasonDe: item.reasonDe, channel: item.channel },
    fromAddress: '',
    accountAddress: account.address,
    accountDisplayName: account.displayName,
    subject: undefined,
    body: cached.bodyMd,
  };
  if (body.previousBodyMd !== undefined) input.previousBodyMd = body.previousBodyMd;
  if (body.tone !== undefined) input.tone = body.tone;
  const result = await generateDraft(input, deps.llm);
  // Observability hook — record that a generation happened, with enough
  // payload to reconstruct cost-attribution (generatorVersion gates which
  // prompt was sent; bodyTruncated reveals when the LLM saw a clipped
  // body; tone tells whether this was a rewrite or a fresh draft).
  deps.state.appendAudit({
    itemId: item.id,
    tenantId: item.tenantId,
    action: 'generation_requested',
    actor: 'user',
    payloadJson: JSON.stringify({
      generatorVersion: result.generatorVersion,
      bodyTruncated: result.bodyTruncated,
      tone: body.tone ?? null,
    }),
  });
  return {
    status: 200,
    body: { bodyMd: result.bodyMd, generatorVersion: result.generatorVersion, bodyTruncated: result.bodyTruncated },
  };
}

/**
 * Pull the full mail body from the provider and overwrite the cached
 * snippet for an item. Does NOT touch the draft — generation/edit
 * proceeds normally afterward, just with richer context. Routes
 * on `item.channel`: email → MailProvider list+fetch, whatsapp →
 * WhatsAppStateDb thread-message concat.
 */
export async function handleRefreshItemBody(
  deps: InboxApiDeps,
  itemId: string,
): Promise<ApiResponse> {
  const item = deps.state.getItem(itemId);
  if (!item) return notFound('item');
  const { refreshItemBody, refreshWhatsappItemBody } = await import('./body-refresh.js');
  let result;
  if (item.channel === 'email') {
    if (!deps.providerResolver) return unavailable('mail provider registry not wired');
    const provider = deps.providerResolver(item.accountId);
    if (!provider) return unprocessable('mail provider not registered for this account', 'not_registered');
    result = await refreshItemBody({
      provider,
      state: deps.state,
      item: {
        id: item.id,
        accountId: item.accountId,
        threadKey: item.threadKey,
        channel: item.channel,
        // v11 metadata narrows the IMAP search to ±7d around the known date
        // and lets us match the envelope by Message-ID directly instead of
        // reconstructing the threadKey across providers.
        ...(item.mailDate !== undefined ? { mailDate: item.mailDate } : {}),
        ...(item.messageId !== undefined && item.messageId !== '' ? { messageId: item.messageId } : {}),
        // Subject feeds the sensitive-content masker (OTP keyword detection).
        ...(item.subject !== undefined && item.subject !== '' ? { subject: item.subject } : {}),
      },
      ...(deps.sensitiveMode !== undefined ? { sensitiveMode: deps.sensitiveMode } : {}),
    });
  } else {
    if (!deps.whatsappStore) return unavailable('whatsapp message store not wired');
    result = await refreshWhatsappItemBody({
      waState: deps.whatsappStore,
      state: deps.state,
      item: {
        id: item.id,
        threadKey: item.threadKey,
        channel: item.channel,
        ...(item.subject !== undefined && item.subject !== '' ? { subject: item.subject } : {}),
      },
      ...(deps.sensitiveMode !== undefined ? { sensitiveMode: deps.sensitiveMode } : {}),
    });
  }
  if (!result.ok) {
    switch (result.reason.kind) {
      case 'not_found':
        return { status: 404, body: { error: 'thread no longer available' } };
      case 'empty_body':
        return unprocessable('thread has no text content to refresh from', 'empty_body');
      case 'fetch_failed':
        return { status: 502, body: { error: 'provider fetch failed' } };
    }
  }
  return {
    status: 200,
    body: {
      bodyMd: result.bodyMd,
      source: result.source,
      bytesWritten: result.bytesWritten,
      truncated: result.truncated,
    },
  };
}

/**
 * Send the draft as a reply to its parent inbox item. Reuses the shared
 * `sendMail` pipeline from `mail/send-core.ts` so the inbox path gets
 * the same rate-limit, secret-scan, recipient-dedup, and follow-up
 * mechanics the agent's `mail_send` tool runs. The UI button click is
 * the user confirmation; no agent.promptUser modal — the textarea
 * already showed the body for review.
 *
 * Routes only the email channel. WhatsApp send is a follow-up slice
 * (needs the WA provider's own outbound API + recipient-from-phone
 * resolution).
 */
export interface SendInboxReplyBody {
  /**
   * Optional override of the body the user wants to send. If absent,
   * uses the draft's persistedBody. Lets the UI flush the live buffer
   * via this field instead of an extra PATCH first.
   */
  body?: string | undefined;
  /**
   * Future-proof: an inbox reply is always single-recipient (the
   * original sender). cc/bcc would route around the mass-send
   * guard `sendMail`'s `beforeSend` hook enforces, and the pane has
   * no UI for them today — accepted only so a future schema bump
   * doesn't silently break the field on the wire.
   */
  cc?: ReadonlyArray<string> | undefined;
  bcc?: ReadonlyArray<string> | undefined;
  /**
   * Send Later — when set to a future ISO timestamp, queue the send into
   * `mail_scheduled` instead of firing immediately. The mail-scheduled
   * poller picks it up at the scheduled time. Past + invalid values
   * return 400 — sending in the past is the same as "now" and that's
   * what the unset case is for.
   */
  scheduledAt?: string | undefined;
}

export async function handleSendInboxReply(
  deps: InboxApiDeps,
  draftId: string,
  body: SendInboxReplyBody = {},
): Promise<ApiResponse> {
  const mailCtx = deps.mailContext;
  if (!mailCtx) return unavailable('mail context not wired');
  // Hard reject cc/bcc — mass-send guard depends on a `beforeSend`
  // hook that the inbox-pane intentionally omits. If a future UI
  // pane exposes cc/bcc, that lands together with a confirmation
  // affordance, not silently.
  if ((body.cc?.length ?? 0) > 0 || (body.bcc?.length ?? 0) > 0) {
    return bad('inbox reply does not support cc/bcc — single-recipient only in v1');
  }
  const draft = deps.state.getDraftById(draftId);
  if (!draft) return notFound('draft');
  const item = deps.state.getItem(draft.itemId);
  if (!item) return notFound('item');
  if (item.channel !== 'email') {
    return { status: 501, body: { error: `send not supported for channel: ${item.channel}` } };
  }
  const replyBody = (body.body ?? draft.bodyMd).trim();
  // Structured 422 so the UI's discriminated `empty_body` kind fires
  // the dedicated "Cannot send an empty draft" copy instead of the
  // generic 400 → network fallback toast.
  if (replyBody.length === 0) return unprocessable('reply body is empty', 'empty_body');

  const provider = mailCtx.registry.get(item.accountId);
  if (!provider) return unprocessable('mail provider not registered for this account', 'not_registered');

  // Find the original envelope so we can reply To: the sender, with the
  // original subject + In-Reply-To/References headers for threading.
  // Reuses the same list+match strategy as body-refresh — bounded by
  // the 30-day lookup window.
  const since = new Date(Date.now() - 30 * 86_400_000);
  const { resolveThreadKey } = await import('./watcher-hook.js');
  let envelope;
  try {
    const envelopes = await provider.list({ since, limit: 200 });
    envelope = envelopes.find((env) => resolveThreadKey(env) === item.threadKey);
  } catch {
    return { status: 502, body: { error: 'provider lookup failed' } };
  }
  if (!envelope) {
    return { status: 404, body: { error: 'original mail no longer available — cannot construct reply headers' } };
  }
  const fromAddress = envelope.from[0]?.address;
  if (!fromAddress) {
    // No usable From header — envelope is functionally not-found for
    // reply construction. 404 with a clear message; structured-422
    // would falsely surface as "empty_body" in the UI.
    return { status: 404, body: { error: 'original mail has no sender address — cannot construct reply headers' } };
  }

  const subject = envelope.subject.startsWith('Re: ') || envelope.subject.startsWith('RE: ')
    ? envelope.subject
    : `Re: ${envelope.subject || '(kein Betreff)'}`;

  const { sendMail } = await import('../mail/send-core.js');
  const coreInput: import('../mail/send-core.js').SendCoreInput = {
    account: provider.accountId,
    to: [{ address: fromAddress, ...(envelope.from[0]?.name !== undefined ? { name: envelope.from[0]!.name! } : {}) }],
    subject,
    body: replyBody,
  };
  if (envelope.messageId) coreInput.inReplyTo = envelope.messageId;
  // Threading: References = whatever the original had, append the
  // original Message-ID so a downstream client can rebuild the chain.
  // We don't have the original's References header here (envelopes
  // omit it for size); a future provider.fetch could supply it. For
  // v1 we just set References = inReplyTo, which is the most common
  // single-message-deep reply shape.
  if (envelope.messageId) coreInput.references = envelope.messageId;

  // Send Later — short-circuit before sendMail when scheduledAt set.
  if (body.scheduledAt !== undefined) {
    const scheduledAt = new Date(body.scheduledAt);
    if (Number.isNaN(scheduledAt.getTime())) return bad('invalid scheduledAt: not an ISO date');
    if (scheduledAt.getTime() <= Date.now()) return bad('scheduledAt must be in the future');
    const scheduledInput: import('../mail/state.js').ScheduledSendInput = {
      accountId: provider.accountId,
      to: coreInput.to,
      subject,
      bodyMd: replyBody,
      scheduledAt,
      replyInboxItemId: item.id,
    };
    if (envelope.messageId) scheduledInput.inReplyTo = envelope.messageId;
    const scheduledId = mailCtx.stateDb.insertScheduledSend(scheduledInput);
    return {
      status: 202,
      body: {
        ok: true,
        scheduled: true,
        scheduledId,
        scheduledAt: scheduledAt.toISOString(),
      },
    };
  }

  // Keep the cross-session rate-limit gate: it's the account-wide
  // ceiling that protects against a stolen-session spam-vector
  // (one send per item per dedup-window would let an attacker fire
  // thousands of replies/hour without it). Manual user clicks won't
  // hit the 60/min cap in practice.
  const result = await sendMail(mailCtx.registry, coreInput, {}, mailCtx);

  if (!result.ok) {
    switch (result.status) {
      case 'rate_limit':         return { status: 429, body: { error: result.message } };
      case 'invalid_recipients': return unprocessable(result.message);
      case 'receive_only':       return unprocessable(result.message, 'receive_only');
      case 'dedup_window':       return { status: 429, body: { error: result.message } };
      case 'secret_in_body':     return unprocessable(result.message, 'secret_in_body');
      case 'cancelled':          return { status: 409, body: { error: 'send cancelled' } };
      case 'provider_error':     return { status: 502, body: { error: result.message } };
      default: {
        // Compile-time exhaustiveness: adding a new SendCoreFailureStatus
        // variant fails this branch and surfaces the omission at build
        // time instead of silently returning undefined at runtime.
        const _exhaustive: never = result.status;
        return { status: 500, body: { error: `unhandled send-core status: ${String(_exhaustive)}` } };
      }
    }
  }

  // Mark the inbox item as replied + audit. The UI then transitions
  // the item out of the Needs-You zone on next list refresh. If the
  // item vanished between the earlier getItem() and now (Art-17 race),
  // skip the audit so it never references a missing row.
  if (!deps.state.updateUserAction(item.id, 'replied')) {
    return notFound('item');
  }
  deps.state.appendAudit({
    itemId: item.id,
    action: 'replied',
    actor: 'user',
    payloadJson: JSON.stringify({
      draft_id: draft.id,
      message_id: result.result.messageId,
      accepted: result.result.accepted,
      rejected: result.result.rejected,
    }),
  });

  return {
    status: 200,
    body: {
      messageId: result.result.messageId,
      accepted: result.result.accepted,
      rejected: result.result.rejected,
    },
  };
}

// ── Compose-new send (PRD-INBOX-PHASE-3 §"Compose-New") ──────────────────

export interface ComposeSendBody {
  /** Sender account id — must be a registered mail account. */
  accountId: string;
  /** Comma-separated address list; parsed via send-core's helper. */
  to: string;
  cc?: string | undefined;
  bcc?: string | undefined;
  subject: string;
  body: string;
}

/**
 * One-shot send for a compose-new (no parent inbox item). Mirrors the
 * reply path but skips draft persistence + audit anchoring. Mass-send
 * guard fires for >5 total recipients via send-core's beforeSend hook
 * (PRD §"Send-time confirmation" round-2 C-S13). The client must
 * confirm before re-POSTing with `confirmedAt: now` — Phase 4 will
 * wire that pre-flight; v1 trusts the UI's recipient cap.
 */
export async function handleComposeSend(
  deps: InboxApiDeps,
  body: ComposeSendBody,
): Promise<ApiResponse> {
  const mailCtx = deps.mailContext;
  if (!mailCtx) return unavailable('mail context not wired');
  if (typeof body.accountId !== 'string' || body.accountId.length === 0) {
    return bad('accountId is required');
  }
  if (typeof body.to !== 'string' || body.to.trim().length === 0) {
    return bad('to is required');
  }
  if (typeof body.subject !== 'string') return bad('subject is required');
  const replyBody = (body.body ?? '').trim();
  if (replyBody.length === 0) return unprocessable('compose body is empty', 'empty_body');

  const provider = mailCtx.registry.get(body.accountId);
  if (!provider) {
    return unprocessable('mail provider not registered for this account', 'not_registered');
  }

  const { parseAddressList, sendMail } = await import('../mail/send-core.js');
  const to = parseAddressList(body.to);
  if (to.length === 0) return bad('to: no valid addresses');
  const cc = body.cc !== undefined ? parseAddressList(body.cc) : [];
  const bcc = body.bcc !== undefined ? parseAddressList(body.bcc) : [];

  const coreInput: import('../mail/send-core.js').SendCoreInput = {
    account: provider.accountId,
    to,
    subject: body.subject,
    body: replyBody,
  };
  if (cc.length > 0) coreInput.cc = cc;
  if (bcc.length > 0) coreInput.bcc = bcc;

  const result = await sendMail(mailCtx.registry, coreInput, {}, mailCtx);
  if (!result.ok) {
    switch (result.status) {
      case 'rate_limit':         return { status: 429, body: { error: result.message } };
      case 'invalid_recipients': return unprocessable(result.message);
      case 'receive_only':       return unprocessable(result.message, 'receive_only');
      case 'dedup_window':       return { status: 429, body: { error: result.message } };
      case 'secret_in_body':     return unprocessable(result.message, 'secret_in_body');
      case 'cancelled':          return { status: 409, body: { error: 'send cancelled' } };
      case 'provider_error':     return { status: 502, body: { error: result.message } };
      default: {
        const _exhaustive: never = result.status;
        return { status: 500, body: { error: `unhandled send-core status: ${String(_exhaustive)}` } };
      }
    }
  }
  return {
    status: 200,
    body: {
      messageId: result.result.messageId,
      accepted: result.result.accepted,
      rejected: result.result.rejected,
    },
  };
}

export interface UpdateDraftBody {
  bodyMd: string;
}

export function handleUpdateDraft(
  deps: InboxApiDeps,
  id: string,
  body: UpdateDraftBody,
): ApiResponse {
  const bodyErr = checkBodyMd(body.bodyMd);
  if (bodyErr) return bodyErr;
  const ok = deps.state.updateDraftBody(id, body.bodyMd);
  if (!ok) return notFound('draft');
  return { status: 200, body: { draft: deps.state.getDraftById(id) } };
}

// ── Contacts ─────────────────────────────────────────────────────────────

export function handleResolveContact(deps: InboxApiDeps, email: string): ApiResponse {
  if (!deps.contactResolver) return { status: 200, body: { contact: null } };
  return { status: 200, body: { contact: deps.contactResolver.resolve(email) } };
}

// ── Rules ────────────────────────────────────────────────────────────────

export interface ListRulesQuery {
  accountId: string;
  tenantId?: string | undefined;
}

export function handleListRules(deps: InboxApiDeps, query: ListRulesQuery): ApiResponse {
  if (!query.accountId) return bad('accountId is required');
  return {
    status: 200,
    body: { rules: deps.state.listRulesForAccount(query.accountId, query.tenantId) },
  };
}

export interface CreateRuleBody {
  accountId: string;
  matcherKind: InboxRuleMatcherKind;
  matcherValue: string;
  bucket: 'requires_user' | 'auto_handled';
  action: InboxRuleAction;
  source: InboxRuleSource;
  tenantId?: string | undefined;
}

export function handleCreateRule(deps: InboxApiDeps, body: CreateRuleBody): ApiResponse {
  if (!body.accountId) return bad('accountId is required');
  if (!VALID_MATCHER_KINDS.includes(body.matcherKind)) return bad('invalid matcherKind');
  if (!body.matcherValue || body.matcherValue.trim().length === 0) {
    return bad('matcherValue is required');
  }
  if (!VALID_RULE_BUCKETS.includes(body.bucket)) return bad('invalid bucket for rule');
  if (!VALID_RULE_ACTIONS.includes(body.action)) return bad('invalid action');
  if (!VALID_RULE_SOURCES.includes(body.source)) return bad('invalid source');
  const id = deps.state.insertRule({
    accountId: body.accountId,
    matcherKind: body.matcherKind,
    matcherValue: body.matcherValue.trim(),
    bucket: body.bucket,
    action: body.action,
    source: body.source,
    tenantId: body.tenantId,
  });
  deps.rules?.invalidate(body.accountId, body.tenantId);
  return { status: 201, body: { id } };
}

export function handleDeleteRule(deps: InboxApiDeps, id: string): ApiResponse {
  if (!deps.state.deleteRule(id)) return notFound('rule');
  // Cannot pinpoint the (tenant, account) of a deleted rule cheaply, so
  // drop the entire rule cache. Rule mutations are user-triggered and
  // infrequent; a coarse invalidation is acceptable.
  deps.rules?.invalidateAll();
  return { status: 204, body: null };
}
