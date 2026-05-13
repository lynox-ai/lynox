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
  /**
   * Throttle thunks read on every fire so a settings UI change takes
   * effect without restart. `perMinute` defaults to 1, `perHour` to 10.
   */
  perMinute?: (() => number) | undefined;
  perHour?: (() => number) | undefined;
  /** Injectable clock for tests. */
  now?: (() => number) | undefined;
  /**
   * Gate the user has flipped to mute new-mail pushes without
   * unsubscribing the device (Reminders + Send-Later results stay live).
   * Returns true → we fire; false → we silently skip without burning the
   * throttle bucket. Absent → always-on (legacy callers).
   */
  isEnabled?: (() => boolean) | undefined;
  /**
   * Per-account mute. Returns true to suppress this account's pushes
   * without touching the global enable flag — e.g. work@ pushes, but
   * private@ stays silent. Absent → no per-account filtering.
   */
  isAccountMuted?: ((accountId: string) => boolean) | undefined;
  /**
   * Quiet-hours window. Returns null when disabled or `{start,end,tz}`
   * with HH:MM strings + IANA tz. Overnight windows (e.g. 22:00→07:00)
   * are handled. Absent → no quiet-hours gate.
   */
  quietHours?: (() => { start: string; end: string; tz: string } | null) | undefined;
}

/**
 * Returns true when `now` (in `tz`) falls inside [start, end). HH:MM
 * strings are user-local; an end < start window crosses midnight (the
 * common case: "22:00 to 07:00").
 */
export function isInQuietHours(now: Date, start: string, end: string, tz: string): boolean {
  const startMin = parseHHMM(start);
  const endMin = parseHHMM(end);
  if (startMin === null || endMin === null) return false;
  if (startMin === endMin) return false; // empty window — never quiet
  let h: number;
  let m: number;
  try {
    const fmt = formatterFor(tz);
    const parts = fmt.formatToParts(now);
    h = parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0', 10);
    m = parseInt(parts.find((p) => p.type === 'minute')?.value ?? '0', 10);
  } catch {
    // Invalid TZ → fall back to UTC; better to occasionally push during
    // quiet hours than to silently drop everything from a typo.
    h = now.getUTCHours();
    m = now.getUTCMinutes();
  }
  const cur = h * 60 + m;
  if (startMin < endMin) return cur >= startMin && cur < endMin;
  return cur >= startMin || cur < endMin;
}

/**
 * Cached formatter per IANA tz — formatter construction is non-trivial
 * in V8 and the notifier fires on every classified mail. Keyed by tz
 * string; the cache is unbounded but tz cardinality is 1 per user
 * (single-tenant) so the Map effectively holds one entry.
 */
const _formatterCache = new Map<string, Intl.DateTimeFormat>();
function formatterFor(tz: string): Intl.DateTimeFormat {
  const cached = _formatterCache.get(tz);
  if (cached) return cached;
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  _formatterCache.set(tz, fmt);
  return fmt;
}

function parseHHMM(s: string): number | null {
  const m = s.match(/^([0-2]?\d):([0-5]\d)$/);
  if (!m) return null;
  const h = parseInt(m[1] ?? '', 10);
  const mm = parseInt(m[2] ?? '', 10);
  if (h > 23) return null;
  return h * 60 + mm;
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
  const now = opts.now ?? Date.now;
  /** Recent push timestamps (ms). Bounded by `perHour` after each prune. */
  let history: number[] = [];

  function shouldThrottle(): boolean {
    const perMinute = opts.perMinute?.() ?? 1;
    const perHour = opts.perHour?.() ?? 10;
    const t = now();
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
      if (opts.isAccountMuted && opts.isAccountMuted(item.accountId)) return false;
      if (opts.quietHours) {
        const window = opts.quietHours();
        if (window && isInQuietHours(new Date(now()), window.start, window.end, window.tz)) return false;
      }
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
