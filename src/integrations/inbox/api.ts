// === Inbox HTTP handlers (pure) ===
//
// Pure async handlers for the `/api/inbox/*` surface. Each one takes a
// `deps` object and a parsed input shape and returns a JSON-ready
// `{status, body}` envelope. The actual route registration in
// `src/server/http-api.ts` is wired in a follow-up PR — keeping the
// handlers framework-free here means Phase-1a tests don't need to spin
// up the full HTTP server, and the same handlers will plug into a
// future REST OR an MCP-tool surface unchanged.
//
// Validation is shallow on purpose: zod-style schemas live one layer up
// (the route adapter parses bodies before calling these). The handlers
// only check the shape they cannot ignore — invalid bucket strings,
// out-of-range pagination, missing required fields.

import type {
  InboxBucket,
  InboxRuleAction,
  InboxRuleMatcherKind,
  InboxRuleSource,
  InboxUserAction,
} from '../../types/index.js';
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
}

function parseInt32(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = typeof value === 'number' ? value : parseInt(value, 10);
  return Number.isFinite(n) ? n : undefined;
}

export function handleListItems(deps: InboxApiDeps, query: ListItemsQuery): ApiResponse {
  const opts: ListItemsOptions = {};
  if (query.bucket !== undefined) {
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
  return { status: 200, body: { items: deps.state.listItems(opts) } };
}

export function handleGetItem(deps: InboxApiDeps, id: string): ApiResponse {
  const item = deps.state.getItem(id);
  return item ? { status: 200, body: { item } } : notFound('item');
}

export function handleListItemAudit(deps: InboxApiDeps, id: string): ApiResponse {
  if (!deps.state.getItem(id)) return notFound('item');
  return { status: 200, body: { entries: deps.state.listAuditForItem(id) } };
}

export function handleGetCounts(deps: InboxApiDeps, query: { tenantId?: string | undefined } = {}): ApiResponse {
  return { status: 200, body: { counts: deps.state.countItemsByBucket(query.tenantId) } };
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

export interface SetSnoozeBody {
  /** Null clears the snooze. */
  until: string | null;
  condition?: string | null | undefined;
  unsnoozeOnReply?: boolean | undefined;
}

export function handleSetSnooze(deps: InboxApiDeps, id: string, body: SetSnoozeBody): ApiResponse {
  let until: Date | null = null;
  if (body.until !== null) {
    until = new Date(body.until);
    if (Number.isNaN(until.getTime())) return bad('invalid until: not an ISO date');
  }
  const condition = body.condition ?? null;
  const unsnoozeOnReply = body.unsnoozeOnReply ?? true;
  const ok = deps.state.setSnooze(id, until, condition, unsnoozeOnReply);
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
    }),
  });
  return { status: 200, body: { ok: true } };
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
