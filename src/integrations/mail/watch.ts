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

import {
  MailError,
  type MailEnvelope,
  type MailErrorCode,
  type MailProvider,
  type MailWatchHandle,
} from './provider.js';
import { InboundMailDeferred } from './inbound-deferred.js';
import { prefilter } from './triage/rules.js';
import type { MailStateDb } from './state.js';

/**
 * How often to check for due follow-ups. Independent of the per-account
 * polling interval — we want timely reminders even if no new mail arrives.
 */
const FOLLOWUP_CHECK_INTERVAL_MS = 60_000;

/** Cap on mails held back per account after a deferral; beyond it the newest are not held. */
const DEFERRED_MAX_PER_ACCOUNT = 500;

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
  /**
   * The last background polling error per account, so the account settings can
   * say why a mailbox went quiet. Without it a poll failure reached nobody: the
   * user saw an empty inbox and no reason.
   *
   * Set on a CHANGE of error code, cleared by the next successful poll. A
   * different error after the first one IS a change, so a first failure never
   * hides a later one. Flapping (error, success, error, …) flips the field each
   * time; that is fine for a status field, but anyone wiring this to an event
   * channel must not assume it is throttled in that case.
   */
  private readonly lastErrors = new Map<string, { code: MailErrorCode; at: string }>();
  /**
   * Mails a handler deferred (`InboundMailDeferred`), per account, handed over again with the
   * account's next successful poll. The watcher holds them itself because a provider does not
   * list a mail twice: Gmail remembers what it emitted and moves its window on, Graph commits its
   * cursor. Only IMAP would list it again. Lives in memory: a restart loses what is held.
   */
  private readonly deferred = new Map<string, MailEnvelope[]>();
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

  /** The last background polling error for this account, or null while polling works. */
  lastError(accountId: string): { code: MailErrorCode; at: string } | null {
    return this.lastErrors.get(accountId) ?? null;
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
      // A re-attach of the same account keeps the mails it held back.
      const held = this.deferred.get(accountId);
      await this.detach(accountId);
      if (held) this.deferred.set(accountId, held);
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
          const code: MailErrorCode = event.error instanceof MailError ? event.error.code : 'unknown';
          if (this.lastErrors.get(accountId)?.code !== code) {
            this.lastErrors.set(accountId, { code, at: new Date().toISOString() });
          }
          return;
        }
        // A successful poll, with or without new mail, ends any error state.
        this.lastErrors.delete(accountId);
        // Mails deferred on an earlier poll come first; one the provider lists again counts once.
        const held = this.deferred.get(accountId) ?? [];
        this.deferred.delete(accountId);
        const listed = event.type === 'new' ? event.envelopes : [];
        const envelopes = held.length === 0 ? listed : withoutRepeats([...held, ...listed]);
        if (envelopes.length === 0) return;

        // 1. Dedup against the SQLite state DB
        const { fresh } = this.state.partition(accountId, envelopes);
        if (fresh.length === 0) return;

        // 2. Optional prefilter — deterministic noise rejection
        const survivors: MailEnvelope[] = [];
        const noise: MailEnvelope[] = [];
        if (applyPrefilter) {
          for (const env of fresh) {
            const decision = prefilter(env);
            if (decision.category === 'noise') {
              noise.push(env);
              continue;
            }
            survivors.push(env);
          }
        } else {
          survivors.push(...fresh);
        }

        // 3. Mark intentional drops (prefiltered noise) seen immediately — we
        //    never want to re-evaluate them. Survivors are marked seen only
        //    AFTER the handler returns (step 4). The provider poll loop
        //    serializes ticks (it awaits this handler inside its `ticking`
        //    guard), so the old "mark all fresh before the handler" bought no
        //    concurrency protection — it only opened a window where a process
        //    crash (or a throw that propagates out of the handler, e.g. during
        //    follow-up resolution) left the mail marked seen yet unprocessed.
        //    (A throw inside the classifier hook itself is swallowed upstream
        //    in MailContext's wrapper, so it does not reach here — the hook
        //    dead-letters instead of throwing on backpressure. The one throw
        //    let through is `InboundMailDeferred`, which a hook uses exactly
        //    to keep the mail unseen for the next tick.) The hook is
        //    thread-idempotent (findItemByThread short-circuit) so a next-tick
        //    retry cannot double-insert.
        if (noise.length > 0) this.state.markSeenBatch(accountId, noise);

        if (survivors.length === 0) return;

        // 4. Hand off to the user handler, then mark the handed-off envelopes
        //    seen. Errors are swallowed so a crash in one tick doesn't take
        //    down the watcher — but on error we deliberately do NOT mark the
        //    survivors seen, leaving them for the next tick to retry.
        try {
          await this.handler(accountId, survivors);
          this.state.markSeenBatch(accountId, survivors);
        } catch (err: unknown) {
          // Swallowed — survivors stay unseen. A deferral also holds them for the next poll, as
          // the provider will not list them again (see `deferred`).
          if (err instanceof InboundMailDeferred) {
            this.deferred.set(accountId, survivors.slice(0, DEFERRED_MAX_PER_ACCOUNT));
          }
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
    this.lastErrors.delete(accountId);
    this.deferred.delete(accountId);
    await attached.handle.stop();
  }

  /** Stop all polling. Does not close the underlying providers. */
  async stopAll(): Promise<void> {
    this.stopFollowupCheck();
    const all = [...this.attachments.values()];
    this.attachments.clear();
    this.deferred.clear();
    await Promise.allSettled(all.map(a => a.handle.stop()));
  }
}

/**
 * The envelopes without a second copy of one; the first copy stays. Same key as the state DB's
 * dedup (the Message-ID), and folder plus uid for a mail without one.
 */
function withoutRepeats(envelopes: ReadonlyArray<MailEnvelope>): MailEnvelope[] {
  const seen = new Set<string>();
  const out: MailEnvelope[] = [];
  for (const env of envelopes) {
    const key = env.messageId ? `id\u0000${env.messageId}` : `uid\u0000${env.folder}\u0000${String(env.uid)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(env);
  }
  return out;
}
