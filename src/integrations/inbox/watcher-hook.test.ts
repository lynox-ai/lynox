import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MailStateDb } from '../mail/state.js';
import { InboxStateDb } from './state.js';
import { InboxRulesLoader } from './rules-loader.js';
import { createInboxClassifierHook, type AccountResolver, type HookQueue } from './watcher-hook.js';
import type { MailAccountConfig, MailEnvelope } from '../mail/provider.js';
import type { InboxQueuePayload } from './runner.js';

const ACCOUNT: MailAccountConfig = {
  id: 'acct-1',
  displayName: 'Rafael (brandfusion)',
  address: 'rafael@brandfusion.ch',
  preset: 'custom',
  imap: { host: 'i', port: 993, secure: true },
  smtp: { host: 's', port: 465, secure: true },
  authType: 'imap',
  type: 'personal',
  isDefault: true,
};

let mail: MailStateDb;
let inbox: InboxStateDb;
let rules: InboxRulesLoader;
let queueCalls: InboxQueuePayload[];
let queue: HookQueue;
let accounts: AccountResolver;

beforeEach(() => {
  mail = new MailStateDb({ path: ':memory:' });
  mail.upsertAccount(ACCOUNT);
  inbox = new InboxStateDb(mail.getConnection());
  rules = new InboxRulesLoader(inbox);
  queueCalls = [];
  queue = {
    enqueue: vi.fn((p: InboxQueuePayload) => {
      queueCalls.push(p);
      return true;
    }),
  };
  accounts = {
    resolve: vi.fn((id: string) =>
      id === ACCOUNT.id ? { address: ACCOUNT.address, displayName: ACCOUNT.displayName } : null,
    ),
  };
});

afterEach(() => {
  mail.close();
});

function envelope(overrides: Partial<MailEnvelope> = {}): MailEnvelope {
  return {
    uid: 1,
    messageId: '<m1@x>',
    folder: 'INBOX',
    threadKey: 'imap:thread-1',
    inReplyTo: undefined,
    from: [{ address: 'roland@war.example', name: 'Roland Beispiel' }],
    to: [{ address: ACCOUNT.address }],
    cc: [],
    replyTo: [],
    subject: 'Termin nächste Woche?',
    date: new Date(),
    flags: [],
    snippet: 'Hi Rafael, hast du Zeit am Mittwoch?',
    hasAttachments: false,
    attachmentCount: 0,
    sizeBytes: 0,
    isAutoReply: false,
    ...overrides,
  };
}

describe('createInboxClassifierHook — enqueue path', () => {
  it('builds a classifier payload from the envelope and enqueues it', async () => {
    const hook = createInboxClassifierHook({ state: inbox, rules, queue, accounts });
    await hook(ACCOUNT.id, envelope());
    expect(queueCalls).toHaveLength(1);
    const payload = queueCalls[0]!;
    expect(payload).toEqual({
      accountId: 'acct-1',
      threadKey: 'imap:thread-1',
      classifierInput: {
        accountAddress: 'rafael@brandfusion.ch',
        accountDisplayName: 'Rafael (brandfusion)',
        subject: 'Termin nächste Woche?',
        fromAddress: 'roland@war.example',
        fromDisplayName: 'Roland Beispiel',
        body: 'Hi Rafael, hast du Zeit am Mittwoch?',
      },
    });
    // No item written yet — queue's onSuccess does that asynchronously.
    expect(inbox.listItems()).toHaveLength(0);
  });

  it('falls back to messageId when threadKey is absent', async () => {
    const hook = createInboxClassifierHook({ state: inbox, rules, queue, accounts });
    await hook(ACCOUNT.id, envelope({ threadKey: undefined }));
    expect(queueCalls[0]?.threadKey).toBe('imap:<m1@x>');
  });

  it('synthesises a key from folder+uid when both threadKey and messageId are absent', async () => {
    const hook = createInboxClassifierHook({ state: inbox, rules, queue, accounts });
    await hook(ACCOUNT.id, envelope({ threadKey: undefined, messageId: undefined, folder: 'Spam', uid: 42 }));
    expect(queueCalls[0]?.threadKey).toBe('imap:Spam:42');
  });
});

describe('createInboxClassifierHook — short-circuit and skip', () => {
  it('skips when the account is unknown', async () => {
    const hook = createInboxClassifierHook({ state: inbox, rules, queue, accounts });
    await hook('unknown', envelope());
    expect(queueCalls).toHaveLength(0);
    expect(inbox.listItems()).toHaveLength(0);
  });

  it('skips when the envelope has no sender', async () => {
    const hook = createInboxClassifierHook({ state: inbox, rules, queue, accounts });
    await hook(ACCOUNT.id, envelope({ from: [] }));
    expect(queueCalls).toHaveLength(0);
  });

  it('skips when the (account, thread) is already classified', async () => {
    const hook = createInboxClassifierHook({ state: inbox, rules, queue, accounts });
    inbox.insertItem({
      accountId: ACCOUNT.id,
      channel: 'email',
      threadKey: 'imap:thread-1',
      bucket: 'requires_user',
      confidence: 0.9,
      reasonDe: 'pre-existing',
      classifiedAt: new Date(),
      classifierVersion: 'haiku-2026-05',
    });
    await hook(ACCOUNT.id, envelope());
    expect(queueCalls).toHaveLength(0);
  });
});

describe('createInboxClassifierHook — rule short-circuit', () => {
  it('writes an item + audit directly when a from-rule matches and skips the queue', async () => {
    inbox.insertRule({
      accountId: ACCOUNT.id,
      matcherKind: 'from',
      matcherValue: 'roland@war.example',
      bucket: 'auto_handled',
      action: 'archive',
      source: 'on_demand',
    });
    const hook = createInboxClassifierHook({ state: inbox, rules, queue, accounts });
    await hook(ACCOUNT.id, envelope());

    expect(queueCalls).toHaveLength(0);
    const items = inbox.listItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      bucket: 'auto_handled',
      confidence: 1,
      reasonDe: 'Regel: from = roland@war.example',
      classifierVersion: expect.stringMatching(/^rule:rul_/),
    });
    const audit = inbox.listAuditForItem(items[0]!.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: 'rule_applied',
      actor: 'rule_engine',
    });
    const auditPayload = JSON.parse(audit[0]!.payloadJson) as Record<string, unknown>;
    expect(auditPayload).toMatchObject({
      matcher_kind: 'from',
      matcher_value: 'roland@war.example',
      action: 'archive',
    });
  });

  it('uses the subject_contains rule when from does not match', async () => {
    inbox.insertRule({
      accountId: ACCOUNT.id,
      matcherKind: 'subject_contains',
      matcherValue: 'invoice',
      bucket: 'auto_handled',
      action: 'mark_read',
      source: 'on_demand',
    });
    const hook = createInboxClassifierHook({ state: inbox, rules, queue, accounts });
    await hook(ACCOUNT.id, envelope({ subject: 'Your INVOICE INV-2026-0042' }));
    expect(queueCalls).toHaveLength(0);
    expect(inbox.listItems()).toHaveLength(1);
  });

  it('falls through to the queue when no rule matches', async () => {
    inbox.insertRule({
      accountId: ACCOUNT.id,
      matcherKind: 'from',
      matcherValue: 'someone-else@x',
      bucket: 'auto_handled',
      action: 'archive',
      source: 'on_demand',
    });
    const hook = createInboxClassifierHook({ state: inbox, rules, queue, accounts });
    await hook(ACCOUNT.id, envelope());
    expect(queueCalls).toHaveLength(1);
    expect(inbox.listItems()).toHaveLength(0);
  });
});
