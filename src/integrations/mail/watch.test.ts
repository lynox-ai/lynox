import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MailWatcher } from './watch.js';
import { MailStateDb } from './state.js';
import type {
  MailEnvelope,
  MailProvider,
  MailWatchEvent,
  MailWatchHandler,
  MailWatchHandle,
} from './provider.js';

// ── Fake provider ──────────────────────────────────────────────────────────

class FakeProvider implements MailProvider {
  readonly accountId: string;
  /** Set by tests after attach() to push events. */
  emit: (event: MailWatchEvent) => Promise<void> = async () => {};
  stopCalls = 0;

  constructor(accountId: string) {
    this.accountId = accountId;
  }

  async list(): Promise<ReadonlyArray<MailEnvelope>> { return []; }
  async fetch(): Promise<never> { throw new Error('not used'); }
  async search(): Promise<ReadonlyArray<MailEnvelope>> { return []; }
  async send(): Promise<never> { throw new Error('not used'); }
  async close(): Promise<void> { /* no-op */ }

  async watch(_opts: unknown, handler: MailWatchHandler): Promise<MailWatchHandle> {
    this.emit = async (event: MailWatchEvent) => { await handler(event); };
    return {
      stop: async () => {
        this.stopCalls++;
        this.emit = async () => {};
      },
    };
  }
}

function envelope(uid: number, opts: { messageId: string; from?: string }): MailEnvelope {
  return {
    uid,
    messageId: opts.messageId,
    folder: 'INBOX',
    threadKey: opts.messageId,
    inReplyTo: undefined,
    from: [{ address: opts.from ?? 'alice@example.com' }],
    to: [{ address: 'me@x.com' }],
    cc: [],
    replyTo: [],
    subject: `msg-${String(uid)}`,
    date: new Date(),
    flags: [],
    snippet: '',
    hasAttachments: false,
    attachmentCount: 0,
    sizeBytes: 0,
    isAutoReply: false,
  };
}

// ── Test fixtures ──────────────────────────────────────────────────────────

let state: MailStateDb;
let watcher: MailWatcher;
let received: Array<{ accountId: string; uids: number[] }>;
let handler: ReturnType<typeof vi.fn>;

beforeEach(() => {
  state = new MailStateDb({ path: ':memory:' });
  received = [];
  handler = vi.fn(async (accountId: string, envelopes: ReadonlyArray<MailEnvelope>) => {
    received.push({ accountId, uids: envelopes.map(e => e.uid) });
  });
  watcher = new MailWatcher(state, handler);
});

afterEach(async () => {
  await watcher.stopAll();
  state.close();
});

// ── Tests ─────────────────────────────────────────────────────────────────

describe('MailWatcher — attach / detach lifecycle', () => {
  it('attaches one provider and tracks size', async () => {
    const provider = new FakeProvider('acct-a');
    await watcher.attach(provider);
    expect(watcher.size).toBe(1);
    expect(watcher.has('acct-a')).toBe(true);
  });

  it('detach removes the provider and stops its handle', async () => {
    const provider = new FakeProvider('acct-a');
    await watcher.attach(provider);
    await watcher.detach('acct-a');
    expect(watcher.size).toBe(0);
    expect(provider.stopCalls).toBe(1);
  });

  it('detach on unknown accountId is a no-op', async () => {
    await watcher.detach('nothing');
    expect(watcher.size).toBe(0);
  });

  it('re-attaching the same accountId replaces and stops the previous handle', async () => {
    const first = new FakeProvider('acct-a');
    const second = new FakeProvider('acct-a');
    await watcher.attach(first);
    await watcher.attach(second);
    expect(watcher.size).toBe(1);
    expect(first.stopCalls).toBe(1);
    expect(second.stopCalls).toBe(0);
  });

  it('stopAll detaches everything', async () => {
    const a = new FakeProvider('a');
    const b = new FakeProvider('b');
    await watcher.attach(a);
    await watcher.attach(b);
    await watcher.stopAll();
    expect(watcher.size).toBe(0);
    expect(a.stopCalls).toBe(1);
    expect(b.stopCalls).toBe(1);
  });
});

describe('MailWatcher — dedup', () => {
  it('passes fresh envelopes to the handler and marks them seen', async () => {
    const provider = new FakeProvider('acct-a');
    await watcher.attach(provider, { applyPrefilter: false });

    await provider.emit({
      type: 'new',
      envelopes: [
        envelope(1, { messageId: '<m-1@x>' }),
        envelope(2, { messageId: '<m-2@x>' }),
      ],
    });

    expect(received).toHaveLength(1);
    expect(received[0]?.uids).toEqual([1, 2]);
    expect(state.countForAccount('acct-a')).toBe(2);
  });

  it('filters out previously-seen envelopes on subsequent ticks', async () => {
    const provider = new FakeProvider('acct-a');
    await watcher.attach(provider, { applyPrefilter: false });

    await provider.emit({
      type: 'new',
      envelopes: [envelope(1, { messageId: '<m-1@x>' })],
    });
    await provider.emit({
      type: 'new',
      envelopes: [
        envelope(1, { messageId: '<m-1@x>' }), // already seen — skipped
        envelope(2, { messageId: '<m-2@x>' }), // fresh
      ],
    });

    expect(received).toHaveLength(2);
    expect(received[0]?.uids).toEqual([1]);
    expect(received[1]?.uids).toEqual([2]);
  });

  it('does not call the handler when every envelope is already seen', async () => {
    const provider = new FakeProvider('acct-a');
    await watcher.attach(provider, { applyPrefilter: false });
    await provider.emit({
      type: 'new',
      envelopes: [envelope(1, { messageId: '<m-1@x>' })],
    });
    handler.mockClear();
    await provider.emit({
      type: 'new',
      envelopes: [envelope(1, { messageId: '<m-1@x>' })],
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it('isolates dedup state per account', async () => {
    const a = new FakeProvider('acct-a');
    const b = new FakeProvider('acct-b');
    await watcher.attach(a, { applyPrefilter: false });
    await watcher.attach(b, { applyPrefilter: false });

    const env = envelope(1, { messageId: '<shared@x>' });
    await a.emit({ type: 'new', envelopes: [env] });
    await b.emit({ type: 'new', envelopes: [env] });

    expect(received).toHaveLength(2);
    expect(received[0]?.accountId).toBe('acct-a');
    expect(received[1]?.accountId).toBe('acct-b');
  });
});

describe('MailWatcher — prefilter integration', () => {
  it('drops noise senders by default', async () => {
    const provider = new FakeProvider('acct-a');
    await watcher.attach(provider); // applyPrefilter default true

    await provider.emit({
      type: 'new',
      envelopes: [
        envelope(1, { messageId: '<m-1@x>', from: 'noreply@example.com' }),
        envelope(2, { messageId: '<m-2@x>', from: 'alice@example.com' }),
      ],
    });

    expect(received).toHaveLength(1);
    expect(received[0]?.uids).toEqual([2]);
    // Both fresh envelopes are still marked seen — including the noise one
    expect(state.countForAccount('acct-a')).toBe(2);
  });

  it('does not call the handler at all when every fresh envelope is noise', async () => {
    const provider = new FakeProvider('acct-a');
    await watcher.attach(provider);

    await provider.emit({
      type: 'new',
      envelopes: [
        envelope(1, { messageId: '<m-1@x>', from: 'noreply@example.com' }),
        envelope(2, { messageId: '<m-2@x>', from: 'donotreply@example.com' }),
      ],
    });

    expect(handler).not.toHaveBeenCalled();
    expect(state.countForAccount('acct-a')).toBe(2);
  });

  it('passes through noise senders when applyPrefilter is false', async () => {
    const provider = new FakeProvider('acct-a');
    await watcher.attach(provider, { applyPrefilter: false });
    await provider.emit({
      type: 'new',
      envelopes: [envelope(1, { messageId: '<m-1@x>', from: 'noreply@example.com' })],
    });
    expect(received).toHaveLength(1);
    expect(received[0]?.uids).toEqual([1]);
  });
});

describe('MailWatcher — error resilience', () => {
  it('swallows error events from the provider', async () => {
    const provider = new FakeProvider('acct-a');
    await watcher.attach(provider);
    await provider.emit({ type: 'error', error: new Error('boom') });
    // No crash, no handler call
    expect(handler).not.toHaveBeenCalled();
  });

  it('swallows handler errors so future ticks still fire', async () => {
    handler.mockImplementationOnce(() => { throw new Error('handler crash'); });
    const provider = new FakeProvider('acct-a');
    await watcher.attach(provider, { applyPrefilter: false });

    await provider.emit({
      type: 'new',
      envelopes: [envelope(1, { messageId: '<m-1@x>' })],
    });
    // Second event must still go through
    await provider.emit({
      type: 'new',
      envelopes: [envelope(2, { messageId: '<m-2@x>' })],
    });

    expect(handler).toHaveBeenCalledTimes(2);
  });
});
