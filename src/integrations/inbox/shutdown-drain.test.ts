import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MailStateDb } from '../mail/state.js';
import { InboxStateDb } from './state.js';
import { buildInboxRunner, type InboxQueuePayload } from './runner.js';
import { DrainedForShutdownError } from './classifier/queue.js';
import type { LLMCaller } from './classifier/index.js';
import type { InboxNotifier } from './notifier.js';
import type { MailAccountConfig } from '../mail/provider.js';

// A shutdown on a signal drains the inbox classifier queue within a deadline: jobs are classified
// until the classify deadline, the ones still waiting are then surfaced unclassified, and the
// running ones are cut off at the cut-off. See classifier/queue.ts (`drainWithin`) and runner.ts
// (`onDeadLetter`). The real signal and the container's kill are in shutdown-sigterm.test.ts.

const ACCOUNT: MailAccountConfig = {
  id: 'acct-1',
  displayName: 'Me',
  address: 'me@acme.example',
  preset: 'custom',
  imap: { host: 'i', port: 993, secure: true },
  smtp: { host: 's', port: 465, secure: true },
  authType: 'imap',
  type: 'personal',
  isDefault: true,
};

const SURFACED_REASON = 'Beim Herunterfahren nicht klassifiziert — manuell prüfen.';

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
      accountAddress: 'me@acme.example',
      accountDisplayName: 'Me',
      subject: `Termin ${String(n)}?`,
      fromAddress: 'mustermann@example.com',
      fromDisplayName: 'Max',
      body: `Hi Me, hast du am ${String(n)}. Zeit?`,
    },
    envelope: { fromAddress: 'mustermann@example.com', subject: `Termin ${String(n)}?`, messageId: `<m${String(n)}@x>` },
  };
}

const ANSWER = JSON.stringify({ bucket: 'auto_handled', confidence: 0.9, one_line_why_de: 'Newsletter' });

/** An LLM that answers only once `release` is called and ignores its abort signal, as a hung provider does. */
function heldLlm(): { llm: LLMCaller; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const llm: LLMCaller = vi.fn(async () => {
    await gate;
    return ANSWER;
  });
  return { llm, release };
}

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
const surfaced = (): number => rows().filter((r) => r.classifier_version === 'shutdown-drain').length;
const audits = (): number =>
  (mail.getConnection().prepare('SELECT COUNT(*) AS n FROM inbox_audit_log').get() as { n: number }).n;

describe('inbox queue drained within a shutdown deadline', () => {
  it('surfaces the waiting mails at the classify deadline and the hung running ones at the cut-off', async () => {
    const { llm, release } = heldLlm();
    const notifyNewItem = vi.fn(async () => undefined);
    const queue = buildInboxRunner({ state: inbox, llm, notifier: { notifyNewItem } as unknown as InboxNotifier });
    for (let n = 1; n <= 12; n++) expect(queue.enqueue(payload(n))).toBe(true);
    await waitFor(() => queue.activeCount === 2);

    const now = Date.now();
    const done = queue.drainWithin({ classifyUntil: now + 100, cutOffAt: now + 600, reason: new DrainedForShutdownError() });
    // Between the two deadlines: the ten waiting are surfaced, the two running are still running.
    await sleep(300);
    expect(surfaced()).toBe(10);
    expect(queue.activeCount).toBe(2);

    expect(await done).toEqual({ deadLetteredWaiting: 10, cutOffRunning: 2 });
    const all = rows();
    expect(all).toHaveLength(12);
    expect(all.every((r) => r.classifier_version === 'shutdown-drain' && r.bucket === 'requires_user')).toBe(true);
    expect(new Set(all.map((r) => r.reason_de))).toEqual(new Set([SURFACED_REASON]));
    expect(llm).toHaveBeenCalledTimes(2);
    expect(notifyNewItem).not.toHaveBeenCalled();

    // The provider answering after the cut-off changes nothing: the answer is dropped.
    const before = audits();
    release();
    await sleep(20);
    expect(audits()).toBe(before);
    expect(surfaced()).toBe(12);
  });

  it('a running job whose answer arrives before the cut-off is classified, not surfaced', async () => {
    const { llm, release } = heldLlm();
    const queue = buildInboxRunner({ state: inbox, llm });
    for (let n = 1; n <= 12; n++) expect(queue.enqueue(payload(n))).toBe(true);
    await waitFor(() => queue.activeCount === 2);

    const now = Date.now();
    const done = queue.drainWithin({ classifyUntil: now + 100, cutOffAt: now + 2_000, reason: new DrainedForShutdownError() });
    await sleep(300);
    release();

    expect(await done).toEqual({ deadLetteredWaiting: 10, cutOffRunning: 0 });
    expect(surfaced()).toBe(10);
    expect(rows().filter((r) => r.classifier_version !== 'shutdown-drain')).toHaveLength(2);
    expect(llm).toHaveBeenCalledTimes(2);
  });

  it('a backlog classified before the classify deadline surfaces nothing', async () => {
    const llm: LLMCaller = vi.fn(async () => ANSWER);
    const queue = buildInboxRunner({ state: inbox, llm });
    for (let n = 1; n <= 6; n++) expect(queue.enqueue(payload(n))).toBe(true);

    const now = Date.now();
    expect(await queue.drainWithin({ classifyUntil: now + 2_000, cutOffAt: now + 4_000, reason: new DrainedForShutdownError() }))
      .toEqual({ deadLetteredWaiting: 0, cutOffRunning: 0 });
    expect(llm).toHaveBeenCalledTimes(6);
    expect(rows()).toHaveLength(6);
    expect(surfaced()).toBe(0);
  });
});
