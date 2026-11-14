import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { MailStateDb } from '../mail/state.js';
import { bootstrapInbox, MAX_PENDING_RULE_PROPOSALS } from './bootstrap.js';
import { ClassifierQueue } from './classifier/queue.js';
import { InboxCostBudget } from './cost-budget.js';
import { InboxRulesLoader } from './rules-loader.js';
import { InboxStateDb } from './state.js';
import type { CRM } from '../../core/crm.js';
import type { MailAccountConfig, MailEnvelope } from '../mail/provider.js';
import { getModelId, MODEL_CAPABILITIES } from '../../types/index.js';

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
    from: [{ address: 'mustermann@example.com', name: 'Max' }],
    to: [{ address: 'me@acme.example' }],
    cc: [],
    replyTo: [],
    subject: 'Termin?',
    date: new Date(),
    flags: [],
    snippet: 'Hi Me',
    hasAttachments: false,
    attachmentCount: 0,
    sizeBytes: 0,
    isAutoReply: false,
    ...overrides,
  };
}

describe('bootstrapInbox — wiring', () => {
  // 966: the reminder poller gets the instance's language, so its title follows it.
  it('titles a reminder in the language it is handed', async () => {
    const titles: string[] = [];
    const router = { notify: vi.fn(async (m: { title: string }) => { titles.push(m.title); return []; }) };
    const client = makeClient({ content: [{ type: 'text', text: '{}' }] });
    const runtime = bootstrapInbox({
      mailStateDb: mail, anthropicClient: client, reminderPollIntervalMs: 10, language: () => 'de',
      notificationRouter: router as unknown as Parameters<typeof bootstrapInbox>[0]['notificationRouter'],
    });
    const id = runtime.state.insertItem({
      accountId: 'acct-1', channel: 'email', threadKey: 't-r', bucket: 'requires_user', confidence: 0.5,
      reasonDe: 'r', classifiedAt: new Date('2026-05-01'), classifierVersion: 'v', subject: 'Vertrag prüfen',
    });
    runtime.state.setSnooze(id, new Date(Date.now() - 5000), null, true, true);
    await vi.waitFor(() => expect(titles).toEqual(['Erinnerung']));
    await runtime.shutdown();
  });

  it('returns a runtime bundle with all parts populated', () => {
    const client = makeClient({ content: [{ type: 'text', text: '{}' }] });
    const runtime = bootstrapInbox({ mailStateDb: mail, anthropicClient: client });
    expect(runtime.state).toBeInstanceOf(InboxStateDb);
    expect(runtime.rules).toBeInstanceOf(InboxRulesLoader);
    expect(runtime.budget).toBeInstanceOf(InboxCostBudget);
    expect(runtime.queue).toBeInstanceOf(ClassifierQueue);
    expect(runtime.hook).toBeInstanceOf(Function);
    expect(runtime.onAccountAdded).toBeInstanceOf(Function);
    expect(runtime.onOutboundReconcile).toBeInstanceOf(Function); // wired to MailHooks.onOutboundSent
    expect(runtime.contactResolver).toBeNull(); // no CRM provided
  });

  // 1070: mail_triage reads the classifier's verdict through this.
  it('answers what the classifier made of a thread, scoped to its account', () => {
    const client = makeClient({ content: [{ type: 'text', text: '{}' }] });
    const runtime = bootstrapInbox({ mailStateDb: mail, anthropicClient: client });
    const id = runtime.state.insertItem({
      accountId: 'acct-1', channel: 'email', threadKey: 't-l', bucket: 'draft_ready', confidence: 0.9,
      reasonDe: 'r', classifiedAt: new Date('2026-05-01'), classifierVersion: 'v', messageId: '<label@x>',
    });
    const before = runtime.inboxLabelOf('acct-1', 't-l');
    expect(before?.bucket).toBe('draft_ready');
    expect(before?.userAction).toBeUndefined();
    runtime.state.updateUserAction(id, 'replied');
    expect(before?.reason).toBe('r');
    expect(runtime.inboxLabelOf('acct-1', 't-l')).toEqual({ bucket: 'draft_ready', userAction: 'replied', reason: 'r' });
    expect(runtime.inboxLabelOf('acct-2', 't-l')).toBeNull();
    expect(runtime.inboxLabelOf('acct-1', 't-unknown')).toBeNull();
  });

  it('the rule proposer files waiting rules in its tenant, at most ten per account, and the runtime does not apply them', () => {
    const client = makeClient({ content: [{ type: 'text', text: '{}' }] });
    const runtime = bootstrapInbox({ mailStateDb: mail, anthropicClient: client, tenantId: 't-9' });
    expect(runtime.inboxRuleProposer.maxPending).toBe(MAX_PENDING_RULE_PROPOSALS);
    expect(MAX_PENDING_RULE_PROPOSALS).toBe(10);
    for (let i = 0; i < 10; i++) {
      expect(runtime.inboxRuleProposer.propose({ accountId: 'acct-1', matcherKind: 'from', matcherValue: `p${String(i)}@x`, name: 'P', runId: 'run-1' }).ok).toBe(true);
    }
    expect(runtime.inboxRuleProposer.propose({ accountId: 'acct-1', matcherKind: 'from', matcherValue: 'p10@x', name: 'P' }))
      .toEqual({ ok: false, reason: 'limit', pending: 10 });
    const stored = runtime.state.listRulesForAccount('acct-1', 't-9');
    expect(stored).toHaveLength(10);
    expect(stored.every((r) => r.source === 'agent' && r.confirmedAt === undefined && r.runId === 'run-1')).toBe(true);
    expect(runtime.state.listRulesForAccount('acct-1')).toHaveLength(0);
    expect(runtime.rules.match({ tenantId: 't-9', accountId: 'acct-1', from: 'p0@x', subject: '', listId: undefined } as never)).toBeNull();
  });

  it('shows no verdict, rather than throwing, when the lookup fails', () => {
    const client = makeClient({ content: [{ type: 'text', text: '{}' }] });
    const runtime = bootstrapInbox({ mailStateDb: mail, anthropicClient: client });
    vi.spyOn(runtime.state, 'findItemByThread').mockImplementation(() => { throw new Error('db closed'); });
    expect(runtime.inboxLabelOf('acct-1', 't-l')).toBeNull();
  });

  it('emits a console.warn when llmRegion=us without an ack (default routing)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = makeClient({ content: [{ type: 'text', text: '{}' }] });
    bootstrapInbox({ mailStateDb: mail, anthropicClient: client }); // region='us' default
    expect(warn).toHaveBeenCalledTimes(1);
    const message = warn.mock.calls[0]![0] as string;
    expect(message).toContain('Anthropic US');
    expect(message).toContain('LYNOX_INBOX_LLM_REGION=eu');
    expect(message).toContain('LYNOX_INBOX_PRIVACY_ACK=1');
    warn.mockRestore();
  });

  it('stays silent when privacyAck is set on US routing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = makeClient({ content: [{ type: 'text', text: '{}' }] });
    bootstrapInbox({ mailStateDb: mail, anthropicClient: client, privacyAck: true });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
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

  it('debits managed classifier spend to the tenant balance via onAfterRun', async () => {
    const client = makeClient({
      content: [{ type: 'text', text: JSON.stringify({
        bucket: 'requires_user',
        confidence: 0.9,
        one_line_why_de: 'Kunde fragt nach Termin',
      }) }],
      usage: { input_tokens: 500, output_tokens: 80 },
    });
    const onAfterRun = vi.fn();
    const meteredHost = { getHooks: () => [{ onAfterRun }], getContext: () => undefined };
    const runtime = bootstrapInbox({ mailStateDb: mail, anthropicClient: client, meteredHost });
    await runtime.hook(ACCOUNT.id, envelope());
    await runtime.shutdown();

    expect(onAfterRun).toHaveBeenCalledOnce();
    const call = onAfterRun.mock.calls[0]!;
    // Same local cost basis as the daily cap: input $1/Mtok, output $5/Mtok →
    // 500/1e6·1 + 80/1e6·5 = 0.0009 USD, labelled on the `fast` tier.
    expect(call[1] as number).toBeCloseTo(0.0009, 6);
    expect((call[2] as { modelTier?: string }).modelTier).toBe('fast');
    // The debit matches what the local budget recorded (single source of truth).
    expect(runtime.budget.snapshot().spentUSD).toBeCloseTo(call[1] as number, 6);
  });

  it('rule short-circuit bypasses the LLM call entirely', async () => {
    const create = vi.fn(async () => ({ content: [{ type: 'text', text: '{}' }] }));
    const client = { messages: { create } } as unknown as Anthropic;
    const runtime = bootstrapInbox({ mailStateDb: mail, anthropicClient: client });
    runtime.state.insertRule({
      accountId: ACCOUNT.id,
      matcherKind: 'from',
      matcherValue: 'mustermann@example.com',
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

  it('throws when requireUsAck=true and privacyAck is not set on US default', () => {
    const client = makeClient({ content: [{ type: 'text', text: '{}' }] });
    expect(() =>
      bootstrapInbox({
        mailStateDb: mail,
        anthropicClient: client,
        requireUsAck: true,
      }),
    ).toThrow(/PRIVACY_ACK/);
  });

  it('does not throw when ack is provided alongside requireUsAck', () => {
    const client = makeClient({ content: [{ type: 'text', text: '{}' }] });
    expect(() =>
      bootstrapInbox({
        mailStateDb: mail,
        anthropicClient: client,
        requireUsAck: true,
        privacyAck: true,
      }),
    ).not.toThrow();
  });

  it('llmRegion=eu requires mistralApiKey — throws otherwise', () => {
    const client = makeClient({ content: [{ type: 'text', text: '{}' }] });
    expect(() =>
      bootstrapInbox({ mailStateDb: mail, anthropicClient: client, llmRegion: 'eu' }),
    ).toThrow(/mistralApiKey/);
  });

  it('llmRegion=eu wires the Mistral caller (no Anthropic call) when key is provided', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      statusText: '',
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({
          bucket: 'requires_user',
          confidence: 0.85,
          one_line_why_de: 'Kunde fragt zurück',
        }) } }],
        usage: { prompt_tokens: 200, completion_tokens: 30 },
      }),
      text: async () => '',
    } as unknown as Response);
    const create = vi.fn(); // must never be called when region=eu
    const client = { messages: { create } } as unknown as Anthropic;
    const runtime = bootstrapInbox({
      mailStateDb: mail,
      anthropicClient: client,
      llmRegion: 'eu',
      mistralApiKey: 'eu-key',
    });
    await runtime.hook(ACCOUNT.id, envelope());
    await runtime.shutdown();

    expect(create).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const url = fetchSpy.mock.calls[0]![0] as string;
    expect(url).toContain('api.eu.mistral.ai');
    expect(runtime.state.listItems()[0]?.bucket).toBe('requires_user');
    expect(runtime.budget.snapshot().spentUSD).toBeGreaterThan(0);
    fetchSpy.mockRestore();
  });

  describe('description rules, checked by their own model per region', () => {
    afterEach(() => { vi.unstubAllEnvs(); });
    const mistralReply = (content: string, tokens = 1_000_000) => ({
      ok: true, status: 200, statusText: '',
      json: async () => ({ choices: [{ message: { content } }], usage: { prompt_tokens: tokens, completion_tokens: tokens } }),
      text: async () => '',
    }) as unknown as Response;
    /** The label the rule check gave the rule named `name`, read from the prompt. */
    const labelOf = (user: string, name: string): string => {
      const m = new RegExp(`Regel (R\\d+) \\| Name: ${name} \\|`).exec(user);
      if (!m) throw new Error(`no label for ${name}`);
      return m[1]!;
    };
    const runHistory = () => {
      const inserted: Array<Record<string, unknown>> = [];
      const updated: Array<Record<string, unknown>> = [];
      return { inserted, updated, rh: { insertRun: (r: Record<string, unknown>) => { inserted.push(r); return `run-${String(inserted.length)}`; }, updateRun: (_id: string, u: Record<string, unknown>) => { updated.push(u); } } };
    };

    it('EU: checks them with ministral-8b, priced at its own rates, recorded as its own run; an auto_handled hit the classifier confirms files the mail', async () => {
      vi.stubEnv('LYNOX_FEATURE_INBOX_USER_RULES', '1');
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        const req = JSON.parse(String((init as RequestInit).body)) as { model: string; messages: Array<{ content: string }> };
        if (req.model === 'ministral-8b-2512') return mistralReply(JSON.stringify({ rule_id: labelOf(req.messages[1]!.content, 'Termine') }));
        return mistralReply(JSON.stringify({ bucket: 'auto_handled', confidence: 0.95, one_line_why_de: 'Termin bestätigt' }), 0);
      });
      const h = runHistory();
      const runtime = bootstrapInbox({ mailStateDb: mail, anthropicClient: makeClient({ content: [] }), llmRegion: 'eu', mistralApiKey: 'eu-key', runHistory: h.rh as never });
      try {
        const ruleId = runtime.state.insertRule({ accountId: ACCOUNT.id, matcherKind: 'matches_description', matcherValue: 'Terminanfragen', bucket: 'auto_handled', action: 'mark_read', source: 'on_demand', name: 'Termine' });
        await runtime.hook(ACCOUNT.id, envelope());
        await runtime.queue.drain();
        expect(fetchSpy).toHaveBeenCalledTimes(2);
        const models = fetchSpy.mock.calls.map((c) => (JSON.parse(String((c[1] as RequestInit).body)) as { model: string }).model);
        expect(models[0]).toBe('ministral-8b-2512');
        expect(models[1]).not.toBe('ministral-8b-2512');
        expect(runtime.state.listItems()[0]).toMatchObject({ bucket: 'auto_handled', matchedRuleId: ruleId });
        const pricing = MODEL_CAPABILITIES['ministral-8b-2512']!.pricing;
        expect(runtime.budget.snapshot().spentUSD).toBeCloseTo(pricing.input + pricing.output, 6);
        expect(h.inserted[0]).toMatchObject({ taskText: 'inbox rule check', modelId: 'ministral-8b-2512', modelTier: 'fast' });
        expect(h.updated[0]?.['costUsd']).toBeCloseTo(pricing.input + pricing.output, 6);
      } finally {
        fetchSpy.mockRestore();
        await runtime.shutdown();
      }
    });

    it('US: checks them with the fast Anthropic model, charged to the budget and recorded as its own run', async () => {
      vi.stubEnv('LYNOX_FEATURE_INBOX_USER_RULES', '1');
      const create = vi.fn(async (req: { model: string; messages: Array<{ content: string }> }) => ({
        content: [{ type: 'text', text: JSON.stringify({ rule_id: labelOf(req.messages[0]!.content, 'Termine') }) }],
        usage: { input_tokens: 10, output_tokens: 5 },
      }));
      const client = { messages: { create } } as unknown as Anthropic;
      const h = runHistory();
      const runtime = bootstrapInbox({ mailStateDb: mail, anthropicClient: client, privacyAck: true, runHistory: h.rh as never });
      try {
        runtime.state.insertRule({ accountId: ACCOUNT.id, matcherKind: 'matches_description', matcherValue: 'Terminanfragen', bucket: 'requires_user', action: 'show', source: 'on_demand', name: 'Termine' });
        await runtime.hook(ACCOUNT.id, envelope());
        await runtime.queue.drain();
        expect(create).toHaveBeenCalledTimes(1);
        expect(create.mock.calls[0]![0].model).toBe(getModelId('fast'));
        expect(runtime.state.listItems()[0]?.matchedRuleId).toBeDefined();
        expect(runtime.budget.snapshot().spentUSD).toBeCloseTo((10 * 1 + 5 * 5) / 1_000_000, 9); // Haiku $1 / $5 per MTok
        expect(h.inserted[0]).toMatchObject({ taskText: 'inbox rule check', modelId: getModelId('fast'), modelTier: 'fast' });
      } finally {
        await runtime.shutdown();
      }
    });

    it.each([[undefined], ['']] as const)('with the flag unset (%j), checks them: the feature is on by default', async (flag) => {
      vi.stubEnv('LYNOX_FEATURE_INBOX_USER_RULES', flag);
      const create = vi.fn(async (req: { model: string; messages: Array<{ content: string }> }) => ({
        content: [{ type: 'text', text: JSON.stringify({ rule_id: labelOf(req.messages[0]!.content, 'Termine') }) }],
        usage: { input_tokens: 10, output_tokens: 5 },
      }));
      const client = { messages: { create } } as unknown as Anthropic;
      const runtime = bootstrapInbox({ mailStateDb: mail, anthropicClient: client, privacyAck: true });
      try {
        const ruleId = runtime.state.insertRule({ accountId: ACCOUNT.id, matcherKind: 'matches_description', matcherValue: 'Terminanfragen', bucket: 'requires_user', action: 'show', source: 'on_demand', name: 'Termine' });
        await runtime.hook(ACCOUNT.id, envelope());
        await runtime.queue.drain();
        expect(create).toHaveBeenCalledTimes(1);
        expect(create.mock.calls[0]![0].model).toBe(getModelId('fast'));
        expect(runtime.state.listItems()[0]?.matchedRuleId).toBe(ruleId);
      } finally {
        await runtime.shutdown();
      }
    });

    it('with the flag off, checks no description rule: the classifier alone decides', async () => {
      vi.stubEnv('LYNOX_FEATURE_INBOX_USER_RULES', '0');
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mistralReply(JSON.stringify({ bucket: 'requires_user', confidence: 0.9, one_line_why_de: 'x' }), 10));
      const runtime = bootstrapInbox({ mailStateDb: mail, anthropicClient: makeClient({ content: [] }), llmRegion: 'eu', mistralApiKey: 'eu-key' });
      try {
        runtime.state.insertRule({ accountId: ACCOUNT.id, matcherKind: 'matches_description', matcherValue: 'Terminanfragen', bucket: 'auto_handled', action: 'mark_read', source: 'on_demand' });
        await runtime.hook(ACCOUNT.id, envelope());
        await runtime.queue.drain();
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        const body = JSON.parse(String((fetchSpy.mock.calls[0]![1] as RequestInit).body)) as { model: string };
        expect(body.model).not.toBe('ministral-8b-2512');
        expect(runtime.state.listItems()[0]?.matchedRuleId).toBeUndefined();
      } finally {
        fetchSpy.mockRestore();
        await runtime.shutdown();
      }
    });
  });

  it('prices classifier spend per region — Mistral for EU, Haiku for US', async () => {
    const client = makeClient({ content: [{ type: 'text', text: '{}' }] });
    const us = bootstrapInbox({ mailStateDb: mail, anthropicClient: client, privacyAck: true });
    const eu = bootstrapInbox({ mailStateDb: mail, anthropicClient: client, llmRegion: 'eu', mistralApiKey: 'eu-key' });
    try {
      // Same 1M-in + 1M-out usage priced at each region's provider rate. The EU
      // path used to bill Mistral spend at the Haiku constants (8× here).
      us.budget.recordUsage(1_000_000, 1_000_000);
      eu.budget.recordUsage(1_000_000, 1_000_000);
      expect(us.budget.snapshot().spentUSD).toBeCloseTo(6.0, 6); // Haiku $1 + $5
      expect(eu.budget.snapshot().spentUSD).toBeCloseTo(0.825, 6); // Mistral Small 4 EU $0.165 + $0.66
    } finally {
      await us.shutdown();
      await eu.shutdown();
    }
  });

  it('LLM rejection cascades through retry to a fail-closed dead-letter item', async () => {
    const create = vi.fn(async () => {
      throw new Error('rate_limited');
    });
    const client = { messages: { create } } as unknown as Anthropic;
    const runtime = bootstrapInbox({ mailStateDb: mail, anthropicClient: client });
    await runtime.hook(ACCOUNT.id, envelope());
    // Let the queue retry + dead-letter complete BEFORE drain (drain sets
    // draining=true and the runner's retry loop intentionally skips retries
    // when draining, which would mask the production retry behavior).
    for (let i = 0; i < 50 && runtime.state.listItems().length === 0; i++) {
      await new Promise((r) => setImmediate(r));
    }
    await runtime.shutdown();

    expect(create).toHaveBeenCalledTimes(2); // initial + one retry
    const items = runtime.state.listItems();
    expect(items).toHaveLength(1);
    expect(items[0]?.bucket).toBe('requires_user');
    expect(items[0]?.confidence).toBe(0);
    expect(items[0]?.classifierVersion).toMatch(/^dead-letter:/);
    expect(items[0]?.reasonDe).toContain('Klassifizierer');

    // No tokens were ever returned, so the budget stays at zero — the SDK
    // failure path never invokes the onUsage hook.
    expect(runtime.budget.snapshot().spentUSD).toBe(0);
  });

  it('on an instance connected to a Shopify store the EU region sends nothing — not to Mistral, not to the US path', async () => {
    vi.stubEnv('LYNOX_SHOPIFY_EXCHANGE', '1');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const create = vi.fn();
    const client = { messages: { create } } as unknown as Anthropic;
    try {
      const runtime = bootstrapInbox({ mailStateDb: mail, anthropicClient: client, llmRegion: 'eu', mistralApiKey: 'eu-key' });
      await runtime.hook(ACCOUNT.id, envelope());
      for (let i = 0; i < 50 && runtime.state.listItems().length === 0; i++) {
        await new Promise((r) => setImmediate(r));
      }
      await runtime.shutdown();

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
      const items = runtime.state.listItems();
      expect(items).toHaveLength(1);
      expect(items[0]?.bucket).toBe('requires_user');
      expect(items[0]?.classifierVersion).toMatch(/^dead-letter:/);
    } finally {
      fetchSpy.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});

describe('bootstrapInbox — push notifier wire', () => {
  it('routes a requires_user classification to the registered router', async () => {
    const { NotificationRouter } = await import('../../core/notification-router.js');
    const router = new NotificationRouter();
    const send = vi.fn(async () => 'delivered' as const);
    router.register({ name: 'web-push', send });

    const client = makeClient({
      content: [{ type: 'text', text: JSON.stringify({
        bucket: 'requires_user',
        confidence: 0.9,
        one_line_why_de: 'Kunde fragt nach Termin',
      }) }],
    });
    const runtime = bootstrapInbox({
      mailStateDb: mail,
      anthropicClient: client,
      notificationRouter: router,
    });
    await runtime.hook(ACCOUNT.id, envelope());
    await runtime.queue.drain();
    expect(send).toHaveBeenCalledTimes(1);
    const msg = send.mock.calls[0]?.[0] as { data?: { itemId?: string } };
    expect(msg.data?.itemId).toMatch(/^inb_/);
  });

  it('respects inbox_push_enabled=false: notifier silently skips even with router wired', async () => {
    const { NotificationRouter } = await import('../../core/notification-router.js');
    const router = new NotificationRouter();
    const send = vi.fn(async () => 'delivered' as const);
    router.register({ name: 'web-push', send });
    const client = makeClient({
      content: [{ type: 'text', text: JSON.stringify({
        bucket: 'requires_user', confidence: 0.9, one_line_why_de: 'r',
      }) }],
    });
    const runtime = bootstrapInbox({
      mailStateDb: mail, anthropicClient: client, notificationRouter: router,
    });
    runtime.state.setSetting('push.inbox_enabled', 'false');
    await runtime.hook(ACCOUNT.id, envelope());
    await runtime.queue.drain();
    expect(send).not.toHaveBeenCalled();
  });

  it('respects inbox_push_enabled=true (default): notifier dispatches as usual', async () => {
    const { NotificationRouter } = await import('../../core/notification-router.js');
    const router = new NotificationRouter();
    const send = vi.fn(async () => 'delivered' as const);
    router.register({ name: 'web-push', send });
    const client = makeClient({
      content: [{ type: 'text', text: JSON.stringify({
        bucket: 'requires_user', confidence: 0.9, one_line_why_de: 'r',
      }) }],
    });
    const runtime = bootstrapInbox({
      mailStateDb: mail, anthropicClient: client, notificationRouter: router,
    });
    // Default = absent setting → isEnabled returns true.
    await runtime.hook(ACCOUNT.id, envelope());
    await runtime.queue.drain();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('does NOT push when no notificationRouter is wired (single-user/headless)', async () => {
    const client = makeClient({
      content: [{ type: 'text', text: JSON.stringify({
        bucket: 'requires_user',
        confidence: 0.9,
        one_line_why_de: 'r',
      }) }],
    });
    const runtime = bootstrapInbox({
      mailStateDb: mail,
      anthropicClient: client,
      // notificationRouter intentionally omitted
    });
    // Drives the hook without throwing — proves the runner+watcher tolerate
    // an absent notifier (the `if (opts.notifier)` guards must hold).
    await runtime.hook(ACCOUNT.id, envelope());
    await runtime.queue.drain();
  });
});
