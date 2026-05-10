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

import { ClassifierQueue, type ClassifierQueueOptions } from './classifier/queue.js';
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
import type { InboxStateDb } from './state.js';

/**
 * Payload threaded through the queue: the prompt input the classifier
 * needs PLUS the (accountId, threadKey) the persistence layer keys on.
 */
export interface InboxQueuePayload {
  accountId: string;
  threadKey: string;
  classifierInput: ClassifierPromptInput;
  /** Optional single tenant override; falls back to the repository default. */
  tenantId?: string | undefined;
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
}

/**
 * Construct the queue + callbacks. Returned queue is hot — caller pushes
 * payloads via `queue.enqueue(payload)` and shuts down via `queue.drain()`.
 */
export function buildInboxRunner(opts: BuildInboxRunnerOptions): ClassifierQueue<InboxQueuePayload> {
  const { state, llm } = opts;
  const policy = opts.policy ?? {};

  const budget = opts.budget;
  const versionStamp = opts.classifierVersionOverride ?? CLASSIFIER_VERSION;

  const queueOptions: ClassifierQueueOptions<InboxQueuePayload> = {
    classify: async (payload, ctx) => {
      // Circuit-breaker: budget exhausted → no LLM call, fail-closed verdict.
      if (budget?.isExceeded()) {
        const verdict: ClassifyResult = {
          bucket: 'requires_user',
          confidence: 0,
          reasonDe: 'Tagesbudget für Klassifizierer erreicht — manuell prüfen.',
          failReason: 'budget_exceeded',
          classifierVersion: versionStamp,
          bodyTruncated: false,
        };
        return verdict;
      }
      return classifyMail(payload.classifierInput, llm, {
        signal: ctx.signal,
        classifierVersion: opts.classifierVersionOverride,
      });
    },
    onSuccess: (payload, result) => {
      state.insertItemWithAudit(
        {
          tenantId: payload.tenantId,
          accountId: payload.accountId,
          channel: 'email',
          threadKey: payload.threadKey,
          bucket: result.bucket,
          confidence: result.confidence,
          reasonDe: result.reasonDe,
          classifiedAt: new Date(),
          classifierVersion: result.classifierVersion,
        },
        {
          tenantId: payload.tenantId,
          action: 'classified',
          actor: 'classifier',
          payloadJson: JSON.stringify({
            bucket: result.bucket,
            confidence: result.confidence,
            fail_reason: result.failReason,
            body_truncated: result.bodyTruncated,
            ...(payload.sensitive
              ? {
                  sensitive_categories: payload.sensitive.categories,
                  sensitive_masked: payload.sensitive.masked,
                  sensitive_redactions: payload.sensitive.redactionCount,
                }
              : {}),
          }),
        },
      );
    },
    onDeadLetter: (payload, error) => {
      // PRD fail-closed default: surface to Needs You so the user sees it.
      state.insertItemWithAudit(
        {
          tenantId: payload.tenantId,
          accountId: payload.accountId,
          channel: 'email',
          threadKey: payload.threadKey,
          bucket: 'requires_user',
          confidence: 0,
          reasonDe: 'Klassifizierer-Aufruf fehlgeschlagen — manuell prüfen.',
          classifiedAt: new Date(),
          classifierVersion: `dead-letter:${error.name || 'Error'}`,
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
          }),
        },
      );
    },
  };
  if (policy.maxConcurrency !== undefined) queueOptions.maxConcurrency = policy.maxConcurrency;
  if (policy.perJobTimeoutMs !== undefined) queueOptions.perJobTimeoutMs = policy.perJobTimeoutMs;
  if (policy.maxQueueDepth !== undefined) queueOptions.maxQueueDepth = policy.maxQueueDepth;
  if (policy.retryOnce !== undefined) queueOptions.retryOnce = policy.retryOnce;

  return new ClassifierQueue<InboxQueuePayload>(queueOptions);
}

