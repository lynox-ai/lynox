// === Inbox reminder poller — fires notifications when reminder-mail wakes ===
//
// Snooze alone resurfaces silently — the item just shows up in the
// requires_user bucket once `snooze_until <= now`. A "📌 Erinner mich"
// click on a mail uses the same snooze mechanism but sets
// `notify_on_unsnooze = 1`. This poller runs every 60s, picks up the
// items whose reminder time has passed, fires a notification through the
// engine's `NotificationRouter`, and stamps `notified_at` so a future
// re-snooze + unsnooze cycle on the same item doesn't re-fire the stale
// reminder.
//
// Single-instance per tenant means one poller per `InboxRuntime` — no
// horizontal-shard coordination. The 60s cadence trades fire-resolution
// for cost: reminders fire ±60s of their schedule, which matches user
// expectation for "remind me Friday morning". A future enhancement could
// use `setTimeout` chains for sub-second precision; not currently needed.

import type { NotificationRouter } from '../../core/notification-router.js';
import type { InboxStateDb } from './state.js';

export interface ReminderPollerOptions {
  state: InboxStateDb;
  router: NotificationRouter;
  /** Poll cadence in milliseconds. Default 60_000 (1 minute). */
  intervalMs?: number;
  /** Cap on items processed per tick — prevents a backlog from flooding
   *  the notification channel. Leftover items fire next tick. Default 50. */
  perTickLimit?: number;
  /** Override the clock for tests. */
  now?: () => number;
  /** Side-channel for tests that need to know a tick completed. */
  onTick?: (firedCount: number) => void;
}

export interface ReminderPoller {
  /** Stop the timer + release the interval handle. Safe to call twice. */
  stop(): void;
  /** Manually trigger one tick. Tests bypass the timer. */
  tickNow(): Promise<number>;
}

/**
 * Wire the poller to a long-lived interval. Idempotent — calling start
 * twice on the same options returns separate pollers (no deduplication
 * at the module level, lifecycle is the caller's responsibility).
 */
export function startReminderPoller(opts: ReminderPollerOptions): ReminderPoller {
  const interval = opts.intervalMs ?? 60_000;
  const limit = opts.perTickLimit ?? 50;
  const now = opts.now ?? Date.now;

  const tick = async (): Promise<number> => {
    const wakeable = opts.state.listReminderWakeable(new Date(now()), limit);
    let fired = 0;
    for (const item of wakeable) {
      try {
        await opts.router.notify({
          title: 'Erinnerung',
          // Subject is plaintext — but it's the user's own mail, so the
          // notification body matches what they'd see in the inbox row.
          // Pre-v13 rows with empty subject fall back to the classifier
          // reason which is always populated.
          body: item.subject || item.reasonDe,
          priority: 'normal',
        });
      } catch {
        // Notification failure is logged by the router; we don't unwind
        // the markReminderNotified call here because re-attempting the
        // same fire on every tick would spam if the channel is broken.
        // The user will see the item resurface in the inbox regardless.
      }
      opts.state.markReminderNotified(item.id, new Date(now()));
      fired++;
    }
    opts.onTick?.(fired);
    return fired;
  };

  const handle = setInterval(() => { void tick(); }, interval);
  return {
    stop: () => clearInterval(handle),
    tickNow: tick,
  };
}
