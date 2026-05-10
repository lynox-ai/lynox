import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MailStateDb } from '../mail/state.js';
import { InboxStateDb } from './state.js';
import { buildInboxRunner, type InboxQueuePayload } from './runner.js';
import type { LLMCaller } from './classifier/index.js';
import type { MailAccountConfig } from '../mail/provider.js';

const ACCOUNT: MailAccountConfig = {
  id: 'acct-1',
  displayName: 'Rafael',
  address: 'rafael@example.com',
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

function payload(overrides: Partial<InboxQueuePayload> = {}): InboxQueuePayload {
  return {
    accountId: 'acct-1',
    threadKey: 'imap:t1',
    classifierInput: {
      accountAddress: 'rafael@example.com',
      accountDisplayName: 'Rafael',
      subject: 'Termin?',
      fromAddress: 'roland@war.example',
      fromDisplayName: 'Roland',
      body: 'Hi Rafael, hast du Zeit?',
    },
    ...overrides,
  };
}

async function waitFor(predicate: () => boolean, iters = 50): Promise<void> {
  for (let i = 0; i < iters; i++) {
    if (predicate()) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error('waitFor: condition not met');
}

describe('buildInboxRunner — happy path', () => {
  it('classifies, persists an inbox_item, and writes an audit entry', async () => {
    const llm: LLMCaller = vi.fn(async () =>
      JSON.stringify({
        bucket: 'requires_user',
        confidence: 0.92,
        one_line_why_de: 'Kunde fragt nach Termin',
      }),
    );
    const queue = buildInboxRunner({ state: inbox, llm });
    queue.enqueue(payload());
    await queue.drain();

    const items = inbox.listItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      accountId: 'acct-1',
      threadKey: 'imap:t1',
      bucket: 'requires_user',
      confidence: 0.92,
      reasonDe: 'Kunde fragt nach Termin',
    });

    const audit = inbox.listAuditForItem(items[0]!.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: 'classified',
      actor: 'classifier',
    });
    const payloadJson = JSON.parse(audit[0]!.payloadJson) as Record<string, unknown>;
    expect(payloadJson).toMatchObject({
      bucket: 'requires_user',
      confidence: 0.92,
      fail_reason: null,
    });
  });

  it('honors classifierVersionOverride for the persisted version stamp', async () => {
    const llm: LLMCaller = vi.fn(async () =>
      JSON.stringify({ bucket: 'auto_handled', confidence: 0.9, one_line_why_de: 'k' }),
    );
    const queue = buildInboxRunner({
      state: inbox,
      llm,
      classifierVersionOverride: 'haiku-canary-1',
    });
    queue.enqueue(payload());
    await queue.drain();
    expect(inbox.listItems()[0]?.classifierVersion).toBe('haiku-canary-1');
  });
});

describe('buildInboxRunner — fail-closed dead-letter', () => {
  it('inserts a requires_user stub and audits the failure when classification fails', async () => {
    const llm: LLMCaller = vi.fn(async () => {
      throw new Error('rate_limited');
    });
    const queue = buildInboxRunner({
      state: inbox,
      llm,
      policy: { retryOnce: false },
    });
    queue.enqueue(payload());
    await waitFor(() => inbox.listItems().length === 1);
    await queue.drain();

    const items = inbox.listItems();
    expect(items).toHaveLength(1);
    expect(items[0]?.bucket).toBe('requires_user');
    expect(items[0]?.confidence).toBe(0);
    expect(items[0]?.classifierVersion).toMatch(/^dead-letter:/);
    expect(items[0]?.reasonDe).toContain('Klassifizierer');

    const audit = inbox.listAuditForItem(items[0]!.id);
    expect(audit).toHaveLength(1);
    const payloadJson = JSON.parse(audit[0]!.payloadJson) as Record<string, unknown>;
    expect(payloadJson['dead_letter']).toBe(true);
    expect(payloadJson['error_message']).toBe('rate_limited');
  });
});

describe('buildInboxRunner — policy passthrough', () => {
  it('forwards maxConcurrency to the underlying queue', () => {
    const llm: LLMCaller = vi.fn(async () => '');
    const queue = buildInboxRunner({
      state: inbox,
      llm,
      policy: { maxConcurrency: 1, maxQueueDepth: 3 },
    });
    expect(queue.enqueue(payload({ threadKey: 'a' }))).toBe(true);
    expect(queue.enqueue(payload({ threadKey: 'b' }))).toBe(true);
    expect(queue.enqueue(payload({ threadKey: 'c' }))).toBe(true);
    expect(queue.enqueue(payload({ threadKey: 'd' }))).toBe(false);
  });
});
