// === Outbound reply reconcile (Slice 1: inbox → chat round-trip) ===
//
// The symmetric twin of the inbound watcher-hook. When the user answers a
// `requires_user` item IN CHAT, the agent sends via the generic `mail_reply`
// tool — which knows nothing about the inbox, so the item would otherwise
// linger in its zone forever. Wired as `MailHooks.onOutboundSent`, this marks
// the open inbox item on the replied-to message `replied`, keeping the inbox
// the single source of truth WITHOUT coupling `mail_reply` to inbox internals.

import type { OutboundContext } from '../mail/context.js';
import type { InboxStateDb } from './state.js';

/**
 * Mark the open inbox item a sent reply answers as `replied`. Best-effort + safe:
 * - only acts on replies that carry the replied-to Message-ID (a fresh
 *   `mail_send` has no item to reconcile);
 * - matched by Message-ID alone (globally unique) so a reply sent from a
 *   different account than the mail was received on still reconciles;
 * - only an OPEN item (no prior `user_action`) is touched, so it never
 *   overwrites an explicit archive/snooze the user already chose;
 * - an unknown message-id (the reply wasn't to a classified inbox item) no-ops.
 */
export function reconcileOutboundReply(
  state: InboxStateDb,
  accountId: string,
  ctx: OutboundContext,
): void {
  if (!ctx.isReply) return;
  // Match the replied-to inbox item: prefer the globally-unique Message-ID
  // (matches even when the reply leaves from a different account than the mail
  // was received on). Fall back to the thread key when the original mail had
  // no Message-ID — `originalMessageId` is then absent and the id lookup can't
  // fire. The thread-key path is account-scoped (folder:uid is account-local),
  // so the rare cross-account + no-Message-ID combination stays uncovered.
  let item = ctx.originalMessageId ? state.findItemByMessageId(ctx.originalMessageId) : null;
  let matchedBy = 'message_id';
  if (!item && ctx.originalThreadKey) {
    item = state.findItemByThread(accountId, ctx.originalThreadKey);
    matchedBy = 'thread_key';
  }
  if (!item || item.userAction) return;
  // Gate the audit on the UPDATE actually matching a row — a concurrent
  // delete/handle between the find and the update would otherwise leave a
  // phantom `replied` audit for an item that was never marked.
  const marked = state.updateUserAction(item.id, 'replied', new Date(), item.tenantId);
  if (!marked) return;
  state.appendAudit({
    tenantId: item.tenantId,
    itemId: item.id,
    action: 'replied',
    actor: 'system',
    payloadJson: JSON.stringify({ trigger: 'outbound_reply', via: 'chat', matchedBy }),
  });
}
