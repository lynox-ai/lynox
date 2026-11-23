/**
 * The messages that came into an inbox item's thread after its own mail and are not answered
 * by its classification: inbound, not the item's own mail, not older than it, and known not to
 * be an automatic reply. "Reply in chat" answers the newest of them; the inbox list and the
 * reading pane say that they came.
 */
import type { InboxItem, InboxItemFollowUps } from '../../types/index.js';
import { detectSensitiveContent } from './sensitive-content.js';

/** What the rule reads of a stored thread message. */
export interface FollowUpMessage {
  messageId: string;
  fromName?: string | undefined;
  subject: string;
  bodyMd?: string | undefined;
  snippet?: string | undefined;
  mailDate?: Date | undefined;
  direction: string;
  /** true = automatic reply, false = checked and not one, undefined = not checked. */
  autoReply?: boolean | undefined;
}

export interface FollowUpReader<M extends FollowUpMessage> {
  /** The thread's stored messages, newest first. */
  listThreadMessages(
    accountId: string,
    threadKey: string,
    opts: { tenantId?: string | undefined; limit?: number | undefined },
  ): ReadonlyArray<M>;
  /** The item's audit, oldest first. */
  listAuditForItem(itemId: string, tenantId?: string): ReadonlyArray<{ action: string; payloadJson: string }>;
}

/**
 * The follow-ups of an item, newest first, among the thread's newest 50 messages.
 *
 * Known not to be an automatic reply means checked and not one, or the message that reopened or
 * raised the item when the check could not tell (its audit names it; a known automatic reply is
 * not taken either way). An out-of-office note is stored in the thread too. Any other message
 * never checked (stored before the check existed) is not taken.
 */
export function followUpsOf<M extends FollowUpMessage>(reader: FollowUpReader<M>, item: InboxItem): M[] {
  const messages = reader.listThreadMessages(item.accountId, item.threadKey, { tenantId: item.tenantId, limit: 50 });
  const own = item.messageId !== undefined ? messages.find((m) => m.messageId === item.messageId) : undefined;
  const since = own?.mailDate?.getTime();
  const reopenedBy = new Set<string>();
  for (const a of reader.listAuditForItem(item.id, item.tenantId)) {
    if (a.action !== 'reopened_on_reply' && a.action !== 'raised_on_sensitive_follow_up') continue;
    try {
      const id = (JSON.parse(a.payloadJson) as { message_id?: unknown }).message_id;
      if (typeof id === 'string') reopenedBy.add(id);
    } catch {
      // An unreadable payload names no message.
    }
  }
  return messages.filter((m) =>
    m.messageId !== item.messageId
    && m.direction === 'inbound'
    && (m.autoReply === false || (m.autoReply === undefined && reopenedBy.has(m.messageId)))
    && !(since !== undefined && m.mailDate !== undefined && m.mailDate.getTime() < since),
  );
}

/** Whether a stored message's own text or sender name holds sensitive content, read as the chat
 *  reads a follow-up: a hit withholds its sender's name wherever the item names it. */
export function followUpIsSensitive(m: FollowUpMessage): boolean {
  const text = m.bodyMd !== undefined && m.bodyMd.length > 0 ? m.bodyMd : (m.snippet ?? '');
  return detectSensitiveContent({ subject: '', body: [m.subject, m.fromName ?? '', text].join('\n') }).categories.length > 0;
}

/**
 * What the inbox shows of an open item's follow-ups: how many, and the newest one's date and
 * sender name. The name is left out when that mail reads as sensitive. Undefined when there is
 * none, or when the item is no longer open (the owner acted after them).
 */
export function itemFollowUps<M extends FollowUpMessage & { id: string }>(
  reader: FollowUpReader<M>,
  item: InboxItem,
): InboxItemFollowUps | undefined {
  if (item.userAction !== undefined) return undefined;
  const found = followUpsOf(reader, item);
  const latest = found[0];
  if (latest === undefined) return undefined;
  // Sensitive: its stored text reads so, or the intake check flagged it and raised the item (the
  // inbox may have stored it with its text dropped or masked, so the text alone no longer tells).
  const sensitive = followUpIsSensitive(latest) || raisedBy(reader, item).has(latest.messageId);
  const name = latest.fromName !== undefined && latest.fromName.trim().length > 0 && !sensitive
    ? latest.fromName
    : undefined;
  return {
    count: found.length,
    latestAt: latest.mailDate?.toISOString(),
    latestFromName: name,
    latestMessageId: latest.id,
  };
}

/** The messages the item's audit names as having raised it for sensitive content. */
function raisedBy(reader: FollowUpReader<FollowUpMessage>, item: InboxItem): Set<string> {
  const ids = new Set<string>();
  for (const a of reader.listAuditForItem(item.id, item.tenantId)) {
    if (a.action !== 'raised_on_sensitive_follow_up') continue;
    try {
      const id = (JSON.parse(a.payloadJson) as { message_id?: unknown }).message_id;
      if (typeof id === 'string') ids.add(id);
    } catch {
      // An unreadable payload names no message.
    }
  }
  return ids;
}
