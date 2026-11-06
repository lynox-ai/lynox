import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MailStateDb } from '../mail/state.js';
import { InboxStateDb } from './state.js';
import { buildInboxRunner, type InboxQueuePayload } from './runner.js';
import { HandedOverError } from './classifier/queue.js';
import { bootstrapInbox } from './bootstrap.js';
import type Anthropic from '@anthropic-ai/sdk';
import type { LLMCaller } from './classifier/index.js';
import type { MailAccountConfig } from '../mail/provider.js';

// The inbox rebootstrap on a region switch (`_rebootstrapInboxOnProviderSwitch` in engine.ts) ends
// an old runtime that did not drain in time by handing what it still holds to the new runtime:
// waiting jobs at once, running ones at the cut-off (`HandedOverError`, runner.ts `onDeadLetter`).
// Here two real runners stand for the old and the new runtime on one inbox store.

const ACCOUNT: MailAccountConfig = {
  id: 'acct-1', displayName: 'Me', address: 'me@acme.example', preset: 'custom',
  imap: { host: 'i', port: 993, secure: true }, smtp: { host: 's', port: 465, secure: true },
  authType: 'imap', type: 'personal', isDefault: true,
};

let mail: MailStateDb;
let inbox: InboxStateDb;

beforeEach(() => {
  mail = new MailStateDb({ path: ':memory:' });
  mail.upsertAccount(ACCOUNT);
  inbox = new InboxStateDb(mail.getConnection());
});

afterEach(() => {
  mail.close();
});

function payload(n: number): InboxQueuePayload {
  return {
    accountId: 'acct-1',
    threadKey: `imap:t${String(n)}`,
    classifierInput: {
      accountAddress: 'me@acme.example', accountDisplayName: 'Me', subject: `Termin ${String(n)}?`,
      fromAddress: 'mustermann@example.com', fromDisplayName: 'Max', body: `Hi Me, hast du am ${String(n)}. Zeit?`,
    },
    envelope: { fromAddress: 'mustermann@example.com', subject: `Termin ${String(n)}?`, messageId: `<m${String(n)}@x>` },
  };
}

const OLD_ANSWER = JSON.stringify({ bucket: 'auto_handled', confidence: 0.9, one_line_why_de: 'alt' });
const NEW_ANSWER = JSON.stringify({ bucket: 'requires_user', confidence: 0.9, one_line_why_de: 'neu' });

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error('waitFor: condition not met');
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const rows = (): Array<{ classifier_version: string; reason_de: string; bucket: string; thread_key: string }> =>
  mail.getConnection().prepare('SELECT classifier_version, reason_de, bucket, thread_key FROM inbox_items').all() as Array<{ classifier_version: string; reason_de: string; bucket: string; thread_key: string }>;
const audits = (): number =>
  (mail.getConnection().prepare('SELECT COUNT(*) AS n FROM inbox_audit_log').get() as { n: number }).n;

describe('an old inbox runtime hands what it holds to the new one', () => {
  it('waiting and cut-off jobs are classified by the new runtime, once each, even when the old one answers late', async () => {
    let releaseOld!: () => void;
    const oldGate = new Promise<void>((r) => { releaseOld = r; });
    const oldLlm: LLMCaller = vi.fn(async () => { await oldGate; return OLD_ANSWER; });
    const newLlm: LLMCaller = vi.fn(async () => NEW_ANSWER);
    const oldQueue = buildInboxRunner({ state: inbox, llm: oldLlm });
    const newQueue = buildInboxRunner({ state: inbox, llm: newLlm });
    for (let n = 1; n <= 12; n++) expect(oldQueue.enqueue(payload(n))).toBe(true);
    await waitFor(() => oldQueue.activeCount === 2);

    const now = Date.now();
    const result = await oldQueue.drainWithin({
      classifyUntil: now, cutOffAt: now + 200,
      reason: new HandedOverError((p) => newQueue.enqueue(p as InboxQueuePayload)),
    });
    expect(result).toEqual({ deadLetteredWaiting: 10, cutOffRunning: 2 });
    await newQueue.drain();

    const all = rows();
    expect(all).toHaveLength(12);
    expect(new Set(all.map((r) => r.thread_key)).size).toBe(12);
    expect(all.every((r) => r.bucket === 'requires_user' && !r.classifier_version.startsWith('dead-letter') && r.classifier_version !== 'shutdown-drain')).toBe(true);
    expect(newLlm).toHaveBeenCalledTimes(12);
    expect(oldLlm).toHaveBeenCalledTimes(2);

    // The old runtime answers after the cut-off: dropped, so no second item and no second audit.
    const before = audits();
    releaseOld();
    await sleep(20);
    expect(audits()).toBe(before);
    expect(rows()).toHaveLength(12);
    expect(rows().some((r) => r.bucket === 'auto_handled')).toBe(false);
  });

  it('a job the new runtime does not take is surfaced as a failed classification, not lost', async () => {
    const oldLlm: LLMCaller = vi.fn(async () => new Promise<string>(() => { /* hangs */ }));
    const oldQueue = buildInboxRunner({ state: inbox, llm: oldLlm });
    for (let n = 1; n <= 3; n++) expect(oldQueue.enqueue(payload(n))).toBe(true);
    await waitFor(() => oldQueue.activeCount === 2);

    const now = Date.now();
    await oldQueue.drainWithin({ classifyUntil: now, cutOffAt: now + 100, reason: new HandedOverError(() => false) });
    const all = rows();
    expect(all).toHaveLength(3);
    expect(all.every((r) => r.classifier_version === 'dead-letter:HandedOver' && r.reason_de === 'Klassifizierer-Aufruf fehlgeschlagen — manuell prüfen.')).toBe(true);
  });

  it('a runtime shut down with handOver gives its backlog to the other runtime, and says so', async () => {
    const hung = { messages: { create: vi.fn(async () => new Promise(() => { /* hangs */ })) } } as unknown as Anthropic;
    const answering = { messages: { create: vi.fn(async () => ({ content: [{ type: 'text', text: NEW_ANSWER }], usage: { input_tokens: 1, output_tokens: 1 } })) } } as unknown as Anthropic;
    const oldRuntime = bootstrapInbox({ mailStateDb: mail, anthropicClient: hung });
    const newRuntime = bootstrapInbox({ mailStateDb: mail, anthropicClient: answering });
    for (let n = 1; n <= 4; n++) expect(oldRuntime.queue.enqueue(payload(n))).toBe(true);
    await waitFor(() => oldRuntime.queue.activeCount === 2);
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const now = Date.now();
      await oldRuntime.shutdown({ within: { classifyUntil: now, cutOffAt: now + 100 }, handOver: (p) => newRuntime.queue.enqueue(p) });
      expect(errSpy.mock.calls.some((c) => /inbox classifier replaced: 4 mails queued, 2 handed over waiting, 2 handed over after a cut-off/.test(String(c[0])))).toBe(true);
    } finally {
      errSpy.mockRestore();
    }
    await newRuntime.shutdown();
    const all = rows();
    expect(all).toHaveLength(4);
    expect(all.every((r) => r.bucket === 'requires_user' && !r.classifier_version.startsWith('dead-letter') && r.classifier_version !== 'shutdown-drain')).toBe(true);
  });
});
