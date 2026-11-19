// === Inbox watcher hook — turns inbound MailEnvelopes into queue payloads ===
//
// Engine wiring (a separate concern, not in this commit) plugs the returned
// function in as `MailHooks.onInboundMail`. Per inbound mail the hook runs
// these checks before deciding what to do:
//
//   1. Already classified for this (account, thread)?  -> skip (re-classify
//      is Phase 3+ scope).
//   2. Matches a user-confirmed inbox_rules row?       -> write the item +
//      audit directly with `actor: 'rule_engine'`. No LLM cost. A rule of
//      any kind that would file sensitive content as handled gives way to
//      step 3; one that files it as needing the user applies.
//   3. Sensitive content (OTP, credentials)?           -> by `sensitiveMode`.
//   3b. A newsletter domain, nothing sensitive?        -> a visible handled
//                                                         item, no LLM cost.
//       A delivery failure notice, nothing sensitive?  -> an item that needs
//                                                         the user, no LLM, no push.
//   4. Otherwise                                       -> enqueue for the
//      classifier runner.
//
// Every item records which prefilter rule its mail met (`prefilterRule`), so
// what the classifier spends on, say, no-reply mail can be counted per rule.
//
// Phase 1a uses `env.snippet` as the body fed to the classifier. The
// snippet is provider-truncated (~200 chars) so the LLM gets less context
// than the full body would; classification quality is acceptable for the
// canary cohort, and full-body fetching can land alongside the read-pane
// integration in Phase 2.

import type { MailAuthType, MailEnvelope } from '../mail/provider.js';
import { prefilter } from '../mail/triage/rules.js';
import { resolveThreadKey } from '../mail/thread-key.js';
import type { InboxChannel, InboxItem, InboxRule } from '../../types/index.js';
import type { ClassifierPromptInput } from './classifier/index.js';
import type { InboxRulesLoader } from './rules-loader.js';
import type { InboxQueuePayload } from './runner.js';
import { analyzeSensitiveContent, reasonForCategories, type SensitiveMode } from './sensitive-content.js';
import { envelopeToItemInputFields, type InboxStateDb, type ThreadMessageInput } from './state.js';

/**
 * Channel discriminator. Currently only `email` ships — other channels
 * (when reintroduced) will be pseudo-accounts with a `<channel>:<id>` prefix
 * and this helper will route them accordingly.
 */
function channelFromAccountId(_accountId: string): InboxChannel {
  return 'email';
}

/**
 * Resolves an accountId to the bits the classifier prompt needs (address +
 * display name as trusted system context). Engine wiring backs this with
 * `MailStateDb.getAccount(id)`; tests pass a plain Map.
 */
export interface AccountResolver {
  resolve(accountId: string): { address: string; displayName: string; authType?: MailAuthType | undefined } | null;
}

/**
 * Providers whose watch envelope cannot tell an automatic reply: Graph's delta query carries no
 * headers, so `isAutoReply` is always false there (`providers/oauth-graph.ts`, ENVELOPE_FIELDS).
 * For every follow-up from someone else on such an account, the hook asks `confirmAutoReply`.
 */
const AUTO_REPLY_NOT_IN_ENVELOPE: ReadonlySet<MailAuthType> = new Set(['oauth_microsoft']);

export interface HookQueue {
  enqueue(payload: InboxQueuePayload): boolean;
}

export interface InboxClassifierHookOptions {
  state: InboxStateDb;
  rules: InboxRulesLoader;
  queue: HookQueue;
  accounts: AccountResolver;
  /**
   * Optional inbox push notifier. Wired the same way as runner.ts —
   * fires on the rule + sensitive-skip paths that bypass the LLM but
   * still produce a `requires_user` row.
   */
  notifier?: import('./notifier.js').InboxNotifier | undefined;
  /** Single tenant override; falls back to the repository default. */
  tenantId?: string | undefined;
  /**
   * How to handle mails the sensitive-content detector flags:
   *   skip  (default) — block, insert as requires_user, no LLM call
   *   mask  — redact matched substrings, classify the masked version
   *   allow — send raw to the LLM (only for trusted EU/self-hosted)
   */
  sensitiveMode?: SensitiveMode | undefined;
  /**
   * Folder names whose mails are skipped entirely (Banking, Privat,
   * Healthcare). Case-insensitive exact match against env.folder. The
   * mail is acknowledged (existing dedup runs) but never classified.
   */
  folderBlacklist?: ReadonlySet<string> | undefined;
  /**
   * Account ids whose mails are skipped. Useful for excluding a
   * sensitive mailbox (lawyer / health / etc.) without disabling the
   * whole inbox feature. Engine wiring populates from env.
   */
  disabledAccounts?: ReadonlySet<string> | undefined;
  /**
   * Reads the full message of an account whose envelope cannot tell an automatic reply
   * (`AUTO_REPLY_NOT_IN_ENVELOPE`) and answers whether it is one. Asked once for every follow-up
   * from someone else, so the stored message carries the answer for "Reply in chat". Missing, or
   * throwing, the answer is unknown: a replied item reopens (losing a customer's message weighs
   * more than one needless notification), and the chat does not take that message.
   */
  confirmAutoReply?: ((accountId: string, env: MailEnvelope) => Promise<boolean>) | undefined;
}

/**
 * Outcome of processing one inbound mail through the hook. Lets callers
 * (the cold-start backfill) count real LLM-queue enqueues vs. dead-lettered
 * overflow vs. no-LLM short-circuits, instead of assuming every envelope was
 * enqueued (which mis-reported the backfill cost + hid queue rejections).
 */
export type InboxHookOutcome =
  | 'enqueued' // handed to the classifier queue (incurs an LLM call)
  | 'dead_lettered' // queue full/draining → surfaced as a requires_user item
  | 'rule_applied' // a user rule short-circuited the LLM
  | 'sensitive_skipped' // sensitive-content prefilter blocked the LLM
  | 'prefilter_filed' // a newsletter (handled) or a delivery failure notice (needs the user), no LLM
  | 'duplicate' // already-classified thread (possibly auto-unsnoozed)
  | 'ignored'; // disabled account / folder blacklist / no sender / unknown account

export type OnInboundMailHook = (accountId: string, env: MailEnvelope) => Promise<InboxHookOutcome>;

/**
 * Build the per-mail hook. Pure factory — no global state, safe to call
 * multiple times if a future test or engine variant needs it.
 */
export function createInboxClassifierHook(opts: InboxClassifierHookOptions): OnInboundMailHook {
  const sensitiveMode: SensitiveMode = opts.sensitiveMode ?? 'skip';
  const folderBlacklistLower = opts.folderBlacklist
    ? new Set([...opts.folderBlacklist].map((f) => f.toLowerCase()))
    : undefined;
  const disabledAccounts = opts.disabledAccounts;

  /**
   * A new message in a thread the inbox already holds (PRD inbox-user-rules E6). It is stored as a
   * thread message after the same sensitive check a first mail gets: without its text on `skip`,
   * masked on `mask`. A `replied` item opens again for it, unless it is an automatic reply; the
   * bucket stays, and no rule or classifier runs. A message the check flags raises the item to
   * "requires you" instead, open and not snoozed, and pushes. Without a Message-ID, or when the message is
   * stored already, nothing happens. Only Gmail and Graph have threads: on IMAP the thread key is the
   * Message-ID, so only a redelivered mail comes here, and it is stored already.
   */
  const recordFollowUp = async (
    existing: InboxItem,
    env: MailEnvelope,
    mode: SensitiveMode,
    account: { address: string; authType?: MailAuthType | undefined },
    wokeForThis: boolean,
  ): Promise<void> => {
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
    // it is stored as sent, so neither reopening nor "Reply in chat" takes it.
    const own = (fields.fromAddress ?? '').toLowerCase() === account.address.toLowerCase();
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
    // A message older than the reply (a backfill or a redelivery) did not come after it.
    const beforeUserAction = fields.mailDate !== undefined && existing.userActionAt !== undefined
      && fields.mailDate.getTime() <= existing.userActionAt.getTime();
    // A flagged message from someone else brings the item back to "requires you", whatever its
    // bucket, user action or snooze, as a flagged first mail lands there: no classifier verdict, no
    // rule and no earlier "done" keeps it out of the owner's view. An automatic reply counts too,
    // since a flagged first mail is not let through for being one.
    const raises = sensitive.isSensitive && !own && !beforeUserAction;
    // Otherwise only a `replied` item opens; `reopenReplied` checks that again in its UPDATE.
    // An unknown answer reopens (see `confirmAutoReply`): only a known automatic reply does not.
    const opens = existing.userAction === 'replied' && autoReply !== true && !own && !beforeUserAction;
    // What the check found in the item's own mail, before this message.
    const itemCategories = opts.state.sensitiveCategoriesAtIngest(existing);
    const outcome = opts.state.runInTransaction((): 'raised' | 'reopened' | 'none' => {
      opts.state.insertThreadMessage(input);
      // Decided on the row as it is now, inside the write, so two flagged messages arriving together
      // raise it once. An item open in "requires you" stays as it is, unless this mail woke it from
      // a snooze a moment ago (`unsnooze_on_reply` above) and nothing has raised or reopened it since
      // (both set `classified_at`): then it was out of view before, and this mail is what shows it.
      const current = raises ? opts.state.getItem(existing.id, existing.tenantId) : undefined;
      const openNow = current !== undefined && current !== null && current.bucket === 'requires_user'
        && current.userAction === undefined
        && !(current.snoozeUntil !== undefined && current.snoozeUntil.getTime() > Date.now());
      const wokeAndUntouched = wokeForThis && current !== undefined && current !== null
        && current.classifiedAt.getTime() === existing.classifiedAt.getTime();
      if (raises && (!openNow || wokeAndUntouched)) {
        opts.state.raiseToRequiresUser(existing.id, existing.tenantId, fields.mailDate ?? new Date());
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
            prior_user_action: existing.userAction ?? null,
            prior_snooze_until: existing.snoozeUntil?.toISOString() ?? null,
            prior_sensitive_categories: itemCategories,
            follow_up_sensitive_categories: sensitive.categories,
          }),
        });
        return 'raised';
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
    });
    if (outcome === 'none' || !opts.notifier) return;
    if (outcome === 'reopened' && existing.bucket !== 'requires_user') return;
    const item = opts.state.getItem(existing.id, existing.tenantId);
    // A snoozed item is not in the list until it wakes; a push now would lead nowhere. A raised item
    // is not snoozed any more.
    const snoozed = item?.snoozeUntil !== undefined && item.snoozeUntil.getTime() > Date.now();
    // The push names the item's own sender and subject, so its own mail's flag counts as well.
    const flagged = sensitive.isSensitive || itemCategories.length > 0;
    if (item && !snoozed) void opts.notifier.notifyNewItem(item, { flagged });
  };

  return async (accountId, env): Promise<InboxHookOutcome> => {
    if (disabledAccounts?.has(accountId)) return 'ignored';
    if (folderBlacklistLower?.has(env.folder.toLowerCase())) return 'ignored';

    const account = opts.accounts.resolve(accountId);
    if (!account) return 'ignored'; // unknown account — nothing to do

    const fromAddress = env.from[0]?.address ?? '';
    if (!fromAddress) return 'ignored'; // no sender, no classification

    const channel = channelFromAccountId(accountId);

    const fromDisplayName = env.from[0]?.name;
    const subject = env.subject;
    const threadKey = resolveThreadKey(env);

    // 1. Skip duplicate work — Phase 1a always inserts on miss; re-classify on
    //    new replies is Phase 3+. Before short-circuiting, run the
    //    auto-unsnooze-on-reply check: if the existing item is snoozed AND
    //    the user opted into unsnooze-on-reply when snoozing, a new mail in
    //    the same thread is the signal to wake it up. Without this the flag
    //    that the schema, the API, and the UI all support was a dead feature
    //    — set, stored, never read (audit K-SR-01).
    const existing = opts.state.findItemByThread(accountId, threadKey);
    if (existing) {
      const snoozeUntilMs = existing.snoozeUntil?.getTime();
      const stillSnoozed = snoozeUntilMs !== undefined && snoozeUntilMs > Date.now();
      if (stillSnoozed && existing.unsnoozeOnReply) {
        // Snooze clear + audit must commit together — if the audit insert
        // throws the snooze should still be live, and vice versa.
        opts.state.runInTransaction(() => {
          opts.state.setSnooze(existing.id, null, null);
          opts.state.appendAudit({
            tenantId: opts.tenantId,
            itemId: existing.id,
            action: 'unsnoozed_on_reply',
            actor: 'system',
            payloadJson: JSON.stringify({ trigger: 'inbound_mail' }),
          });
        });
      }
      await recordFollowUp(existing, env, sensitiveMode, account, stillSnoozed && existing.unsnoozeOnReply);
      return 'duplicate';
    }

    // 2. User-confirmed rule short-circuits the LLM.
    // What the sensitive check finds in this mail. Run before the rule, which files the mail
    // without it, so the rule's audit records it too: the store keeps 200 characters of what
    // the check read, and a reader of the item (`inbox_read`) withholds the mail by this.
    const sensitive = analyzeSensitiveContent({ subject, body: env.snippet });
    const rule = opts.rules.match({
      accountId,
      tenantId: opts.tenantId,
      from: fromAddress,
      subject,
      listId: env.listId,
    });
    // Only the sender the user sees decides: with several From addresses, a
    // newsletter domain behind a contact's address must not file it as handled.
    const pre = prefilter({ ...env, from: env.from.slice(0, 1) });
    const filed: { bucket: 'requires_user' | 'auto_handled'; reasonDe: string } | undefined = pre.rule === 'bounce'
      ? { bucket: 'requires_user', reasonDe: 'Meldet, dass eine deiner Mails nicht ankam. Prüf in deinen gesendeten Mails, ob das stimmt.' }
      : (pre.rule === 'newsletter_domain' || pre.rule === 'bulk_subdomain') && pre.domain !== undefined
        ? { bucket: 'auto_handled', reasonDe: `Newsletter-Domain: ${pre.domain}` }
        : undefined;
    const envelopeFields = { ...envelopeToItemInputFields(env), prefilterRule: pre.rule };
    // A rule that would file a sensitive mail as handled does not apply:
    // the mail goes to "requires you" as a sensitive skip, whatever the mode, so neither a rule nor
    // the classifier silences it. The owner's own rules included, and a list-id rule too: any
    // sender can write a `List-Id`. A rule that files it as needing the user still applies.
    const withheldRule = rule && rule.bucket === 'auto_handled' && sensitive.isSensitive ? rule : null;

    if (rule && !withheldRule) {
      const itemId = opts.state.insertItemWithAudit(
        {
          tenantId: opts.tenantId,
          accountId,
          channel,
          threadKey,
          bucket: rule.bucket,
          confidence: 1,
          reasonDe: ruleReasonDe(rule),
          classifiedAt: new Date(),
          classifierVersion: `rule:${rule.id}`,
          matchedRuleId: rule.id,
          ...envelopeFields,
        },
        {
          tenantId: opts.tenantId,
          action: 'rule_applied',
          actor: 'rule_engine',
          payloadJson: JSON.stringify({
            rule_id: rule.id,
            // The name stays here when the rule is deleted and the item's rule id is cleared.
            ...(rule.name !== undefined ? { rule_name: rule.name } : {}),
            matcher_kind: rule.matcherKind,
            matcher_value: rule.matcherValue,
            action: rule.action,
            ...(sensitive.isSensitive ? { sensitive_categories: sensitive.categories } : {}),
          }),
        },
      );
      writeThreadMessageFromEnvelope(opts.state, {
        tenantId: opts.tenantId,
        accountId,
        threadKey,
        env,
        envelopeFields,
        // Under `skip` a flagged mail is stored without its text, as on the sensitive-skip branch.
        bodyMd: sensitive.isSensitive && sensitiveMode === 'skip' ? undefined : env.snippet,
        inboxItemId: itemId,
      });
      if (opts.notifier && rule.bucket === 'requires_user') {
        const inserted = opts.state.getItem(itemId);
        if (inserted) void opts.notifier.notifyNewItem(inserted, { flagged: sensitive.isSensitive });
      }
      return 'rule_applied';
    }

    // 3. Sensitive-content pre-filter. Mode decides what happens:
    //    skip  → block, audit categories, no LLM
    //    mask  → redact matched substrings, classify the masked version
    //    allow → send raw, audit that user opted in
    if (sensitive.isSensitive && (sensitiveMode === 'skip' || withheldRule)) {
      const itemId = opts.state.insertItemWithAudit(
        {
          tenantId: opts.tenantId,
          accountId,
          channel,
          threadKey,
          bucket: 'requires_user',
          confidence: 0,
          reasonDe: reasonForCategories(sensitive.categories),
          classifiedAt: new Date(),
          classifierVersion: 'sensitive-prefilter',
          ...envelopeFields,
        },
        {
          tenantId: opts.tenantId,
          action: 'classified',
          actor: 'rule_engine',
          payloadJson: JSON.stringify({
            sensitive_categories: sensitive.categories,
            sensitive_mode: withheldRule ? sensitiveMode : 'skip',
            skipped_llm: true,
            ...(withheldRule ? { rule_withheld: withheldRule.id } : {}),
          }),
        },
      );
      // Sensitive-skip stores no body (PRD: bucket=requires_user, no LLM-readable content).
      writeThreadMessageFromEnvelope(opts.state, {
        tenantId: opts.tenantId,
        accountId,
        threadKey,
        env,
        envelopeFields,
        bodyMd: undefined,
        inboxItemId: itemId,
      });
      if (opts.notifier) {
        const inserted = opts.state.getItem(itemId);
        if (inserted) void opts.notifier.notifyNewItem(inserted, { flagged: true });
      }
      return 'sensitive_skipped';
    }

    // 3b. Mail from a newsletter domain (`newsletter.*`, a bulk subdomain of
    //     three or more levels) is filed as handled, visibly, without an LLM
    //     call; the watcher used to drop it unseen. A delivery failure notice
    //     is filed as needing the user, also without an LLM call and without
    //     a push: it may be the only sign that a mail the user sent did not
    //     arrive, and such notices come in waves the classifier's daily
    //     budget should not pay for. The reason says only what the mail
    //     claims; its sender is written by whoever sent it. An automated sender (no-reply, notifications, alerts) is
    //     classified like any mail: real invoices and warnings come from
    //     there. A user's from, subject and list-id rule decides first (a rule
    //     on a description is applied later, by the classifier's runner), and
    //     the sensitive check comes before this.
    if (filed !== undefined && !sensitive.isSensitive) {
      const itemId = opts.state.insertItemWithAudit(
        {
          tenantId: opts.tenantId,
          accountId,
          channel,
          threadKey,
          bucket: filed.bucket,
          confidence: 1,
          reasonDe: filed.reasonDe,
          classifiedAt: new Date(),
          classifierVersion: 'prefilter',
          ...envelopeFields,
        },
        {
          tenantId: opts.tenantId,
          action: 'classified',
          actor: 'rule_engine',
          payloadJson: JSON.stringify({
            prefilter_rule: pre.rule,
            ...(pre.domain !== undefined ? { domain: pre.domain } : {}),
            ...(env.listId !== undefined ? { list_id: env.listId } : {}),
            skipped_llm: true,
          }),
        },
      );
      writeThreadMessageFromEnvelope(opts.state, {
        tenantId: opts.tenantId,
        accountId,
        threadKey,
        env,
        envelopeFields,
        bodyMd: env.snippet,
        inboxItemId: itemId,
      });
      // No push, a delivery failure notice's either: one wave would use up the
      // shared push budget that a code or an invoice needs, and anyone can
      // write `postmaster@` in From to buy a guaranteed alert.
      return 'prefilter_filed';
    }

    // 4. Enqueue for the classifier. Backpressure (queue full / draining) must
    //    NOT silently drop the mail — the watcher already marked it seen, so a
    //    dropped enqueue is a permanent loss with no trace. On rejection we
    //    dead-letter it as a requires_user item (like runner.onDeadLetter, but
    //    keeping the body it would have classified) so an inbound always
    //    surfaces. For mode=mask we substitute the masked
    //    subject/body; for mode=allow we send the raw envelope but tag the
    //    payload so audit records the detected categories alongside the verdict.
    const useMasked = sensitive.isSensitive && sensitiveMode === 'mask';
    const promptSubject = useMasked ? sensitive.masked.subject : subject;
    const promptBody = useMasked ? sensitive.masked.body : env.snippet;
    const classifierInput: ClassifierPromptInput = {
      accountAddress: account.address,
      accountDisplayName: account.displayName,
      subject: promptSubject,
      fromAddress,
      fromDisplayName,
      body: promptBody,
    };
    const payload: InboxQueuePayload = {
      accountId,
      channel,
      threadKey,
      classifierInput,
      envelope: {
        fromAddress: envelopeFields.fromAddress ?? '',
        fromName: envelopeFields.fromName,
        subject: envelopeFields.subject ?? '',
        mailDate: envelopeFields.mailDate,
        snippet: envelopeFields.snippet,
        messageId: envelopeFields.messageId,
        inReplyTo: envelopeFields.inReplyTo,
        prefilterRule: envelopeFields.prefilterRule,
      },
    };
    if (opts.tenantId !== undefined) payload.tenantId = opts.tenantId;
    // No description rule is checked for an automatic reply such as an out-of-office note (runner).
    // On Microsoft 365 the watch envelope carries no headers, so this is false there.
    if (env.isAutoReplied === true) payload.isAutoReplied = true;
    if (sensitive.isSensitive) {
      payload.sensitive = {
        categories: sensitive.categories,
        masked: useMasked,
        redactionCount: useMasked ? sensitive.masked.redactionCount : 0,
      };
    }
    const accepted = opts.queue.enqueue(payload);
    if (accepted) return 'enqueued';

    // Queue full or draining — dead-letter instead of dropping. The mail was
    // already marked seen upstream, so without this it would vanish on a burst
    // (the classifier queue is in-memory; there is no unclassified pool to
    // retry from). Surface it as a requires_user item so the user still sees it.
    const deadLetterId = opts.state.insertItemWithAudit(
      {
        tenantId: opts.tenantId,
        accountId,
        channel,
        threadKey,
        bucket: 'requires_user',
        confidence: 0,
        reasonDe: 'Klassifizierungs-Warteschlange voll — manuell prüfen.',
        classifiedAt: new Date(),
        classifierVersion: 'queue-overflow',
        ...envelopeFields,
      },
      {
        tenantId: opts.tenantId,
        action: 'classified',
        actor: 'system',
        payloadJson: JSON.stringify({
          dead_letter: true, reason: 'queue_overflow',
          ...(sensitive.isSensitive ? { sensitive_categories: sensitive.categories, sensitive_masked: useMasked } : {}),
        }),
      },
    );
    // Store the body the classifier would have seen (masked variant under
    // mode=mask) so the user has context on the surfaced item.
    writeThreadMessageFromEnvelope(opts.state, {
      tenantId: opts.tenantId,
      accountId,
      threadKey,
      env,
      envelopeFields,
      bodyMd: promptBody,
      inboxItemId: deadLetterId,
    });
    if (opts.notifier) {
      const inserted = opts.state.getItem(deadLetterId);
      if (inserted) void opts.notifier.notifyNewItem(inserted, { flagged: sensitive.isSensitive });
    }
    return 'dead_lettered';
  };
}


/**
 * v12 sibling write: store the per-message envelope in
 * `inbox_thread_messages` after the inbox_items insert. Skips silently
 * when the mail has no Message-ID header (we can't dedup it). Direction
 * is always 'inbound' here — outbound mails come from send-core's
 * post-send hook, not this watcher path.
 */
function writeThreadMessageFromEnvelope(
  state: InboxStateDb,
  args: {
    tenantId: string | undefined;
    accountId: string;
    threadKey: string;
    env: MailEnvelope;
    envelopeFields: ReturnType<typeof envelopeToItemInputFields>;
    bodyMd: string | undefined;
    inboxItemId: string;
  },
): void {
  if (!args.env.messageId || args.env.messageId.length === 0) return;
  const input: ThreadMessageInput = {
    accountId: args.accountId,
    threadKey: args.threadKey,
    messageId: args.env.messageId,
    fromAddress: args.envelopeFields.fromAddress ?? '',
    subject: args.envelopeFields.subject ?? '',
    direction: 'inbound',
    inboxItemId: args.inboxItemId,
  };
  if (args.tenantId !== undefined) input.tenantId = args.tenantId;
  if (args.envelopeFields.fromName !== undefined) input.fromName = args.envelopeFields.fromName;
  if (args.envelopeFields.inReplyTo !== undefined) input.inReplyTo = args.envelopeFields.inReplyTo;
  if (args.envelopeFields.mailDate !== undefined) input.mailDate = args.envelopeFields.mailDate;
  if (args.envelopeFields.snippet !== undefined) input.snippet = args.envelopeFields.snippet;
  if (args.bodyMd !== undefined) input.bodyMd = args.bodyMd;
  state.insertThreadMessage(input);
}

/** The reason a rule's item shows: what the rule matched, named in words, never a field name. */
function ruleReasonDe(rule: InboxRule): string {
  switch (rule.matcherKind) {
    case 'from': return `Regel: Absender = ${rule.matcherValue}`;
    case 'subject_contains': return `Regel: Betreff enthält ${rule.matcherValue}`;
    case 'list_id': return `Regel: Verteilerliste = ${rule.matcherValue}`;
    // A rule on a description is applied by the classifier's runner, named.
    case 'matches_description': return `Regel: ${rule.name ?? 'ohne Namen'}`;
  }
}
