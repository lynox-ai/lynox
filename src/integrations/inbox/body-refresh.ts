// === Inbox body-refresh adapters — pull the full conversation on demand ===
//
// Two flavours sharing the same `inbox_item_bodies` cache + truncation:
//
//   refreshItemBody          — email items: `provider.list({since:30d})`
//                              then `provider.fetch({uid})` for the matched
//                              envelope's full text body.
//   refreshWhatsappItemBody  — WA items: pulls the last N messages of the
//                              thread from `WhatsAppStateDb` and concatenates
//                              them as a "Gegenüber:" / "Ich:" transcript.
//
// Both paths trim + clamp to `MAX_ITEM_BODY_CHARS` BEFORE handing the
// body back to `state.saveItemBody` so `bytesWritten` reports what
// actually hit the cache.
//
// Why list+fetch instead of fetch-by-id for email: `MailProvider.fetch()`
// takes a UID, but `inbox_items.thread_key` stores either a provider-set
// threading id or a synthesised key — not the UID. The list() call
// returns recent envelopes including their UIDs; we match by
// `resolveThreadKey(env) === item.threadKey` and then fetch the matched
// envelope's UID. Cross-provider clean.

import type { MailEnvelope, MailProvider } from '../mail/provider.js';
import { analyzeSensitiveContent, type SensitiveMode } from './sensitive-content.js';
import { MAX_ITEM_BODY_CHARS, type InboxStateDb } from './state.js';
import { resolveThreadKey } from './watcher-hook.js';
import type { WhatsAppMessage } from '../whatsapp/types.js';

/**
 * Subset of `WhatsAppStateDb` the WA refresh path consumes. Structural
 * dependency so tests can pass a minimal stub instead of standing up
 * the WA state DB + schema migration.
 */
export interface WhatsAppMessageStore {
  getMessagesForThread(threadId: string, limit?: number): WhatsAppMessage[];
}

/** How many recent thread messages we concatenate for the refreshed body. */
const WA_MESSAGE_FETCH_LIMIT = 50;

/** Window for the provider.list() probe when the item has no `mailDate`. */
const DEFAULT_LOOKUP_DAYS = 30;
/** Slack around a known `mailDate`: IMAP returns INTERNALDATE, the envelope
  *  has the Date header — these can disagree by hours across timezones. ±7d
 *  is generous enough to absorb that without re-introducing the limit problem. */
const DATE_SLACK_DAYS = 7;
/** Hard upper bound on the envelope batch. Was 200; rafael's canary had 93
 *  threads in the last 30 days, so a busy inbox can easily exceed the cap
 *  and silently drop the target mail with a misleading "30 Tage" toast. */
const DEFAULT_LIST_LIMIT = 1000;

export type RefreshBodyFailure =
  | { kind: 'not_found' }       // no envelope in the lookup window matches threadKey
  | { kind: 'fetch_failed' }    // provider raised (auth, transport)
  | { kind: 'empty_body' };     // mail exists but has no text body to surface

export interface RefreshItemBodyOptions {
  provider: MailProvider;
  state: InboxStateDb;
  item: {
    id: string;
    accountId: string;
    threadKey: string;
    channel: 'email' | 'whatsapp';
    /** v11 envelope date — narrows the lookup window from 30d → ±7d around this. */
    mailDate?: Date | undefined;
    /** v11 RFC 5322 Message-ID — used for direct envelope match before falling back to threadKey. */
    messageId?: string | undefined;
    /** Subject of the item — fed to the sensitive-content masker when mode='mask'.
     *  The masker reads both subject + body to catch OTP keywords; passing only
     *  body would under-detect. Optional because some pre-v11 items have no
     *  subject; the masker treats empty subject as neutral. */
    subject?: string | undefined;
  };
  /** Override the 30-day lookup window — tests pass small values. */
  lookupDays?: number | undefined;
  listLimit?: number | undefined;
  /** When 'mask', re-run the sensitive-content masker on the refreshed body
   *  before saveItemBody. Without this the classifier saw a masked snippet
   *  but the refresh-path persisted unmasked content, so the generator could
   *  later see OTPs/IBANs that were blocked at classify time. Defaults to
   *  'allow' (no masking) to keep tests deterministic; callers in api.ts
   *  thread the real env-driven value through. */
  sensitiveMode?: SensitiveMode | undefined;
}

export interface RefreshItemBodyResult {
  ok: true;
  /** The body actually written to the cache — already truncated to MAX_ITEM_BODY_CHARS. */
  bodyMd: string;
  source: string;
  /** UTF-8 byte count of the written body (not char count). */
  bytesWritten: number;
  /** True when the full body was clipped to fit MAX_ITEM_BODY_CHARS. */
  truncated: boolean;
}

/**
 * Pull the full mail body for an inbox item and overwrite the cached
 * snippet. Resolves to `{ ok: true }` with the new body on success, or a
 * discriminated failure the caller can surface as 404 / 502 / 422.
 *
 * Provider errors are caught and folded into `fetch_failed` so the HTTP
 * handler returns a clean envelope instead of letting an SDK exception
 * bubble up to the route framework's 500 catch-all.
 */
export async function refreshItemBody(
  opts: RefreshItemBodyOptions,
): Promise<RefreshItemBodyResult | { ok: false; reason: RefreshBodyFailure }> {
  // Narrow the lookup window around the known mail date when v11 envelope
  // metadata is populated. Without this we'd scan up to 30 days × 200 mails
  // (the old default) and miss anything beyond the first 200 — that's how
  // the misleading "older than 30 days" toast was firing on a 1-day-old mail
  // last night.
  const lookupDays = opts.lookupDays ?? DEFAULT_LOOKUP_DAYS;
  const slackMs = DATE_SLACK_DAYS * 86_400_000;
  const since = opts.item.mailDate !== undefined
    ? new Date(opts.item.mailDate.getTime() - slackMs)
    : new Date(Date.now() - lookupDays * 86_400_000);
  const listLimit = opts.listLimit ?? DEFAULT_LIST_LIMIT;

  let envelopes: ReadonlyArray<MailEnvelope>;
  try {
    // Prefer search() with a tight date range when we know mailDate — IMAP-native
    // SEARCH SINCE/BEFORE bypasses the list-window pagination problem entirely.
    // Fall back to list() when mailDate is missing (pre-v11 items).
    if (opts.item.mailDate !== undefined) {
      const before = new Date(opts.item.mailDate.getTime() + slackMs);
      envelopes = await opts.provider.search(
        { since, before },
        { limit: listLimit },
      );
    } else {
      envelopes = await opts.provider.list({ since, limit: listLimit });
    }
  } catch {
    return { ok: false, reason: { kind: 'fetch_failed' } };
  }

  // Match strategy (most → least precise):
  //   1. v11 Message-ID — RFC 5322 ID is unique per mail. Direct lookup.
  //   2. resolveThreadKey() — synthesised thread key, matches the watcher path.
  // resolveThreadKey is duplicated from watcher-hook.ts on purpose — both
  // call sites must agree on the synthesised key shape so dedup never
  // collapses unrelated mails. An import would tangle the refresh path
  // into the live-watcher module.
  let match: MailEnvelope | undefined;
  if (opts.item.messageId !== undefined && opts.item.messageId !== '') {
    match = envelopes.find((env) => env.messageId === opts.item.messageId);
  }
  if (!match) {
    match = envelopes.find((env) => resolveThreadKey(env) === opts.item.threadKey);
  }
  if (!match) return { ok: false, reason: { kind: 'not_found' } };

  let message;
  try {
    message = await opts.provider.fetch({ uid: match.uid });
  } catch {
    return { ok: false, reason: { kind: 'fetch_failed' } };
  }

  const full = message.text.trim();
  if (full.length === 0) return { ok: false, reason: { kind: 'empty_body' } };

  // Pre-clamp keeps the API's `truncated` field honest. The state layer
  // also runs an HTML/invisible-char strip + its own clamp; we read the
  // post-write `bytesWritten` back so the response reports the actual
  // bytes in cache rather than the pre-strip char count.
  const truncated = full.length > MAX_ITEM_BODY_CHARS;
  let body = truncated ? full.slice(0, MAX_ITEM_BODY_CHARS) : full;

  // Re-run the sensitive-content masker when the engine is in mask-mode so
  // the refreshed full body matches the redaction guarantees the classifier
  // applied to the snippet at classify time. Without this, refreshItemBody
  // could persist plaintext OTPs/secrets that the generator then reads,
  // bypassing the privacy contract.
  if (opts.sensitiveMode === 'mask') {
    const analysis = analyzeSensitiveContent({ subject: opts.item.subject ?? '', body });
    if (analysis.isSensitive) body = analysis.masked.body;
  }

  const persisted = opts.state.saveItemBody(opts.item.id, body, opts.item.channel);
  return {
    ok: true,
    bodyMd: persisted.bodyMd,
    source: opts.item.channel,
    bytesWritten: persisted.bytesWritten,
    truncated: truncated || persisted.clampedAtCacheLayer,
  };
}

export interface RefreshWhatsappItemBodyOptions {
  waState: WhatsAppMessageStore;
  state: InboxStateDb;
  item: {
    id: string;
    threadKey: string;
    channel: 'email' | 'whatsapp';
    /** See RefreshItemBodyOptions.item.subject — fed to the masker when mode='mask'. */
    subject?: string | undefined;
  };
  /** Override the thread-history depth (mostly for tests). */
  messageLimit?: number | undefined;
  /** See RefreshItemBodyOptions.sensitiveMode. */
  sensitiveMode?: SensitiveMode | undefined;
}

/**
 * WhatsApp counterpart to `refreshItemBody`. The classifier cached the
 * first-message snippet at classify time; this concatenates the most
 * recent `WA_MESSAGE_FETCH_LIMIT` messages of the same thread (text +
 * voice transcripts) into a single chronological context block.
 *
 * Direction tags `"Gegenüber:"` / `"Ich:"` are hard-coded German
 * because the generator prompt is DE-default. Revisit when the
 * generator gets per-locale prompt branching.
 *
 * The output is plain text — the generator's `<untrusted_data>`
 * wrapping still applies because we plumb the cached body through the
 * same `state.saveItemBody` → generator path.
 */
export async function refreshWhatsappItemBody(
  opts: RefreshWhatsappItemBodyOptions,
): Promise<RefreshItemBodyResult | { ok: false; reason: RefreshBodyFailure }> {
  let messages: ReadonlyArray<WhatsAppMessage>;
  try {
    messages = opts.waState.getMessagesForThread(
      opts.item.threadKey,
      opts.messageLimit ?? WA_MESSAGE_FETCH_LIMIT,
    );
  } catch {
    return { ok: false, reason: { kind: 'fetch_failed' } };
  }
  if (messages.length === 0) return { ok: false, reason: { kind: 'not_found' } };

  // Inbound messages carry the counterparty's content; outbound ones
  // are the user's own. Render direction as a prefix so the generator
  // can tell who said what.
  const lines: string[] = [];
  for (const msg of messages) {
    const content = (msg.text ?? msg.transcript ?? '').trim();
    if (!content) continue;
    const tag = msg.direction === 'inbound' ? 'Gegenüber' : 'Ich';
    lines.push(`${tag}: ${content}`);
  }
  const full = lines.join('\n\n').trim();
  if (full.length === 0) return { ok: false, reason: { kind: 'empty_body' } };

  // The transcript is chronological-ASC; the latest message — the actual
  // "ask" the generator must answer — sits at the END. When truncating
  // we drop the oldest context and keep the tail, so the most recent
  // exchange survives.
  const truncated = full.length > MAX_ITEM_BODY_CHARS;
  let body = truncated ? full.slice(full.length - MAX_ITEM_BODY_CHARS) : full;

  // Same mask-mode guarantee as the email path. WA snippets carry OTPs +
  // 2FA codes more often than mail does (WhatsApp Business templates),
  // so this is the higher-leverage masker call of the two.
  if (opts.sensitiveMode === 'mask') {
    const analysis = analyzeSensitiveContent({ subject: opts.item.subject ?? '', body });
    if (analysis.isSensitive) body = analysis.masked.body;
  }

  const persisted = opts.state.saveItemBody(opts.item.id, body, opts.item.channel);
  return {
    ok: true,
    bodyMd: persisted.bodyMd,
    source: opts.item.channel,
    bytesWritten: persisted.bytesWritten,
    truncated: truncated || persisted.clampedAtCacheLayer,
  };
}
