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

const DEFAULT_TENANT_ID = 'default';

export interface InboxNotifierOptions {
  router: NotificationRouter;
  /** Max pushes per minute per tenant. PRD default 1. */
  perMinute?: number | undefined;
  /** Max pushes per hour per tenant. PRD default 10. */
  perHour?: number | undefined;
  /** Injectable clock for tests. */
  now?: (() => number) | undefined;
}

interface RateState {
  /** Recent push timestamps (ms). Trimmed on each notify call. */
  history: number[];
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
  if (cleaned.length > maxLen) cleaned = cleaned.slice(0, maxLen - 1) + '…';
  return cleaned;
}

/**
 * Build a long-lived notifier. The returned object holds the rate-limit
 * state — re-create it across processes (or instances) and limits reset.
 */
export function createInboxNotifier(opts: InboxNotifierOptions): InboxNotifier {
  const perMinute = opts.perMinute ?? 1;
  const perHour = opts.perHour ?? 10;
  const now = opts.now ?? Date.now;
  const buckets = new Map<string, RateState>();

  function getState(tenantId: string): RateState {
    let state = buckets.get(tenantId);
    if (!state) {
      state = { history: [] };
      buckets.set(tenantId, state);
    }
    return state;
  }

  function shouldThrottle(tenantId: string): boolean {
    const state = getState(tenantId);
    const t = now();
    // Drop entries older than 1h on every call — keeps the array
    // bounded (worst case: perHour entries) without a separate sweep.
    state.history = state.history.filter((ts) => t - ts < 3_600_000);
    if (state.history.length >= perHour) return true;
    const lastMinuteCount = state.history.filter((ts) => t - ts < 60_000).length;
    if (lastMinuteCount >= perMinute) return true;
    return false;
  }

  function recordSent(tenantId: string): void {
    getState(tenantId).history.push(now());
  }

  return {
    async notifyNewItem(item: InboxItem): Promise<boolean> {
      // Defensive contract check — caller is expected to filter, but
      // a wider deploy of the notifier shouldn't blast every bucket.
      if (item.bucket !== 'requires_user') return false;
      const tenantId = item.tenantId || DEFAULT_TENANT_ID;
      if (shouldThrottle(tenantId)) return false;

      const fromLabel = item.fromName ? sanitisePushText(item.fromName, 80) : sanitisePushText(item.fromAddress, 80);
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
        if (ok) recordSent(tenantId);
        return ok;
      } catch {
        return false;
      }
    },
  };
}
