// === Inbox runner — classifier queue wired to the state repository ===
//
// Composes the standalone modules into a working background runner:
//
//   classifier  →  queue  →  onSuccess writes inbox_items + audit
//                            onDeadLetter writes a fail-closed item
//
// Engine wiring constructs the queue once at startup and pushes per-mail
// payloads into it. The queue is generic over `InboxQueuePayload` — the
// watcher hook builds those from MailEnvelopes, cold-start builds them
// from a backfill iterator.
//
// Dead-letter policy: classification failure that exhausts retries still
// surfaces to the user as a `requires_user` item — a missed customer mail
// is unrepairable; an extra Needs-You item is a one-click archive.

import { ClassifierQueue, DrainedForRestoreError, DrainedForShutdownError, type ClassifierQueueOptions } from './classifier/queue.js';
import {
  CLASSIFIER_VERSION,
  classifyMail,
  type ClassifierPromptInput,
  type ClassifyResult,
  type LLMCaller,
} from './classifier/index.js';
// Re-exported from sensitive-content so both runner consumers and the
// Mistral caller can pull the scrubber without creating a module cycle.
export { scrubErrorMessage } from './sensitive-content.js';
import { scrubErrorMessage as _scrubErrorMessage } from './sensitive-content.js';
import type { InboxCostBudget } from './cost-budget.js';
import { fireBeforeRunGate, type HookHost } from '../../core/metered-request.js';
import type { InboxNotifier } from './notifier.js';
import type { InboxStateDb, ThreadMessageInput } from './state.js';
import type { InboxRulesLoader } from './rules-loader.js';
import type { InboxRule } from '../../types/index.js';
import { checkDescriptionRules } from './rule-check.js';
import { FORWARDED_REASON_DE, isForwardedByPerson } from './classifier/forwarded.js';

/**
 * Payload threaded through the queue: the prompt input the classifier
 * needs PLUS the (accountId, threadKey) the persistence layer keys on.
 */
export interface InboxQueuePayload {
  accountId: string;
  /** Channel discriminator — currently only 'email'. Default 'email' for legacy callers. */
  channel?: 'email' | undefined;
  threadKey: string;
  classifierInput: ClassifierPromptInput;
  /** Optional single tenant override; falls back to the repository default. */
  tenantId?: string | undefined;
  /**
   * v11 envelope projection. Threaded from the watcher-hook so
   * runner.onSuccess + onDeadLetter can populate from/subject/date on
   * the row even when classification fails. Pre-built via
   * `envelopeToItemInputFields` so the four insert sites share one
   * projection function.
   */
  envelope?: {
    fromAddress: string;
    fromName: string | undefined;
    subject: string;
    mailDate: Date | undefined;
    snippet: string | undefined;
    messageId: string | undefined;
    inReplyTo: string | undefined;
  } | undefined;
  /**
   * Set when the watcher hook detected sensitive content and either
   * masked it or sent it through under the `allow` mode. The runner
   * folds this into the classification audit's payload_json so the user
   * can see what was redacted (or knowingly allowed).
   */
  sensitive?: {
    categories: ReadonlyArray<string>;
    masked: boolean;
    redactionCount: number;
  } | undefined;
  /** The envelope marks the mail as an automatic reply (`Auto-Submitted: auto-replied`, such as an
   *  out-of-office note); no description rule is checked for it. Other machine-sent mail (a dunning
   *  letter from an ERP, `auto-generated`) is checked. */
  isAutoReplied?: boolean | undefined;
}

/**
 * What the watcher's sensitive check found, for the item's audit. Every audit a queued mail
 * ends in carries it — classified, dead-lettered or drained — so a reader of the item
 * (`inbox_read`) knows the mail was sensitive even where the stored 200 characters no longer
 * show it: the check ran on more of the mail than is kept.
 */
export function sensitiveAudit(payload: Pick<InboxQueuePayload, 'sensitive'>): Record<string, unknown> {
  return payload.sensitive
    ? {
        sensitive_categories: payload.sensitive.categories,
        sensitive_masked: payload.sensitive.masked,
        sensitive_redactions: payload.sensitive.redactionCount,
      }
    : {};
}

/** Subset of ClassifierQueueOptions the wiring exposes — callbacks are owned. */
export interface InboxRunnerPolicy {
  maxConcurrency?: number | undefined;
  perJobTimeoutMs?: number | undefined;
  maxQueueDepth?: number | undefined;
  retryOnce?: boolean | undefined;
}

export interface BuildInboxRunnerOptions {
  state: InboxStateDb;
  llm: LLMCaller;
  policy?: InboxRunnerPolicy | undefined;
  /** Override the classifier-version stamp (e.g. for canary). */
  classifierVersionOverride?: string | undefined;
  /**
   * Optional daily cost budget. When set, the runner short-circuits to a
   * fail-closed `requires_user` verdict (no LLM call) once the budget is
   * exhausted. Engine wiring connects `budget.recordUsage` to the LLM
   * caller's `onUsage` hook so the SDK-reported tokens flow back.
   */
  budget?: InboxCostBudget | undefined;
  /**
   * Managed credit lifecycle host. When wired (managed tenants), each classify
   * fires the `onBeforeRun` gate BEFORE the pool-key LLM call, so a
   * credit-exhausted (or fail-closed) tenant short-circuits to `requires_user`
   * instead of spending against an empty balance. No-op on self-host / BYOK (no
   * hooks registered). Distinct from `budget`, the local per-instance daily $ cap.
   */
  meteredHost?: HookHost | undefined;
  /**
   * Optional inbox push notifier. Fires on a NEW classification with
   * bucket=`requires_user`. Absent on instances without web-push wiring.
   */
  notifier?: InboxNotifier | undefined;
  /**
   * Description rules (PRD inbox-user-rules E3): the account's confirmed `matches_description`
   * rules and the cheap model that checks them, between the budget check and the classifier.
   * Absent when the feature is off.
   */
  ruleCheck?: { rules: Pick<InboxRulesLoader, 'descriptionRules'>; llm: LLMCaller } | undefined;
}

/** A description rule named the mail: its bucket, unless it would file a sensitive or forwarded
 *  mail as handled (F1, E3) — then the mail is shown, and the rule is named as withheld. */
function ruleVerdict(rule: InboxRule, payload: InboxQueuePayload): ClassifyResult {
  const label = rule.name ?? 'ohne Namen';
  const base = { classifierVersion: `rule:${rule.id}`, bodyTruncated: false, confidence: 1 };
  const named = { id: rule.id, name: rule.name, action: rule.action };
  if (rule.bucket === 'auto_handled' && payload.sensitive !== undefined) {
    return { ...base, bucket: 'requires_user', reasonDe: `Sensibler Inhalt — Regel „${label}“ nicht angewandt, bitte ansehen.`, failReason: 'rule_withheld_sensitive', rule: { ...named, withheld: 'rule_withheld_sensitive' } };
  }
  if (rule.bucket === 'auto_handled' && isForwardedByPerson(payload.classifierInput)) {
    return { ...base, bucket: 'requires_user', reasonDe: FORWARDED_REASON_DE, failReason: 'forwarded_by_person', rule: { ...named, withheld: 'forwarded_by_person' } };
  }
  return { ...base, bucket: rule.bucket, reasonDe: `Regel: ${label}`, failReason: null, rule: { ...named, withheld: false } };
}

/** An `auto_handled` hit the classifier does not confirm: its verdict stands, the rule is named as
 *  withheld (decision 801-3b A: a description rule files no mail the classifier would show). */
function ruleOverruled(rule: InboxRule, verdict: ClassifyResult): ClassifyResult {
  const label = rule.name ?? 'ohne Namen';
  return {
    ...verdict,
    classifierFailReason: verdict.failReason,
    reasonDe: `Regel „${label}“ nicht angewandt: ${verdict.reasonDe}`,
    failReason: 'rule_withheld_classifier',
    rule: { id: rule.id, name: rule.name, action: rule.action, withheld: 'rule_withheld_classifier' },
  };
}

/** An `auto_handled` hit whose check by the classifier could not run: the mail is shown. */
function ruleUnchecked(rule: InboxRule, classifierVersion: string): ClassifyResult {
  const label = rule.name ?? 'ohne Namen';
  return {
    bucket: 'requires_user',
    confidence: 0,
    reasonDe: `Regel „${label}“ nicht angewandt: Gegenprüfung nicht möglich, bitte ansehen.`,
    failReason: 'rule_withheld_unchecked',
    classifierVersion,
    bodyTruncated: false,
    rule: { id: rule.id, name: rule.name, action: rule.action, withheld: 'rule_withheld_unchecked' },
  };
}

/**
 * Construct the queue + callbacks. Returned queue is hot — caller pushes
 * payloads via `queue.enqueue(payload)` and shuts down via `queue.drain()`.
 */
export function buildInboxRunner(opts: BuildInboxRunnerOptions): ClassifierQueue<InboxQueuePayload> {
  const { state, llm } = opts;
  const policy = opts.policy ?? {};

  const budget = opts.budget;
  const meteredHost = opts.meteredHost;
  const versionStamp = opts.classifierVersionOverride ?? CLASSIFIER_VERSION;

  const budgetExceededVerdict = (reasonDe: string): ClassifyResult => ({
    bucket: 'requires_user',
    confidence: 0,
    reasonDe,
    failReason: 'budget_exceeded',
    classifierVersion: versionStamp,
    bodyTruncated: false,
  });

  const queueOptions: ClassifierQueueOptions<InboxQueuePayload> = {
    classify: async (payload, ctx) => {
      // Circuit-breaker: local daily $ budget exhausted → no LLM call.
      if (budget?.isExceeded()) {
        return budgetExceededVerdict('Tagesbudget für Klassifizierer erreicht — manuell prüfen.');
      }
      // Managed credit gate: a credit-exhausted (or control-plane-stale →
      // fail-closed) managed tenant must not drive the pool key per inbound
      // mail. No-op on self-host / BYOK.
      if (meteredHost) {
        const gate = await fireBeforeRunGate(meteredHost, 'fast');
        if (gate.blockedReason !== null) {
          return budgetExceededVerdict('AI-Guthaben erschöpft — manuell prüfen.');
        }
      }
      const classify = (): Promise<ClassifyResult> => classifyMail(payload.classifierInput, llm, {
        signal: ctx.signal,
        classifierVersion: opts.classifierVersionOverride,
      });
      // Description rules: one cheap call with the account's confirmed rules; a hit files the mail.
      // No rule, no call; an automatic reply is never checked. A failed call leaves the mail to the
      // classifier, unless the job itself was aborted (the classifier would share its signal).
      const ruleCheck = opts.ruleCheck;
      if (ruleCheck !== undefined && payload.isAutoReplied !== true) {
        let hit: InboxRule | null = null;
        try {
          hit = await checkDescriptionRules(
            ruleCheck.rules.descriptionRules(payload.accountId, payload.tenantId),
            payload.classifierInput,
            ruleCheck.llm,
            ctx.signal,
          );
        } catch (err) {
          if (ctx.signal.aborted) throw err;
        }
        if (hit !== null) {
          const verdict = ruleVerdict(hit, payload);
          if (verdict.bucket !== 'auto_handled') return verdict;
          // Filing as handled hides the mail, so the classifier checks it too: the rule applies
          // only when the classifier also sees it as handled. A check that cannot run shows it.
          if (budget?.isExceeded()) return ruleUnchecked(hit, versionStamp);
          if (meteredHost && (await fireBeforeRunGate(meteredHost, 'fast')).blockedReason !== null) {
            return ruleUnchecked(hit, versionStamp);
          }
          let check: ClassifyResult;
          try {
            check = await classify();
          } catch (err) {
            if (ctx.signal.aborted) throw err;
            return ruleUnchecked(hit, versionStamp);
          }
          return check.bucket === 'auto_handled' ? verdict : ruleOverruled(hit, check);
        }
      }
      return classify();
    },
    onSuccess: (payload, result) => {
      const envelopeFields = payload.envelope ?? {};
      const metadataWarning = _detectEmptyMetadata(payload.envelope);
      const rule = result.rule;
      const itemId = state.insertItemWithAudit(
        {
          tenantId: payload.tenantId,
          accountId: payload.accountId,
          channel: payload.channel ?? 'email',
          threadKey: payload.threadKey,
          bucket: result.bucket,
          confidence: result.confidence,
          reasonDe: result.reasonDe,
          classifiedAt: new Date(),
          classifierVersion: result.classifierVersion,
          // A rule either filed the item or was withheld on it; the item says which (v20, v21).
          ...(rule !== undefined && rule.withheld === false ? { matchedRuleId: rule.id } : {}),
          ...(rule !== undefined && rule.withheld !== false
            ? { ruleWithheld: { id: rule.id, name: rule.name, reason: rule.withheld } }
            : {}),
          ...envelopeFields,
        },
        rule === undefined
          ? {
              tenantId: payload.tenantId,
              action: 'classified',
              actor: 'classifier',
              payloadJson: JSON.stringify({
                bucket: result.bucket,
                confidence: result.confidence,
                fail_reason: result.failReason,
                body_truncated: result.bodyTruncated,
                ...sensitiveAudit(payload),
                ...(metadataWarning ? { warning: 'classified_with_empty_metadata', missing: metadataWarning } : {}),
              }),
            }
          : {
              tenantId: payload.tenantId,
              action: rule.withheld !== false ? 'classified' : 'rule_applied',
              actor: 'rule_engine',
              payloadJson: JSON.stringify({
                ...(rule.withheld !== false ? { rule_withheld: rule.id, fail_reason: result.failReason } : { rule_id: rule.id }),
                ...(result.classifierFailReason !== undefined ? { classifier_fail_reason: result.classifierFailReason } : {}),
                ...(rule.name !== undefined ? { rule_name: rule.name } : {}),
                matcher_kind: 'matches_description',
                stage: 'description',
                bucket: result.bucket,
                action: rule.action,
                ...sensitiveAudit(payload),
                ...(metadataWarning ? { warning: 'classified_with_empty_metadata', missing: metadataWarning } : {}),
              }),
            },
      );
      // Persist the sanitised body the classifier saw so the draft
      // generator can read it without a second provider round-trip. We
      // store the masked variant when sensitive-mode = 'mask' so the
      // generator never receives PII the classifier was forbidden from
      // seeing; for 'skip' the item bucket is `requires_user` and the
      // body is intentionally empty (no LLM-readable content).
      const body = payload.classifierInput.body;
      if (typeof body === 'string' && body.length > 0) {
        state.saveItemBody(itemId, body, payload.channel ?? 'email');
      }
      _writeThreadMessage(state, payload, itemId, body);
      if (opts.notifier && result.bucket === 'requires_user') {
        const item = state.getItem(itemId);
        if (item) void opts.notifier.notifyNewItem(item);
      }
    },
    onDeadLetter: (payload, error) => {
      // PRD fail-closed default: surface to Needs You so the user sees it.
      const envelopeFields = payload.envelope ?? {};
      if (error instanceof DrainedForRestoreError || error instanceof DrainedForShutdownError) {
        // Waiting when a migration restore stopped the engine: never sent to the classifier.
        // Or, on a shutdown, waiting when its classify window ran out or cut off while running.
        // The body it would have seen goes with it, as for an overflowing queue. No notification
        // per mail: the process is ending, and the items wait in Needs You.
        const forRestore = error instanceof DrainedForRestoreError;
        const drainedId = state.insertItemWithAudit(
          {
            tenantId: payload.tenantId,
            accountId: payload.accountId,
            channel: payload.channel ?? 'email',
            threadKey: payload.threadKey,
            bucket: 'requires_user',
            confidence: 0,
            reasonDe: forRestore
              ? 'Wegen der Migration nicht klassifiziert — manuell prüfen.'
              : 'Beim Herunterfahren nicht klassifiziert — manuell prüfen.',
            classifiedAt: new Date(),
            classifierVersion: forRestore ? 'restore-drain' : 'shutdown-drain',
            ...envelopeFields,
          },
          {
            tenantId: payload.tenantId,
            action: 'classified',
            actor: 'system',
            payloadJson: JSON.stringify({ dead_letter: true, reason: forRestore ? 'restore_drain' : 'shutdown_drain', ...sensitiveAudit(payload) }),
          },
        );
        _writeThreadMessage(state, payload, drainedId, payload.classifierInput.body);
        return;
      }
      const itemId = state.insertItemWithAudit(
        {
          tenantId: payload.tenantId,
          accountId: payload.accountId,
          channel: payload.channel ?? 'email',
          threadKey: payload.threadKey,
          bucket: 'requires_user',
          confidence: 0,
          reasonDe: 'Klassifizierer-Aufruf fehlgeschlagen — manuell prüfen.',
          classifiedAt: new Date(),
          classifierVersion: `dead-letter:${error.name || 'Error'}`,
          ...envelopeFields,
        },
        {
          tenantId: payload.tenantId,
          action: 'classified',
          actor: 'classifier',
          payloadJson: JSON.stringify({
            dead_letter: true,
            // SDK errors usually do not echo the request body, but we cap
            // length and strip secret-prefix patterns before persisting +
            // reporting so a chatty future SDK cannot leak prompt content
            // into audit logs or downstream Bugsink reports.
            error_message: _scrubErrorMessage(error.message),
            ...sensitiveAudit(payload),
          }),
        },
      );
      // Dead-letter still records the message — operator may need to
      // see what arrived even when classify failed. No body (none was
      // successfully classified).
      _writeThreadMessage(state, payload, itemId, undefined);
      if (opts.notifier) {
        const item = state.getItem(itemId);
        if (item) void opts.notifier.notifyNewItem(item);
      }
    },
  };
  if (policy.maxConcurrency !== undefined) queueOptions.maxConcurrency = policy.maxConcurrency;
  if (policy.perJobTimeoutMs !== undefined) queueOptions.perJobTimeoutMs = policy.perJobTimeoutMs;
  if (policy.maxQueueDepth !== undefined) queueOptions.maxQueueDepth = policy.maxQueueDepth;
  if (policy.retryOnce !== undefined) queueOptions.retryOnce = policy.retryOnce;

  return new ClassifierQueue<InboxQueuePayload>(queueOptions);
}

/**
 * Writer-layer metadata validation (PRD §Multi-Insert-Site Architecture).
 *
 * Returns the missing-field names when from_address or subject is empty —
 * the caller folds this into the classification audit's payload_json as
 * a `classified_with_empty_metadata` warning. Insert proceeds either
 * way: the user must still see every item, even ones the provider gave
 * us with mangled headers.
 */
function _detectEmptyMetadata(env: InboxQueuePayload['envelope']): ReadonlyArray<string> | null {
  if (!env) return null;
  const missing: string[] = [];
  if (env.fromAddress.length === 0) missing.push('from_address');
  if (env.subject.length === 0) missing.push('subject');
  return missing.length > 0 ? missing : null;
}

/**
 * v12 thread_message write: store the per-message envelope after the
 * classifier (or dead-letter) has decided the row's bucket. Skips
 * silently when the payload lacks a Message-ID — we cannot dedup
 * messages without one.
 */
function _writeThreadMessage(
  state: InboxStateDb,
  payload: InboxQueuePayload,
  inboxItemId: string,
  bodyMd: string | undefined,
): void {
  const env = payload.envelope;
  if (!env || !env.messageId || env.messageId.length === 0) return;
  const input: ThreadMessageInput = {
    accountId: payload.accountId,
    threadKey: payload.threadKey,
    messageId: env.messageId,
    fromAddress: env.fromAddress,
    subject: env.subject,
    direction: 'inbound',
    inboxItemId,
  };
  if (payload.tenantId !== undefined) input.tenantId = payload.tenantId;
  if (env.fromName !== undefined) input.fromName = env.fromName;
  if (env.inReplyTo !== undefined) input.inReplyTo = env.inReplyTo;
  if (env.mailDate !== undefined) input.mailDate = env.mailDate;
  if (env.snippet !== undefined) input.snippet = env.snippet;
  if (bodyMd !== undefined && bodyMd.length > 0) input.bodyMd = bodyMd;
  state.insertThreadMessage(input);
}

