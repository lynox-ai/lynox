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
  /** When the inbox stored it; stands in for a missing mail date. */
  fetchedAt?: Date | undefined;
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
  listAuditForItem(
    itemId: string,
    tenantId?: string,
  ): ReadonlyArray<{ action: string; payloadJson: string; createdAt?: Date | undefined }>;
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

/** Audit actions whose payload names a follow-up the intake check found sensitive. */
const SENSITIVE_FOLLOW_UP_ACTIONS: ReadonlySet<string> = new Set(['raised_on_sensitive_follow_up', 'sensitive_follow_up_kept_open']);

/**
 * What the inbox shows of an open item's follow-ups: how many came since the owner last dealt
 * with the thread, and the newest one's date and sender name. The name is left out when that
 * mail reads as sensitive. Undefined when there is none, or when the item is no longer open.
 *
 * Dealt with: a reply or archive of the item that a follow-up then ended, or a mail sent into the
 * thread (a reply written outside lynox). A follow-up from before that is answered and not
 * counted; one without a mail date counts by when the inbox stored it.
 */
export function itemFollowUps<M extends FollowUpMessage & { id: string }>(
  reader: FollowUpReader<M>,
  item: InboxItem,
): InboxItemFollowUps | undefined {
  if (item.userAction !== undefined) return undefined;
  const audit = reader.listAuditForItem(item.id, item.tenantId);
  const handledAt = lastHandledAt(reader, item, audit);
  const found = followUpsOf(reader, item).filter((m) => {
    const at = m.mailDate ?? m.fetchedAt;
    return handledAt === undefined || at === undefined || at.getTime() > handledAt;
  });
  const latest = found[0];
  if (latest === undefined) return undefined;
  // Sensitive: its stored text reads so, or the intake check flagged it (the inbox may have stored
  // it with its text dropped or masked, so the text alone no longer tells).
  const sensitive = followUpIsSensitive(latest) || flaggedAtIntake(audit).has(latest.messageId);
  const name = latest.fromName !== undefined && latest.fromName.trim().length > 0 && !sensitive
    ? latest.fromName
    : undefined;
  return {
    count: found.length,
    latestAt: (latest.mailDate ?? latest.fetchedAt)?.toISOString(),
    latestFromName: name,
    latestMessageId: latest.id,
  };
}

/** When the owner last dealt with the thread: replied to or archived the item, or sent a mail into it. */
function lastHandledAt(
  reader: FollowUpReader<FollowUpMessage>,
  item: InboxItem,
  audit: ReturnType<FollowUpReader<FollowUpMessage>['listAuditForItem']>,
): number | undefined {
  let at: number | undefined;
  const later = (d: Date | undefined): void => {
    if (d !== undefined && (at === undefined || d.getTime() > at)) at = d.getTime();
  };
  // A reply (through lynox, recorded by the system) or an archive (by the owner) dealt with the
  // thread only if a follow-up then opened the item again: an open item whose last reply or archive
  // is followed by nothing had it undone, and counts from before it. Every undo writes an audit row,
  // the bulk undo and bulk "unhandled" too; an undo of a bulk action puts back what was pending
  // before that bulk. "Unhandled" says the owner has not dealt with it. A clear of a snooze, or of
  // nothing, undoes nothing the owner answered.
  // A raise ends a pending reply or archive whatever the item showed when the mail came (a snooze,
  // a wake, an action taken meanwhile): the undos are all in the audit. Except for an action written
  // before undos were (no `undo_logged`): a bulk undo of it left no trace, so only a raise that
  // names it as the action it ended (`prior_user_action`) ends it.
  type Pending = { at: Date | undefined; logged: boolean } | undefined;
  let pending: Pending;
  const beforeBulk = new Map<string, Pending>();
  const remember = (p: Record<string, unknown>): void => {
    const bulk = p['bulk_id'];
    if (typeof bulk === 'string' && !beforeBulk.has(bulk)) beforeBulk.set(bulk, pending);
  };
  for (const a of audit) {
    const p = payloadOf(a);
    if (a.action === 'replied' || a.action === 'archived') {
      remember(p);
      pending = { at: a.createdAt, logged: p['undo_logged'] === true };
    } else if (a.action === 'snoozed') {
      const bulk = p['bulk_id'];
      if (typeof bulk === 'string' && !beforeBulk.has(bulk)) beforeBulk.set(bulk, pending);
    } else if (a.action === 'undo') {
      const intent = p['intent'];
      if (intent === 'unsnooze') continue;
      if (intent === 'bulk_undo') {
        // A bulk without a row of its own (written before bulks were audited) was an "unhandled",
        // which ended nothing the owner had answered: what is pending stays.
        const bulk = p['bulk_id'];
        if (typeof bulk === 'string' && beforeBulk.has(bulk)) pending = beforeBulk.get(bulk);
        continue;
      }
      if (intent === undefined && 'undid' in p) {
        // A clear of the item's action, naming it: a snooze or nothing undone leaves the reply or
        // archive before it standing; any other clear ends what is pending.
        const undid = p['undid'];
        if (undid === 'replied' || undid === 'archived' || undid === 'unhandled') pending = undefined;
        continue;
      }
      remember(p);
      pending = undefined;
    } else if (a.action === 'reopened_on_reply') {
      later(pending?.at);
      pending = undefined;
    } else if (a.action === 'raised_on_sensitive_follow_up') {
      const prior = p['prior_user_action'];
      if (pending?.logged === true || prior === 'replied' || prior === 'archived') later(pending?.at);
      pending = undefined;
    }
  }
  // A sent mail's date is its sender's word: one dated after it was stored (a mail from the
  // account's own address with a date to come) counts from when it was stored.
  for (const m of reader.listThreadMessages(item.accountId, item.threadKey, { tenantId: item.tenantId, limit: 50 })) {
    if (m.direction !== 'outbound') continue;
    const sent = m.mailDate !== undefined && m.fetchedAt !== undefined && m.mailDate.getTime() > m.fetchedAt.getTime() ? m.fetchedAt : (m.mailDate ?? m.fetchedAt);
    later(sent);
  }
  return at;
}

function payloadOf(a: { payloadJson: string }): Record<string, unknown> {
  try {
    const p = JSON.parse(a.payloadJson) as unknown;
    return typeof p === 'object' && p !== null ? p as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/** The messages the item's audit names as found sensitive by the intake check. */
export function flaggedAtIntake(audit: ReadonlyArray<{ action: string; payloadJson: string }>): Set<string> {
  const ids = new Set<string>();
  for (const a of audit) {
    if (!SENSITIVE_FOLLOW_UP_ACTIONS.has(a.action)) continue;
    try {
      const id = (JSON.parse(a.payloadJson) as { message_id?: unknown }).message_id;
      if (typeof id === 'string') ids.add(id);
    } catch {
      // An unreadable payload names no message.
    }
  }
  return ids;
}
