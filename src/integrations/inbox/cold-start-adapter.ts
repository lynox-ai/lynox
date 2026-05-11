// === Inbox cold-start adapter — provider.list() → inbox hook ===
//
// Triggered on `MailHooks.onAccountAdded` per PRD-UNIFIED-INBOX. Pulls a
// recent batch of envelopes from the just-attached provider and threads
// them through the existing per-envelope hook (the same path the watcher
// uses), so dedup / rule short-circuit / sensitive-content all apply
// uniformly between live arrivals and the historical backfill.
//
// `runColdStart` (the pure orchestrator) is intentionally not reused here:
// its `queue.enqueue(payload)` shape requires the caller to pre-build the
// classifier prompt and bypasses the rule + sensitive pre-filter. Driving
// envelopes through the existing hook keeps the two paths aligned.
//
// Re-credential safety: `state.hasAnyItemForAccount` short-circuits a
// second backfill when the account has been seen before — re-adding the
// same `gmail-rafael-at-x` row must not pull provider.list() again.

import { DEFAULT_THREAD_CAP, estimateCost } from './cold-start.js';
import type { ColdStartTracker } from './cold-start-tracker.js';
import type { InboxStateDb } from './state.js';
import type { OnInboundMailHook } from './watcher-hook.js';
import type { MailEnvelope, MailProvider } from '../mail/provider.js';

/** Provider.list() batch — large enough for typical onboarding, well under the cap. */
export const DEFAULT_BACKFILL_LIMIT = 200;

export interface RunColdStartForAccountOptions {
  provider: MailProvider;
  /** Existing per-envelope hook. The runtime exposes this as `InboxRuntime.hook`. */
  hook: OnInboundMailHook;
  tracker: ColdStartTracker;
  state: InboxStateDb;
  /** Optional override for the per-account thread cap (default 1000). */
  threadCap?: number | undefined;
  /** Optional override for the initial provider.list() batch (default 200). */
  listLimit?: number | undefined;
  /** Single tenant scope; defaults to the repo's `'default'` sentinel. */
  tenantId?: string | undefined;
}

/**
 * Pulls a backfill batch for an account and pushes each envelope through
 * `hook`. Fire-and-forget from the caller's perspective — the engine
 * wires this onto `onAccountAdded` so user-facing `addAccount` returns
 * without waiting for IMAP/Gmail. The tracker surfaces progress to the
 * UI banner.
 *
 * Returns a resolved Promise that never rejects: any error is reported
 * through the tracker so the UI sees the failure state, and the engine's
 * fire-and-forget caller stays clean of unhandled-rejection warnings.
 */
export async function runColdStartForAccount(
  opts: RunColdStartForAccountOptions,
): Promise<void> {
  const accountId = opts.provider.accountId;
  // Re-credential gate: if items already exist for this account, the
  // backfill has run once before and per-envelope dedup would no-op
  // every iteration. Skip the provider round-trip entirely.
  if (opts.state.hasAnyItemForAccount(accountId, opts.tenantId)) return;

  const cap = opts.threadCap ?? DEFAULT_THREAD_CAP;
  const listLimit = opts.listLimit ?? DEFAULT_BACKFILL_LIMIT;
  const seenThreads = new Set<string>();
  let enqueued = 0;
  let capped = false;

  opts.tracker.start(accountId);

  try {
    const envelopes = await opts.provider.list({ limit: listLimit });
    for (const env of envelopes) {
      const threadKey = resolveThreadKey(env);
      if (seenThreads.has(threadKey)) continue;
      if (seenThreads.size >= cap) {
        capped = true;
        break;
      }
      seenThreads.add(threadKey);
      // Errors inside the hook are already swallowed at the watcher
      // layer (audit-log records the dead-letter); we await so the
      // tracker progress reflects real per-envelope completion rather
      // than just enqueue order.
      await opts.hook(accountId, env);
      enqueued += 1;
      opts.tracker.progress({
        accountId,
        uniqueThreads: seenThreads.size,
        enqueued,
        capped: false,
        capValue: cap,
      });
    }
    opts.tracker.complete({
      accountId,
      uniqueThreads: seenThreads.size,
      enqueued,
      cappedAt: capped ? cap : null,
      rejectedByQueue: 0,
      estimatedCostUSD: estimateCost(enqueued),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    opts.tracker.fail(accountId, message);
  }
}

/**
 * Mirror of the watcher-hook's thread-key resolution — duplicated here
 * so the adapter does not import an internal helper from another file.
 * Both call sites must agree on the synthesised key shape or dedup
 * collapses unrelated mails.
 */
function resolveThreadKey(env: MailEnvelope): string {
  if (env.threadKey) return env.threadKey;
  if (env.messageId) return `imap:${env.messageId}`;
  return `imap:${env.folder}:${String(env.uid)}`;
}
