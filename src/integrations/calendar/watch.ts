// === Calendar watcher — ICS poller ===
//
// Per-account setInterval driver around `pollIcsFeed()`. Follows the mail
// integration's setInterval pattern (`integrations/mail/watch.ts:57`). The
// PRD aspirationally specs WorkerLoop-TaskRecord — that migration is a
// nice-to-have once the inbox-side TaskRecord plumbing stabilizes.
//
// CalDAV accounts are NOT polled here. Phase 1a refreshes CalDAV on every
// `calendar_list` tool call (provider issues live `fetchCalendars` +
// `fetchCalendarObjects` requests). Phase 2 may add CalDAV-side caching
// with sync-token incremental REPORTs.

import { pollIcsFeed } from './providers/ics-feed.js';
import type { CalendarStateDb } from './state.js';
import type { CalendarAccount } from '../../types/calendar.js';

const DEFAULT_POLL_INTERVAL_MIN = 10;
const MIN_POLL_INTERVAL_MIN = 5;
const MAX_POLL_INTERVAL_MIN = 60;

export interface IcsUrlResolver {
  /** Returns the cleartext ICS URL for the given account, or null if missing. */
  (account: CalendarAccount): string | null;
}

export class CalendarWatcher {
  private readonly timers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly state: CalendarStateDb;
  private readonly resolveIcsUrl: IcsUrlResolver;
  private readonly onError: (accountId: string, err: unknown) => void;

  constructor(opts: {
    state: CalendarStateDb;
    resolveIcsUrl: IcsUrlResolver;
    onError?: ((accountId: string, err: unknown) => void) | undefined;
  }) {
    this.state = opts.state;
    this.resolveIcsUrl = opts.resolveIcsUrl;
    this.onError = opts.onError ?? (() => { /* swallow */ });
  }

  /**
   * Start polling for one account. Idempotent — calling twice for the same
   * id replaces the existing timer. Triggers an immediate poll then schedules
   * the recurring interval.
   */
  start(account: CalendarAccount): void {
    if (account.provider !== 'ics-feed') return;
    this.stop(account.id);

    const intervalMin = clampInterval(account.poll_interval_minutes);
    const intervalMs = intervalMin * 60 * 1000;

    const run = (): void => {
      void this.runOnce(account);
    };

    // Fire immediately so accounts populate their cache without waiting.
    setImmediate(run);
    const timer = setInterval(run, intervalMs);
    // Don't pin the event loop just for polling — let process exit cleanly.
    if (typeof timer.unref === 'function') timer.unref();
    this.timers.set(account.id, timer);
  }

  stop(accountId: string): void {
    const t = this.timers.get(accountId);
    if (t) {
      clearInterval(t);
      this.timers.delete(accountId);
    }
  }

  stopAll(): void {
    for (const t of this.timers.values()) clearInterval(t);
    this.timers.clear();
  }

  async runOnce(account: CalendarAccount): Promise<void> {
    const url = this.resolveIcsUrl(account);
    if (!url) {
      this.onError(account.id, new Error(`ICS URL not in vault for account ${account.id}`));
      return;
    }
    try {
      await pollIcsFeed(this.state, account.id, url);
    } catch (err) {
      this.onError(account.id, err);
    }
  }
}

function clampInterval(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return DEFAULT_POLL_INTERVAL_MIN;
  return Math.min(MAX_POLL_INTERVAL_MIN, Math.max(MIN_POLL_INTERVAL_MIN, Math.floor(raw)));
}
