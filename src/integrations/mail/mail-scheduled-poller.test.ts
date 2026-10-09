import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MailError, type MailProvider, type MailSendInput, type MailSendResult, type MailAccountConfig } from './provider.js';
import { startScheduledSendPoller, classifyScheduledFailure, OUTCOME_UNKNOWN_PREFIX, SCHEDULED_CLAIM_STALE_MS } from './mail-scheduled-poller.js';
import { MailStateDb } from './state.js';
import type { MailRegistry } from './tools/registry.js';

let db: MailStateDb;
let sendCalls: MailSendInput[];
let provider: MailProvider;
let registry: MailRegistry;
/** Answers from the same DB the rows live in, like the engine's MailContext. */
const accounts = { getAccountConfig: (id: string) => db.getAccount(id) };
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
  it('sends nothing from a receive-only account — the same refusal as an immediate send', async () => {
    db.upsertAccount({ ...ACCOUNT, type: 'info' });
    queue({ scheduledAt: new Date(Date.now() - 5000), subject: 'receive-only probe' });
    const poller = startScheduledSendPoller({ state: db, registry, accounts });
    const result = await poller.tickNow();
    poller.stop();
    expect(sendCalls).toHaveLength(0);
    expect(result).toEqual({ fired: 0, failed: 1 });
    expect(db.listScheduledForAccount('acct-1')[0]!.failReason).toMatch(/receive_only/);
  });

  it('sends from the same account once its type allows sending', async () => {
    // The positive half: without it the test above also passes against a
    // poller that sends nothing at all. Its own subject: the recipient dedup
    // window is process-wide and would otherwise refuse a later test's send.
    queue({ scheduledAt: new Date(Date.now() - 5000), subject: 'send-capable probe' });
    const poller = startScheduledSendPoller({ state: db, registry, accounts });
    const result = await poller.tickNow();
    poller.stop();
    expect(sendCalls).toHaveLength(1);
    expect(result.fired).toBe(1);
  });

  it('fires a due send + marks sent_at', async () => {
    const past = new Date(Date.now() - 5000);
    const id = queue({ scheduledAt: past });
    const poller = startScheduledSendPoller({ state: db, registry, accounts });
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
    const poller = startScheduledSendPoller({ state: db, registry, accounts });
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
    const poller = startScheduledSendPoller({ state: db, registry, accounts });
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
      const poller = startScheduledSendPoller({ state: db, registry, accounts });
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
    const poller = startScheduledSendPoller({ state: db, registry, accounts });
    expect((await poller.tickNow()).failed).toBe(1);
    poller.stop();
    expect(tries).toBe(1);
    expect(db.listScheduledForAccount('acct-1')[0]!.failReason).toMatch(/^send failed, nothing was sent: provider_error/);
  });

  it('a refusal decided before the provider is marked failed at once, and nothing reaches the provider', async () => {
    db.insertScheduledSend({ accountId: 'acct-1', to: [], subject: 'nobody', bodyMd: 'x', scheduledAt: new Date(Date.now() - 5000) });
    const poller = startScheduledSendPoller({ state: db, registry, accounts });
    expect((await poller.tickNow()).failed).toBe(1);
    poller.stop();
    expect(sendCalls).toHaveLength(0);
    expect(db.listScheduledForAccount('acct-1')[0]!.failReason).toMatch(/^send failed, nothing was sent: invalid_recipients/);
  });

  it('a throw out of the send pipeline is not retried: it may come after the mail went out', async () => {
    queue({ scheduledAt: new Date(Date.now() - 5000), subject: 'throws' });
    registry = { ...registry, get: () => { throw new Error('registry broke'); }, getDefault: () => { throw new Error('registry broke'); } } as unknown as MailRegistry;
    const poller = startScheduledSendPoller({ state: db, registry, accounts });
    expect((await poller.tickNow()).failed).toBe(1);
    await poller.tickNow();
    poller.stop();
    expect(db.listScheduledForAccount('acct-1')[0]!.failReason?.startsWith(OUTCOME_UNKNOWN_PREFIX)).toBe(true);
  });

  it('two pollers that both read a row as due send it once: the second loses the claim', async () => {
    queue({ scheduledAt: new Date(Date.now() - 5000), subject: 'race' });
    // The second poller's view of the due list is taken BEFORE the first claims — the
    // interleaving two processes on one file can produce, forced here.
    const snapshot = db.listDueScheduledSends(new Date(), 25);
    expect(snapshot).toHaveLength(1);
    const stateB = Object.create(db, { listDueScheduledSends: { value: () => snapshot } }) as MailStateDb;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    sendImpl = async (input) => { sendCalls.push(input); await gate; return { messageId: '<m@x>', accepted: ['recipient@x'], rejected: [] }; };
    const a = startScheduledSendPoller({ state: db, registry, accounts });
    const b = startScheduledSendPoller({ state: stateB, registry, accounts });
    const first = a.tickNow();
    const secondResult = await b.tickNow();
    release();
    const firstResult = await first;
    a.stop(); b.stop();
    expect(sendCalls).toHaveLength(1);
    expect([firstResult.fired, secondResult.fired]).toEqual([1, 0]);
    expect(secondResult.failed).toBe(0);
  });

  it('a send that outlives its claim and then succeeds is recorded as sent, not as possibly sent', async () => {
    const t0 = Date.now();
    queue({ scheduledAt: new Date(t0 - 60_000), subject: 'slow-outlives-claim' });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    sendImpl = async (input) => { sendCalls.push(input); await gate; return { messageId: '<m@x>', accepted: ['recipient@x'], rejected: [] }; };
    const a = startScheduledSendPoller({ state: db, registry, accounts, now: () => t0 });
    const first = a.tickNow();
    await vi.waitFor(() => expect(sendCalls).toHaveLength(1));
    // Another tick, past the stale limit, reports the row as possibly sent…
    const later = startScheduledSendPoller({ state: db, registry, accounts, now: () => t0 + SCHEDULED_CLAIM_STALE_MS + 60_000 });
    await later.tickNow();
    expect(db.listScheduledForAccount('acct-1')[0]!.failReason?.startsWith(OUTCOME_UNKNOWN_PREFIX)).toBe(true);
    // …and then the send comes back: it went out.
    release();
    await first;
    a.stop(); later.stop();
    const row = db.listScheduledForAccount('acct-1')[0]!;
    expect(row.sentAt).toBeInstanceOf(Date);
    expect(row.failedAt).toBeUndefined();
    expect(row.failReason).toBeUndefined();
    expect(sendCalls).toHaveLength(1);
  });

  it('cancel stops only a pending send: not a failed row, which may record a mail that went out', async () => {
    const pending = queue({ scheduledAt: new Date(Date.now() + 60_000), subject: 'pending' });
    const failed = queue({ scheduledAt: new Date(Date.now() - 5000), subject: 'possibly-sent' });
    sendImpl = async () => { throw new MailError('timeout', 'SMTP timeout'); };
    const poller = startScheduledSendPoller({ state: db, registry, accounts });
    await poller.tickNow();
    poller.stop();
    expect(db.cancelScheduledSend(failed)).toBe(false);
    expect(db.cancelScheduledSend(pending)).toBe(true);
    expect(db.listScheduledForAccount('acct-1').map((r) => r.subject)).toEqual(['possibly-sent']);
  });

  it('a row that failed before claims existed (no sending_at) is not cancelled either', () => {
    // A row failed by a pre-v17 engine carries no claim; only failed_at says it is not pending.
    const id = queue({ scheduledAt: new Date(Date.now() - 5000), subject: 'failed-before-v17' });
    expect(db.markScheduledFailed(id, 'send failed after 3 attempts: provider_error — x')).toBe(true);
    expect(db.cancelScheduledSend(id)).toBe(false);
  });

  it('a row reported as stuck is not cancelled: its send may still be running', () => {
    const t0 = Date.now();
    const id = queue({ scheduledAt: new Date(t0 - 60_000), subject: 'stuck' });
    expect(db.claimScheduledSend(id, new Date(t0 - SCHEDULED_CLAIM_STALE_MS - 1000))).toBe(true);
    db.failStaleScheduledSends(new Date(t0 - SCHEDULED_CLAIM_STALE_MS), 'stuck');
    expect(db.cancelScheduledSend(id)).toBe(false);
  });

  it('keeps at most 200 characters of a provider message in the reason', async () => {
    queue({ scheduledAt: new Date(Date.now() - 5000), subject: 'long' });
    sendImpl = async () => { throw new MailError('send_rejected', 'x'.repeat(5000)); };
    const poller = startScheduledSendPoller({ state: db, registry, accounts });
    await poller.tickNow();
    poller.stop();
    const reason = db.listScheduledForAccount('acct-1')[0]!.failReason!;
    // The kept text is `send_rejected: xxx…` cut at 200 characters, then the ellipsis.
    const kept = reason.slice(reason.indexOf('(') + 1, -1);
    expect(kept).toBe(`provider_error: ${`send_rejected: ${'x'.repeat(5000)}`.slice(0, 200)}…`);
  });

  it('a row a stopped process left claimed is reported as possibly sent, not sent again', async () => {
    const t0 = Date.now();
    const id = queue({ scheduledAt: new Date(t0 - 60_000), subject: 'orphan' });
    expect(db.claimScheduledSend(id, new Date(t0 - SCHEDULED_CLAIM_STALE_MS - 1000))).toBe(true);
    const poller = startScheduledSendPoller({ state: db, registry, accounts, now: () => t0 });
    await poller.tickNow();
    poller.stop();
    expect(sendCalls).toHaveLength(0);
    const row = db.listScheduledForAccount('acct-1')[0]!;
    expect(row.failReason).toBe(`${OUTCOME_UNKNOWN_PREFIX} (the send did not finish within 15 minutes; the engine may have stopped)`);
  });

  it('a row claimed a moment ago is left alone: its send may still be running', async () => {
    const t0 = Date.now();
    const id = queue({ scheduledAt: new Date(t0 - 60_000), subject: 'busy' });
    expect(db.claimScheduledSend(id, new Date(t0 - 1000))).toBe(true);
    const poller = startScheduledSendPoller({ state: db, registry, accounts, now: () => t0 });
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
    const poller = startScheduledSendPoller({ state: db, registry, accounts, now: () => t0, perTickLimit: 1 });
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
    const poller = startScheduledSendPoller({ state: db, registry, accounts });
    const result = await poller.tickNow();
    poller.stop();
    expect(result.fired).toBe(0);
    expect(sendCalls).toHaveLength(0);
  });

  it('respects perTickLimit + leaves overflow for next tick', async () => {
    for (let i = 0; i < 5; i++) queue({ scheduledAt: new Date(Date.now() - 5000), subject: `s${i}` });
    const poller = startScheduledSendPoller({ state: db, registry, accounts, perTickLimit: 2 });
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

    const poller = startScheduledSendPoller({ state: db, registry, accounts });
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

// The classification treats `send_rejected` as "may have been sent" because SMTP maps every
// send error it cannot place — a connection lost in the middle of the transfer included — to
// it. That premise lives in the provider; this holds it there.
describe('wrapSmtpError — what a lost connection during a send becomes', () => {
  it('a connection lost mid-send is send_rejected (outcome unknown), a timeout is timeout', async () => {
    const { wrapSmtpError } = await import('./providers/imap-smtp.js');
    expect(wrapSmtpError(new Error('Connection closed unexpectedly'), 'send').code).toBe('send_rejected');
    expect(wrapSmtpError(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }), 'send').code).toBe('send_rejected');
    expect(wrapSmtpError(Object.assign(new Error('Timeout'), { code: 'ETIMEDOUT', command: 'CONN' }), 'send').code).toBe('timeout');
    expect(classifyScheduledFailure({ status: 'provider_error', errorCode: wrapSmtpError(new Error('Connection closed unexpectedly'), 'send').code })).toBe('unknown');
  });
});
