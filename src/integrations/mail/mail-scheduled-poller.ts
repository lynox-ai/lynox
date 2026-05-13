// === mail_scheduled poller — fires queued sends at their scheduled time ===
//
// Polls `mail_scheduled` rows where scheduled_at <= now AND not yet sent
// AND not yet permanently failed. Hands each due payload to the same
// `sendMail()` pipeline used by immediate sends — gets the same rate-limit,
// recipient-dedup, secret-scan, follow-up wiring for free.
//
// Failure handling: a transient send error increments `attempts`; after
// `MAX_ATTEMPTS` the row is marked `failed_at` + `fail_reason` and stays
// in the DB for UI visibility (the user can re-queue via UI).
//
// 60s cadence trades fire-resolution for SMTP cost: a row scheduled for
// 09:00 fires within 60s of that wall-clock time. Per-tick limit prevents
// a backlog from flooding SMTP if many sends share a wake-up minute.

import type { MailRegistry } from './tools/registry.js';
import type { MailStateDb, ScheduledSend } from './state.js';
import { sendMail, type SendCoreInput } from './send-core.js';

/** Max retries before a row is marked permanently failed. */
const MAX_ATTEMPTS = 3;

export interface ScheduledSendPollerOptions {
  state: MailStateDb;
  registry: MailRegistry;
  /** Poll cadence in milliseconds. Default 60_000 (1 minute). */
  intervalMs?: number;
  /** Cap on items processed per tick. Default 25 — bounded SMTP burst. */
  perTickLimit?: number;
  /** Override the clock for tests. */
  now?: () => number;
  /** Side-channel for tests that need to know a tick completed. */
  onTick?: (firedCount: number, failedCount: number) => void;
}

export interface ScheduledSendPoller {
  stop(): void;
  tickNow(): Promise<{ fired: number; failed: number }>;
}

export function startScheduledSendPoller(opts: ScheduledSendPollerOptions): ScheduledSendPoller {
  const interval = opts.intervalMs ?? 60_000;
  const limit = opts.perTickLimit ?? 25;
  const now = opts.now ?? Date.now;

  const tick = async (): Promise<{ fired: number; failed: number }> => {
    const due = opts.state.listDueScheduledSends(new Date(now()), limit);
    let fired = 0;
    let failed = 0;
    for (const row of due) {
      const result = await fireOne(row, opts);
      if (result === 'sent') fired++;
      else if (result === 'failed') failed++;
      // 'retry' leaves attempts++ in DB; next tick re-picks the row.
    }
    opts.onTick?.(fired, failed);
    return { fired, failed };
  };

  const handle = setInterval(() => { void tick(); }, interval);
  return {
    stop: () => clearInterval(handle),
    tickNow: tick,
  };
}

async function fireOne(
  row: ScheduledSend,
  opts: ScheduledSendPollerOptions,
): Promise<'sent' | 'retry' | 'failed'> {
  const sendInput: SendCoreInput = {
    account: row.accountId,
    to: row.to,
    cc: row.cc,
    bcc: row.bcc,
    subject: row.subject,
    body: row.bodyMd,
    ...(row.inReplyTo !== undefined ? { inReplyTo: row.inReplyTo } : {}),
  };
  // skipRateLimit=true so a high-volume scheduled-send wave doesn't get
  // blocked by the per-session mail_send cap — those rows already passed
  // gates at queue-insert time, the poller is just the deferred actuator.
  const result = await sendMail(opts.registry, sendInput, { skipRateLimit: true });
  if (result.ok) {
    opts.state.markScheduledSent(row.id);
    return 'sent';
  }
  // Treat all non-ok statuses uniformly as transient up to MAX_ATTEMPTS.
  // Refining per-status (e.g. permanent on auth-failure) is a follow-up.
  const attempts = opts.state.bumpScheduledAttempt(row.id);
  if (attempts >= MAX_ATTEMPTS) {
    opts.state.markScheduledFailed(row.id, `send failed after ${attempts} attempts: ${result.status} — ${result.message}`);
    return 'failed';
  }
  return 'retry';
}
