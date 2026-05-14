import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MailStateDb } from '../mail/state.js';
import { InboxStateDb } from './state.js';
import { InboxRulesLoader } from './rules-loader.js';
import { createInboxClassifierHook, type AccountResolver, type HookQueue } from './watcher-hook.js';
import type { MailAccountConfig, MailEnvelope } from '../mail/provider.js';
import type { InboxQueuePayload } from './runner.js';

const ACCOUNT: MailAccountConfig = {
  id: 'acct-1',
  displayName: 'Me (Acme)',
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
    from: [{ address: 'mustermann@example.com', name: 'Max Mustermann' }],
    to: [{ address: ACCOUNT.address }],
    cc: [],
    replyTo: [],
    subject: 'Termin nächste Woche?',
    date: new Date(),
    flags: [],
    snippet: 'Hi Me, hast du Zeit am Mittwoch?',
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
    const env = envelope();
    await hook(ACCOUNT.id, env);
    expect(queueCalls).toHaveLength(1);
    const payload = queueCalls[0]!;
    expect(payload).toEqual({
      accountId: 'acct-1',
      channel: 'email',
      threadKey: 'imap:thread-1',
      classifierInput: {
        accountAddress: 'me@acme.example',
        accountDisplayName: 'Me (Acme)',
        subject: 'Termin nächste Woche?',
        fromAddress: 'mustermann@example.com',
        fromDisplayName: 'Max Mustermann',
        body: 'Hi Me, hast du Zeit am Mittwoch?',
      },
      envelope: {
        fromAddress: 'mustermann@example.com',
        fromName: 'Max Mustermann',
        subject: 'Termin nächste Woche?',
        mailDate: env.date,
        snippet: 'Hi Me, hast du Zeit am Mittwoch?',
        messageId: '<m1@x>',
        inReplyTo: undefined,
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

  // Audit K-SR-01: unsnooze_on_reply was schema-+API-supported but never
  // actuated. A reply on a snoozed thread should auto-clear the snooze
  // when the user opted into reply-wake.
  it('auto-unsnoozes on reply when unsnooze_on_reply is set', async () => {
    const itemId = inbox.insertItem({
      accountId: ACCOUNT.id,
      channel: 'email',
      threadKey: 'imap:thread-1',
      bucket: 'requires_user',
      confidence: 0.9,
      reasonDe: 'pre-existing',
      classifiedAt: new Date(),
      classifierVersion: 'haiku-2026-05',
    });
    const future = new Date(Date.now() + 7 * 24 * 60_000 * 60); // 7d out
    inbox.setSnooze(itemId, future, null, /* unsnoozeOnReply */ true);

    // Sanity: row is snoozed before the hook fires.
    expect(inbox.getItem(itemId)?.snoozeUntil).toBeDefined();

    const hook = createInboxClassifierHook({ state: inbox, rules, queue, accounts });
    await hook(ACCOUNT.id, envelope());

    expect(queueCalls).toHaveLength(0); // still short-circuited
    const after = inbox.getItem(itemId);
    expect(after?.snoozeUntil).toBeUndefined(); // ← was cleared
    const audit = inbox.listAuditForItem(itemId);
    expect(audit.map(a => a.action)).toContain('unsnoozed_on_reply');
  });

  it('does NOT auto-unsnooze when unsnooze_on_reply is off', async () => {
    const itemId = inbox.insertItem({
      accountId: ACCOUNT.id,
      channel: 'email',
      threadKey: 'imap:thread-1',
      bucket: 'requires_user',
      confidence: 0.9,
      reasonDe: 'pre-existing',
      classifiedAt: new Date(),
      classifierVersion: 'haiku-2026-05',
    });
    const future = new Date(Date.now() + 7 * 24 * 60_000 * 60);
    inbox.setSnooze(itemId, future, null, /* unsnoozeOnReply */ false);

    const hook = createInboxClassifierHook({ state: inbox, rules, queue, accounts });
    await hook(ACCOUNT.id, envelope());

    expect(inbox.getItem(itemId)?.snoozeUntil).toBeDefined(); // ← preserved
  });
});

describe('createInboxClassifierHook — rule short-circuit', () => {
  it('writes an item + audit directly when a from-rule matches and skips the queue', async () => {
    inbox.insertRule({
      accountId: ACCOUNT.id,
      matcherKind: 'from',
      matcherValue: 'mustermann@example.com',
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
      reasonDe: 'Regel: from = mustermann@example.com',
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
      matcher_value: 'mustermann@example.com',
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

describe('createInboxClassifierHook — sensitive-content pre-filter', () => {
  it('detects an OTP-shaped mail and skips the LLM, audit records the category', async () => {
    const hook = createInboxClassifierHook({ state: inbox, rules, queue, accounts });
    await hook(
      ACCOUNT.id,
      envelope({
        subject: 'Your verification code',
        snippet: 'Bestätigungscode 482917 ist gültig für 5 Minuten.',
      }),
    );
    expect(queueCalls).toHaveLength(0);
    const items = inbox.listItems();
    expect(items).toHaveLength(1);
    expect(items[0]?.bucket).toBe('requires_user');
    expect(items[0]?.classifierVersion).toBe('sensitive-prefilter');
    expect(items[0]?.reasonDe).toContain('OTP/2FA');

    const audit = inbox.listAuditForItem(items[0]!.id);
    expect(audit[0]?.actor).toBe('rule_engine');
    const payloadJson = JSON.parse(audit[0]!.payloadJson) as Record<string, unknown>;
    expect(payloadJson['skipped_llm']).toBe(true);
    expect(payloadJson['sensitive_categories']).toContain('otp_or_2fa');
  });

  it('skips classification for an API-key disclosure', async () => {
    const hook = createInboxClassifierHook({ state: inbox, rules, queue, accounts });
    await hook(
      ACCOUNT.id,
      envelope({ subject: 'API key', snippet: 'Hier dein Key: sk-ant-api03-abcdefghijklmnopqr' }),
    );
    expect(queueCalls).toHaveLength(0);
    expect(inbox.listItems()[0]?.classifierVersion).toBe('sensitive-prefilter');
  });

  it('rule short-circuit takes precedence over the sensitive pre-filter', async () => {
    inbox.insertRule({
      accountId: ACCOUNT.id,
      matcherKind: 'from',
      matcherValue: 'mustermann@example.com',
      bucket: 'auto_handled',
      action: 'archive',
      source: 'on_demand',
    });
    const hook = createInboxClassifierHook({ state: inbox, rules, queue, accounts });
    // Sensitive content present BUT rule matches first → archive path,
    // no sensitive-prefilter audit category.
    await hook(
      ACCOUNT.id,
      envelope({
        subject: 'Your code',
        snippet: 'OTP 482917',
      }),
    );
    const items = inbox.listItems();
    expect(items[0]?.bucket).toBe('auto_handled');
    expect(items[0]?.classifierVersion).toMatch(/^rule:/);
  });
});

describe('createInboxClassifierHook — sensitiveMode = mask', () => {
  it('redacts the OTP digit run and enqueues the masked classifier input', async () => {
    const hook = createInboxClassifierHook({
      state: inbox, rules, queue, accounts, sensitiveMode: 'mask',
    });
    await hook(
      ACCOUNT.id,
      envelope({
        subject: 'Sicherheitscode',
        snippet: 'Bestätigungscode 482917 ist gültig für 5 Minuten.',
      }),
    );
    expect(queueCalls).toHaveLength(1);
    const enqueued = queueCalls[0]!;
    expect(enqueued.classifierInput.body).not.toContain('482917');
    expect(enqueued.classifierInput.body).toContain('[REDACTED:OTP]');
    expect(enqueued.sensitive).toMatchObject({
      categories: ['otp_or_2fa'],
      masked: true,
    });
    expect(enqueued.sensitive!.redactionCount).toBeGreaterThan(0);
  });

  it('falls through to a plain enqueue when nothing is sensitive', async () => {
    const hook = createInboxClassifierHook({
      state: inbox, rules, queue, accounts, sensitiveMode: 'mask',
    });
    await hook(ACCOUNT.id, envelope({ snippet: 'Treffen wir uns am Mittwoch?' }));
    const enqueued = queueCalls[0]!;
    expect(enqueued.sensitive).toBeUndefined();
    expect(enqueued.classifierInput.body).toBe('Treffen wir uns am Mittwoch?');
  });
});

describe('createInboxClassifierHook — folder blacklist + per-account disable', () => {
  it('skips a mail whose folder is in the blacklist (case-insensitive)', async () => {
    const hook = createInboxClassifierHook({
      state: inbox, rules, queue, accounts,
      folderBlacklist: new Set(['Banking', 'Privat']),
    });
    await hook(ACCOUNT.id, envelope({ folder: 'banking' }));
    await hook(ACCOUNT.id, envelope({ folder: 'PRIVAT', threadKey: 'imap:t2' }));
    expect(queueCalls).toHaveLength(0);
    expect(inbox.listItems()).toHaveLength(0);
  });

  it('processes a mail in a folder NOT on the blacklist', async () => {
    const hook = createInboxClassifierHook({
      state: inbox, rules, queue, accounts,
      folderBlacklist: new Set(['Banking']),
    });
    await hook(ACCOUNT.id, envelope({ folder: 'INBOX' }));
    expect(queueCalls).toHaveLength(1);
  });

  it('skips when accountId is in the disabled set', async () => {
    const hook = createInboxClassifierHook({
      state: inbox, rules, queue, accounts,
      disabledAccounts: new Set([ACCOUNT.id]),
    });
    await hook(ACCOUNT.id, envelope());
    expect(queueCalls).toHaveLength(0);
  });
});

describe('createInboxClassifierHook — sensitiveMode = allow', () => {
  it('sends the raw body to the classifier and tags the audit categories', async () => {
    const hook = createInboxClassifierHook({
      state: inbox, rules, queue, accounts, sensitiveMode: 'allow',
    });
    await hook(
      ACCOUNT.id,
      envelope({ subject: 'Sicherheitscode', snippet: 'Code 482917' }),
    );
    expect(queueCalls).toHaveLength(1);
    const enqueued = queueCalls[0]!;
    // Raw — NOT redacted
    expect(enqueued.classifierInput.body).toBe('Code 482917');
    expect(enqueued.classifierInput.subject).toBe('Sicherheitscode');
    // Tagged for audit
    expect(enqueued.sensitive).toEqual({
      categories: ['otp_or_2fa'],
      masked: false,
      redactionCount: 0,
    });
  });
});

describe('createInboxClassifierHook — push notifier wire', () => {
  it('fires notifier on the rule path when the rule lands in requires_user', async () => {
    inbox.insertRule({
      accountId: ACCOUNT.id,
      matcherKind: 'from',
      matcherValue: 'mustermann@example.com',
      bucket: 'requires_user',
      action: 'show',
      source: 'on_demand',
    });
    const notifyNewItem = vi.fn(async () => true);
    const hook = createInboxClassifierHook({
      state: inbox, rules, queue, accounts, notifier: { notifyNewItem },
    });
    await hook(ACCOUNT.id, envelope());
    expect(notifyNewItem).toHaveBeenCalledTimes(1);
    expect(notifyNewItem.mock.calls[0]?.[0]).toMatchObject({ bucket: 'requires_user' });
  });

  it('does NOT fire on the rule path when rule routes to auto_handled', async () => {
    inbox.insertRule({
      accountId: ACCOUNT.id,
      matcherKind: 'from',
      matcherValue: 'mustermann@example.com',
      bucket: 'auto_handled',
      action: 'archive',
      source: 'on_demand',
    });
    const notifyNewItem = vi.fn(async () => true);
    const hook = createInboxClassifierHook({
      state: inbox, rules, queue, accounts, notifier: { notifyNewItem },
    });
    await hook(ACCOUNT.id, envelope());
    expect(notifyNewItem).not.toHaveBeenCalled();
  });

  it('fires notifier on the sensitive-skip path (always lands in requires_user)', async () => {
    const notifyNewItem = vi.fn(async () => true);
    const hook = createInboxClassifierHook({
      state: inbox, rules, queue, accounts, notifier: { notifyNewItem },
    });
    await hook(ACCOUNT.id, envelope({
      subject: 'Your verification code',
      snippet: 'Your one-time code is 123456. Do not share.',
    }));
    expect(queueCalls).toHaveLength(0); // sensitive-skip → no LLM
    expect(notifyNewItem).toHaveBeenCalledTimes(1);
  });
});
