import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MailContext } from './context.js';
import { MailStateDb, type MailFollowup } from './state.js';
import type { MailEnvelope, MailProvider, MailWatchEvent, MailWatchHandle, MailWatchHandler } from './provider.js';
import type { MailCredentialBackend } from './auth/app-password.js';

/**
 * A reminder to wait for an answer is kept under the sent mail's Message-ID. An answer's thread key
 * is that id only where the server threads by it; on an IMAP server without thread ids it is the
 * answer's own Message-ID, and a server with its own thread ids gives another key again. The answer
 * names the sent mail in In-Reply-To or References, and the reminder is matched by those too.
 */

class MapBackend implements MailCredentialBackend {
  private readonly store = new Map<string, string>();
  set(name: string, value: string): void { this.store.set(name, value); }
  get(name: string): string | null { return this.store.get(name) ?? null; }
  delete(name: string): boolean { return this.store.delete(name); }
  has(name: string): boolean { return this.store.has(name); }
}

class EmittingProvider {
  readonly accountId = 'acct-r';
  emit: (event: MailWatchEvent) => Promise<void> = async () => { /* not attached */ };
  async list(): Promise<ReadonlyArray<MailEnvelope>> { return []; }
  async fetch(): Promise<never> { throw new Error('not used'); }
  async search(): Promise<ReadonlyArray<MailEnvelope>> { return []; }
  async send(): Promise<never> { throw new Error('not used'); }
  async close(): Promise<void> { /* no-op */ }
  async watch(_opts: unknown, handler: MailWatchHandler): Promise<MailWatchHandle> {
    this.emit = async (event) => { await handler(event); };
    return { stop: async () => { this.emit = async () => { /* stopped */ }; } };
  }
}

/** An answer as the IMAP provider builds it on a server without thread ids: its key is its Message-ID. */
function answer(overrides: Partial<MailEnvelope> = {}): MailEnvelope {
  return {
    uid: 1, messageId: '<answer@x>', threadKey: '<answer@x>', folder: 'INBOX', inReplyTo: '<sent@me.example>',
    from: [{ address: 'kunde@example.com' }], to: [{ address: 'me@me.example' }], cc: [], replyTo: [],
    subject: 'Re: Offerte', date: new Date('2026-11-24T09:05:00Z'), flags: [], snippet: '',
    hasAttachments: false, attachmentCount: 0, sizeBytes: 0, isAutoReply: false, ...overrides,
  };
}

let stateDb: MailStateDb;
beforeEach(() => { stateDb = new MailStateDb({ path: ':memory:' }); });
afterEach(() => stateDb.close());

function waitFor(recipient = 'kunde@example.com', accountId = 'acct-r'): string {
  return stateDb.recordFollowup({
    accountId, sentMessageId: '<sent@me.example>', threadKey: '<sent@me.example>', recipient,
    type: 'awaiting_reply', reason: 'Offerte', reminderAt: new Date(Date.now() + 86_400_000), source: 'agent',
  });
}
function status(id: string, accountId = 'acct-r'): string | undefined {
  return stateDb.listFollowups(accountId).find((f) => f.id === id)?.status;
}

async function deliver(env: MailEnvelope): Promise<MailFollowup[]> {
  const resolved: MailFollowup[] = [];
  const ctx = new MailContext(stateDb, new MapBackend(), undefined, {
    onFollowupResolved: async (f) => { resolved.push(f); },
  });
  const provider = new EmittingProvider();
  try {
    await ctx.watcher.attach(provider as unknown as MailProvider, { applyPrefilter: false });
    await provider.emit({ type: 'new', envelopes: [env] });
  } finally {
    await ctx.close();
  }
  return resolved;
}

describe('a reminder waiting for an answer', () => {
  it('is resolved when the answer names the sent mail in In-Reply-To', async () => {
    const id = waitFor();
    const resolved = await deliver(answer());
    expect(status(id)).toBe('resolved');
    expect(resolved.map((f) => f.id)).toEqual([id]);
  });

  it('is resolved when the answer names the sent mail only in References', async () => {
    const id = waitFor();
    await deliver(answer({ inReplyTo: '<unknown@x>', references: ['<sent@me.example>', '<unknown@x>'] }));
    expect(status(id)).toBe('resolved');
  });

  it('is resolved by the reply headers also where the server gives its own thread id', async () => {
    const id = waitFor();
    await deliver(answer({ threadKey: 'server-thread-9' }));
    expect(status(id)).toBe('resolved');
  });

  it('keeps waiting when the recipient\'s automatic reply names the sent mail, by headers or by thread key', async () => {
    const id = waitFor();
    const resolved = await deliver(answer({ isAutoReply: true }));
    await deliver(answer({ messageId: '<ooo2@x>', isAutoReply: true, threadKey: '<sent@me.example>' }));
    expect(status(id)).toBe('pending');
    expect(resolved).toEqual([]);
  });

  it('is still resolved by the thread key where that is the sent mail\'s id (control)', async () => {
    const id = waitFor();
    await deliver(answer({ threadKey: '<sent@me.example>', inReplyTo: undefined }));
    expect(status(id)).toBe('resolved');
  });

  it('keeps waiting when the answer comes from someone else', async () => {
    const id = waitFor();
    await deliver(answer({ from: [{ address: 'fremd@example.com' }] }));
    expect(status(id)).toBe('pending');
  });

  it('keeps waiting when it belongs to another account', async () => {
    const id = waitFor('kunde@example.com', 'acct-other');
    await deliver(answer());
    expect(status(id, 'acct-other')).toBe('pending');
  });

  it('keeps waiting when the answer names another mail', async () => {
    const id = waitFor();
    await deliver(answer({ inReplyTo: '<other@x>', references: ['<other@x>'] }));
    expect(status(id)).toBe('pending');
  });

  it('is matched against the first five From addresses only', async () => {
    const id = waitFor('sechste@example.com');
    const from = ['a', 'b', 'c', 'd', 'e', 'sechste'].map((n) => ({ address: `${n}@example.com` }));
    await deliver(answer({ from }));
    expect(status(id)).toBe('pending');
    const id5 = waitFor('e@example.com');
    await deliver(answer({ from, messageId: '<answer-2@x>', threadKey: '<answer-2@x>' }));
    expect(status(id5)).toBe('resolved');
  });
});
