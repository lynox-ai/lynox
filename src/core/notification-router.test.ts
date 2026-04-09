import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  NotificationRouter,
  type NotificationChannel,
  type NotificationMessage,
} from './notification-router.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeChannel(
  name: string,
  sendFn?: (msg: NotificationMessage) => Promise<boolean>,
): NotificationChannel {
  return {
    name,
    send: sendFn ?? vi.fn<(msg: NotificationMessage) => Promise<boolean>>().mockResolvedValue(true),
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
    const first = makeChannel('sms', vi.fn<(msg: NotificationMessage) => Promise<boolean>>().mockResolvedValue(false));
    const second = makeChannel('sms', vi.fn<(msg: NotificationMessage) => Promise<boolean>>().mockResolvedValue(true));

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

    await expect(router.notify(MSG)).resolves.toBeUndefined();

    // healthy still received the message
    expect(healthy.send).toHaveBeenCalledWith(MSG);

    // failure was logged
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('channel "bad" failed: boom'),
    );

    stderrSpy.mockRestore();
  });

  it('notify logs when a channel returns false', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const ch = makeChannel('flaky', () => Promise.resolve(false));
    router.register(ch);

    await router.notify(MSG);

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('channel "flaky" returned false'),
    );

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
