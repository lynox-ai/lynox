// === Inbox Push Notifier ===
//
// Wraps `NotificationRouter.notify` for the inbox classifier path:
//
//   - Trigger: a NEW item lands with bucket=`requires_user`. The
//     watcher-hook's findItemByThread short-circuit guarantees we only
//     reach this point on a genuinely new thread; re-classifications
//     don't enter the path.
//   - Throttle: per-tenant rate limit (default 1/min, 10/hour). The
//     limit lives in-process — multi-tenant SaaS deploys swap the
//     factory for one keyed on tenantId.
//   - Sanitisation: subject + sender are user-controlled strings. The
//     PRD requires control-char + HTML-bracket strip before write so
//     a crafted From header cannot inject markup into the OS-level
//     toast (which on Android renders limited HTML).
//
// Foreground-suppression (PRD §"Foreground suppression") is OUT OF
// SCOPE for the first slice — it requires a SW↔tab postMessage
// channel that exposes the active tab's `document.visibilityState` to
// the backend before each notify. Tracked as a follow-up.

import type { NotificationRouter, NotificationMessage } from '../../core/notification-router.js';
import type { InboxItem } from '../../types/index.js';

export interface InboxNotifierOptions {
  router: NotificationRouter;
  /** Max pushes per minute. PRD default 1. */
  perMinute?: number | undefined;
  /** Max pushes per hour. PRD default 10. */
  perHour?: number | undefined;
  /** Injectable clock for tests. */
  now?: (() => number) | undefined;
  /**
   * Gate the user has flipped to mute new-mail pushes without
   * unsubscribing the device (Reminders + Send-Later results stay live).
   * Returns true → we fire; false → we silently skip without burning the
   * throttle bucket. Absent → always-on (legacy callers).
   */
  isEnabled?: (() => boolean) | undefined;
}

export interface InboxNotifier {
  notifyNewItem(item: InboxItem): Promise<boolean>;
}

/**
 * Strip C0 control chars + HTML angle brackets so a crafted `<script>`
 * in subject/from-name cannot reach the OS toast renderer. Also drops
 * Unicode bidi/format overrides (U+202A-202E, U+2066-2069) — without
 * this a sender like `evil‮gro.acme` reverse-renders as
 * `acme.gro.live` in the toast and can spoof a known contact. Caps
 * length defensively — web-push is ~4KB, the subject column isn't.
 */
export function sanitisePushText(s: string, maxLen: number = 200): string {
  let cleaned = '';
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    // C0 (0x00-0x1F), DEL (0x7F), C1 (0x80-0x9F), bidi/format overrides
    // (LRE/RLE/PDF/LRO/RLO + LRI/RLI/FSI/PDI), zero-width joiner/non-joiner.
    if (code < 0x20 || code === 0x7f) continue;
    if (code >= 0x80 && code <= 0x9f) continue;
    if (code >= 0x202a && code <= 0x202e) continue;
    if (code >= 0x2066 && code <= 0x2069) continue;
    if (code === 0x200b || code === 0x200c || code === 0x200d || code === 0xfeff) continue;
    if (ch === '<' || ch === '>') {
      cleaned += ' ';
    } else {
      cleaned += ch;
    }
  }
  cleaned = cleaned.trim();
  if (cleaned.length > maxLen) {
    // Slice on the codepoint array so we never split a surrogate pair
    // and leave a lone high-surrogate dangling before the ellipsis —
    // emoji-heavy subjects render as a replacement char otherwise.
    cleaned = [...cleaned].slice(0, maxLen - 1).join('') + '…';
  }
  return cleaned;
}

/**
 * Build a long-lived notifier. The returned object holds the rate-limit
 * state — re-create it across processes (or instances) and limits reset.
 * Single-tenant by design: a lynox instance is always one user, multi-
 * tenancy is handled at the container level (separate engine per user).
 */
export function createInboxNotifier(opts: InboxNotifierOptions): InboxNotifier {
  const perMinute = opts.perMinute ?? 1;
  const perHour = opts.perHour ?? 10;
  const now = opts.now ?? Date.now;
  /** Recent push timestamps (ms). Bounded by `perHour` after each prune. */
  let history: number[] = [];

  function shouldThrottle(): boolean {
    const t = now();
    // Single-pass prune + last-minute count — no second filter scan.
    history = history.filter((ts) => t - ts < 3_600_000);
    if (history.length >= perHour) return true;
    let lastMinuteCount = 0;
    for (const ts of history) if (t - ts < 60_000) lastMinuteCount++;
    return lastMinuteCount >= perMinute;
  }

  return {
    async notifyNewItem(item: InboxItem): Promise<boolean> {
      // Defensive contract check — caller is expected to filter, but
      // a wider deploy of the notifier shouldn't blast every bucket.
      if (item.bucket !== 'requires_user') return false;
      // User-flipped opt-out (settings UI). Reminders + scheduled-send
      // pings live on a separate channel and ignore this gate.
      if (opts.isEnabled && !opts.isEnabled()) return false;
      if (shouldThrottle()) return false;

      // Treat empty-string fromName as missing — exactOptionalPropertyTypes
      // makes `undefined` the canonical "no value", but envelope parsers
      // sometimes set the field to '' when a header is present-but-empty.
      const fromLabel = item.fromName !== undefined && item.fromName !== ''
        ? sanitisePushText(item.fromName, 80)
        : sanitisePushText(item.fromAddress, 80);
      const subject = sanitisePushText(item.subject || item.reasonDe, 200);
      const body = fromLabel ? `${fromLabel}: ${subject}` : subject;
      const msg: NotificationMessage = {
        title: 'Inbox',
        body,
        priority: 'normal',
        data: { itemId: item.id },
      };
      try {
        // Targeted send so a silent web-push failure (zero subscriptions,
        // expired key, all endpoints 410) returns false and we don't
        // burn the throttle budget on a delivery that never happened.
        // Other channels (telegram, etc.) are addressed via their own
        // notifier path — inbox push is web-push specifically.
        const ok = await opts.router.sendTo('web-push', msg);
        if (ok) history.push(now());
        return ok;
      } catch {
        return false;
      }
    },
  };
}
