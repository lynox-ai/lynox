// === Mail tool rate limiting + per-recipient dedup ===
//
// Mirrors the http_request rate-limit pattern (src/tools/builtin/http.ts)
// but on a separate state — mail and HTTP have distinct quotas and the
// failure modes differ (a stuck mail loop is reputation damage; a stuck
// HTTP loop is just budget burn).
//
// Two layers of protection:
//
// 1. Per-tool hourly + daily count caps (cross-session, sourced from
//    RunHistory's run_tool_calls tally — same provider as http rate
//    limits). Defaults: 50/h, 200/d, configurable via env / config.
//
// 2. Per-(recipients, subject) dedup window — rejects sends with the
//    same recipient set + subject within a short window (default 60s).
//    Catches retry storms and approval-fatigue chains where the agent
//    re-issues the same outbound after a transient error.
//
// Both rules return clear-text error strings so the agent can surface
// them or wait. Audit logging happens via the existing toolEnd channel
// (with body redacted via ToolEntry.redactInputForAudit).

import type { ToolCallCountProvider } from '../../../core/tool-context.js';
import type { MailAddress } from '../provider.js';

const DEFAULT_HOURLY_LIMIT = 50;
const DEFAULT_DAILY_LIMIT = 200;
const DEFAULT_DEDUP_WINDOW_MS = 60_000;

let _provider: ToolCallCountProvider | null = null;
let _hourlyLimit = DEFAULT_HOURLY_LIMIT;
let _dailyLimit = DEFAULT_DAILY_LIMIT;
let _dedupWindowMs = DEFAULT_DEDUP_WINDOW_MS;

/** Map<dedupKey, expiresAtMs>. Pruned lazily on every check. */
const _dedupSeen = new Map<string, number>();

export interface MailRateLimitOptions {
  provider: ToolCallCountProvider;
  hourlyLimit?: number | undefined;
  dailyLimit?: number | undefined;
  dedupWindowMs?: number | undefined;
}

/** Configure cross-session mail rate limits. Called once at orchestrator init. */
export function configureMailRateLimits(opts: MailRateLimitOptions): void {
  _provider = opts.provider;
  _hourlyLimit = opts.hourlyLimit ?? DEFAULT_HOURLY_LIMIT;
  _dailyLimit = opts.dailyLimit ?? DEFAULT_DAILY_LIMIT;
  _dedupWindowMs = opts.dedupWindowMs ?? DEFAULT_DEDUP_WINDOW_MS;
}

/** Reset all mail rate-limit state (for testing). */
export function resetMailRateLimits(): void {
  _provider = null;
  _hourlyLimit = DEFAULT_HOURLY_LIMIT;
  _dailyLimit = DEFAULT_DAILY_LIMIT;
  _dedupWindowMs = DEFAULT_DEDUP_WINDOW_MS;
  _dedupSeen.clear();
}

/**
 * Check the per-tool hourly + daily caps. Returns null when below both
 * limits, or a clear-text block message when one is exceeded.
 *
 * No provider configured → no enforcement (self-host without RunHistory
 * still works; managed instances always wire one).
 */
export function checkMailRateLimit(toolName: 'mail_send' | 'mail_reply'): string | null {
  if (!_provider) return null;

  if (Number.isFinite(_hourlyLimit)) {
    const hourly = _provider.getToolCallCountSince(toolName, 1);
    if (hourly >= _hourlyLimit) {
      return `Blocked: hourly ${toolName} limit (${String(_hourlyLimit)}) reached. Count: ${String(hourly)}. Try again later.`;
    }
  }
  if (Number.isFinite(_dailyLimit)) {
    const daily = _provider.getToolCallCountSince(toolName, 24);
    if (daily >= _dailyLimit) {
      return `Blocked: daily ${toolName} limit (${String(_dailyLimit)}) reached. Count: ${String(daily)}. Try again tomorrow.`;
    }
  }
  return null;
}

/**
 * Build a stable dedup key from the recipient set + subject. The key is
 * tool-agnostic on purpose — a fast retry that swaps mail_send for
 * mail_reply (or vice-versa) should still be caught.
 */
function buildDedupKey(recipients: ReadonlyArray<MailAddress>, subject: string): string {
  const addrs = Array.from(
    new Set(recipients.map(a => a.address.toLowerCase().trim())),
  ).sort();
  return `${addrs.join(',')}|${subject.trim().toLowerCase()}`;
}

function pruneExpired(now: number): void {
  for (const [key, exp] of _dedupSeen) {
    if (exp <= now) _dedupSeen.delete(key);
  }
}

/**
 * Check whether the given (recipients, subject) was sent in the dedup
 * window. Returns null if clear, or a block message if it would be a
 * duplicate. Does not mutate state — call recordMailSend after a
 * successful send to register the key.
 */
export function checkRecipientDedup(
  recipients: ReadonlyArray<MailAddress>,
  subject: string,
  now: number = Date.now(),
): string | null {
  if (_dedupWindowMs <= 0) return null;
  pruneExpired(now);
  const key = buildDedupKey(recipients, subject);
  const exp = _dedupSeen.get(key);
  if (exp === undefined || exp <= now) return null;
  const remainingMs = exp - now;
  const remainingSec = Math.max(1, Math.ceil(remainingMs / 1000));
  return `Blocked: same recipient(s) + subject was sent within the last ${String(Math.ceil(_dedupWindowMs / 1000))}s. Wait ${String(remainingSec)}s or change recipients/subject.`;
}

/** Register a successful send in the dedup map. */
export function recordMailSend(
  recipients: ReadonlyArray<MailAddress>,
  subject: string,
  now: number = Date.now(),
): void {
  if (_dedupWindowMs <= 0) return;
  const key = buildDedupKey(recipients, subject);
  _dedupSeen.set(key, now + _dedupWindowMs);
}
