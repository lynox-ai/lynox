import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  NotificationRouter,
  summarizeDelivery,
  type ChannelOutcome,
  type NotificationChannel,
  type NotificationMessage,
} from './notification-router.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeChannel(
  name: string,
  sendFn?: (msg: NotificationMessage) => Promise<ChannelOutcome>,
): NotificationChannel {
  return {
    name,
    send: sendFn ?? vi.fn<(msg: NotificationMessage) => Promise<ChannelOutcome>>().mockResolvedValue('delivered'),
  };
}

const MSG: NotificationMessage = {
  title: 'Test',
  body: 'Hello',
  priority: 'normal',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('NotificationRouter', () => {
  let router: NotificationRouter;

  beforeEach(() => {
    router = new NotificationRouter();
  });

  // ---- registration ----

  it('registers a channel and reports it via getChannelNames', () => {
    const ch = makeChannel('email');
    router.register(ch);
    expect(router.getChannelNames()).toEqual(['email']);
  });

  it('unregisters a channel', () => {
    router.register(makeChannel('email'));
    router.unregister('email');
    expect(router.getChannelNames()).toEqual([]);
    expect(router.hasChannels()).toBe(false);
  });

  it('unregister is a no-op for unknown names', () => {
    router.unregister('nonexistent');
    expect(router.hasChannels()).toBe(false);
  });

  it('duplicate register replaces the previous channel', async () => {
    const first = makeChannel('sms', vi.fn<(msg: NotificationMessage) => Promise<ChannelOutcome>>().mockResolvedValue('failed'));
    const second = makeChannel('sms', vi.fn<(msg: NotificationMessage) => Promise<ChannelOutcome>>().mockResolvedValue('delivered'));

    router.register(first);
    router.register(second);

    expect(router.getChannelNames()).toEqual(['sms']);

    const ok = await router.sendTo('sms', MSG);
    expect(ok).toBe(true);
    expect(first.send).not.toHaveBeenCalled();
    expect(second.send).toHaveBeenCalledWith(MSG);
  });

  // ---- hasChannels ----

  it('hasChannels returns false when empty, true after register', () => {
    expect(router.hasChannels()).toBe(false);
    router.register(makeChannel('push'));
    expect(router.hasChannels()).toBe(true);
  });

  // ---- notify ----

  it('notify sends to all registered channels', async () => {
    const a = makeChannel('a');
    const b = makeChannel('b');
    router.register(a);
    router.register(b);

    await router.notify(MSG);

    expect(a.send).toHaveBeenCalledWith(MSG);
    expect(b.send).toHaveBeenCalledWith(MSG);
  });

  it('notify does not throw when a channel fails', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const failing = makeChannel('bad', () => Promise.reject(new Error('boom')));
    const healthy = makeChannel('good');

    router.register(failing);
    router.register(healthy);

    await expect(router.notify(MSG)).resolves.toEqual([
      { channel: 'bad', outcome: 'failed' },
      { channel: 'good', outcome: 'delivered' },
    ]);

    // healthy still received the message
    expect(healthy.send).toHaveBeenCalledWith(MSG);

    // failure was logged
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('channel "bad" failed: boom'),
    );

    stderrSpy.mockRestore();
  });

  it('notify logs when a channel did not deliver', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const ch = makeChannel('flaky', () => Promise.resolve('failed'));
    router.register(ch);

    await router.notify(MSG);

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('channel "flaky" did not deliver'),
    );

    stderrSpy.mockRestore();
  });

  it('notify does not log a skipped message — it was not for that channel', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    router.register(makeChannel('person', () => Promise.resolve('skipped')));

    await expect(router.notify(MSG)).resolves.toEqual([{ channel: 'person', outcome: 'skipped' }]);
    const calls = stderrSpy.mock.calls.map((c) => String(c[0]));
    stderrSpy.mockRestore();
    expect(calls.filter((l) => l.includes('notification-router'))).toEqual([]);
  });

  // ---- summarizeDelivery: "was anyone told?" ----

  it('a channel that only handled the message does not count as delivered', async () => {
    // The trap this type exists for: a channel answering "handled, not addressed"
    // used to answer `true`, the same as a delivery.
    router.register(makeChannel('person', () => Promise.resolve('skipped')));
    expect(summarizeDelivery(await router.notify(MSG))).toBe('not_delivered');
  });

  it('one delivering channel is enough, beside one that skipped and one that failed', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    router.register(makeChannel('person', () => Promise.resolve('skipped')));
    router.register(makeChannel('down', () => Promise.resolve('failed')));
    router.register(makeChannel('push', () => Promise.resolve('delivered')));
    const report = await router.notify(MSG);
    stderrSpy.mockRestore();
    expect(summarizeDelivery(report)).toBe('delivered');
  });

  it('no registered channel reads as no_channel, not as a failed delivery', async () => {
    expect(summarizeDelivery(await router.notify(MSG))).toBe('no_channel');
  });

  it('a channel that throws reads as not delivered', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    router.register(makeChannel('bad', () => Promise.reject(new Error('boom'))));
    const report = await router.notify(MSG);
    stderrSpy.mockRestore();
    expect(summarizeDelivery(report)).toBe('not_delivered');
  });

  it('reads a channel written against the old boolean contract strictly', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    // A JS channel, or one built against an older release, resolves to a boolean.
    const legacy = (v: unknown): NotificationChannel => ({ name: `legacy-${String(v)}`, send: (async () => v) as unknown as NotificationChannel['send'] });
    router.register(legacy(true));
    router.register(legacy(false));
    router.register(legacy('maybe'));
    // `true` meant "handled" — delivered OR not for this channel — so it never counts as told.
    expect(await router.notify(MSG)).toEqual([
      { channel: 'legacy-true', outcome: 'skipped' },
      { channel: 'legacy-false', outcome: 'failed' },
      { channel: 'legacy-maybe', outcome: 'failed' },
    ]);
    // `false` must not read as handled — the inbox notifier throttles on this answer.
    expect(await router.sendTo('legacy-false', MSG)).toBe(false);
    expect(await router.sendTo('legacy-maybe', MSG)).toBe(false);
    expect(await router.sendTo('legacy-true', MSG)).toBe(true);
    stderrSpy.mockRestore();
  });

  it('sendTo keeps reading a skipped message as handled (true), a failed one as false', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    router.register(makeChannel('person', () => Promise.resolve('skipped')));
    router.register(makeChannel('down', () => Promise.resolve('failed')));
    expect(await router.sendTo('person', MSG)).toBe(true);
    expect(await router.sendTo('down', MSG)).toBe(false);
    stderrSpy.mockRestore();
  });

  // ---- sendTo ----

  it('sendTo returns false for unknown channel', async () => {
    const result = await router.sendTo('ghost', MSG);
    expect(result).toBe(false);
  });

  it('sendTo returns false and logs when channel throws', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const failing = makeChannel('broken', () => Promise.reject(new Error('kaboom')));
    router.register(failing);

    const result = await router.sendTo('broken', MSG);

    expect(result).toBe(false);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('channel "broken" failed: kaboom'),
    );

    stderrSpy.mockRestore();
  });
});
