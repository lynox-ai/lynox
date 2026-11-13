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
import { processErrorText } from '../../core/error-egress.js';
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
  /** Ends this attachment's claim on the held mails: a poll still in its handler holds nothing. */
  retire: () => void;
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
   * cursor. Only IMAP would list it again. Held here for the polls, and kept in the state DB
   * (`holdDeferredMail`) so a restart does not lose them: `attach` takes the kept ones back, and
   * a kept mail is released once it is marked seen. A deferral that lands after the account was
   * detached is still kept there (a restore defers and then exits), only not held here.
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
      await this.detach(accountId);
    }

    const applyPrefilter = options.applyPrefilter ?? true;
    const folder = options.folder;
    const intervalMs = options.intervalMs;
    const maxPerTick = options.maxPerTick;
    // A poll can still be in its handler when the account is detached; its deferral must not
    // bring back a held list that detach cleared (it would reach a later account of the same id).
    let live = true;
    // Mails deferred before a restart come back first.
    const kept = this.keptDeferred(accountId);
    if (kept.length > 0) {
      this.deferred.set(accountId, withoutRepeats([...kept, ...(this.deferred.get(accountId) ?? [])]).slice(0, DEFERRED_MAX_PER_ACCOUNT));
    }

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
        const envelopes = held.length === 0 ? listed : withoutRepeats([...held, ...listed], listed);
        if (envelopes.length === 0) return;

        // 1. Dedup against the SQLite state DB
        const { fresh, alreadySeen } = this.state.partition(accountId, envelopes);
        if (held.length > 0) this.release(accountId, alreadySeen);
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
        // A held mail is never noise here: it passed this same prefilter when it was deferred.
        if (noise.length > 0) this.state.markSeenBatch(accountId, noise);

        if (survivors.length === 0) return;

        // 4. Hand off to the user handler, then mark the handed-off envelopes
        //    seen. Errors are swallowed so a crash in one tick doesn't take
        //    down the watcher — but on error we deliberately do NOT mark the
        //    survivors seen, leaving them for the next tick to retry.
        try {
          await this.handler(accountId, survivors);
          this.state.markSeenBatch(accountId, survivors);
          if (held.length > 0) this.release(accountId, survivors);
        } catch (err: unknown) {
          // Swallowed — survivors stay unseen. A deferral also holds them for the next poll, as
          // the provider will not list them again (see `deferred`), and keeps them in the state
          // DB, also once the account is detached: a restore defers and then exits.
          if (err instanceof InboundMailDeferred) {
            this.keep(accountId, survivors);
            if (live) this.hold(accountId, survivors);
          }
        }
      },
    );

    this.attachments.set(accountId, { provider, handle, retire: () => { live = false; } });

    return async () => {
      await this.detach(accountId);
    };
  }

  /**
   * Hold deferred mails for the account's next poll, after what it already holds: a Gmail poll
   * can overlap the one before it (no guard there), so a second deferral must not replace the
   * first one's mails. Beyond the cap the newest are dropped, and the drop is logged.
   */
  private hold(accountId: string, survivors: ReadonlyArray<MailEnvelope>): void {
    const all = withoutRepeats([...(this.deferred.get(accountId) ?? []), ...survivors]);
    if (all.length > DEFERRED_MAX_PER_ACCOUNT) {
      process.stderr.write(`[lynox] mail watcher: ${String(all.length - DEFERRED_MAX_PER_ACCOUNT)} deferred mail(s) for one account over the cap of ${String(DEFERRED_MAX_PER_ACCOUNT)} not held for the next poll\n`);
    }
    this.deferred.set(accountId, all.slice(0, DEFERRED_MAX_PER_ACCOUNT));
  }

  /**
   * The state DB's side of the held mails. Each step is best-effort: a failing write is logged
   * and the poll goes on, as it did when the mails lived only in memory.
   */
  private keep(accountId: string, envelopes: ReadonlyArray<MailEnvelope>): void {
    try {
      const notKept = this.state.holdDeferredMail(accountId, envelopes, DEFERRED_MAX_PER_ACCOUNT);
      if (notKept > 0) {
        process.stderr.write(`[lynox] mail watcher: ${String(notKept)} deferred mail(s) for one account over the cap of ${String(DEFERRED_MAX_PER_ACCOUNT)} not kept across a restart\n`);
      }
    } catch (err: unknown) {
      process.stderr.write(`[lynox] mail watcher: deferred mail not kept across a restart: ${processErrorText(err)}\n`);
    }
  }

  private release(accountId: string, envelopes: ReadonlyArray<MailEnvelope>): void {
    if (envelopes.length === 0) return;
    try {
      this.state.releaseDeferredMail(accountId, envelopes);
    } catch (err: unknown) {
      process.stderr.write(`[lynox] mail watcher: kept deferred mail not released: ${processErrorText(err)}\n`);
    }
  }

  private keptDeferred(accountId: string): MailEnvelope[] {
    try {
      return this.state.deferredMail(accountId);
    } catch (err: unknown) {
      process.stderr.write(`[lynox] mail watcher: kept deferred mail not read: ${processErrorText(err)}\n`);
      return [];
    }
  }

  /** Detach a single provider. Idempotent. */
  async detach(accountId: string): Promise<void> {
    const attached = this.attachments.get(accountId);
    if (!attached) return;
    this.attachments.delete(accountId);
    this.lastErrors.delete(accountId);
    attached.retire();
    this.deferred.delete(accountId);
    await attached.handle.stop();
  }

  /** Stop all polling. Does not close the underlying providers. */
  async stopAll(): Promise<void> {
    this.stopFollowupCheck();
    const all = [...this.attachments.values()];
    this.attachments.clear();
    for (const a of all) a.retire();
    this.deferred.clear();
    await Promise.allSettled(all.map(a => a.handle.stop()));
  }
}

/**
 * The envelopes without a second copy of one, in the place of the first copy. Same key as the
 * state DB's dedup (the Message-ID), and folder plus uid for a mail without one. The copy taken
 * is the one in `preferred` where there is one (what the provider lists now, with a uid valid in
 * this process; a mail kept across a restart carries uid 0), else the first.
 */
function withoutRepeats(envelopes: ReadonlyArray<MailEnvelope>, preferred: ReadonlyArray<MailEnvelope> = []): MailEnvelope[] {
  const keyOf = (env: MailEnvelope): string => (env.messageId ? `id\u0000${env.messageId}` : `uid\u0000${env.folder}\u0000${String(env.uid)}`);
  const current = new Map(preferred.map((env) => [keyOf(env), env] as const));
  const seen = new Set<string>();
  const out: MailEnvelope[] = [];
  for (const env of envelopes) {
    const key = keyOf(env);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(current.get(key) ?? env);
  }
  return out;
}
