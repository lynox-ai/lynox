// === MailWatcher — multi-account polling orchestrator ===
//
// Phase 0 sits one layer above MailProvider.watch():
//   provider.watch()  → low-level per-provider polling tick
//   MailWatcher       → multi-account coordination + dedup + prefilter
//
// The watcher is intentionally lightweight: it owns no LLM coupling, no
// notification routing, no classification. Phase 1 wires those above.
//
// Lifecycle: instantiate once, attach() each configured account, call
// stopAll() on engine shutdown. Each attach() returns an unsubscribe handle.

import type {
  MailEnvelope,
  MailProvider,
  MailWatchHandle,
} from './provider.js';
import { prefilter } from './triage/rules.js';
import type { MailStateDb } from './state.js';

/**
 * How often to check for due follow-ups. Independent of the per-account
 * polling interval — we want timely reminders even if no new mail arrives.
 */
const FOLLOWUP_CHECK_INTERVAL_MS = 60_000;

/**
 * Called for each batch of truly-new envelopes (post-dedup, optionally
 * post-prefilter). Phase 0 callers typically just log; Phase 1 wires this
 * into the classification pipeline.
 */
export type MailWatcherHandler = (
  accountId: string,
  fresh: ReadonlyArray<MailEnvelope>,
) => void | Promise<void>;

export interface MailWatcherAttachOptions {
  /** Folder to watch. Default: 'INBOX'. */
  folder?: string | undefined;
  /** Polling interval in ms. Default: 120_000 (2 min) per PRD. */
  intervalMs?: number | undefined;
  /** Cap envelopes per tick. Default: 50. */
  maxPerTick?: number | undefined;
  /** Apply triage/rules.ts to drop noise before invoking handler. Default: true. */
  applyPrefilter?: boolean | undefined;
}

interface Attachment {
  provider: MailProvider;
  handle: MailWatchHandle;
}

export class MailWatcher {
  private readonly state: MailStateDb;
  private readonly handler: MailWatcherHandler;
  private readonly attachments = new Map<string, Attachment>();
  private followupTimer: ReturnType<typeof setInterval> | null = null;
  /** Optional callback invoked each time the followup-check fires. */
  private followupCheckCallback: (() => Promise<void>) | null = null;

  constructor(state: MailStateDb, handler: MailWatcherHandler) {
    this.state = state;
    this.handler = handler;
  }

  /**
   * Register a periodic followup-check loop. The callback runs every minute
   * (FOLLOWUP_CHECK_INTERVAL_MS) and is expected to call
   * MailContext.checkDueFollowups. Wiring is inverted so MailContext owns
   * the policy while MailWatcher owns the timer.
   */
  startFollowupCheck(cb: () => Promise<void>): void {
    if (this.followupTimer) return;
    this.followupCheckCallback = cb;
    this.followupTimer = setInterval(() => {
      if (this.followupCheckCallback) void this.followupCheckCallback().catch(() => { /* swallow */ });
    }, FOLLOWUP_CHECK_INTERVAL_MS);
    this.followupTimer.unref();
  }

  stopFollowupCheck(): void {
    if (this.followupTimer) {
      clearInterval(this.followupTimer);
      this.followupTimer = null;
    }
    this.followupCheckCallback = null;
  }

  /** Number of currently-attached accounts. */
  get size(): number {
    return this.attachments.size;
  }

  /** True if a provider with this accountId is currently attached. */
  has(accountId: string): boolean {
    return this.attachments.has(accountId);
  }

  /**
   * Attach a provider for polling. Replaces any existing attachment for the
   * same accountId. Returns an unsubscribe function for convenience; you can
   * also call detach(accountId) explicitly.
   */
  async attach(provider: MailProvider, options: MailWatcherAttachOptions = {}): Promise<() => Promise<void>> {
    const accountId = provider.accountId;
    if (this.attachments.has(accountId)) {
      await this.detach(accountId);
    }

    const applyPrefilter = options.applyPrefilter ?? true;
    const folder = options.folder;
    const intervalMs = options.intervalMs;
    const maxPerTick = options.maxPerTick;

    const handle = await provider.watch(
      {
        ...(folder !== undefined ? { folder } : {}),
        ...(intervalMs !== undefined ? { intervalMs } : {}),
        ...(maxPerTick !== undefined ? { maxPerTick } : {}),
      },
      async (event) => {
        if (event.type === 'error') {
          // Phase 0: swallow watcher errors silently. Phase 1 will route
          // them through the engine's observability channel.
          return;
        }

        // 1. Dedup against the SQLite state DB
        const { fresh } = this.state.partition(accountId, event.envelopes);
        if (fresh.length === 0) return;

        // 2. Optional prefilter — deterministic noise rejection
        const survivors: MailEnvelope[] = [];
        if (applyPrefilter) {
          for (const env of fresh) {
            const decision = prefilter(env);
            if (decision.category === 'noise') continue;
            survivors.push(env);
          }
        } else {
          survivors.push(...fresh);
        }

        // 3. Mark ALL fresh envelopes as seen — even prefiltered ones —
        //    so we don't re-evaluate them on every tick. Marking before the
        //    handler runs avoids double-processing if the handler is slow
        //    and another tick fires concurrently.
        this.state.markSeenBatch(accountId, fresh);

        if (survivors.length === 0) return;

        // 4. Hand off to the user handler. Errors here are swallowed so a
        //    crash in one tick doesn't take down the watcher.
        try {
          await this.handler(accountId, survivors);
        } catch {
          /* swallow — Phase 1 routes to observability */
        }
      },
    );

    this.attachments.set(accountId, { provider, handle });

    return async () => {
      await this.detach(accountId);
    };
  }

  /** Detach a single provider. Idempotent. */
  async detach(accountId: string): Promise<void> {
    const attached = this.attachments.get(accountId);
    if (!attached) return;
    this.attachments.delete(accountId);
    await attached.handle.stop();
  }

  /** Stop all polling. Does not close the underlying providers. */
  async stopAll(): Promise<void> {
    this.stopFollowupCheck();
    const all = [...this.attachments.values()];
    this.attachments.clear();
    await Promise.allSettled(all.map(a => a.handle.stop()));
  }
}
