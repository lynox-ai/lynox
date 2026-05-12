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
import type { InboxChannel } from '../../types/index.js';
import type { ClassifierPromptInput } from './classifier/index.js';
import type { InboxRulesLoader } from './rules-loader.js';
import type { InboxQueuePayload } from './runner.js';
import { analyzeSensitiveContent, reasonForCategories, type SensitiveMode } from './sensitive-content.js';
import { envelopeToItemInputFields, type InboxStateDb } from './state.js';

/**
 * Pseudo-accounts for non-mail channels carry an `<channel>:<id>` prefix
 * in their accountId (e.g. `whatsapp:default`). Real mail account ids
 * never start with `<channel>:` so the prefix check is unambiguous.
 */
function channelFromAccountId(accountId: string): InboxChannel {
  if (accountId.startsWith('whatsapp:')) return 'whatsapp';
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

export type OnInboundMailHook = (accountId: string, env: MailEnvelope) => Promise<void>;

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
  return async (accountId, env) => {
    if (disabledAccounts?.has(accountId)) return;
    if (folderBlacklistLower?.has(env.folder.toLowerCase())) return;

    const account = opts.accounts.resolve(accountId);
    if (!account) return; // unknown account — nothing to do

    const fromAddress = env.from[0]?.address ?? '';
    if (!fromAddress) return; // no sender, no classification

    const channel = channelFromAccountId(accountId);

    const fromDisplayName = env.from[0]?.name;
    const subject = env.subject;
    const threadKey = resolveThreadKey(env);

    // 1. Skip duplicate work — Phase 1a always inserts on miss; re-classify on
    //    new replies is Phase 3+.
    const existing = opts.state.findItemByThread(accountId, threadKey);
    if (existing) return;

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
      opts.state.insertItemWithAudit(
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
      return;
    }

    // 3. Sensitive-content pre-filter. Mode decides what happens:
    //    skip  → block, audit categories, no LLM
    //    mask  → redact matched substrings, classify the masked version
    //    allow → send raw, audit that user opted in
    const sensitive = analyzeSensitiveContent({ subject, body: env.snippet });
    if (sensitive.isSensitive && sensitiveMode === 'skip') {
      opts.state.insertItemWithAudit(
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
      return;
    }

    // 4. Enqueue for the classifier — backpressure (queue full) drops the
    //    mail back to the unclassified pool; the watcher's next tick retries.
    //    For mode=mask we substitute the masked subject/body; for mode=allow
    //    we send the raw envelope but tag the payload so audit records the
    //    detected categories alongside the verdict.
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
    opts.queue.enqueue(payload);
  };
}

/**
 * Stable per-channel key for an envelope. Prefers the provider's threading
 * decision, falls back to the Message-ID, and finally synthesises one from
 * the (folder, uid) pair so dedup never collapses unrelated mails. Exported
 * because the body-refresh adapter must produce the same key shape — drift
 * would silently break the match-by-threadKey lookup on reload.
 */
export function resolveThreadKey(env: MailEnvelope): string {
  if (env.threadKey) return env.threadKey;
  if (env.messageId) return `imap:${env.messageId}`;
  return `imap:${env.folder}:${String(env.uid)}`;
}
