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

// ── Cold start ───────────────────────────────────────────────────────────

export function handleGetColdStart(deps: InboxApiDeps): ApiResponse {
  // Absence of the tracker is degraded-but-safe: an older runtime build
  // serving a newer UI gets an empty snapshot and the banner stays hidden.
  if (!deps.coldStartTracker) {
    return { status: 200, body: { active: [], recent: [] } };
  }
  return { status: 200, body: deps.coldStartTracker.getSnapshot() };
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

// ── Drafts ───────────────────────────────────────────────────────────────
//
// Phase-2 surface: state-layer CRUD over the existing `inbox_drafts` table.
// LLM generation + send-via-mail-tool live in separate slices — these
// handlers persist and read drafts but do not invoke the model or the
// outbound mail tool. That keeps the surface easy to drive from the UI
// (which can already render an "empty draft" affordance and a regenerate
// button against this layer) and reviewable in isolation.

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
  tenantId?: string | undefined;
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
  if (typeof body.bodyMd !== 'string' || body.bodyMd.length === 0) {
    return bad('bodyMd is required');
  }
  if (typeof body.generatorVersion !== 'string' || body.generatorVersion.length === 0) {
    return bad('generatorVersion is required');
  }
  const generatedAt = body.generatedAt ? new Date(body.generatedAt) : new Date();
  if (body.generatedAt && Number.isNaN(generatedAt.getTime())) {
    return bad('invalid generatedAt: not an ISO date');
  }
  if (!deps.state.getItem(itemId)) return notFound('item');
  // Supersede target must belong to the same item — otherwise a bug in the
  // UI could supersede a draft from an unrelated thread.
  if (body.supersededDraftId !== undefined) {
    const prior = deps.state.getDraftById(body.supersededDraftId);
    if (!prior) return bad('supersededDraftId not found');
    if (prior.itemId !== itemId) return bad('supersededDraftId belongs to a different item');
  }
  const input: Parameters<typeof deps.state.insertDraft>[0] = {
    itemId,
    bodyMd: body.bodyMd,
    generatedAt,
    generatorVersion: body.generatorVersion,
  };
  if (body.supersededDraftId !== undefined) input.supersededDraftId = body.supersededDraftId;
  if (body.tenantId !== undefined) input.tenantId = body.tenantId;
  const id = deps.state.insertDraft(input);
  // Attach the fresh draft so `inbox_items.draft_id` always points at the
  // active one. The UI lists items by bucket; without this, "Drafted for
  // You" would not know which draft to render after a regenerate.
  deps.state.attachDraft(itemId, id);
  const draft = deps.state.getDraftById(id);
  return { status: 201, body: { draft } };
}

export interface UpdateDraftBody {
  bodyMd: string;
}

export function handleUpdateDraft(
  deps: InboxApiDeps,
  id: string,
  body: UpdateDraftBody,
): ApiResponse {
  if (typeof body.bodyMd !== 'string' || body.bodyMd.length === 0) {
    return bad('bodyMd is required');
  }
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
