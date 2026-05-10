import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { MailStateDb } from '../mail/state.js';
import { bootstrapInbox } from './bootstrap.js';
import { waMessageToInboxInput } from './whatsapp-adapter.js';
import type { WhatsAppContact, WhatsAppMessage } from '../whatsapp/types.js';

let mail: MailStateDb;

beforeEach(() => {
  mail = new MailStateDb({ path: ':memory:' });
});

afterEach(() => {
  mail.close();
});

function stubClient(reply: { content: ReadonlyArray<{ type: string; text?: string }>; usage?: { input_tokens: number; output_tokens: number } }): Anthropic {
  return {
    messages: { create: vi.fn(async () => reply) },
  } as unknown as Anthropic;
}

function waMsg(overrides: Partial<WhatsAppMessage> = {}): WhatsAppMessage {
  return {
    id: 'wamid.smoke-1',
    threadId: 'whatsapp:491234567890',
    phoneE164: '491234567890',
    direction: 'inbound',
    kind: 'text',
    text: 'Hi, ich brauche dringend deine Hilfe bei der Bestellung 4711.',
    mediaId: null,
    transcript: null,
    mimeType: null,
    timestamp: 1_700_000_000,
    isEcho: false,
    rawJson: '{}',
    ...overrides,
  };
}

const CONTACT: WhatsAppContact = {
  phoneE164: '491234567890',
  displayName: 'Max Mustermann',
  profileName: 'mxm',
  lastSeenAt: 1_700_000_000,
};

describe('WhatsApp -> Inbox end-to-end', () => {
  it('drives a WA inbound message through the inbox runtime into an inbox_items row', async () => {
    const client = stubClient({
      content: [{ type: 'text', text: JSON.stringify({
        bucket: 'requires_user',
        confidence: 0.88,
        one_line_why_de: 'Kunde fragt nach Hilfe zur Bestellung',
      }) }],
      usage: { input_tokens: 100, output_tokens: 30 },
    });
    const runtime = bootstrapInbox({
      mailStateDb: mail,
      anthropicClient: client,
      privacyAck: true,
    });
    const adapted = waMessageToInboxInput(waMsg(), CONTACT, { phoneNumberId: 'pn-test' });
    expect(adapted).not.toBeNull();
    if (!adapted) return;
    await runtime.hook(adapted.accountId, adapted.envelope);
    await runtime.shutdown();

    const items = runtime.state.listItems();
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.channel).toBe('whatsapp');
    expect(item.accountId).toBe('whatsapp:pn-test');
    expect(item.threadKey).toBe('whatsapp:491234567890');
    expect(item.bucket).toBe('requires_user');
    expect(item.reasonDe).toContain('Kunde fragt');

    const audit = runtime.state.listAuditForItem(item.id);
    expect(audit[0]?.action).toBe('classified');
    expect(audit[0]?.actor).toBe('classifier');
  });

  it('routes a WA mail containing an OTP through the sensitive-skip path (no LLM)', async () => {
    const create = vi.fn();
    const client = { messages: { create } } as unknown as Anthropic;
    const runtime = bootstrapInbox({
      mailStateDb: mail,
      anthropicClient: client,
      privacyAck: true,
    });
    const adapted = waMessageToInboxInput(
      waMsg({ id: 'wamid.otp', text: 'Bestätigungscode 482917 ist 5 Minuten gültig.' }),
      CONTACT,
      { phoneNumberId: 'pn-test' },
    );
    expect(adapted).not.toBeNull();
    if (!adapted) return;
    await runtime.hook(adapted.accountId, adapted.envelope);
    await runtime.shutdown();

    expect(create).not.toHaveBeenCalled();
    const items = runtime.state.listItems();
    expect(items[0]?.classifierVersion).toBe('sensitive-prefilter');
    expect(items[0]?.channel).toBe('whatsapp');
  });

  it('rule short-circuit works for WA pseudo-accounts (from-rule matches counterparty)', async () => {
    const create = vi.fn();
    const client = { messages: { create } } as unknown as Anthropic;
    const runtime = bootstrapInbox({
      mailStateDb: mail,
      anthropicClient: client,
      privacyAck: true,
    });
    runtime.state.insertRule({
      accountId: 'whatsapp:pn-test',
      matcherKind: 'from',
      matcherValue: 'whatsapp:491234567890',
      bucket: 'auto_handled',
      action: 'archive',
      source: 'on_demand',
    });
    runtime.rules.invalidate('whatsapp:pn-test');

    const adapted = waMessageToInboxInput(waMsg(), CONTACT, { phoneNumberId: 'pn-test' });
    if (!adapted) return;
    await runtime.hook(adapted.accountId, adapted.envelope);
    await runtime.shutdown();

    expect(create).not.toHaveBeenCalled();
    const items = runtime.state.listItems();
    expect(items[0]?.bucket).toBe('auto_handled');
    expect(items[0]?.classifierVersion).toMatch(/^rule:/);
    expect(items[0]?.channel).toBe('whatsapp');
  });

  it('bootstrap.AccountResolver synthesises an identity for whatsapp:* pseudo-accounts', async () => {
    const client = stubClient({
      content: [{ type: 'text', text: JSON.stringify({
        bucket: 'auto_handled', confidence: 0.9, one_line_why_de: 'ok',
      }) }],
    });
    const runtime = bootstrapInbox({
      mailStateDb: mail,
      anthropicClient: client,
      privacyAck: true,
    });
    const adapted = waMessageToInboxInput(waMsg(), CONTACT, { phoneNumberId: 'pn-test' });
    if (!adapted) return;
    // hook resolves accounts via the AccountResolver; if it returned null
    // the hook would early-return without inserting anything.
    await runtime.hook(adapted.accountId, adapted.envelope);
    await runtime.shutdown();
    expect(runtime.state.listItems()).toHaveLength(1);
  });
});
