import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MailWatcher } from './watch.js';
import { MailStateDb } from './state.js';
import { MailError } from './provider.js';
import { InboundMailDeferred } from './inbound-deferred.js';
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

describe('MailWatcher — ack ordering (mark seen after handoff)', () => {
  it('does NOT mark survivors seen when the handler throws — they retry next tick', async () => {
    handler.mockImplementationOnce(() => { throw new Error('handler crash'); });
    const provider = new FakeProvider('acct-a');
    await watcher.attach(provider, { applyPrefilter: false });

    await provider.emit({
      type: 'new',
      envelopes: [envelope(1, { messageId: '<m-1@x>' })],
    });
    // Handler threw → the survivor must stay unseen (old code marked it seen
    // before the handler, so a throw lost it permanently).
    expect(state.countForAccount('acct-a')).toBe(0);

    // Re-emit the same envelope: still fresh → handler runs again (retry).
    await provider.emit({
      type: 'new',
      envelopes: [envelope(1, { messageId: '<m-1@x>' })],
    });
    expect(handler).toHaveBeenCalledTimes(2);
    expect(received.at(-1)?.uids).toEqual([1]);
    // Retry succeeded → now marked seen.
    expect(state.countForAccount('acct-a')).toBe(1);
  });

  it('marks prefiltered noise seen immediately even while survivors await the handler', async () => {
    handler.mockImplementationOnce(() => { throw new Error('handler crash'); });
    const provider = new FakeProvider('acct-a');
    await watcher.attach(provider); // prefilter on

    await provider.emit({
      type: 'new',
      envelopes: [
        envelope(1, { messageId: '<m-1@x>', from: 'noreply@example.com' }), // noise
        envelope(2, { messageId: '<m-2@x>', from: 'alice@example.com' }), // survivor
      ],
    });
    // Noise marked seen (intentional drop); survivor NOT (handler threw).
    expect(state.countForAccount('acct-a')).toBe(1);

    // Re-emit: noise deduped away, only the survivor reaches the handler.
    await provider.emit({
      type: 'new',
      envelopes: [
        envelope(1, { messageId: '<m-1@x>', from: 'noreply@example.com' }),
        envelope(2, { messageId: '<m-2@x>', from: 'alice@example.com' }),
      ],
    });
    expect(received.at(-1)?.uids).toEqual([2]);
    expect(state.countForAccount('acct-a')).toBe(2);
  });
});

describe('MailWatcher — last polling error per account', () => {
  const fail = (code: ConstructorParameters<typeof MailError>[0]) => ({ type: 'error' as const, error: new MailError(code, `poll failed: ${code}`) });

  it('records a polling error by code, without the raw message', async () => {
    const provider = new FakeProvider('acct-a');
    await watcher.attach(provider);
    expect(watcher.lastError('acct-a'), 'no error before any poll').toBeNull();
    await provider.emit(fail('starttls_unavailable'));
    const e = watcher.lastError('acct-a');
    expect(e?.code).toBe('starttls_unavailable');
    expect(Object.keys(e ?? {}).sort()).toEqual(['at', 'code']);
  });

  it('keeps the first timestamp when the same error repeats (a change, not every poll)', async () => {
    const provider = new FakeProvider('acct-a');
    await watcher.attach(provider);
    await provider.emit(fail('auth_failed'));
    const first = watcher.lastError('acct-a')?.at;
    await new Promise(r => setTimeout(r, 5));
    await provider.emit(fail('auth_failed'));
    expect(watcher.lastError('acct-a')?.at).toBe(first);
  });

  it('a DIFFERENT error after the first one replaces it (the first never hides a later one)', async () => {
    const provider = new FakeProvider('acct-a');
    await watcher.attach(provider);
    await provider.emit(fail('starttls_unavailable'));
    await provider.emit(fail('auth_failed'));
    expect(watcher.lastError('acct-a')?.code).toBe('auth_failed');
  });

  it('a successful poll clears it, with or without new mail', async () => {
    const provider = new FakeProvider('acct-a');
    await watcher.attach(provider);
    await provider.emit(fail('connection_failed'));
    await provider.emit({ type: 'ok' });
    expect(watcher.lastError('acct-a'), 'cleared by an empty successful poll').toBeNull();
    await provider.emit(fail('connection_failed'));
    await provider.emit({ type: 'new', envelopes: [envelope(1, { messageId: '<m1@x>' })] });
    expect(watcher.lastError('acct-a'), 'cleared by a poll that found mail').toBeNull();
    expect(received.length, 'and the new mail still reaches the handler').toBe(1);
  });

  it('an error that is not a MailError is recorded as unknown, and detach forgets it', async () => {
    const provider = new FakeProvider('acct-a');
    await watcher.attach(provider);
    await provider.emit({ type: 'error', error: new Error('boom') });
    expect(watcher.lastError('acct-a')?.code).toBe('unknown');
    await watcher.detach('acct-a');
    expect(watcher.lastError('acct-a')).toBeNull();
  });

  it('keeps accounts apart', async () => {
    const a = new FakeProvider('acct-a');
    const b = new FakeProvider('acct-b');
    await watcher.attach(a);
    await watcher.attach(b);
    await a.emit(fail('auth_failed'));
    expect(watcher.lastError('acct-b')).toBeNull();
  });
});

describe('MailWatcher — a deferred batch is held for the next poll', () => {
  // The fake provider here emits each mail once, as Gmail and Graph do: neither lists a mail a
  // second time once it handed it on.
  it('hands a deferred mail over on the next poll even when the provider does not list it again', async () => {
    handler.mockImplementationOnce(() => { throw new InboundMailDeferred('test'); });
    const provider = new FakeProvider('acct-a');
    await watcher.attach(provider, { applyPrefilter: false });

    await provider.emit({ type: 'new', envelopes: [envelope(1, { messageId: '<d-1@x>' }), envelope(2, { messageId: '<d-2@x>' })] });
    expect(state.countForAccount('acct-a'), 'deferred batch marked seen').toBe(0);

    await provider.emit({ type: 'ok' });
    expect(handler).toHaveBeenCalledTimes(2);
    expect(received.at(-1)?.uids).toEqual([1, 2]);
    expect(state.countForAccount('acct-a')).toBe(2);

    // Handed over once: a later poll does not repeat it.
    await provider.emit({ type: 'ok' });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('a held mail the provider lists again goes over once, ahead of the new mail', async () => {
    handler.mockImplementationOnce(() => { throw new InboundMailDeferred('test'); });
    const provider = new FakeProvider('acct-a');
    await watcher.attach(provider, { applyPrefilter: false });
    await provider.emit({ type: 'new', envelopes: [envelope(1, { messageId: '<d-1@x>' })] });

    await provider.emit({ type: 'new', envelopes: [envelope(1, { messageId: '<d-1@x>' }), envelope(3, { messageId: '<d-3@x>' })] });
    expect(received.at(-1)?.uids).toEqual([1, 3]);
  });

  it('a poll error does not hand the held mail over; the next good poll does', async () => {
    handler.mockImplementationOnce(() => { throw new InboundMailDeferred('test'); });
    const provider = new FakeProvider('acct-a');
    await watcher.attach(provider, { applyPrefilter: false });
    await provider.emit({ type: 'new', envelopes: [envelope(1, { messageId: '<d-1@x>' })] });

    await provider.emit({ type: 'error', error: new MailError('timeout', 'poll failed') });
    expect(handler).toHaveBeenCalledTimes(1);
    await provider.emit({ type: 'ok' });
    expect(handler).toHaveBeenCalledTimes(2);
    expect(received.at(-1)?.uids).toEqual([1]);
  });

  it('a handler crash is not held: only a deferral is (control)', async () => {
    handler.mockImplementationOnce(() => { throw new Error('handler crash'); });
    const provider = new FakeProvider('acct-a');
    await watcher.attach(provider, { applyPrefilter: false });
    await provider.emit({ type: 'new', envelopes: [envelope(1, { messageId: '<d-1@x>' })] });

    await provider.emit({ type: 'ok' });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('a removed account drops what it held', async () => {
    handler.mockImplementationOnce(() => { throw new InboundMailDeferred('test'); });
    const first = new FakeProvider('acct-a');
    await watcher.attach(first, { applyPrefilter: false });
    await first.emit({ type: 'new', envelopes: [envelope(1, { messageId: '<d-1@x>' })] });
    await watcher.detach('acct-a');

    const second = new FakeProvider('acct-a');
    await watcher.attach(second, { applyPrefilter: false });
    await second.emit({ type: 'ok' });
    expect(handler, 'removed account handed over its held mail').toHaveBeenCalledTimes(1);
  });

  it('a poll still in its handler when the account is removed holds nothing for a later account', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    handler.mockImplementationOnce(async () => { await gate; throw new InboundMailDeferred('test'); });
    const first = new FakeProvider('acct-a');
    await watcher.attach(first, { applyPrefilter: false });
    const inFlight = first.emit({ type: 'new', envelopes: [envelope(1, { messageId: '<d-1@x>' })] });
    await watcher.detach('acct-a');
    release();
    await inFlight;

    const second = new FakeProvider('acct-a');
    await watcher.attach(second, { applyPrefilter: false });
    await second.emit({ type: 'ok' });
    expect(handler, 'the removed account\'s deferral reached the new one').toHaveBeenCalledTimes(1);
  });

  it('a second deferral adds to what is held instead of replacing it', async () => {
    // Gmail polls can overlap; the second one's deferral must not drop the first one's mails.
    // Deferred after a turn of the event loop, so both polls are in their handler at once.
    const deferLater = async (): Promise<never> => { await new Promise((r) => setTimeout(r, 0)); throw new InboundMailDeferred('test'); };
    handler.mockImplementationOnce(deferLater);
    const provider = new FakeProvider('acct-a');
    await watcher.attach(provider, { applyPrefilter: false });
    const first = provider.emit({ type: 'new', envelopes: [envelope(1, { messageId: '<d-1@x>' })] });
    handler.mockImplementationOnce(deferLater);
    const second = provider.emit({ type: 'new', envelopes: [envelope(2, { messageId: '<d-2@x>' })] });
    await Promise.all([first, second]);

    await provider.emit({ type: 'ok' });
    expect([...(received.at(-1)?.uids ?? [])].sort()).toEqual([1, 2]);
  });

  it('beyond the cap the newest are not held, and that is logged', async () => {
    handler.mockImplementationOnce(() => { throw new InboundMailDeferred('test'); });
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const provider = new FakeProvider('acct-a');
      await watcher.attach(provider, { applyPrefilter: false });
      const many = Array.from({ length: 502 }, (_, i) => envelope(i + 1, { messageId: `<cap-${String(i + 1)}@x>` }));
      await provider.emit({ type: 'new', envelopes: many });
      expect(errSpy.mock.calls.some((c) => /2 deferred mail\(s\).*not held/.test(String(c[0])))).toBe(true);

      await provider.emit({ type: 'ok' });
      expect(received.at(-1)?.uids.length).toBe(500);
      expect(received.at(-1)?.uids.at(-1)).toBe(500);
    } finally {
      errSpy.mockRestore();
    }
  });
});

// Gmail and Graph do not list a mail again after a restart, so a held mail must outlive the
// process: the state DB keeps it, and a new watcher takes it back on attach.
describe('MailWatcher — a deferred mail is kept across a restart', () => {
  const ACCOUNT = {
    id: 'acct-a', displayName: 'a', address: 'a@example.org', preset: 'gmail' as const,
    imap: { host: '', port: 0, secure: true }, smtp: { host: '', port: 0, secure: true },
    authType: 'oauth_google' as const, type: 'personal' as const,
  };
  beforeEach(() => { state.upsertAccount(ACCOUNT); });

  /** Defer one mail on the fixture watcher, then stop it as a shutdown does. */
  async function deferThenStop(): Promise<void> {
    handler.mockImplementationOnce(() => { throw new InboundMailDeferred('test'); });
    const provider = new FakeProvider('acct-a');
    await watcher.attach(provider, { applyPrefilter: false });
    await provider.emit({ type: 'new', envelopes: [envelope(4, { messageId: '<r-1@x>' })] });
    await watcher.stopAll();
  }

  it('a new watcher hands the kept mail over on its first poll, with uid 0, and releases it', async () => {
    await deferThenStop();
    const handed: MailEnvelope[] = [];
    const next = new MailWatcher(state, async (_a, envs) => { handed.push(...envs); });
    const provider = new FakeProvider('acct-a');
    try {
      await next.attach(provider, { applyPrefilter: false });
      await provider.emit({ type: 'ok' });
    } finally {
      await next.stopAll();
    }
    expect(handed.map((e) => [e.messageId, e.uid])).toEqual([['<r-1@x>', 0]]);
    expect(state.countForAccount('acct-a')).toBe(1);
    expect(state.deferredMail('acct-a')).toEqual([]);
  });

  it('takes the copy the provider lists now, with its uid, over the kept one', async () => {
    await deferThenStop();
    const handed: MailEnvelope[] = [];
    const next = new MailWatcher(state, async (_a, envs) => { handed.push(...envs); });
    const provider = new FakeProvider('acct-a');
    try {
      await next.attach(provider, { applyPrefilter: false });
      await provider.emit({ type: 'new', envelopes: [envelope(9, { messageId: '<r-1@x>' })] });
    } finally {
      await next.stopAll();
    }
    expect(handed.map((e) => [e.messageId, e.uid])).toEqual([['<r-1@x>', 9]]);
  });

  it('releases a kept mail that is already marked seen', async () => {
    await deferThenStop();
    state.markSeen('acct-a', envelope(4, { messageId: '<r-1@x>' }));
    const next = new MailWatcher(state, handler);
    const provider = new FakeProvider('acct-a');
    try {
      await next.attach(provider, { applyPrefilter: false });
      await provider.emit({ type: 'ok' });
    } finally {
      await next.stopAll();
    }
    expect(handler).toHaveBeenCalledTimes(1);
    expect(state.deferredMail('acct-a')).toEqual([]);
  });

  it('logs the mails beyond the cap that are not kept across a restart', async () => {
    handler.mockImplementationOnce(() => { throw new InboundMailDeferred('test'); });
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const provider = new FakeProvider('acct-a');
      await watcher.attach(provider, { applyPrefilter: false });
      await provider.emit({ type: 'new', envelopes: Array.from({ length: 503 }, (_, i) => envelope(i + 1, { messageId: `<k-${String(i + 1)}@x>` })) });
      expect(errSpy.mock.calls.some((c) => /3 deferred mail\(s\).*not kept across a restart/.test(String(c[0])))).toBe(true);
    } finally {
      errSpy.mockRestore();
    }
    expect(state.deferredMail('acct-a')).toHaveLength(500);
  });

  it('keeps a mail deferred after the account was detached (a restore defers, then exits)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    handler.mockImplementationOnce(async () => { await gate; throw new InboundMailDeferred('test'); });
    const provider = new FakeProvider('acct-a');
    await watcher.attach(provider, { applyPrefilter: false });
    const poll = provider.emit({ type: 'new', envelopes: [envelope(5, { messageId: '<late@x>' })] });
    await watcher.stopAll();
    release();
    await poll;
    expect(state.deferredMail('acct-a').map((e) => e.messageId)).toEqual(['<late@x>']);
  });
});
