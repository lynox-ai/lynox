import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MailError, type MailProvider, type MailSendInput, type MailSendResult, type MailAccountConfig } from './provider.js';
import { startScheduledSendPoller, classifyScheduledFailure, OUTCOME_UNKNOWN_PREFIX, SCHEDULED_CLAIM_STALE_MS } from './mail-scheduled-poller.js';
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

  it('retries a failure that proves nothing was sent up to MAX_ATTEMPTS, then marks failed', async () => {
    const { resetMailRateLimits } = await import('./tools/rate-limit.js');
    resetMailRateLimits();
    queue({ scheduledAt: new Date(Date.now() - 5000), subject: 'retry-test' });
    let tries = 0;
    sendImpl = async () => { tries++; throw new MailError('rate_limited', 'throttled'); };
    const poller = startScheduledSendPoller({ state: db, registry });
    expect((await poller.tickNow()).failed).toBe(0);
    expect((await poller.tickNow()).failed).toBe(0);
    const r = await poller.tickNow();
    poller.stop();
    expect(tries).toBe(3);
    expect(r.failed).toBe(1);
    const row = db.listScheduledForAccount('acct-1')[0]!;
    expect(row.failedAt).toBeInstanceOf(Date);
    expect(row.failReason).toContain('after 3 attempts');
  });

  // A failure that may have sent the mail is never sent again on its own: a duplicate cannot be
  // taken back, a missed mail can be re-queued by the person who reads the reason.
  for (const [what, err] of [
    ['a timeout', new MailError('timeout', 'SMTP timeout')],
    ['a send error SMTP could not place (a connection lost mid-transfer lands here)', new MailError('send_rejected', 'SMTP send failed: Connection closed')],
    ['a Gmail 5xx', new MailError('connection_failed', 'Gmail send: HTTP 502')],
    ['a provider error without a code', new Error('socket hang up')],
  ] as const) {
    it(`${what} is not retried and is marked as possibly sent`, async () => {
      queue({ scheduledAt: new Date(Date.now() - 5000), subject: `unknown-${what}` });
      let tries = 0;
      sendImpl = async () => { tries++; throw err; };
      const poller = startScheduledSendPoller({ state: db, registry });
      expect((await poller.tickNow()).failed).toBe(1);
      await poller.tickNow();
      poller.stop();
      expect(tries).toBe(1);
      const row = db.listScheduledForAccount('acct-1')[0]!;
      expect(row.failReason?.startsWith(OUTCOME_UNKNOWN_PREFIX)).toBe(true);
      expect(row.attempts).toBe(0);
    });
  }

  it('a failure that proves nothing was sent and would fail again is marked failed at once', async () => {
    queue({ scheduledAt: new Date(Date.now() - 5000), subject: 'scope' });
    let tries = 0;
    sendImpl = async () => { tries++; throw new MailError('unsupported', 'needs the send scope'); };
    const poller = startScheduledSendPoller({ state: db, registry });
    expect((await poller.tickNow()).failed).toBe(1);
    poller.stop();
    expect(tries).toBe(1);
    expect(db.listScheduledForAccount('acct-1')[0]!.failReason).toMatch(/^send failed, nothing was sent: provider_error/);
  });

  it('a refusal decided before the provider is marked failed at once, and nothing reaches the provider', async () => {
    db.insertScheduledSend({ accountId: 'acct-1', to: [], subject: 'nobody', bodyMd: 'x', scheduledAt: new Date(Date.now() - 5000) });
    const poller = startScheduledSendPoller({ state: db, registry });
    expect((await poller.tickNow()).failed).toBe(1);
    poller.stop();
    expect(sendCalls).toHaveLength(0);
    expect(db.listScheduledForAccount('acct-1')[0]!.failReason).toMatch(/^send failed, nothing was sent: invalid_recipients/);
  });

  it('a throw out of the send pipeline is not retried: it may come after the mail went out', async () => {
    queue({ scheduledAt: new Date(Date.now() - 5000), subject: 'throws' });
    registry = { ...registry, get: () => { throw new Error('registry broke'); }, getDefault: () => { throw new Error('registry broke'); } } as unknown as MailRegistry;
    const poller = startScheduledSendPoller({ state: db, registry });
    expect((await poller.tickNow()).failed).toBe(1);
    await poller.tickNow();
    poller.stop();
    expect(db.listScheduledForAccount('acct-1')[0]!.failReason?.startsWith(OUTCOME_UNKNOWN_PREFIX)).toBe(true);
  });

  it('two pollers on one database send a due row once', async () => {
    queue({ scheduledAt: new Date(Date.now() - 5000), subject: 'race' });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    sendImpl = async (input) => { sendCalls.push(input); await gate; return { messageId: '<m@x>', accepted: ['recipient@x'], rejected: [] }; };
    const a = startScheduledSendPoller({ state: db, registry });
    const b = startScheduledSendPoller({ state: db, registry });
    const first = a.tickNow();
    // Let the first tick reach the provider and hold there, then start the second.
    await vi.waitFor(() => expect(sendCalls).toHaveLength(1));
    const second = b.tickNow();
    const secondResult = await second;
    release();
    const firstResult = await first;
    a.stop(); b.stop();
    expect(sendCalls).toHaveLength(1);
    expect(firstResult.fired + secondResult.fired).toBe(1);
  });

  it('a row a stopped process left claimed is reported as possibly sent, not sent again', async () => {
    const t0 = Date.now();
    const id = queue({ scheduledAt: new Date(t0 - 60_000), subject: 'orphan' });
    expect(db.claimScheduledSend(id, new Date(t0 - SCHEDULED_CLAIM_STALE_MS - 1000))).toBe(true);
    const poller = startScheduledSendPoller({ state: db, registry, now: () => t0 });
    await poller.tickNow();
    poller.stop();
    expect(sendCalls).toHaveLength(0);
    const row = db.listScheduledForAccount('acct-1')[0]!;
    expect(row.failReason).toBe(`${OUTCOME_UNKNOWN_PREFIX} (the engine stopped while sending it)`);
  });

  it('a row claimed a moment ago is left alone: its send may still be running', async () => {
    const t0 = Date.now();
    const id = queue({ scheduledAt: new Date(t0 - 60_000), subject: 'busy' });
    expect(db.claimScheduledSend(id, new Date(t0 - 1000))).toBe(true);
    const poller = startScheduledSendPoller({ state: db, registry, now: () => t0 });
    await poller.tickNow();
    poller.stop();
    expect(sendCalls).toHaveLength(0);
    const row = db.listScheduledForAccount('acct-1')[0]!;
    expect(row.failedAt).toBeUndefined();
    expect(row.sentAt).toBeUndefined();
  });

  it('a claimed row does not take a due row\'s place in the tick', async () => {
    const t0 = Date.now();
    const busy = queue({ scheduledAt: new Date(t0 - 120_000), subject: 'busy-first' });
    queue({ scheduledAt: new Date(t0 - 60_000), subject: 'due-second' });
    expect(db.claimScheduledSend(busy, new Date(t0 - 1000))).toBe(true);
    const poller = startScheduledSendPoller({ state: db, registry, now: () => t0, perTickLimit: 1 });
    expect((await poller.tickNow()).fired).toBe(1);
    poller.stop();
    expect(sendCalls.map((c) => c.subject)).toEqual(['due-second']);
  });

  it('a row is claimed once: a second claim, from anywhere, is refused', () => {
    const id = queue({ scheduledAt: new Date(Date.now() - 5000), subject: 'claim' });
    expect(db.claimScheduledSend(id)).toBe(true);
    expect(db.claimScheduledSend(id)).toBe(false);
    db.markScheduledSent(id);
    expect(db.claimScheduledSend(id)).toBe(false);
  });

  it('a row being sent cannot be cancelled', () => {
    const id = queue({ scheduledAt: new Date(Date.now() - 5000), subject: 'cancel' });
    expect(db.claimScheduledSend(id)).toBe(true);
    expect(db.cancelScheduledSend(id)).toBe(false);
    expect(db.listScheduledForAccount('acct-1')).toHaveLength(1);
  });

  it('classifies every failure by whether it proves nothing was sent', () => {
    for (const s of ['invalid_recipients', 'receive_only', 'dedup_window', 'secret_in_body', 'cancelled'] as const) {
      expect(classifyScheduledFailure({ status: s })).toBe('failed');
    }
    expect(classifyScheduledFailure({ status: 'rate_limit' })).toBe('retry');
    for (const c of ['auth_failed', 'rate_limited', 'tls_failed', 'starttls_unavailable'] as const) {
      expect(classifyScheduledFailure({ status: 'provider_error', errorCode: c })).toBe('retry');
    }
    for (const c of ['not_found', 'unsupported'] as const) {
      expect(classifyScheduledFailure({ status: 'provider_error', errorCode: c })).toBe('failed');
    }
    for (const c of ['timeout', 'send_rejected', 'connection_failed', 'unknown', undefined] as const) {
      expect(classifyScheduledFailure({ status: 'provider_error', errorCode: c })).toBe('unknown');
    }
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

  it('coalesces overlapping ticks so a slow tick is not run twice (no double-send)', async () => {
    queue({ scheduledAt: new Date(Date.now() - 5000), subject: 'slow' });

    // Gate the send so the first tick stays in-flight while we fire a second.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    sendImpl = async (input: MailSendInput): Promise<MailSendResult> => {
      sendCalls.push(input);
      await gate;
      return { messageId: '<sent@x>', accepted: input.to.map((a) => a.address), rejected: [] };
    };

    // Spy the due-query: the reentrancy guard must keep it to ONE call even
    // though two ticks overlap (without the guard the second tick re-queries
    // the still-unsent row and re-delivers it).
    const dueSpy = vi.spyOn(db, 'listDueScheduledSends');

    const poller = startScheduledSendPoller({ state: db, registry });
    const first = poller.tickNow(); // starts, blocks inside the gated send
    const second = poller.tickNow(); // must coalesce onto the in-flight tick
    expect(first).toBe(second); // same promise → no second concurrent tick
    release();
    const [r1, r2] = await Promise.all([first, second]);
    poller.stop();

    expect(dueSpy).toHaveBeenCalledTimes(1);
    expect(sendCalls).toHaveLength(1);
    expect(r1).toEqual(r2);
    expect(r1.fired).toBe(1);
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
