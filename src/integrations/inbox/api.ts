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
      },
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
      },
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
