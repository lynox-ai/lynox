import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MailProvider, MailSendInput, MailSendResult, MailAccountConfig } from './provider.js';
import { startScheduledSendPoller } from './mail-scheduled-poller.js';
import { MailStateDb } from './state.js';
import type { MailRegistry } from './tools/registry.js';

let db: MailStateDb;
let sendCalls: MailSendInput[];
let provider: MailProvider;
let registry: MailRegistry;
let sendImpl: (input: MailSendInput) => Promise<MailSendResult>;

const ACCOUNT: MailAccountConfig = {
  id: 'acct-1',
  displayName: 'R',
  address: 'r@x',
  preset: 'custom',
  imap: { host: 'i', port: 1, secure: true },
  smtp: { host: 's', port: 1, secure: true },
  authType: 'imap',
  type: 'personal',
  isDefault: true,
};

beforeEach(() => {
  db = new MailStateDb({ path: ':memory:' });
  db.upsertAccount(ACCOUNT);
  sendCalls = [];
  sendImpl = async (input: MailSendInput): Promise<MailSendResult> => {
    sendCalls.push(input);
    return { messageId: '<sent@x>', accepted: input.to.map((a) => a.address), rejected: [] };
  };
  provider = {
    accountId: 'acct-1',
    name: 'fake',
    list: vi.fn(),
    fetch: vi.fn(),
    send: (input: MailSendInput) => sendImpl(input),
    search: vi.fn(),
    health: vi.fn(),
    watch: vi.fn(),
  } as unknown as MailProvider;
  registry = {
    get: (_id: string) => provider,
    getDefault: () => provider,
    register: vi.fn(),
    unregister: vi.fn(),
    list: vi.fn(),
  } as unknown as MailRegistry;
});

function queue(opts: { scheduledAt: Date; subject?: string }): string {
  return db.insertScheduledSend({
    accountId: 'acct-1',
    to: [{ address: 'recipient@x', name: undefined }],
    subject: opts.subject ?? 'Hello',
    bodyMd: 'Body content',
    scheduledAt: opts.scheduledAt,
  });
}

describe('mail-scheduled-poller', () => {
  it('fires a due send + marks sent_at', async () => {
    const past = new Date(Date.now() - 5000);
    const id = queue({ scheduledAt: past });
    const poller = startScheduledSendPoller({ state: db, registry });
    const result = await poller.tickNow();
    poller.stop();
    expect(result.fired).toBe(1);
    expect(result.failed).toBe(0);
    expect(sendCalls).toHaveLength(1);
    const fetched = db.listScheduledForAccount('acct-1');
    expect(fetched[0]?.sentAt).toBeInstanceOf(Date);
  });

  it('does not fire rows whose scheduled_at is still in the future', async () => {
    queue({ scheduledAt: new Date(Date.now() + 60_000) });
    const poller = startScheduledSendPoller({ state: db, registry });
    const result = await poller.tickNow();
    poller.stop();
    expect(result.fired).toBe(0);
    expect(sendCalls).toHaveLength(0);
  });

  it('retries up to MAX_ATTEMPTS on transient failure, then marks failed', async () => {
    // Reset dedup so the previous test's send doesn't bleed in.
    const { resetMailRateLimits } = await import('./tools/rate-limit.js');
    resetMailRateLimits();
    queue({ scheduledAt: new Date(Date.now() - 5000), subject: 'retry-test' });
    sendImpl = async () => { throw new Error('SMTP greylist'); };
    const poller = startScheduledSendPoller({ state: db, registry });
    // Tick 1: provider raises → caught at sendMail layer → retry. Note:
    // subsequent ticks hit the recipient-dedup window (same to+subject
    // within 60s), so attempts 2-3 fail with 'dedup_window' rather than
    // the original 'provider_error'. The end state — row marked failed
    // after MAX_ATTEMPTS — is what matters for this test.
    await poller.tickNow();
    await poller.tickNow();
    const r = await poller.tickNow();
    poller.stop();
    expect(r.failed).toBe(1);
    const row = db.listScheduledForAccount('acct-1')[0]!;
    expect(row.failedAt).toBeInstanceOf(Date);
    expect(row.failReason).toContain('after 3 attempts');
  });

  it('skips rows already marked sent or failed', async () => {
    const id1 = queue({ scheduledAt: new Date(Date.now() - 5000), subject: 'sent' });
    const id2 = queue({ scheduledAt: new Date(Date.now() - 5000), subject: 'failed' });
    db.markScheduledSent(id1);
    db.markScheduledFailed(id2, 'manual');
    const poller = startScheduledSendPoller({ state: db, registry });
    const result = await poller.tickNow();
    poller.stop();
    expect(result.fired).toBe(0);
    expect(sendCalls).toHaveLength(0);
  });

  it('respects perTickLimit + leaves overflow for next tick', async () => {
    for (let i = 0; i < 5; i++) queue({ scheduledAt: new Date(Date.now() - 5000), subject: `s${i}` });
    const poller = startScheduledSendPoller({ state: db, registry, perTickLimit: 2 });
    expect((await poller.tickNow()).fired).toBe(2);
    expect((await poller.tickNow()).fired).toBe(2);
    expect((await poller.tickNow()).fired).toBe(1);
    poller.stop();
  });

  it('cancelScheduledSend deletes a not-yet-sent row', async () => {
    const id = queue({ scheduledAt: new Date(Date.now() + 60_000) });
    expect(db.cancelScheduledSend(id)).toBe(true);
    expect(db.listScheduledForAccount('acct-1')).toHaveLength(0);
  });

  it('cancelScheduledSend refuses an already-sent row', async () => {
    const id = queue({ scheduledAt: new Date(Date.now() - 5000) });
    db.markScheduledSent(id);
    expect(db.cancelScheduledSend(id)).toBe(false);
  });
});
