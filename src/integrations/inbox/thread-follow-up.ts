// === A mail filed into a thread the inbox already holds ===
//
// One path for every mail that lands in an existing item's thread, so a mail the watcher sees
// after the item was filed (a follow-up) and a mail the classifier finished after another mail of
// its thread had created the item (a joined mail) are stored and judged the same way. The watcher
// hook calls it for the first, the classifier's runner for the second, with that mail's verdict.

import type { MailAuthType, MailEnvelope } from '../mail/provider.js';
import type { InboxBucket, InboxItem } from '../../types/index.js';
import { analyzeSensitiveContent, type SensitiveMode } from './sensitive-content.js';
import { envelopeToItemInputFields, type InboxStateDb, type ThreadMessageInput } from './state.js';
import { sanitisePushText, type InboxNotifier, type InboxNotifyOptions } from './notifier.js';

/**
 * Resolves an accountId to the bits the classifier prompt needs (address +
 * display name as trusted system context). Engine wiring backs this with
 * `MailStateDb.getAccount(id)`; tests pass a plain Map.
 */
export interface AccountResolver {
  resolve(accountId: string): { address: string; displayName: string; authType?: MailAuthType | undefined } | null;
  /** Whether a (lower-cased) address belongs to any mail account connected on this instance. */
  isOwnAddress?(address: string): boolean;
}

/**
 * Providers whose watch envelope cannot tell an automatic reply: Graph's delta query carries no
 * headers, so `isAutoReply` is always false there (`providers/oauth-graph.ts`, ENVELOPE_FIELDS).
 * For every follow-up from someone else on such an account, the hook asks `confirmAutoReply`.
 */
const AUTO_REPLY_NOT_IN_ENVELOPE: ReadonlySet<MailAuthType> = new Set(['oauth_microsoft']);

export interface FollowUpRecorderOptions {
  state: InboxStateDb;
  accounts: AccountResolver;
  notifier?: InboxNotifier | undefined;
  /** See `InboxClassifierHookOptions.confirmAutoReply`. */
  confirmAutoReply?: ((accountId: string, env: MailEnvelope) => Promise<boolean>) | undefined;
}

/**
 * The verdict a joined mail brings with it: what its own classification (or its failure) said.
 * The item keeps the verdict of the mail that created it; this one is recorded next to it, and
 * one that needs the owner brings the item to "requires you".
 */
export interface JoinVerdict {
  bucket: InboxBucket;
  confidence: number;
  reasonDe: string;
  classifierVersion: string;
  failReason: string | null;
  /** Set when the mail was not classified: the classifier failed, or the queue was drained. */
  deadLetter?: 'classifier_failed' | 'restore_drain' | 'shutdown_drain' | undefined;
  /** False: a raise sends no push (the process is ending, as for a drained item). Default true. */
  push?: boolean | undefined;
}

export type RecordFollowUp = (
  existing: InboxItem,
  env: MailEnvelope,
  mode: SensitiveMode,
  account: { address: string; authType?: MailAuthType | undefined },
  join?: JoinVerdict | undefined,
) => Promise<void>;

/**
 * A new message in a thread the inbox already holds (PRD inbox-user-rules E6). It is stored as a
 * thread message after the same sensitive check a first mail gets: without its text on `skip`,
 * masked on `mask`. A `replied` item opens again for it, unless it is an automatic reply; the
 * bucket stays, and no rule or classifier runs. A message the check flags raises the item to
 * "requires you" instead, open and not snoozed, and pushes. A snooze set to wake on a reply wakes
 * for the messages that may reopen an item: not for an automatic reply, our own mail or a message
 * older than the owner's reply. Without a Message-ID, or when the message is stored already,
 * nothing happens, so a redelivered mail wakes nothing either. Gmail and Graph name the thread
 * themselves; on an IMAP server without thread ids the thread key is the Message-ID, and a reply
 * comes here through its reply headers (`itemAnswered`).
 *
 * With `join`, the mail was classified on its own and found the item already created by another
 * mail of its thread. It is filed the same way, and its verdict is recorded (`joined_thread`). A
 * verdict that needs the owner (a classification as `requires_user`, a failed classification, a
 * drained queue) raises the item to "requires you" and pushes under this mail's sender, unless the
 * item is open there already. The owner has not seen such a mail, whatever its Date header says,
 * so the header does not hold it back as older than the owner's last action.
 */
export function createFollowUpRecorder(opts: FollowUpRecorderOptions): RecordFollowUp {
  return async (existing, env, mode, account, join) => {
    const messageId = env.messageId;
    if (messageId === undefined || messageId.length === 0) return;
    if (opts.state.hasThreadMessage(existing.tenantId, existing.accountId, messageId)) return;
    const fields = envelopeToItemInputFields(env);
    const sensitive = analyzeSensitiveContent({ subject: env.subject, body: env.snippet });
    let subject = fields.subject ?? '';
    let snippet = fields.snippet;
    if (sensitive.isSensitive && mode === 'skip') {
      snippet = undefined;
    } else if (sensitive.isSensitive && mode === 'mask') {
      const masked = envelopeToItemInputFields({ ...env, subject: sensitive.masked.subject, snippet: sensitive.masked.body });
      subject = masked.subject ?? '';
      snippet = masked.snippet;
    }
    // Our own mail coming back into the thread (a copy of the reply) is no new customer message:
    // it is stored as sent, so neither reopening nor "Reply in chat" takes it. Own is this account's
    // address or that of any other account connected here (a reply sent from the shared address).
    const from = (fields.fromAddress ?? '').toLowerCase();
    const own = from === account.address.toLowerCase() || opts.accounts.isOwnAddress?.(from) === true;
    // Whether it is an automatic reply, stored with the message for "Reply in chat": true, false
    // (checked, not one), or undefined (not known). The envelope says it, except where it carries
    // no headers; there the message is fetched once. That fetch throwing leaves it unknown.
    let autoReply: boolean | undefined;
    if (!own) {
      if (env.isAutoReply) {
        autoReply = true;
      } else if (account.authType !== undefined && AUTO_REPLY_NOT_IN_ENVELOPE.has(account.authType)) {
        if (opts.confirmAutoReply) {
          try {
            autoReply = await opts.confirmAutoReply(existing.accountId, env);
          } catch {
            // Unknown: stays undefined (see `confirmAutoReply`).
          }
        }
      } else {
        autoReply = false;
      }
    }
    const input: ThreadMessageInput = {
      tenantId: existing.tenantId,
      accountId: existing.accountId,
      threadKey: existing.threadKey,
      messageId,
      fromAddress: fields.fromAddress ?? '',
      subject,
      direction: own ? 'outbound' : 'inbound',
      inboxItemId: existing.id,
    };
    if (autoReply !== undefined) input.autoReply = autoReply;
    if (fields.fromName !== undefined) input.fromName = fields.fromName;
    if (fields.inReplyTo !== undefined) input.inReplyTo = fields.inReplyTo;
    if (fields.mailDate !== undefined) input.mailDate = fields.mailDate;
    if (snippet !== undefined) input.snippet = snippet;
    // A message older than the reply (a backfill or a redelivery) did not come after it. A joined
    // mail was never shown to the owner, so it never counts as older.
    const beforeUserAction = join === undefined && fields.mailDate !== undefined && existing.userActionAt !== undefined
      && fields.mailDate.getTime() <= existing.userActionAt.getTime();
    // A flagged message from someone else brings the item back to "requires you", whatever its
    // bucket, user action or snooze, as a flagged first mail lands there: no classifier verdict, no
    // rule and no earlier "done" keeps it out of the owner's view. An automatic reply counts too,
    // since a flagged first mail is not let through for being one.
    const raises = sensitive.isSensitive && !own && !beforeUserAction;
    // A joined mail whose own verdict needs the owner brings the item there too: had it been first
    // in its thread, it would have been an item in "requires you" itself.
    const verdictRaises = join !== undefined && join.bucket === 'requires_user' && !own;
    // Otherwise only a `replied` item opens; `reopenReplied` checks that again in its UPDATE.
    // An unknown answer reopens (see `confirmAutoReply`): only a known automatic reply does not.
    const opens = existing.userAction === 'replied' && autoReply !== true && !own && !beforeUserAction;
    // A snooze the owner set to wake on a reply wakes for a message that may reopen an item.
    const mayWake = autoReply !== true && !own && !beforeUserAction;
    // What the check found in the item's own mail, before this message.
    const itemCategories = opts.state.sensitiveCategoriesAtIngest(existing);
    const outcome = opts.state.runInTransaction((): 'raised' | 'reopened' | 'none' => {
      opts.state.insertThreadMessage(input);
      // Whether the item sleeps with wake-on-reply is read here, inside the write, not from the row
      // read before the auto-reply check above: the owner may have snoozed it again since, or another
      // message woken it. The wake and its audit commit with the message they are for. One clock for
      // the whole write, so the wake and the raise below judge the snooze at the same moment.
      const now = Date.now();
      const asleep = mayWake ? opts.state.getItem(existing.id, existing.tenantId) : undefined;
      const wakes = asleep !== undefined && asleep !== null && asleep.unsnoozeOnReply
        && asleep.snoozeUntil !== undefined && asleep.snoozeUntil.getTime() > now;
      if (wakes) {
        // A message that raises the item below clears the snooze with the raise; cleared here first,
        // an item already in "requires you" would look open to the raise and stay where it was.
        if (!raises && !verdictRaises) opts.state.setSnooze(existing.id, null, null, true, false, existing.tenantId);
        opts.state.appendAudit({
          tenantId: existing.tenantId,
          itemId: existing.id,
          action: 'unsnoozed_on_reply',
          actor: 'system',
          payloadJson: JSON.stringify({ trigger: 'inbound_mail', message_id: messageId }),
        });
      }
      // Decided on the row as it is now, inside the write, so two messages arriving together raise
      // it once. An item open in "requires you" stays as it is. One this mail wakes is still
      // snoozed here, so out of view, and this mail is what shows it.
      const current = raises || verdictRaises ? opts.state.getItem(existing.id, existing.tenantId) : undefined;
      const openNow = current !== undefined && current !== null && current.bucket === 'requires_user'
        && current.userAction === undefined
        && !(current.snoozeUntil !== undefined && current.snoozeUntil.getTime() > now);
      const decided = ((): 'raised' | 'reopened' | 'none' => {
        if (raises && !openNow) {
          opts.state.raiseToRequiresUser(existing.id, existing.tenantId, fields.mailDate ?? new Date(now), new Date(now));
          opts.state.appendAudit({
            tenantId: existing.tenantId,
            itemId: existing.id,
            action: 'raised_on_sensitive_follow_up',
            actor: 'system',
            // The verdict the item had before, and what the check found in this message. Under its own
            // key, not `sensitive_categories`: a reader withholds the item's own mail by that, and this
            // is another message, stored as the mode says.
            payloadJson: JSON.stringify({
              trigger: 'inbound_mail',
              message_id: messageId,
              prior_bucket: existing.bucket,
              prior_classifier_version: existing.classifierVersion,
              prior_reason_de: existing.reasonDe,
              // Read inside this write (`current`), not from the row read before the automatic-reply
              // check awaited the provider: the owner may have acted on the item meanwhile.
              prior_user_action: (current ?? existing).userAction ?? null,
              prior_snooze_until: (current ?? existing).snoozeUntil?.toISOString() ?? null,
              prior_sensitive_categories: itemCategories,
              follow_up_sensitive_categories: sensitive.categories,
            }),
          });
          return 'raised';
        }
        if (raises) {
          // Already open in "requires you": nothing to raise, but the inbox notes that the check
          // flagged this message, since its stored text may be dropped or masked and no longer tell.
          opts.state.appendAudit({
            tenantId: existing.tenantId,
            itemId: existing.id,
            action: 'sensitive_follow_up_kept_open',
            actor: 'system',
            payloadJson: JSON.stringify({ trigger: 'inbound_mail', message_id: messageId, follow_up_sensitive_categories: sensitive.categories }),
          });
          return 'none';
        }
        if (verdictRaises && join !== undefined) {
          if (openNow) return 'none';
          // The item takes this mail's verdict and reason, so the list says why it is there. Its
          // mail date stays: the joined mail's Date header is its sender's word.
          return opts.state.raiseForJoinedMail(existing.id, existing.tenantId, join.reasonDe, join.classifierVersion, new Date(now))
            ? 'raised'
            : 'none';
        }
        if (!opens) return 'none';
        if (!opts.state.reopenReplied(existing.id, existing.tenantId, fields.mailDate ?? new Date())) return 'none';
        opts.state.appendAudit({
          tenantId: existing.tenantId,
          itemId: existing.id,
          action: 'reopened_on_reply',
          actor: 'system',
          // No `sensitive_categories` here: the item's audit is what a reader withholds the item's own
          // mail by, and this is another message. Its stored text is checked again when it is read.
          payloadJson: JSON.stringify({ trigger: 'inbound_mail', message_id: messageId }),
        });
        return 'reopened';
      })();
      if (join !== undefined) {
        // The joined mail's own verdict, next to the item's. No `sensitive_categories` key, as above:
        // what the check found in this mail is in the raise or kept-open entry of its own.
        opts.state.appendAudit({
          tenantId: existing.tenantId,
          itemId: existing.id,
          action: 'joined_thread',
          actor: join.deadLetter === undefined ? 'classifier' : 'system',
          payloadJson: JSON.stringify({
            message_id: messageId,
            bucket: join.bucket,
            confidence: join.confidence,
            fail_reason: join.failReason,
            ...(join.deadLetter !== undefined ? { dead_letter: join.deadLetter } : {}),
            raised: decided === 'raised',
            ...(decided === 'raised'
              ? {
                  prior_bucket: (current ?? existing).bucket,
                  prior_user_action: (current ?? existing).userAction ?? null,
                }
              : {}),
          }),
        });
      }
      return decided;
    });
    if (outcome === 'none' || !opts.notifier) return;
    if (outcome === 'raised' && join?.push === false) return;
    if (outcome === 'reopened' && existing.bucket !== 'requires_user') return;
    const item = opts.state.getItem(existing.id, existing.tenantId);
    // A snoozed item is not in the list until it wakes; a push now would lead nowhere. A raised item
    // is not snoozed any more.
    const snoozed = item?.snoozeUntil !== undefined && item.snoozeUntil.getTime() > Date.now();
    // The push names the item's own sender and subject, so its own mail's flag counts as well.
    const flagged = sensitive.isSensitive || itemCategories.length > 0;
    // A follow-up from someone other than the item's sender is announced under its own sender. When
    // its name reads, as pushed, like the item sender's name or address, the push shows its address
    // instead: that name alone would read as the item's sender.
    const otherSender = fields.fromAddress !== undefined && fields.fromAddress !== ''
      && fields.fromAddress.toLowerCase() !== existing.fromAddress.toLowerCase();
    const notifyOpts: InboxNotifyOptions = { flagged };
    if (otherSender) {
      // Compared as read: one Unicode form, without characters that show nothing (a soft hyphen).
      // Folded both before the push's length cut (padding cannot push the name past it) and after
      // it (the label as shown); a match either way, or a name that reads as nothing, shows the
      // address.
      const fold = (x: string): string => x.normalize('NFKC').replace(/\p{Default_Ignorable_Code_Point}/gu, '').toLowerCase();
      const readings = (x: string | undefined): string[] =>
        [sanitisePushText(fold(x ?? ''), 80), fold(sanitisePushText(x ?? '', 80))];
      const ownName = readings(fields.fromName);
      const theirs = [...readings(existing.fromName), ...readings(existing.fromAddress)];
      const showAddress = ownName.includes('') || ownName.some((r) => theirs.includes(r));
      notifyOpts.sender = { address: fields.fromAddress ?? '', name: showAddress ? undefined : fields.fromName };
    }
    if (item && !snoozed) void opts.notifier.notifyNewItem(item, notifyOpts);
  };
}
