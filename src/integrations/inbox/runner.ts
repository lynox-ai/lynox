// === Inbox runner — classifier queue wired to the state repository ===
//
// Composes the standalone modules into a working background runner:
//
//   classifier  →  queue  →  onSuccess writes inbox_items + audit
//                            onDeadLetter writes a fail-closed item
//
// Watcher-side wiring (next commit) constructs the queue once at startup
// and pushes per-mail payloads into it. The queue here is generic over
// `InboxQueuePayload` — the watcher hook builds those from MailEnvelopes,
// cold-start builds them from a backfill iterator.
//
// Dead-letter policy: per PRD §Threat Model fail-closed default, a
// classification failure that exhausts retries still surfaces to the user
// as a `requires_user` item. A missed customer mail is unrepairable; an
// extra Needs-You item is a one-click archive.

import { ClassifierQueue, type ClassifierQueueOptions } from './classifier/queue.js';
import { classifyMail, type ClassifierPromptInput, type LLMCaller } from './classifier/index.js';
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
}

/**
 * Construct the queue + callbacks. Returned queue is hot — caller pushes
 * payloads via `queue.enqueue(payload)` and shuts down via `queue.drain()`.
 */
export function buildInboxRunner(opts: BuildInboxRunnerOptions): ClassifierQueue<InboxQueuePayload> {
  const { state, llm } = opts;
  const policy = opts.policy ?? {};

  const queueOptions: ClassifierQueueOptions<InboxQueuePayload> = {
    classify: (payload, ctx) =>
      classifyMail(payload.classifierInput, llm, {
        signal: ctx.signal,
        classifierVersion: opts.classifierVersionOverride,
      }),
    onSuccess: (payload, result) => {
      const itemId = state.insertItem({
        tenantId: payload.tenantId,
        accountId: payload.accountId,
        channel: 'email',
        threadKey: payload.threadKey,
        bucket: result.bucket,
        confidence: result.confidence,
        reasonDe: result.reasonDe,
        classifiedAt: new Date(),
        classifierVersion: result.classifierVersion,
      });
      state.appendAudit({
        tenantId: payload.tenantId,
        itemId,
        action: 'classified',
        actor: 'classifier',
        payloadJson: JSON.stringify({
          bucket: result.bucket,
          confidence: result.confidence,
          fail_reason: result.failReason,
          body_truncated: result.bodyTruncated,
        }),
      });
    },
    onDeadLetter: (payload, error) => {
      // PRD fail-closed default: surface to Needs You so the user sees it.
      const itemId = state.insertItem({
        tenantId: payload.tenantId,
        accountId: payload.accountId,
        channel: 'email',
        threadKey: payload.threadKey,
        bucket: 'requires_user',
        confidence: 0,
        reasonDe: 'Klassifizierer-Aufruf fehlgeschlagen — manuell prüfen.',
        classifiedAt: new Date(),
        classifierVersion: `dead-letter:${error.name || 'Error'}`,
      });
      state.appendAudit({
        tenantId: payload.tenantId,
        itemId,
        action: 'classified',
        actor: 'classifier',
        payloadJson: JSON.stringify({
          dead_letter: true,
          error_message: error.message,
        }),
      });
    },
  };
  if (policy.maxConcurrency !== undefined) queueOptions.maxConcurrency = policy.maxConcurrency;
  if (policy.perJobTimeoutMs !== undefined) queueOptions.perJobTimeoutMs = policy.perJobTimeoutMs;
  if (policy.maxQueueDepth !== undefined) queueOptions.maxQueueDepth = policy.maxQueueDepth;
  if (policy.retryOnce !== undefined) queueOptions.retryOnce = policy.retryOnce;

  return new ClassifierQueue<InboxQueuePayload>(queueOptions);
}
