import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MailStateDb } from '../mail/state.js';
import { InboxStateDb } from './state.js';
import { buildInboxRunner, type InboxQueuePayload } from './runner.js';
import { DrainedForRestoreError } from './classifier/queue.js';
import type { LLMCaller } from './classifier/index.js';
import type { InboxNotifier } from './notifier.js';
import type { MailAccountConfig } from '../mail/provider.js';

// A migration restore drains the inbox classifier queue the short way: the mails still waiting are
// surfaced unclassified, under their own reason, and the classifier is not asked about them. Every
// other drain classifies the backlog. See classifier/queue.ts (`drain`) and runner.ts (`onDeadLetter`).

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

/** An LLM that answers only once `release` is called, so the running jobs stay running. */
function heldLlm(): { llm: LLMCaller; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const llm: LLMCaller = vi.fn(async () => {
    await gate;
    return JSON.stringify({ bucket: 'auto_handled', confidence: 0.9, one_line_why_de: 'Newsletter' });
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

const rows = (): Array<{ classifier_version: string; reason_de: string; bucket: string; thread_key: string }> =>
  mail.getConnection().prepare('SELECT classifier_version, reason_de, bucket, thread_key FROM inbox_items').all() as Array<{ classifier_version: string; reason_de: string; bucket: string; thread_key: string }>;
const bodyOf = (threadKey: string): string | null =>
  (mail.getConnection().prepare('SELECT body_md FROM inbox_thread_messages WHERE thread_key = ?').get(threadKey) as { body_md: string | null } | undefined)?.body_md ?? null;

describe('inbox queue drained for a migration restore', () => {
  it('surfaces the 100 waiting mails unclassified under their own reason, without asking the classifier', async () => {
    const { llm, release } = heldLlm();
    const notifyNewItem = vi.fn(async () => undefined);
    const queue = buildInboxRunner({ state: inbox, llm, notifier: { notifyNewItem } as unknown as InboxNotifier });
    for (let n = 1; n <= 102; n++) expect(queue.enqueue(payload(n))).toBe(true);
    await waitFor(() => queue.activeCount === 2);

    const drained = queue.drain({ deadLetterPending: new DrainedForRestoreError() });
    // The waiting ones are surfaced before the running ones finish.
    await waitFor(() => rows().filter((r) => r.classifier_version === 'restore-drain').length === 100);
    release();
    await drained;

    const all = rows();
    const surfaced = all.filter((r) => r.classifier_version === 'restore-drain');
    expect(surfaced).toHaveLength(100);
    expect(new Set(surfaced.map((r) => r.reason_de))).toEqual(new Set(['Wegen der Migration nicht klassifiziert — manuell prüfen.']));
    expect(surfaced.every((r) => r.bucket === 'requires_user')).toBe(true);
    // The mail's content goes with it.
    expect(bodyOf(surfaced[0]!.thread_key)).toMatch(/^Hi Me, hast du am \d+\. Zeit\?$/);
    // Only the two that were running asked the classifier, and they were classified.
    expect(llm).toHaveBeenCalledTimes(2);
    expect(all.filter((r) => r.classifier_version !== 'restore-drain')).toHaveLength(2);
    // No notification per surfaced mail; the process restarts right after the restore.
    expect(notifyNewItem).not.toHaveBeenCalled();
  });

  it('a plain drain still classifies every waiting mail', async () => {
    const { llm, release } = heldLlm();
    const queue = buildInboxRunner({ state: inbox, llm });
    for (let n = 1; n <= 6; n++) expect(queue.enqueue(payload(n))).toBe(true);
    await waitFor(() => queue.activeCount === 2);

    const drained = queue.drain();
    release();
    await drained;

    expect(llm).toHaveBeenCalledTimes(6);
    expect(rows().filter((r) => r.classifier_version === 'restore-drain')).toEqual([]);
    expect(rows()).toHaveLength(6);
  });
});
