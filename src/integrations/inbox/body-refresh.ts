// === Inbox body-refresh adapter — pull the full mail body on demand ===
//
// The classifier caches a 500-char snippet at classify time (PR #277).
// The generator works from that snippet by default. When the user clicks
// "Reload from server" on the Draft pane, this module pulls the FULL
// body via `provider.list()` + `provider.fetch()` and writes it back to
// `inbox_item_bodies`, overwriting the cached snippet. Subsequent
// generation calls then have the full mail content as context.
//
// Why a list+fetch round-trip instead of a direct fetch-by-id: the
// `MailProvider.fetch()` API takes a UID, but `inbox_items.thread_key`
// stores either a provider-set threading id or a synthesised key — not
// the UID. The list() call returns recent envelopes including their
// UIDs; we match by `resolveThreadKey(env) === item.threadKey` and
// then fetch by the matched envelope's UID. Cross-provider clean — no
// per-provider lookup gymnastics.

import type { MailEnvelope, MailProvider } from '../mail/provider.js';
import type { InboxStateDb } from './state.js';

/** Window for the provider.list() probe. Items older than this won't refresh. */
const DEFAULT_LOOKUP_DAYS = 30;
/** Hard upper bound on the envelope batch — keeps the round-trip cheap. */
const DEFAULT_LIST_LIMIT = 200;

export type RefreshBodyFailure =
  | { kind: 'not_found' }       // no envelope in the lookup window matches threadKey
  | { kind: 'fetch_failed' }    // provider raised (auth, transport)
  | { kind: 'empty_body' };     // mail exists but has no text body to surface

export interface RefreshItemBodyOptions {
  provider: MailProvider;
  state: InboxStateDb;
  item: { id: string; accountId: string; threadKey: string; channel: 'email' | 'whatsapp' };
  /** Override the 30-day lookup window — tests pass small values. */
  lookupDays?: number | undefined;
  listLimit?: number | undefined;
}

export interface RefreshItemBodyResult {
  ok: true;
  bodyMd: string;
  source: string;
  bytesWritten: number;
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
  const since = new Date(Date.now() - (opts.lookupDays ?? DEFAULT_LOOKUP_DAYS) * 86_400_000);
  const listLimit = opts.listLimit ?? DEFAULT_LIST_LIMIT;

  let envelopes: ReadonlyArray<MailEnvelope>;
  try {
    envelopes = await opts.provider.list({ since, limit: listLimit });
  } catch {
    return { ok: false, reason: { kind: 'fetch_failed' } };
  }

  // resolveThreadKey is duplicated from watcher-hook.ts on purpose —
  // both call sites must agree on the synthesised key shape so dedup
  // never collapses unrelated mails. An import would tangle the
  // refresh path into the live-watcher module.
  const match = envelopes.find((env) => resolveThreadKey(env) === opts.item.threadKey);
  if (!match) return { ok: false, reason: { kind: 'not_found' } };

  let message;
  try {
    message = await opts.provider.fetch({ uid: match.uid });
  } catch {
    return { ok: false, reason: { kind: 'fetch_failed' } };
  }

  const body = message.text.trim();
  if (body.length === 0) return { ok: false, reason: { kind: 'empty_body' } };

  // The same MAX_ITEM_BODY_CHARS clamp the state-layer enforces still
  // applies — the saveItemBody call truncates server-side.
  opts.state.saveItemBody(opts.item.id, body, opts.item.channel);
  return { ok: true, bodyMd: body, source: opts.item.channel, bytesWritten: body.length };
}

function resolveThreadKey(env: MailEnvelope): string {
  if (env.threadKey) return env.threadKey;
  if (env.messageId) return `imap:${env.messageId}`;
  return `imap:${env.folder}:${String(env.uid)}`;
}
