import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runColdStartForAccount } from './cold-start-adapter.js';
import { ColdStartTracker } from './cold-start-tracker.js';
import { MailStateDb } from '../mail/state.js';
import { InboxStateDb } from './state.js';
import type { MailEnvelope, MailProvider } from '../mail/provider.js';
import type { MailAccountConfig } from '../mail/provider.js';

const ACCOUNT: MailAccountConfig = {
  id: 'acct-1',
  displayName: 'Me',
  address: 'me@x',
  preset: 'custom',
  imap: { host: 'i', port: 1, secure: true },
  smtp: { host: 's', port: 1, secure: true },
  authType: 'imap',
  type: 'personal',
  isDefault: true,
};

function envelope(uid: number, threadKey?: string): MailEnvelope {
  return {
    uid,
    messageId: `<m${String(uid)}@x>`,
    folder: 'INBOX',
    threadKey,
    from: [{ address: 'sender@x' }],
    to: [{ address: 'me@x' }],
    cc: [],
    bcc: [],
    subject: `s${String(uid)}`,
    date: new Date('2026-05-01'),
    snippet: 'snippet',
    flags: [],
    seen: true,
  } as unknown as MailEnvelope;
}

function fakeProvider(envelopes: ReadonlyArray<MailEnvelope>, opts: { listThrows?: Error } = {}): MailProvider {
  const list = vi.fn(async () => {
    if (opts.listThrows) throw opts.listThrows;
    return envelopes;
  });
  return {
    accountId: ACCOUNT.id,
    authType: 'imap',
    list,
    fetch: vi.fn(),
    search: vi.fn(),
    send: vi.fn(),
    watch: vi.fn(),
    close: vi.fn(),
  } as unknown as MailProvider;
}

let mail: MailStateDb;
let state: InboxStateDb;
let tracker: ColdStartTracker;

beforeEach(() => {
  mail = new MailStateDb({ path: ':memory:' });
  mail.upsertAccount(ACCOUNT);
  state = new InboxStateDb(mail.getConnection());
  tracker = new ColdStartTracker();
});

describe('runColdStartForAccount', () => {
  it('iterates envelopes through the hook and reports completion via the tracker', async () => {
    const hook = vi.fn(async () => {});
    const provider = fakeProvider([envelope(1, 't-a'), envelope(2, 't-b'), envelope(3, 't-c')]);
    await runColdStartForAccount({ provider, hook, tracker, state });
    expect(hook).toHaveBeenCalledTimes(3);
    expect(hook.mock.calls.map((c) => c[0])).toEqual([ACCOUNT.id, ACCOUNT.id, ACCOUNT.id]);
    const snap = tracker.getSnapshot();
    expect(snap.active).toHaveLength(0);
    expect(snap.recent).toHaveLength(1);
    expect(snap.recent[0]?.status).toBe('completed');
    expect(snap.recent[0]?.report?.uniqueThreads).toBe(3);
    expect(snap.recent[0]?.report?.enqueued).toBe(3);
    expect(snap.recent[0]?.report?.cappedAt).toBeNull();
  });

  it('dedupes by threadKey so two envelopes on the same thread only invoke the hook once', async () => {
    const hook = vi.fn(async () => {});
    const provider = fakeProvider([envelope(1, 'same'), envelope(2, 'same'), envelope(3, 'other')]);
    await runColdStartForAccount({ provider, hook, tracker, state });
    expect(hook).toHaveBeenCalledTimes(2);
  });

  it('honours the thread cap and stops before the over-cap envelope', async () => {
    const hook = vi.fn(async () => {});
    const envelopes = Array.from({ length: 5 }, (_, i) => envelope(i + 1, `t-${String(i)}`));
    const provider = fakeProvider(envelopes);
    await runColdStartForAccount({ provider, hook, tracker, state, threadCap: 3 });
    expect(hook).toHaveBeenCalledTimes(3);
    const recent = tracker.getSnapshot().recent[0];
    expect(recent?.report?.cappedAt).toBe(3);
    expect(recent?.report?.uniqueThreads).toBe(3);
  });

  it('skips the backfill entirely when items already exist for the account', async () => {
    state.insertItem({
      accountId: ACCOUNT.id,
      channel: 'email',
      threadKey: 'preexisting',
      bucket: 'requires_user',
      confidence: 0.9,
      reasonDe: 'r',
      classifiedAt: new Date(),
      classifierVersion: 'v',
    });
    const hook = vi.fn(async () => {});
    const provider = fakeProvider([envelope(1, 't')]);
    await runColdStartForAccount({ provider, hook, tracker, state });
    expect(hook).not.toHaveBeenCalled();
    // provider.list should not even be called
    expect((provider.list as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    // tracker should be unchanged — no start/complete/fail
    expect(tracker.getSnapshot().active).toHaveLength(0);
    expect(tracker.getSnapshot().recent).toHaveLength(0);
  });

  it('bypasses the re-credential gate when force=true', async () => {
    state.insertItem({
      accountId: ACCOUNT.id,
      channel: 'email',
      threadKey: 'preexisting',
      bucket: 'requires_user',
      confidence: 0.9,
      reasonDe: 'r',
      classifiedAt: new Date(),
      classifierVersion: 'v',
    });
    const hook = vi.fn(async () => {});
    const provider = fakeProvider([envelope(1, 't1'), envelope(2, 't2')]);
    await runColdStartForAccount({ provider, hook, tracker, state, force: true });
    expect(hook).toHaveBeenCalledTimes(2);
    expect(tracker.getSnapshot().recent[0]?.status).toBe('completed');
  });

  it('reports tracker.fail when provider.list throws — never rejects', async () => {
    const hook = vi.fn(async () => {});
    const provider = fakeProvider([], { listThrows: new Error('IMAP timeout') });
    await expect(runColdStartForAccount({ provider, hook, tracker, state })).resolves.toBeUndefined();
    const recent = tracker.getSnapshot().recent[0];
    expect(recent?.status).toBe('failed');
    expect(recent?.error).toBe('IMAP timeout');
  });

  it('passes the listLimit override to provider.list', async () => {
    const hook = vi.fn(async () => {});
    const provider = fakeProvider([]);
    await runColdStartForAccount({ provider, hook, tracker, state, listLimit: 42 });
    const listMock = provider.list as ReturnType<typeof vi.fn>;
    expect(listMock.mock.calls[0]?.[0]).toEqual({ limit: 42 });
  });

  it('synthesises a thread key from (folder, uid) when neither threadKey nor messageId is set', async () => {
    const hook = vi.fn(async () => {});
    const dupA = { ...envelope(7), threadKey: undefined, messageId: undefined } as MailEnvelope;
    const dupB = { ...envelope(7), threadKey: undefined, messageId: undefined } as MailEnvelope;
    const other = { ...envelope(8), threadKey: undefined, messageId: undefined } as MailEnvelope;
    const provider = fakeProvider([dupA, dupB, other]);
    await runColdStartForAccount({ provider, hook, tracker, state });
    // dupA and dupB share (folder, uid) → one synthesised key → deduped
    expect(hook).toHaveBeenCalledTimes(2);
  });
});
