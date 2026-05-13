import { describe, expect, it, vi } from 'vitest';
import { NotificationRouter, type NotificationMessage } from '../../core/notification-router.js';
import { createInboxNotifier, isInQuietHours, sanitisePushText } from './notifier.js';
import type { InboxItem } from '../../types/index.js';

function fakeItem(over: Partial<InboxItem> = {}): InboxItem {
  return {
    id: 'inb_test',
    tenantId: 'default',
    accountId: 'acct',
    channel: 'email',
    threadKey: 'thr-1',
    bucket: 'requires_user',
    confidence: 0.9,
    reasonDe: 'r',
    classifiedAt: new Date(),
    classifierVersion: 'v',
    unsnoozeOnReply: true,
    fromAddress: 'sender@acme.example',
    fromName: 'Sender',
    subject: 'Hello',
    ...over,
  };
}

describe('sanitisePushText', () => {
  it('strips control chars (CR/LF/null/DEL)', () => {
    expect(sanitisePushText('line1\nline2\rstop\x00end\x7f')).toBe('line1line2stopend');
  });

  it('replaces angle brackets with spaces (no script-tag injection)', () => {
    expect(sanitisePushText('Hi <script>alert(1)</script>')).toBe('Hi  script alert(1) /script');
  });

  it('truncates with ellipsis past maxLen', () => {
    const long = 'x'.repeat(300);
    const out = sanitisePushText(long, 50);
    expect(out).toHaveLength(50);
    expect(out.endsWith('…')).toBe(true);
  });

  it('handles empty input', () => {
    expect(sanitisePushText('')).toBe('');
  });

  it('strips Unicode bidi/format overrides (no RTL spoofing)', () => {
    // U+202E = RIGHT-TO-LEFT OVERRIDE — without this filter, a sender
    // name like "evil‮gro.acme" reverse-renders as "acme.gro.live"
    // in the OS toast and can pretend to be a known contact.
    expect(sanitisePushText('evil‮gro.acme')).toBe('evilgro.acme');
    expect(sanitisePushText('zwj‍joiner')).toBe('zwjjoiner');
  });
});

describe('createInboxNotifier — basic dispatch', () => {
  it('routes a requires_user item via the router with the item id in data', async () => {
    const router = new NotificationRouter();
    const sent: NotificationMessage[] = [];
    router.register({ name: 'web-push', send: async (m) => { sent.push(m); return true; } });
    const notifier = createInboxNotifier({ router });
    const ok = await notifier.notifyNewItem(fakeItem());
    expect(ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.title).toBe('Inbox');
    expect(sent[0]?.body).toBe('Sender: Hello');
    expect(sent[0]?.data).toEqual({ itemId: 'inb_test' });
  });

  it('skips non-requires_user items even when called', async () => {
    const router = new NotificationRouter();
    const send = vi.fn(async () => true);
    router.register({ name: 'web-push', send });
    const notifier = createInboxNotifier({ router });
    const ok = await notifier.notifyNewItem(fakeItem({ bucket: 'auto_handled' }));
    expect(ok).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('falls back to fromAddress when fromName is undefined', async () => {
    const router = new NotificationRouter();
    const sent: NotificationMessage[] = [];
    router.register({ name: 'web-push', send: async (m) => { sent.push(m); return true; } });
    const notifier = createInboxNotifier({ router });
    await notifier.notifyNewItem(fakeItem({ fromName: undefined }));
    expect(sent[0]?.body).toBe('sender@acme.example: Hello');
  });

  it('falls back to reasonDe when subject is empty', async () => {
    const router = new NotificationRouter();
    const sent: NotificationMessage[] = [];
    router.register({ name: 'web-push', send: async (m) => { sent.push(m); return true; } });
    const notifier = createInboxNotifier({ router });
    await notifier.notifyNewItem(fakeItem({ subject: '', reasonDe: 'Kunde fragt nach Termin' }));
    expect(sent[0]?.body).toBe('Sender: Kunde fragt nach Termin');
  });

  it('sanitises angle brackets out of subject + sender (no toast injection)', async () => {
    const router = new NotificationRouter();
    const sent: NotificationMessage[] = [];
    router.register({ name: 'web-push', send: async (m) => { sent.push(m); return true; } });
    const notifier = createInboxNotifier({ router });
    await notifier.notifyNewItem(fakeItem({ fromName: '<script>', subject: '<b>x</b>' }));
    expect(sent[0]?.body).not.toContain('<');
    expect(sent[0]?.body).not.toContain('>');
  });
});

describe('createInboxNotifier — throttle', () => {
  it('drops the second push within a minute when perMinute=1 (PRD default)', async () => {
    const router = new NotificationRouter();
    const send = vi.fn(async () => true);
    router.register({ name: 'web-push', send });
    let t = 1_000_000;
    const notifier = createInboxNotifier({ router, perMinute: () => 1, perHour: () => 10, now: () => t });

    expect(await notifier.notifyNewItem(fakeItem({ id: 'a' }))).toBe(true);
    t += 30_000; // 30s later
    expect(await notifier.notifyNewItem(fakeItem({ id: 'b' }))).toBe(false);
    t += 35_000; // total 65s — minute window slid
    expect(await notifier.notifyNewItem(fakeItem({ id: 'c' }))).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('caps at perHour pushes and recovers after the hour passes', async () => {
    const router = new NotificationRouter();
    const send = vi.fn(async () => true);
    router.register({ name: 'web-push', send });
    let t = 1_000_000;
    const notifier = createInboxNotifier({ router, perMinute: () => 100, perHour: () => 3, now: () => t });

    for (let i = 0; i < 5; i++) {
      await notifier.notifyNewItem(fakeItem({ id: `i${String(i)}` }));
    }
    expect(send).toHaveBeenCalledTimes(3);

    t += 3_600_001; // jump past 1h window
    expect(await notifier.notifyNewItem(fakeItem({ id: 'after' }))).toBe(true);
    expect(send).toHaveBeenCalledTimes(4);
  });

  it('does not consume throttle budget when no web-push channel is registered', async () => {
    // Bare router → sendTo('web-push', …) returns false. The throttle
    // budget must NOT burn on a non-delivery, otherwise a single misconfig
    // (forgot-to-register) blocks every legitimate push for a full minute.
    const router = new NotificationRouter();
    let t = 1_000_000;
    const notifier = createInboxNotifier({ router, perMinute: () => 1, perHour: () => 10, now: () => t });

    expect(await notifier.notifyNewItem(fakeItem({ id: 'a' }))).toBe(false);
    expect(await notifier.notifyNewItem(fakeItem({ id: 'b' }))).toBe(false);
    // Register mid-test; the next call should succeed even though we're
    // still in the same minute as the two no-channel attempts.
    router.register({ name: 'web-push', send: async () => true });
    expect(await notifier.notifyNewItem(fakeItem({ id: 'c' }))).toBe(true);
  });

  it('skips dispatch when isEnabled returns false, without burning the throttle bucket', async () => {
    const router = new NotificationRouter();
    const send = vi.fn(async () => true);
    router.register({ name: 'web-push', send });
    let t = 1_000_000;
    let enabled = false;
    const notifier = createInboxNotifier({
      router, perMinute: () => 1, perHour: () => 10, now: () => t, isEnabled: () => enabled,
    });

    expect(await notifier.notifyNewItem(fakeItem({ id: 'a' }))).toBe(false);
    expect(send).not.toHaveBeenCalled();
    // Flip the toggle — the next fire should succeed even within the
    // same minute as the disabled-state call.
    enabled = true;
    expect(await notifier.notifyNewItem(fakeItem({ id: 'b' }))).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('does not consume throttle budget when the channel.send throws', async () => {
    const router = new NotificationRouter();
    let throws = true;
    router.register({ name: 'web-push', send: async () => {
      if (throws) throw new Error('channel down');
      return true;
    } });
    let t = 1_000_000;
    const notifier = createInboxNotifier({ router, perMinute: () => 1, perHour: () => 10, now: () => t });

    expect(await notifier.notifyNewItem(fakeItem({ id: 'a' }))).toBe(false);
    throws = false;
    // Same minute window — would be throttled if the failure had counted.
    expect(await notifier.notifyNewItem(fakeItem({ id: 'b' }))).toBe(true);
  });
});

describe('isInQuietHours', () => {
  // 2026-05-13 14:00 UTC → 16:00 Europe/Berlin (CEST = UTC+2 in May)
  const dayUtc14 = new Date('2026-05-13T14:00:00Z');
  // 2026-05-14 02:00 UTC → 04:00 Europe/Berlin (mid-night-window)
  const nightUtc02 = new Date('2026-05-14T02:00:00Z');

  it('returns false outside the window (daytime, 22-07 quiet)', () => {
    expect(isInQuietHours(dayUtc14, '22:00', '07:00', 'Europe/Berlin')).toBe(false);
  });

  it('returns true inside an overnight window (22:00 → 07:00)', () => {
    expect(isInQuietHours(nightUtc02, '22:00', '07:00', 'Europe/Berlin')).toBe(true);
  });

  it('returns false at the exact end boundary (window is half-open)', () => {
    // 07:00 Berlin == 05:00 UTC
    expect(isInQuietHours(new Date('2026-05-14T05:00:00Z'), '22:00', '07:00', 'Europe/Berlin')).toBe(false);
  });

  it('returns true at the exact start boundary', () => {
    // 22:00 Berlin == 20:00 UTC
    expect(isInQuietHours(new Date('2026-05-13T20:00:00Z'), '22:00', '07:00', 'Europe/Berlin')).toBe(true);
  });

  it('handles a same-day window (e.g. 12:00–14:00 lunch quiet)', () => {
    expect(isInQuietHours(new Date('2026-05-13T11:00:00Z'), '12:00', '14:00', 'Europe/Berlin')).toBe(true); // 13:00 Berlin
    expect(isInQuietHours(new Date('2026-05-13T13:00:00Z'), '12:00', '14:00', 'Europe/Berlin')).toBe(false); // 15:00 Berlin
  });

  it('returns false for malformed start/end (defensive parse)', () => {
    expect(isInQuietHours(dayUtc14, 'bogus', '07:00', 'UTC')).toBe(false);
    expect(isInQuietHours(dayUtc14, '22:00', '99:99', 'UTC')).toBe(false);
  });

  it('falls back to UTC when the tz string is invalid', () => {
    // 14:00 UTC ∈ [12:00, 17:00) → quiet under UTC fallback
    expect(isInQuietHours(dayUtc14, '12:00', '17:00', 'Not/A/Real/Zone')).toBe(true);
  });
});

describe('createInboxNotifier — quiet hours / per-account / dynamic throttle', () => {
  it('skips dispatch during quiet hours without burning the throttle', async () => {
    const router = new NotificationRouter();
    const send = vi.fn(async () => true);
    router.register({ name: 'web-push', send });
    let t = new Date('2026-05-14T02:00:00Z').getTime(); // 04:00 Berlin
    let quietEnabled = true;
    const notifier = createInboxNotifier({
      router, now: () => t,
      quietHours: () => quietEnabled ? { start: '22:00', end: '07:00', tz: 'Europe/Berlin' } : null,
    });
    expect(await notifier.notifyNewItem(fakeItem({ id: 'a' }))).toBe(false);
    expect(send).not.toHaveBeenCalled();
    // Quiet ends at 07:00 Berlin = 05:00 UTC.
    t = new Date('2026-05-14T07:00:00Z').getTime(); // 09:00 Berlin
    expect(await notifier.notifyNewItem(fakeItem({ id: 'b' }))).toBe(true);
    // Disabling the window also lets us through (1h later → throttle clear).
    t = new Date('2026-05-14T08:30:00Z').getTime();
    quietEnabled = false;
    expect(await notifier.notifyNewItem(fakeItem({ id: 'c' }))).toBe(true);
  });

  it('mutes a specific accountId without affecting others', async () => {
    const router = new NotificationRouter();
    const send = vi.fn(async () => true);
    router.register({ name: 'web-push', send });
    const muted = new Set(['acct-private']);
    const notifier = createInboxNotifier({
      router,
      isAccountMuted: (id) => muted.has(id),
    });
    expect(await notifier.notifyNewItem(fakeItem({ id: 'a', accountId: 'acct-private' }))).toBe(false);
    expect(await notifier.notifyNewItem(fakeItem({ id: 'b', accountId: 'acct-work' }))).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('reads perMinute / perHour thunks on every fire (settings change at runtime)', async () => {
    const router = new NotificationRouter();
    const send = vi.fn(async () => true);
    router.register({ name: 'web-push', send });
    let perMinute = 1;
    let t = 1_000_000;
    const notifier = createInboxNotifier({
      router, now: () => t,
      perMinute: () => perMinute,
      perHour: () => 100,
    });
    expect(await notifier.notifyNewItem(fakeItem({ id: 'a' }))).toBe(true);
    // Same minute, perMinute=1 → throttled.
    expect(await notifier.notifyNewItem(fakeItem({ id: 'b' }))).toBe(false);
    // Bump live: thunk picks up the new value on the next call.
    perMinute = 5;
    expect(await notifier.notifyNewItem(fakeItem({ id: 'c' }))).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
  });
});
