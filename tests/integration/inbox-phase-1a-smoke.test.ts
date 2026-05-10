// === Inbox Phase 1a smoke ===
//
// End-to-end verification of the bootstrap → hook → queue → state →
// API handler chain with the `unified-inbox` flag turned on. Stubs the
// Anthropic client so it runs without network or API keys but exercises
// every wire that engine.ts hooks together at startup.
//
// Two scenarios:
//   1. Rule short-circuit: a user-confirmed rule matches the inbound
//      mail; no LLM call, item lands in inbox_items via the rule
//      engine path with audit('rule_applied').
//   2. Classifier path: no rule matches; queue runs the stub LLM,
//      onSuccess writes the item + audit('classified'). API handlers
//      can then list / get / set-action / audit-log the item.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import {
  handleGetCounts,
  handleGetItem,
  handleListItemAudit,
  handleListItems,
  handleSetAction,
} from '../../src/integrations/inbox/api.js';
import { bootstrapInbox, type InboxRuntime } from '../../src/integrations/inbox/bootstrap.js';
import { MailStateDb } from '../../src/integrations/mail/state.js';
import type { MailAccountConfig, MailEnvelope } from '../../src/integrations/mail/provider.js';

const ACCOUNT: MailAccountConfig = {
  id: 'acct-smoke',
  displayName: 'Me (Acme)',
  address: 'me@acme.example',
  preset: 'custom',
  imap: { host: 'i', port: 993, secure: true },
  smtp: { host: 's', port: 465, secure: true },
  authType: 'imap',
  type: 'business',
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

function envelope(overrides: Partial<MailEnvelope> = {}): MailEnvelope {
  return {
    uid: 1,
    messageId: '<m1@example.com>',
    folder: 'INBOX',
    threadKey: 'imap:thread-smoke',
    inReplyTo: undefined,
    from: [{ address: 'mustermann@example.com', name: 'Max Mustermann' }],
    to: [{ address: 'me@acme.example' }],
    cc: [],
    replyTo: [],
    subject: 'Termin nächste Woche?',
    date: new Date('2026-05-10T09:00:00Z'),
    flags: [],
    snippet: 'Hi Me, hast du Zeit am Mittwoch für ein Strategiegespräch?',
    hasAttachments: false,
    attachmentCount: 0,
    sizeBytes: 1024,
    isAutoReply: false,
    ...overrides,
  };
}

function stubClient(replyText: string, usage = { input_tokens: 612, output_tokens: 88 }): Anthropic {
  return {
    messages: {
      create: vi.fn(async () => ({
        content: [{ type: 'text', text: replyText }],
        usage,
      })),
    },
  } as unknown as Anthropic;
}

async function settle(runtime: InboxRuntime, predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (predicate()) return;
    await new Promise((r) => setImmediate(r));
  }
  await runtime.shutdown();
  throw new Error('settle: predicate never true');
}

describe('Inbox Phase 1a — end-to-end smoke', () => {
  it('classifier path: hook -> queue -> classify -> insert -> audit -> API list', async () => {
    const client = stubClient(
      JSON.stringify({
        bucket: 'requires_user',
        confidence: 0.92,
        one_line_why_de: 'Kunde fragt nach Strategie-Termin am Mittwoch',
      }),
    );
    const runtime = bootstrapInbox({ mailStateDb: mail, anthropicClient: client });
    expect(runtime).toBeDefined();
    expect(runtime.queue.depth).toBe(0);

    await runtime.hook(ACCOUNT.id, envelope());
    await settle(runtime, () => runtime.state.listItems().length === 1);
    await runtime.shutdown();

    // State chain
    const items = runtime.state.listItems();
    expect(items).toHaveLength(1);
    expect(items[0]?.bucket).toBe('requires_user');
    expect(items[0]?.confidence).toBe(0.92);
    expect(items[0]?.reasonDe).toBe('Kunde fragt nach Strategie-Termin am Mittwoch');
    expect(items[0]?.classifierVersion).toMatch(/^haiku-/);

    // Budget reflects SDK-reported usage via onUsage
    expect(runtime.budget.snapshot().spentUSD).toBeGreaterThan(0);

    // API surface
    const deps = { state: runtime.state, rules: runtime.rules };

    const list = handleListItems(deps, {});
    expect((list.body as { items: unknown[] }).items).toHaveLength(1);

    const counts = handleGetCounts(deps);
    expect((counts.body as { counts: Record<string, number> }).counts).toEqual({
      requires_user: 1,
      draft_ready: 0,
      auto_handled: 0,
    });

    const get = handleGetItem(deps, items[0]!.id);
    expect(get.status).toBe(200);

    const audit = handleListItemAudit(deps, items[0]!.id);
    expect((audit.body as { entries: unknown[] }).entries).toHaveLength(1);

    // User action through API: archive then verify audit
    const action = handleSetAction(deps, items[0]!.id, { action: 'archived' });
    expect(action.status).toBe(200);
    expect(runtime.state.getItem(items[0]!.id)?.userAction).toBe('archived');

    const fullAudit = runtime.state.listAuditForItem(items[0]!.id);
    expect(fullAudit.map((e) => e.action)).toEqual(['classified', 'archived']);
  });

  it('rule short-circuit path: insertRule + invalidate -> hook bypasses LLM', async () => {
    const create = vi.fn(async () => ({ content: [{ type: 'text', text: '{}' }] }));
    const client = { messages: { create } } as unknown as Anthropic;
    const runtime = bootstrapInbox({ mailStateDb: mail, anthropicClient: client });

    // User-confirmed "always archive Max's mails" rule
    runtime.state.insertRule({
      accountId: ACCOUNT.id,
      matcherKind: 'from',
      matcherValue: 'mustermann@example.com',
      bucket: 'auto_handled',
      action: 'archive',
      source: 'on_demand',
    });
    runtime.rules.invalidate(ACCOUNT.id);

    await runtime.hook(ACCOUNT.id, envelope());
    await runtime.shutdown();

    // No LLM call
    expect(create).not.toHaveBeenCalled();

    const items = runtime.state.listItems();
    expect(items).toHaveLength(1);
    expect(items[0]?.bucket).toBe('auto_handled');
    expect(items[0]?.classifierVersion).toMatch(/^rule:/);

    const audit = runtime.state.listAuditForItem(items[0]!.id);
    expect(audit[0]?.action).toBe('rule_applied');
    expect(audit[0]?.actor).toBe('rule_engine');
  });

  it('dedup race: a second hook fire on the same thread does not produce a duplicate item', async () => {
    const client = stubClient(
      JSON.stringify({ bucket: 'requires_user', confidence: 0.9, one_line_why_de: 'k' }),
    );
    const runtime = bootstrapInbox({ mailStateDb: mail, anthropicClient: client });

    await runtime.hook(ACCOUNT.id, envelope({ uid: 1, messageId: '<a@x>' }));
    await settle(runtime, () => runtime.state.listItems().length === 1);

    // Second mail on the same thread — pre-check sees the existing item and
    // returns early. (The watcher hook's pre-check; the v8 UNIQUE index is
    // the defense-in-depth that covers the racing-classifier window.)
    await runtime.hook(
      ACCOUNT.id,
      envelope({ uid: 2, messageId: '<b@x>', threadKey: 'imap:thread-smoke' }),
    );
    await runtime.shutdown();

    expect(runtime.state.listItems()).toHaveLength(1);
  });
});
