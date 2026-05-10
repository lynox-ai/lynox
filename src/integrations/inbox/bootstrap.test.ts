import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { MailStateDb } from '../mail/state.js';
import { bootstrapInbox } from './bootstrap.js';
import type { CRM } from '../../core/crm.js';
import type { MailAccountConfig, MailEnvelope } from '../mail/provider.js';

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

beforeEach(() => {
  mail = new MailStateDb({ path: ':memory:' });
  mail.upsertAccount(ACCOUNT);
});

afterEach(() => {
  mail.close();
});

function makeClient(reply: { content: ReadonlyArray<{ type: string; text?: string }>; usage?: { input_tokens: number; output_tokens: number } }): Anthropic {
  return {
    messages: {
      create: vi.fn(async () => reply),
    },
  } as unknown as Anthropic;
}

function envelope(overrides: Partial<MailEnvelope> = {}): MailEnvelope {
  return {
    uid: 1,
    messageId: '<m1@x>',
    folder: 'INBOX',
    threadKey: 'imap:t1',
    inReplyTo: undefined,
    from: [{ address: 'roland@war.example', name: 'Roland' }],
    to: [{ address: 'rafael@example.com' }],
    cc: [],
    replyTo: [],
    subject: 'Termin?',
    date: new Date(),
    flags: [],
    snippet: 'Hi Rafael',
    hasAttachments: false,
    attachmentCount: 0,
    sizeBytes: 0,
    isAutoReply: false,
    ...overrides,
  };
}

describe('bootstrapInbox — wiring', () => {
  it('returns a runtime bundle with all parts populated', () => {
    const client = makeClient({ content: [{ type: 'text', text: '{}' }] });
    const runtime = bootstrapInbox({ mailStateDb: mail, anthropicClient: client });
    expect(runtime.state).toBeDefined();
    expect(runtime.rules).toBeDefined();
    expect(runtime.budget).toBeDefined();
    expect(runtime.queue).toBeDefined();
    expect(runtime.hook).toBeInstanceOf(Function);
    expect(runtime.contactResolver).toBeNull(); // no CRM provided
  });

  it('attaches the contact resolver when a CRM is provided', () => {
    const client = makeClient({ content: [{ type: 'text', text: '{}' }] });
    const crm = { findContact: vi.fn(), getInteractions: vi.fn() } as unknown as CRM;
    const runtime = bootstrapInbox({ mailStateDb: mail, anthropicClient: client, crm });
    expect(runtime.contactResolver).not.toBeNull();
  });

  it('end-to-end: hook + queue + classifier + state writes an inbox_item with audit', async () => {
    const client = makeClient({
      content: [{ type: 'text', text: JSON.stringify({
        bucket: 'requires_user',
        confidence: 0.9,
        one_line_why_de: 'Kunde fragt nach Termin',
      }) }],
      usage: { input_tokens: 500, output_tokens: 80 },
    });
    const runtime = bootstrapInbox({ mailStateDb: mail, anthropicClient: client });
    await runtime.hook(ACCOUNT.id, envelope());
    await runtime.shutdown();

    const items = runtime.state.listItems();
    expect(items).toHaveLength(1);
    expect(items[0]?.bucket).toBe('requires_user');
    expect(items[0]?.reasonDe).toBe('Kunde fragt nach Termin');

    const audit = runtime.state.listAuditForItem(items[0]!.id);
    expect(audit[0]?.action).toBe('classified');

    // Budget reflects SDK-reported usage via the onUsage hook closure
    const snap = runtime.budget.snapshot();
    expect(snap.spentUSD).toBeGreaterThan(0);
  });

  it('rule short-circuit bypasses the LLM call entirely', async () => {
    const create = vi.fn(async () => ({ content: [{ type: 'text', text: '{}' }] }));
    const client = { messages: { create } } as unknown as Anthropic;
    const runtime = bootstrapInbox({ mailStateDb: mail, anthropicClient: client });
    runtime.state.insertRule({
      accountId: ACCOUNT.id,
      matcherKind: 'from',
      matcherValue: 'roland@war.example',
      bucket: 'auto_handled',
      action: 'archive',
      source: 'on_demand',
    });
    await runtime.hook(ACCOUNT.id, envelope());
    await runtime.shutdown();
    expect(create).not.toHaveBeenCalled();
    expect(runtime.state.listItems()[0]?.bucket).toBe('auto_handled');
  });

  it('shutdown drains the queue without throwing on an empty runtime', async () => {
    const client = makeClient({ content: [{ type: 'text', text: '{}' }] });
    const runtime = bootstrapInbox({ mailStateDb: mail, anthropicClient: client });
    await runtime.shutdown();
  });
});
