import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * The approval queue's executor (PRD unattended-approval-queue §4.8) against a real store over a
 * real engine.db and a fake mail provider that counts what it sends.
 */

import { EngineDb } from './engine-db.js';
import { ApprovalStore, APPROVAL_RETRY_DELAY_MS, APPROVAL_CLAIM_STALE_MS, APPROVAL_MAX_ATTEMPTS, type ApprovalFiling, type MailReplyPayload, type MailSendPayload } from './approval-store.js';
import { ApprovalExecutor, APPROVAL_SEND_DEADLINE_MS } from './approval-executor.js';
import type { AuditEntry, AuditLog } from './audit-log.js';
import { InMemoryMailRegistry } from '../integrations/mail/tools/registry.js';
import { configureMailRateLimits, recordMailSend, resetMailRateLimits } from '../integrations/mail/tools/rate-limit.js';
import type { MailContext } from '../integrations/mail/context.js';
import type {
  MailEnvelope, MailFetchOptions, MailListOptions, MailMessage, MailProvider,
  MailSearchOptions, MailSearchQuery, MailSendInput, MailSendResult, MailWatchHandle,
} from '../integrations/mail/provider.js';

class FakeProvider implements MailProvider {
  readonly accountId: string;
  readonly address: string;
  list = vi.fn(async (_opts?: MailListOptions): Promise<ReadonlyArray<MailEnvelope>> => []);
  fetch = vi.fn(async (_opts: MailFetchOptions): Promise<MailMessage> => { throw new Error('not configured'); });
  search = vi.fn(async (_q: MailSearchQuery, _o?: MailSearchOptions): Promise<ReadonlyArray<MailEnvelope>> => []);
  send = vi.fn(async (_input: MailSendInput): Promise<MailSendResult> => ({ messageId: '<sent@x>', accepted: [], rejected: [] }));
  watch = vi.fn(async (): Promise<MailWatchHandle> => ({ stop: async () => {} }));
  close = vi.fn(async () => {});
  constructor(id: string, address = `${id}@example.com`) { this.accountId = id; this.address = address; }
}

const T0 = Date.parse('2026-10-21T12:00:00Z');
const advance = (ms: number): void => { now += ms; vi.setSystemTime(now); };

let dir: string;
let engine: EngineDb;
let store: ApprovalStore;
let provider: FakeProvider;
let registry: InMemoryMailRegistry;
let mail: MailContext;
let trail: AuditEntry[];
let notes: Array<{ threadId: string; content: unknown }>;
let now: number;
let live: Set<string>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lynox-approval-exec-'));
  engine = new EngineDb(join(dir, 'engine.db'), 'test-vault-key');
  store = new ApprovalStore(engine);
  provider = new FakeProvider('acc-1');
  registry = new InMemoryMailRegistry();
  registry.add(provider);
  registry.setDefault('acc-1');
  mail = {
    registry,
    getAccountConfig: (id: string) => (id === 'acc-1' ? { id, type: 'business' } : null),
    notifyOutboundSent: vi.fn(async () => {}),
  } as unknown as MailContext;
  trail = [];
  notes = [];
  now = T0;
  // The recipient dedup window reads the clock itself, so the clock and `now` move together.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
  live = new Set(['grant-1']);
  resetMailRateLimits();
});

afterEach(() => {
  vi.useRealTimers();
  engine.close();
  rmSync(dir, { recursive: true, force: true });
  resetMailRateLimits();
});

function executor(over: { audit?: AuditLog | null; mail?: MailContext | null } = {}): ApprovalExecutor {
  const audit = over.audit !== undefined ? over.audit : ({ record: (e: AuditEntry) => { trail.push(e); } } as unknown as AuditLog);
  const threads = {
    getThread: (id: string) => (id === 'th-1' ? { id } : undefined),
    getMessageCount: () => 4,
    getNextSeq: () => 4,
    appendDisplayNotes: (threadId: string, rows: Array<{ content: unknown }>) => { for (const r of rows) notes.push({ threadId, content: r.content }); },
    updateThread: () => {},
  };
  return new ApprovalExecutor({
    store,
    mail: () => (over.mail !== undefined ? over.mail : mail),
    audit: () => audit,
    threads: () => threads as never,
    isMandateLive: (id) => live.has(id),
    now: () => now,
  });
}

const sendPayload = (over: Partial<MailSendPayload> = {}): MailSendPayload => ({
  accountId: 'acc-1', fromAddress: 'acc-1@example.com', to: [{ name: 'Bob', address: 'bob@example.com' }], cc: [], bcc: [],
  subject: 'Wochenbericht', bodyText: 'Hier der Bericht.', trackFollowup: null, ...over,
});

const replyPayload = (over: Partial<MailReplyPayload> = {}): MailReplyPayload => ({
  accountId: 'acc-1', fromAddress: 'acc-1@example.com', to: [{ address: 'alice@example.com' }], cc: [],
  subject: 'Re: Angebot', bodyText: 'Danke, passt.', inReplyTo: '<1@x>', references: '<1@x>',
  originalThreadKey: '<1@x>', originalMessageId: '<1@x>', originalFolderUid: 'INBOX:1',
  original: { from: 'alice@example.com', to: ['acc-1@example.com'], cc: [], subject: 'Angebot', date: '2026-10-20T10:00:00Z' },
  ...over,
});

let runN = 0;
/** File an entry and approve it, as the filer and the decide route would. */
function approved(filing: ApprovalFiling, who: { createdBy?: string | null; mandateId?: string | null } = {}): string {
  runN++;
  const out = store.file({
    filing, origin: { source: 'task', triggerId: 'trg-1', runId: `run-${String(runN)}`, rootRunId: `run-${String(runN)}`, threadId: 'th-1' },
    createdBy: who.createdBy ?? 'owner', mandateId: who.mandateId ?? null, now,
  });
  if (!out.ok) throw new Error(`filing refused: ${out.reason}`);
  const entry = store.get(out.id)!;
  const decided = store.decide(out.id, { action: 'approve', checksum: entry.checksum }, 'owner', now);
  if (!decided.ok) throw new Error(`approval refused: ${decided.reason}`);
  // Entries are tried in the order they were approved.
  advance(1_000);
  return out.id;
}

const send = (over: Partial<MailSendPayload> = {}): ApprovalFiling => ({ kind: 'mail_send', payload: sendPayload(over) });
const reply = (over: Partial<MailReplyPayload> = {}): ApprovalFiling => ({ kind: 'mail_reply', payload: replyPayload(over) });
const reason = (id: string): unknown => (JSON.parse(store.get(id)!.resultJson ?? 'null') as { reason?: unknown } | null)?.reason;

describe('the executor sends an approved mail once, as it was filed', () => {
  it('mail_send: one send with the stored recipients and body, done, a trail row on each side, a note in the thread', async () => {
    const id = approved(send({ cc: [{ address: 'carl@example.com' }] }));
    expect(await executor().tick()).toEqual({ id, status: 'done' });
    expect(provider.send).toHaveBeenCalledTimes(1);
    const sent = provider.send.mock.calls[0]![0];
    expect(sent.to).toEqual([{ name: 'Bob', address: 'bob@example.com' }]);
    expect(sent.cc).toEqual([{ address: 'carl@example.com' }]);
    expect(sent.subject).toBe('Wochenbericht');
    expect(sent.text).toBe('Hier der Bericht.');
    expect(store.get(id)!.status).toBe('done');
    expect(trail.map(e => e.phase)).toEqual(['attempt', 'done']);
    expect(trail[0]!.action).toBe('mail_send:send');
    expect(trail[0]!.target).toBe(`approval ${id}: mail_send, 2 recipients, approved by owner`);
    expect(trail[0]!.target).not.toContain('bob@');
    expect(notes).toEqual([{ threadId: 'th-1', content: { _lynox_note: { code: 'approval_sent' } } }]);
    // A second tick has nothing left to send.
    expect(await executor().tick()).toBeNull();
    expect(provider.send).toHaveBeenCalledTimes(1);
  });

  it('mail_reply: one send through the shared commit, threaded on the original, and the inbox reconcile', async () => {
    const id = approved(reply());
    expect(await executor().tick()).toEqual({ id, status: 'done' });
    expect(provider.send).toHaveBeenCalledTimes(1);
    const sent = provider.send.mock.calls[0]![0];
    expect(sent.to).toEqual([{ address: 'alice@example.com' }]);
    expect(sent.inReplyTo).toBe('<1@x>');
    expect(sent.references).toBe('<1@x>');
    expect(mail.notifyOutboundSent).toHaveBeenCalledTimes(1);
    expect(trail[0]!.action).toBe('mail_reply:reply');
  });

  it('mail_send registers the follow-up it was filed with, and writes the sent log', async () => {
    const recordFollowup = vi.fn(() => 'fu-1');
    const recordSentMail = vi.fn();
    (mail as unknown as { stateDb: unknown }).stateDb = { recordFollowup, recordSentMail };
    const id = approved(send({ trackFollowup: { reminder_in_days: 3, reason: 'awaiting reply', type: 'awaiting_reply' } }));
    expect(await executor().tick()).toEqual({ id, status: 'done' });
    expect(recordFollowup).toHaveBeenCalledTimes(1);
    expect(recordFollowup.mock.calls[0]![0]).toMatchObject({ accountId: 'acc-1', reason: 'awaiting reply', type: 'awaiting_reply' });
    expect(recordSentMail).toHaveBeenCalledTimes(1);
  });

  it('control: a mail_send filed without a follow-up registers none', async () => {
    const recordFollowup = vi.fn(() => 'fu-1');
    (mail as unknown as { stateDb: unknown }).stateDb = { recordFollowup, recordSentMail: vi.fn() };
    approved(send());
    await executor().tick();
    expect(recordFollowup).not.toHaveBeenCalled();
  });

  it('a tick that starts while the last one sends does nothing: one entry at a time', async () => {
    approved(send());
    approved(send({ to: [{ address: 'dora@example.com' }] }));
    let release!: () => void;
    provider.send.mockImplementationOnce(() => new Promise<MailSendResult>((r) => { release = () => r({ messageId: '<a@x>', accepted: [], rejected: [] }); }));
    const ex = executor();
    const first = ex.tick();
    await vi.waitFor(() => { expect(provider.send).toHaveBeenCalledTimes(1); });
    expect(await ex.tick()).toBeNull();
    release();
    expect((await first)?.status).toBe('done');
    expect(provider.send).toHaveBeenCalledTimes(1);
  });

  it('a pending entry is not sent: only an approved one is', async () => {
    const out = store.file({
      filing: send(), origin: { source: 'task', triggerId: 't', runId: 'r', rootRunId: 'r' }, createdBy: 'owner', mandateId: null, now,
    });
    expect(out.ok).toBe(true);
    expect(await executor().tick()).toBeNull();
    expect(provider.send).not.toHaveBeenCalled();
  });
});

describe('what the executor checks again before it sends', () => {
  it('a payload changed after filing fails its checksum and is not sent', async () => {
    const id = approved(send());
    const row = engine.getDb().prepare('SELECT payload_json FROM approval_entries WHERE id = ?').get(id) as { payload_json: string };
    const changed = JSON.parse(engine.tryDec(row.payload_json)!) as MailSendPayload;
    changed.to = [{ address: 'mallory@example.com' }];
    // The table refuses an UPDATE of the payload, so the test goes around it as a direct write would.
    engine.getDb().exec('DROP TRIGGER approval_entries_written_once');
    engine.getDb().prepare('UPDATE approval_entries SET payload_json = ? WHERE id = ?').run(engine.enc(JSON.stringify(changed)), id);
    expect(await executor().tick()).toEqual({ id, status: 'failed' });
    expect(provider.send).not.toHaveBeenCalled();
    expect(reason(id)).toBe('checksum');
    expect(notes[0]!.content).toEqual({ _lynox_note: { code: 'approval_failed' } });
  });

  it('a mail a mandate filed is not sent once that mandate has ended', async () => {
    const id = approved(send(), { createdBy: 'mandate:anna@example.com', mandateId: 'grant-1' });
    live.delete('grant-1');
    expect(await executor().tick()).toEqual({ id, status: 'failed' });
    expect(provider.send).not.toHaveBeenCalled();
    expect(reason(id)).toBe('mandate_ended');
  });

  it('control: the same mail of a live mandate is sent', async () => {
    const id = approved(send(), { createdBy: 'mandate:anna@example.com', mandateId: 'grant-1' });
    expect(await executor().tick()).toEqual({ id, status: 'done' });
    expect(provider.send).toHaveBeenCalledTimes(1);
  });

  it('a mandate filer that names no mandate counts as ended', async () => {
    const id = approved(send(), { createdBy: 'mandate:anna@example.com', mandateId: null });
    expect(await executor().tick()).toEqual({ id, status: 'failed' });
    expect(provider.send).not.toHaveBeenCalled();
    expect(reason(id)).toBe('mandate_ended');
  });

  it('an account whose sending address is no longer the one filed is not used', async () => {
    const id = approved(send({ fromAddress: 'old@example.com' }));
    expect(await executor().tick()).toEqual({ id, status: 'failed' });
    expect(provider.send).not.toHaveBeenCalled();
    expect(reason(id)).toBe('account_changed');
  });

  it('an account that is gone is not used', async () => {
    const id = approved(send({ accountId: 'acc-2' }));
    expect(await executor().tick()).toEqual({ id, status: 'failed' });
    expect(provider.send).not.toHaveBeenCalled();
    expect(reason(id)).toBe('account_not_configured');
  });

  it('a mail_reply inside the recipient dedup window waits and goes out after it', async () => {
    const id = approved(reply());
    recordMailSend([{ address: 'alice@example.com' }], 'Re: Angebot');
    expect(await executor().tick()).toEqual({ id, status: 'approved' });
    expect(provider.send).not.toHaveBeenCalled();
    expect(reason(id)).toBe('dedup_window');
    expect(store.get(id)!.heldReason).toBe('retry');
    // Not tried again before the delay, so the window is not met again on the same attempt.
    advance(APPROVAL_RETRY_DELAY_MS - 1);
    expect(await executor().tick()).toBeNull();
    advance(2);
    expect(await executor().tick()).toEqual({ id, status: 'done' });
    expect(provider.send).toHaveBeenCalledTimes(1);
  });

  it('two replies with the same recipients and subject approved together go out one window apart', async () => {
    const first = approved(reply());
    const second = approved(reply({ originalMessageId: '<2@x>', inReplyTo: '<2@x>', originalFolderUid: 'INBOX:2', originalThreadKey: '<2@x>' }));
    expect(await executor().tick()).toEqual({ id: first, status: 'done' });
    expect(await executor().tick()).toEqual({ id: second, status: 'approved' });
    expect(provider.send).toHaveBeenCalledTimes(1);
    advance(60_001);
    expect(await executor().tick()).toEqual({ id: second, status: 'done' });
    expect(provider.send).toHaveBeenCalledTimes(2);
  });

  it('a send that throws ends unknown and is never tried again', async () => {
    const id = approved(reply());
    provider.send.mockRejectedValueOnce(new Error('connection reset after DATA'));
    expect(await executor().tick()).toEqual({ id, status: 'unknown' });
    advance(10 * 60_000);
    expect(await executor().tick()).toBeNull();
    expect(provider.send).toHaveBeenCalledTimes(1);
    expect(notes.at(-1)!.content).toEqual({ _lynox_note: { code: 'approval_unknown' } });
  });

  it('a mail_send whose provider fails ends unknown', async () => {
    const id = approved(send());
    provider.send.mockRejectedValueOnce(new Error('timeout'));
    expect(await executor().tick()).toEqual({ id, status: 'unknown' });
  });

  it('without a trail, a mail the owner\'s run filed goes out without a row', async () => {
    const id = approved(send());
    expect(await executor({ audit: null }).tick()).toEqual({ id, status: 'done' });
    expect(provider.send).toHaveBeenCalledTimes(1);
  });

  it('without a trail, a mail a mandate\'s run filed does not go out', async () => {
    const id = approved(send(), { createdBy: 'mandate:anna@example.com', mandateId: 'grant-1' });
    expect(await executor({ audit: null }).tick()).toEqual({ id, status: 'approved' });
    expect(provider.send).not.toHaveBeenCalled();
    expect(reason(id)).toBe('trail_unavailable');
  });

  it('a trail that cannot take the attempt row stops the send', async () => {
    const id = approved(send());
    const broken = { record: () => { throw new Error('disk full'); } } as unknown as AuditLog;
    expect(await executor({ audit: broken }).tick()).toEqual({ id, status: 'approved' });
    expect(provider.send).not.toHaveBeenCalled();
    expect(reason(id)).toBe('trail_unavailable');
  });

  it('a check that throws before the send settles the entry for another attempt at once', async () => {
    const id = approved(send());
    const ex = new ApprovalExecutor({
      store, mail: () => { throw new Error('mail context broken'); }, audit: () => null, threads: () => null,
      isMandateLive: () => true, now: () => now,
    });
    expect(await ex.tick()).toEqual({ id, status: 'approved' });
    expect(reason(id)).toBe('executor_error');
    expect(provider.send).not.toHaveBeenCalled();
  });

  it('without mail set up nothing is sent and the entry waits', async () => {
    const id = approved(send());
    expect(await executor({ mail: null }).tick()).toEqual({ id, status: 'approved' });
    expect(reason(id)).toBe('mail_unavailable');
  });
});

describe('attempts, the retry delay and the send deadline', () => {
  it('a reply the dedup window keeps refusing ends failed after the last attempt, sent never', async () => {
    const id = approved(reply());
    for (let i = 1; i <= APPROVAL_MAX_ATTEMPTS; i++) {
      recordMailSend([{ address: 'alice@example.com' }], 'Re: Angebot');
      const out = await executor().tick();
      expect(out).toEqual({ id, status: i < APPROVAL_MAX_ATTEMPTS ? 'approved' : 'failed' });
      advance(APPROVAL_RETRY_DELAY_MS);
    }
    expect(provider.send).not.toHaveBeenCalled();
    expect(store.get(id)!.attempts).toBe(APPROVAL_MAX_ATTEMPTS);
  });

  it('a retry waits for the dedup window as configured when it is longer than the default', async () => {
    configureMailRateLimits({ provider: { getToolCallCountSince: () => 0 }, dedupWindowMs: 120_000 });
    const id = approved(reply());
    recordMailSend([{ address: 'alice@example.com' }], 'Re: Angebot');
    expect(await executor().tick()).toEqual({ id, status: 'approved' });
    advance(APPROVAL_RETRY_DELAY_MS + 1);
    expect(await executor().tick()).toBeNull();
    advance(120_000 - APPROVAL_RETRY_DELAY_MS);
    expect(await executor().tick()).toEqual({ id, status: 'done' });
  });

  it('the deadline ends below the sweep\'s stale-claim limit', () => {
    expect(APPROVAL_SEND_DEADLINE_MS).toBeLessThan(APPROVAL_CLAIM_STALE_MS);
  });

  it('a send still running at the deadline ends unknown and is never tried again', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(now);
    const id = approved(send());
    provider.send.mockImplementationOnce(() => new Promise<MailSendResult>(() => {}));
    const pending = executor().tick();
    await vi.advanceTimersByTimeAsync(APPROVAL_SEND_DEADLINE_MS - 1);
    expect(store.get(id)!.status).toBe('executing');
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ id, status: 'unknown' });
    expect(reason(id)).toBe('send_timeout');
    advance(APPROVAL_RETRY_DELAY_MS * 10);
    expect(store.executable(now)).toEqual([]);
  });

  it('an entry whose send had not begun at the deadline waits for another attempt, and its late send is barred', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(now);
    const id = approved(send());
    let answer!: (a: string) => void;
    (provider as unknown as { fromAddress: () => Promise<string> }).fromAddress = () => new Promise<string>((r) => { answer = r; });
    const pending = executor().tick();
    await vi.advanceTimersByTimeAsync(APPROVAL_SEND_DEADLINE_MS);
    expect(await pending).toEqual({ id, status: 'approved' });
    expect(reason(id)).toBe('deadline_before_send');
    // The lookup answers after the deadline: the attempt that was given up does not send.
    answer('acc-1@example.com');
    await vi.advanceTimersByTimeAsync(0);
    expect(provider.send).not.toHaveBeenCalled();
    expect(trail).toEqual([]);
  });

  it('a slow send that ends inside the deadline is done, and leaves no timer behind', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(now);
    const id = approved(send());
    provider.send.mockImplementationOnce(() => new Promise<MailSendResult>((r) => {
      setTimeout(() => r({ messageId: '<slow@x>', accepted: [], rejected: [] }), APPROVAL_SEND_DEADLINE_MS - 1_000);
    }));
    const pending = executor().tick();
    await vi.advanceTimersByTimeAsync(APPROVAL_SEND_DEADLINE_MS - 1_000);
    expect(await pending).toEqual({ id, status: 'done' });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('the send limit', () => {
  it('holds an entry while the limit is reached and sends it once there is room', async () => {
    let calls = 1;
    configureMailRateLimits({ provider: { getToolCallCountSince: () => calls }, hourlyLimit: 2, dailyLimit: 100 });
    const first = approved(send());
    const second = approved(send({ to: [{ address: 'dora@example.com' }] }));
    expect(await executor().tick()).toEqual({ id: first, status: 'done' });
    // One tool call plus the queue's own send fill the hourly limit of 2.
    expect(await executor().tick()).toBeNull();
    expect(store.get(second)!.status).toBe('approved');
    expect(store.get(second)!.heldReason).toBe('send_limit');
    expect(provider.send).toHaveBeenCalledTimes(1);
    calls = 0;
    expect(await executor().tick()).toEqual({ id: second, status: 'done' });
    expect(provider.send).toHaveBeenCalledTimes(2);
  });

  it('a kind the limit holds waits as a whole, stamped, and the other kind goes on', async () => {
    configureMailRateLimits({ provider: { getToolCallCountSince: (tool: string) => (tool === 'mail_send' ? 5 : 0) }, hourlyLimit: 5, dailyLimit: 100 });
    const held = Array.from({ length: 25 }, (_, i) => approved(send({ to: [{ address: `r${String(i)}@example.com` }] })));
    const other = approved(reply());
    expect(await executor().tick()).toEqual({ id: other, status: 'done' });
    // Every entry of the held kind carries the hold, so the claim window does not expire it.
    expect(held.every((id) => store.get(id)!.heldReason === 'send_limit')).toBe(true);
    expect(held.every((id) => store.get(id)!.attempts === 0)).toBe(true);
    expect(provider.send).toHaveBeenCalledTimes(1);
  });

  it('however many entries of a held kind wait in front, the other kind is reached', async () => {
    configureMailRateLimits({ provider: { getToolCallCountSince: (tool: string) => (tool === 'mail_send' ? 5 : 0) }, hourlyLimit: 5, dailyLimit: 1000 });
    for (let i = 0; i < 205; i++) approved(send({ to: [{ address: `r${String(i)}@example.com` }] }));
    const other = approved(reply());
    expect(await executor().tick()).toEqual({ id: other, status: 'done' });
  });

  it('within a kind the oldest approval goes first when the limit frees a place', async () => {
    let calls = 5;
    configureMailRateLimits({ provider: { getToolCallCountSince: () => calls }, hourlyLimit: 5, dailyLimit: 100 });
    const older = approved(send({ subject: 'Älter' }));
    expect(await executor().tick()).toBeNull();
    const newer = approved(send({ subject: 'Neuer' }));
    calls = 4;
    expect(await executor().tick()).toEqual({ id: older, status: 'done' });
    expect(store.get(newer)!.status).toBe('approved');
  });

  it('an entry the limit holds does not stand in front of one of the other kind', async () => {
    configureMailRateLimits({ provider: { getToolCallCountSince: (tool: string) => (tool === 'mail_send' ? 5 : 0) }, hourlyLimit: 5, dailyLimit: 100 });
    const held = approved(send());
    const other = approved(reply());
    expect(await executor().tick()).toEqual({ id: other, status: 'done' });
    expect(store.get(held)!.heldReason).toBe('send_limit');
  });
});
