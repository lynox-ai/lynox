import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MailStateDb } from '../mail/state.js';
import { InboxStateDb } from './state.js';
import { InboxRulesLoader } from './rules-loader.js';
import { buildInboxRunner, type InboxQueuePayload } from './runner.js';
import { DrainedForRestoreError } from './classifier/queue.js';
import { createInboxClassifierHook, type HookQueue } from './watcher-hook.js';
import type { LLMCaller } from './classifier/index.js';
import type { MailAccountConfig, MailEnvelope } from '../mail/provider.js';

// The intake check reads more of a mail than the inbox keeps, so what it found has to stay
// with the item: `inbox_read` withholds a mail by it (PRD inbox-user-rules E10). Every audit a
// sensitive mail ends in names the categories — not only the classified one, also the mail
// that overflowed the queue, failed the classifier or was drained unclassified.

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

afterEach(() => { mail.close(); });

const SENSITIVE = { categories: ['otp_or_2fa'], masked: true, redactionCount: 1 };

function payload(n: number, sensitive: InboxQueuePayload['sensitive'] | null = SENSITIVE): InboxQueuePayload {
  return {
    accountId: 'acct-1',
    threadKey: `imap:t${String(n)}`,
    classifierInput: {
      accountAddress: 'me@acme.example', accountDisplayName: 'Me', subject: 'Code',
      fromAddress: 'noreply@bank.example', fromDisplayName: 'Bank', body: 'Ihr Code lautet ******',
    },
    envelope: {
      fromAddress: 'noreply@bank.example', fromName: undefined, subject: 'Code', mailDate: undefined,
      snippet: undefined, messageId: `<m${String(n)}@x>`, inReplyTo: undefined,
    },
    ...(sensitive !== null && sensitive !== undefined ? { sensitive } : {}),
  };
}

function categoriesOf(itemId: string): unknown {
  const audit = inbox.listAuditForItem(itemId);
  return audit.map((a) => (JSON.parse(a.payloadJson) as Record<string, unknown>)['sensitive_categories']);
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error('waitFor: condition not met');
}

describe('the intake check\'s finding stays in the item\'s audit', () => {
  it('when the classifier fails (dead-letter)', async () => {
    const llm: LLMCaller = vi.fn(async () => { throw new Error('rate_limited'); });
    const queue = buildInboxRunner({ state: inbox, llm, policy: { retryOnce: false } });
    queue.enqueue(payload(1));
    await waitFor(() => inbox.listItems().length === 1);
    await queue.drain();
    const [item] = inbox.listItems();
    expect(item!.classifierVersion).toMatch(/^dead-letter:/);
    expect(categoriesOf(item!.id)).toEqual([['otp_or_2fa']]);
  });

  it('when a migration restore drains it unclassified', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const llm: LLMCaller = vi.fn(async () => { await gate; return JSON.stringify({ bucket: 'auto_handled', confidence: 0.9, one_line_why_de: 'x' }); });
    const queue = buildInboxRunner({ state: inbox, llm, policy: { maxConcurrency: 1 } });
    queue.enqueue(payload(1));
    queue.enqueue(payload(2));
    await waitFor(() => queue.activeCount === 1);
    const drained = queue.drain({ deadLetterPending: new DrainedForRestoreError() });
    await waitFor(() => inbox.listItems().some((i) => i.classifierVersion === 'restore-drain'));
    release();
    await drained;
    const surfaced = inbox.listItems().find((i) => i.classifierVersion === 'restore-drain')!;
    expect(categoriesOf(surfaced.id)).toEqual([['otp_or_2fa']]);
  });

  it('when it is classified, and not when the check found nothing', async () => {
    const llm: LLMCaller = vi.fn(async () => JSON.stringify({ bucket: 'draft_ready', confidence: 0.9, one_line_why_de: 'Bestätigung' }));
    const queue = buildInboxRunner({ state: inbox, llm, policy: { retryOnce: false } });
    queue.enqueue(payload(1));
    queue.enqueue(payload(2, null));
    await waitFor(() => inbox.listItems().length === 2);
    await queue.drain();
    const byThread = new Map(inbox.listItems().map((i) => [i.threadKey, i.id]));
    expect(categoriesOf(byThread.get('imap:t1')!)).toEqual([['otp_or_2fa']]);
    expect(categoriesOf(byThread.get('imap:t2')!)).toEqual([undefined]);
  });

  it('when the queue is full (watcher dead-letter, mask mode)', async () => {
    const fullQueue: HookQueue = { enqueue: vi.fn(() => false) };
    const hook = createInboxClassifierHook({
      state: inbox, rules: new InboxRulesLoader(inbox), queue: fullQueue, sensitiveMode: 'mask',
      accounts: { resolve: () => ({ address: ACCOUNT.address, displayName: ACCOUNT.displayName }) },
    });
    const env: MailEnvelope = {
      uid: 1, messageId: '<m1@x>', folder: 'INBOX', threadKey: 'imap:of', inReplyTo: undefined,
      from: [{ address: 'noreply@bank.example' }], to: [{ address: ACCOUNT.address }], cc: [], replyTo: [],
      subject: 'Ihr Bestätigungscode', date: new Date(), flags: [], snippet: 'Ihr Bestätigungscode lautet 482913',
      hasAttachments: false, attachmentCount: 0, sizeBytes: 0, isAutoReply: false,
    };
    expect(await hook(ACCOUNT.id, env)).toBe('dead_lettered');
    const [item] = inbox.listItems();
    expect(item!.classifierVersion).toBe('queue-overflow');
    expect(categoriesOf(item!.id)).toEqual([['otp_or_2fa']]);
  });
});
