// === mail_scheduled poller — fires queued sends at their scheduled time ===
//
// Polls `mail_scheduled` rows where scheduled_at <= now AND not yet sent
// AND not yet permanently failed. Hands each due payload to the same
// `sendMail()` pipeline used by immediate sends — gets the same rate-limit,
// recipient-dedup, secret-scan, follow-up wiring for free.
//
// Each row is claimed (`sending_at`) before it is sent, so no second tick or process sends it.
// A failure is retried only when it proves nothing was sent (see `classifyScheduledFailure`);
// after `MAX_ATTEMPTS` the row is marked `failed_at` + `fail_reason`. A failure that may have
// sent the mail — a timeout, a connection lost mid-send, a provider error without a code — is
// never retried: the row is marked failed with a reason that says the mail may have gone out,
// stored in `fail_reason` for a human to resolve. So is a row a crashed process left claimed.
// A duplicate mail cannot be taken back; a missed one can be sent again.
//
// 60s cadence trades fire-resolution for SMTP cost: a row scheduled for
// 09:00 fires within 60s of that wall-clock time. Per-tick limit prevents
// a backlog from flooding SMTP if many sends share a wake-up minute.

import type { MailRegistry } from './tools/registry.js';
import type { MailStateDb, ScheduledSend } from './state.js';
import type { MailErrorCode } from './provider.js';
import { accountLookupOnly, sendMail, type MailAccountLookup, type SendCoreFailureStatus, type SendCoreInput } from './send-core.js';

/** Max retries before a row is marked permanently failed. */
const MAX_ATTEMPTS = 3;

/** A claim older than this belongs to a process that stopped mid-send. Well above a normal
 *  send (SMTP aborts after 60 s of socket inactivity, the Gmail API after 30 s). A send that
 *  does outlive it and then succeeds is still recorded as sent (`markScheduledSent`). */
export const SCHEDULED_CLAIM_STALE_MS = 15 * 60_000;

/** The start of `fail_reason` when the mail may have been sent. No screen shows it yet. The
 *  Sent folder is no proof either way for an IMAP/SMTP account — the copy there is filed only
 *  after a send succeeds — so the reason does not send the reader there. */
export const OUTCOME_UNKNOWN_PREFIX = 'outcome unknown — the mail may have been sent; confirm with the recipient before sending it again';

/** The longest provider or exception text kept in `fail_reason`. */
const REASON_DETAIL_MAX = 200;
const detail = (text: string): string => (text.length > REASON_DETAIL_MAX ? `${text.slice(0, REASON_DETAIL_MAX)}…` : text);

/**
 * What a failed send means for its row: `retry` only when the failure proves nothing was sent,
 * `failed` when nothing was sent and a retry cannot help (a refusal decided before the
 * provider, a missing scope or account), `unknown` when the mail may have gone out. An
 * authentication failure is retried, up to MAX_ATTEMPTS: an expired token is often refreshed
 * by the next attempt, and nothing was sent either way. Every status but `provider_error` is decided before the provider is
 * called. Of the provider's codes, only those raised before or instead of the transfer prove
 * nothing was sent: SMTP maps any other send error — a connection lost in the middle of the
 * transfer included — to `send_rejected`, and the Gmail API maps an HTTP 5xx to
 * `connection_failed`, so neither is proof.
 */
export function classifyScheduledFailure(r: { status: SendCoreFailureStatus; errorCode?: MailErrorCode | undefined }): 'retry' | 'failed' | 'unknown' {
  if (r.status === 'rate_limit') return 'retry';
  if (r.status !== 'provider_error') return 'failed';
  switch (r.errorCode) {
    case 'auth_failed':
    case 'rate_limited':
    case 'tls_failed':
    case 'starttls_unavailable':
      return 'retry';
    case 'not_found':
    case 'unsupported':
      return 'failed';
    default:
      return 'unknown';
  }
}

export interface ScheduledSendPollerOptions {
  state: MailStateDb;
  registry: MailRegistry;
  /**
   * Account configurations, so a receive-only account is refused here exactly
   * as it is for an immediate send. Required, not optional: without it
   * `sendMail` cannot see the account type and sends from any account.
   */
  accounts: MailAccountLookup;
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
    opts.state.failStaleScheduledSends(
      new Date(now() - SCHEDULED_CLAIM_STALE_MS),
      `${OUTCOME_UNKNOWN_PREFIX} (the send did not finish within 15 minutes; the engine may have stopped)`,
      new Date(now()),
    );
    const due = opts.state.listDueScheduledSends(new Date(now()), limit);
    let fired = 0;
    let failed = 0;
    for (const row of due) {
      const result = await fireOne(row, opts, now);
      if (result === 'sent') fired++;
      else if (result === 'failed') failed++;
      // 'retry' leaves attempts++ in DB; next tick re-picks the row.
    }
    opts.onTick?.(fired, failed);
    return { fired, failed };
  };

  // Reentrancy guard: a tick can outlive the interval (e.g. 25 slow/timing-out
  // SMTP sends at a 60s SMTP socket timeout easily exceed a 60s cadence).
  // Without this, the next interval — or a concurrent `tickNow()` — runs a
  // second tick against the SAME due rows: listDueScheduledSends does no
  // row-claim and `sent_at` is only stamped AFTER sendMail returns, so both
  // ticks deliver every row before either marks it sent → double-send. Coalesce
  // so that while a tick is in flight, callers share its promise and no second
  // concurrent tick starts (mirrors the provider watch loop's `ticking` guard).
  let inFlight: Promise<{ fired: number; failed: number }> | null = null;
  const runTick = (): Promise<{ fired: number; failed: number }> => {
    if (inFlight) return inFlight;
    inFlight = tick().finally(() => { inFlight = null; });
    return inFlight;
  };

  const handle = setInterval(() => { void runTick(); }, interval);
  return {
    stop: () => clearInterval(handle),
    tickNow: runTick,
  };
}

async function fireOne(
  row: ScheduledSend,
  opts: ScheduledSendPollerOptions,
  now: () => number,
): Promise<'sent' | 'retry' | 'failed' | 'skipped'> {
  // Claimed by someone else since the list was read: not ours to send.
  if (!opts.state.claimScheduledSend(row.id, new Date(now()))) return 'skipped';
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
  let result: Awaited<ReturnType<typeof sendMail>>;
  try {
    result = await sendMail(opts.registry, sendInput, { skipRateLimit: true }, accountLookupOnly(opts.accounts));
  } catch (err) {
    // sendMail returns its own refusals and catches the provider's errors, so a throw is
    // unexpected and its place in the pipeline unknown — most likely before the send (resolving
    // the account), but not provably. Not a reason to send again.
    const msg = err instanceof Error ? err.message : String(err);
    opts.state.markScheduledFailed(row.id, `${OUTCOME_UNKNOWN_PREFIX} (${detail(msg)})`);
    return 'failed';
  }
  if (result.ok) {
    opts.state.markScheduledSent(row.id);
    return 'sent';
  }
  const verdict = classifyScheduledFailure(result);
  if (verdict === 'unknown') {
    opts.state.markScheduledFailed(row.id, `${OUTCOME_UNKNOWN_PREFIX} (${result.status}: ${detail(result.message)})`);
    return 'failed';
  }
  if (verdict === 'failed') {
    opts.state.markScheduledFailed(row.id, `send failed, nothing was sent: ${result.status} — ${detail(result.message)}`);
    return 'failed';
  }
  const attempts = opts.state.bumpScheduledAttempt(row.id);
  if (attempts >= MAX_ATTEMPTS) {
    opts.state.markScheduledFailed(row.id, `send failed after ${attempts} attempts: ${result.status} — ${detail(result.message)}`);
    return 'failed';
  }
  return 'retry';
}
