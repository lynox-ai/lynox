// === Inbox watcher hook — turns inbound MailEnvelopes into queue payloads ===
//
// Engine wiring (a separate concern, not in this commit) plugs the returned
// function in as `MailHooks.onInboundMail`. Per inbound mail the hook runs
// three checks before deciding what to do:
//
//   1. Already classified for this (account, thread)?  -> skip (re-classify
//      is Phase 3+ scope).
//   2. Matches a user-confirmed inbox_rules row?       -> write the item +
//      audit directly with `actor: 'rule_engine'`. No LLM cost.
//   3. Otherwise                                       -> enqueue for the
//      classifier runner.
//
// Phase 1a uses `env.snippet` as the body fed to the classifier. The
// snippet is provider-truncated (~200 chars) so the LLM gets less context
// than the full body would; classification quality is acceptable for the
// canary cohort, and full-body fetching can land alongside the read-pane
// integration in Phase 2.

import type { MailEnvelope } from '../mail/provider.js';
import { resolveThreadKey } from '../mail/thread-key.js';
import type { InboxChannel } from '../../types/index.js';
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
  resolve(accountId: string): { address: string; displayName: string } | null;
}

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
      return 'duplicate';
    }

    // 2. User-confirmed rule short-circuits the LLM.
    const rule = opts.rules.match({
      accountId,
      tenantId: opts.tenantId,
      from: fromAddress,
      subject,
      // listId left undefined — full RFC 2919 List-Id requires raw headers
      // which the watcher does not pass through. List-Id rules will start
      // matching once the watcher hook gains header forwarding.
    });
    const envelopeFields = envelopeToItemInputFields(env);

    if (rule) {
      const itemId = opts.state.insertItemWithAudit(
        {
          tenantId: opts.tenantId,
          accountId,
          channel,
          threadKey,
          bucket: rule.bucket,
          confidence: 1,
          reasonDe: `Regel: ${rule.matcherKind} = ${rule.matcherValue}`,
          classifiedAt: new Date(),
          classifierVersion: `rule:${rule.id}`,
          ...envelopeFields,
        },
        {
          tenantId: opts.tenantId,
          action: 'rule_applied',
          actor: 'rule_engine',
          payloadJson: JSON.stringify({
            rule_id: rule.id,
            matcher_kind: rule.matcherKind,
            matcher_value: rule.matcherValue,
            action: rule.action,
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
      if (opts.notifier && rule.bucket === 'requires_user') {
        const inserted = opts.state.getItem(itemId);
        if (inserted) void opts.notifier.notifyNewItem(inserted);
      }
      return 'rule_applied';
    }

    // 3. Sensitive-content pre-filter. Mode decides what happens:
    //    skip  → block, audit categories, no LLM
    //    mask  → redact matched substrings, classify the masked version
    //    allow → send raw, audit that user opted in
    const sensitive = analyzeSensitiveContent({ subject, body: env.snippet });
    if (sensitive.isSensitive && sensitiveMode === 'skip') {
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
            sensitive_mode: 'skip',
            skipped_llm: true,
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
        if (inserted) void opts.notifier.notifyNewItem(inserted);
      }
      return 'sensitive_skipped';
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
      },
    };
    if (opts.tenantId !== undefined) payload.tenantId = opts.tenantId;
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
        payloadJson: JSON.stringify({ dead_letter: true, reason: 'queue_overflow' }),
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
      if (inserted) void opts.notifier.notifyNewItem(inserted);
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
