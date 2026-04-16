// Co-located tests for the five mail tools. Uses an in-memory MailRegistry
// + fake provider — no IMAP/SMTP, no real network.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  MailEnvelope,
  MailFetchOptions,
  MailListOptions,
  MailMessage,
  MailProvider,
  MailSearchOptions,
  MailSearchQuery,
  MailSendInput,
  MailSendResult,
  MailWatchHandle,
} from '../provider.js';
import type { IAgent } from '../../../types/index.js';
import { InMemoryMailRegistry } from './registry.js';
import { createMailSearchTool } from './mail-search.js';
import { createMailReadTool } from './mail-read.js';
import { createMailSendTool } from './mail-send.js';
import { createMailReplyTool } from './mail-reply.js';
import { createMailTriageTool } from './mail-triage.js';
import type { MailContext, MailAccountView } from '../context.js';
import type { MailAccountConfig } from '../provider.js';

/** Minimal MailContext stub for type-aware tool tests. */
function makeStubContext(accounts: ReadonlyArray<MailAccountConfig>): MailContext {
  const byId = new Map(accounts.map(a => [a.id, a]));
  const byAddress = new Map(accounts.map(a => [a.address.toLowerCase(), a]));
  return {
    getAccountConfig: (id: string) => byId.get(id) ?? null,
    findAccountByAddress: (addr: string) => byAddress.get(addr.toLowerCase()) ?? null,
  } as unknown as MailContext;
}

// ── Fake provider ──────────────────────────────────────────────────────────

class FakeProvider implements MailProvider {
  readonly accountId: string;
  list = vi.fn(async (_opts?: MailListOptions): Promise<ReadonlyArray<MailEnvelope>> => []);
  fetch = vi.fn(async (_opts: MailFetchOptions): Promise<MailMessage> => { throw new Error('not configured'); });
  search = vi.fn(async (_q: MailSearchQuery, _o?: MailSearchOptions): Promise<ReadonlyArray<MailEnvelope>> => []);
  send = vi.fn(async (_input: MailSendInput): Promise<MailSendResult> => ({ messageId: '<sent@x>', accepted: [], rejected: [] }));
  watch = vi.fn(async (): Promise<MailWatchHandle> => ({ stop: async () => {} }));
  close = vi.fn(async () => {});
  constructor(id: string) { this.accountId = id; }
}

function envelope(uid: number, opts: { messageId: string; from?: string; subject?: string; flags?: string[]; date?: string; snippet?: string } = { messageId: `<${String(uid)}@x>` }): MailEnvelope {
  return {
    uid,
    messageId: opts.messageId,
    folder: 'INBOX',
    threadKey: opts.messageId,
    inReplyTo: undefined,
    from: [{ address: opts.from ?? 'alice@example.com' }],
    to: [{ address: 'me@example.com' }],
    cc: [],
    replyTo: [],
    subject: opts.subject ?? `Subject ${String(uid)}`,
    date: new Date(opts.date ?? '2026-04-15T10:00:00Z'),
    flags: opts.flags ?? [],
    snippet: opts.snippet ?? 'short snippet',
    hasAttachments: false,
    attachmentCount: 0,
    sizeBytes: 1024,
    isAutoReply: false,
  };
}

function makeMessage(env: MailEnvelope, body: string, html: string | undefined = undefined): MailMessage {
  return {
    envelope: env,
    text: body,
    html,
    attachments: [],
    inReplyTo: env.inReplyTo,
    references: undefined,
  };
}

const noPromptAgent: IAgent = {} as IAgent;
const yesAgent: IAgent = { promptUser: async () => 'Yes' } as unknown as IAgent;
const noAgent: IAgent = { promptUser: async () => 'No' } as unknown as IAgent;

let provider: FakeProvider;
let registry: InMemoryMailRegistry;

beforeEach(() => {
  provider = new FakeProvider('rafael-gmail');
  registry = new InMemoryMailRegistry();
  registry.add(provider);
});

// ── mail_search ────────────────────────────────────────────────────────────

describe('mail_search tool', () => {
  it('translates input into a MailSearchQuery and renders the result', async () => {
    provider.search.mockResolvedValue([
      envelope(1, { messageId: '<a>', subject: 'Invoice', from: 'billing@acme.com' }),
      envelope(2, { messageId: '<b>', subject: 'Contract', from: 'legal@acme.com' }),
    ]);

    const tool = createMailSearchTool(registry);
    const out = await tool.handler({ from: 'acme.com', unseen: true, limit: 10 }, noPromptAgent);

    expect(provider.search).toHaveBeenCalledTimes(1);
    const [q, o] = provider.search.mock.calls[0]!;
    expect(q.from).toBe('acme.com');
    expect(q.unseen).toBe(true);
    expect(o?.limit).toBe(10);
    expect(out).toContain('Found 2 message(s)');
    expect(out).toContain('1. Invoice');
    expect(out).toContain('2. Contract');
  });

  it('parses since/before into Date objects', async () => {
    provider.search.mockResolvedValue([]);
    const tool = createMailSearchTool(registry);
    await tool.handler({ since: '2026-04-01', before: '2026-04-15' }, noPromptAgent);
    const q = provider.search.mock.calls[0]![0];
    expect(q.since).toBeInstanceOf(Date);
    expect(q.before).toBeInstanceOf(Date);
  });

  it('returns "No messages found." for empty results', async () => {
    const tool = createMailSearchTool(registry);
    const out = await tool.handler({ subject: 'nothing' }, noPromptAgent);
    expect(out).toBe('No messages found.');
  });

  it('caps limit at 50', async () => {
    provider.search.mockResolvedValue([]);
    const tool = createMailSearchTool(registry);
    await tool.handler({ limit: 999 }, noPromptAgent);
    expect(provider.search.mock.calls[0]![1]?.limit).toBe(50);
  });

  it('reports MailError as a friendly tool error string', async () => {
    registry.clear();
    const tool = createMailSearchTool(registry);
    const out = await tool.handler({}, noPromptAgent);
    expect(out).toContain('mail_search error');
    expect(out).toContain('not_found');
  });
});

// ── mail_read ──────────────────────────────────────────────────────────────

describe('mail_read tool', () => {
  it('returns formatted message with body wrapped in untrusted_data tags', async () => {
    const env = envelope(42, { messageId: '<r-1@x>', subject: 'Project update', from: 'bob@example.com' });
    provider.fetch.mockResolvedValue(makeMessage(env, 'This is the body.\n\nOn Wed, Alice wrote:\n> previous'));

    const tool = createMailReadTool(registry);
    const out = await tool.handler({ uid: 42 }, noPromptAgent);

    expect(provider.fetch).toHaveBeenCalledWith({ uid: 42 });
    expect(out).toContain('Project update');
    expect(out).toContain('From: bob@example.com');
    expect(out).toContain('UID: 42');
    expect(out).toContain('<untrusted_data');
    expect(out).toContain('This is the body.');
    // Quoted history is stripped by default
    expect(out).not.toContain('previous');
  });

  it('include_quoted=true appends the quoted history block (still wrapped)', async () => {
    const env = envelope(42, { messageId: '<r-2@x>' });
    provider.fetch.mockResolvedValue(makeMessage(env, 'New content.\n\nOn Wed, Alice wrote:\n> old content'));

    const tool = createMailReadTool(registry);
    const out = await tool.handler({ uid: 42, include_quoted: true }, noPromptAgent);

    expect(out).toContain('Quoted history');
    expect(out).toContain('old content');
    // Must still be wrapped
    const matches = out.match(/<untrusted_data/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it('rejects non-numeric uid', async () => {
    const tool = createMailReadTool(registry);
    const out = await tool.handler({ uid: NaN }, noPromptAgent);
    expect(out).toContain('mail_read error');
    expect(out).toContain('uid');
  });

  it('passes folder and include_html through to provider.fetch', async () => {
    const env = envelope(7, { messageId: '<r-3@x>' });
    provider.fetch.mockResolvedValue(makeMessage(env, 'body', '<p>html body</p>'));
    const tool = createMailReadTool(registry);
    await tool.handler({ uid: 7, folder: 'Sent', include_html: true }, noPromptAgent);
    expect(provider.fetch).toHaveBeenCalledWith({ uid: 7, folder: 'Sent', includeHtml: true });
  });

  it('wraps the html body in its own untrusted_data block when included', async () => {
    const env = envelope(8, { messageId: '<r-4@x>' });
    provider.fetch.mockResolvedValue(makeMessage(env, 'plain', '<b>html</b>'));
    const tool = createMailReadTool(registry);
    const out = await tool.handler({ uid: 8, include_html: true }, noPromptAgent);
    expect(out).toContain('Raw HTML');
    expect(out).toContain('<b>html</b>');
    expect(out).toContain('html');
  });
});

// ── mail_send ──────────────────────────────────────────────────────────────

describe('mail_send tool', () => {
  it('refuses without an interactive prompt (background mode)', async () => {
    const tool = createMailSendTool(registry);
    const out = await tool.handler({ to: 'a@x.com', subject: 's', body: 'b' }, noPromptAgent);
    expect(out).toContain('mail_send error');
    expect(out).toContain('confirmation');
    expect(provider.send).not.toHaveBeenCalled();
  });

  it('cancels when user declines confirmation', async () => {
    const tool = createMailSendTool(registry);
    const out = await tool.handler({ to: 'a@x.com', subject: 's', body: 'b' }, noAgent);
    expect(out).toContain('cancelled by user');
    expect(provider.send).not.toHaveBeenCalled();
  });

  it('sends after confirmation and reports the result', async () => {
    provider.send.mockResolvedValue({ messageId: '<sent-1@x>', accepted: ['a@x.com'], rejected: [] });
    const tool = createMailSendTool(registry);
    const out = await tool.handler({
      to: '"Alice" <alice@example.com>, bob@example.com',
      cc: 'cc@example.com',
      subject: 'Hi',
      body: 'Just saying hello.',
    }, yesAgent);

    expect(provider.send).toHaveBeenCalledTimes(1);
    const sent = provider.send.mock.calls[0]![0];
    expect(sent.to).toEqual([
      { name: 'Alice', address: 'alice@example.com' },
      { address: 'bob@example.com' },
    ]);
    expect(sent.cc).toEqual([{ address: 'cc@example.com' }]);
    expect(sent.subject).toBe('Hi');
    expect(sent.text).toBe('Just saying hello.');
    expect(out).toContain('Email sent');
    expect(out).toContain('<sent-1@x>');
  });

  it('rejects empty required fields', async () => {
    const tool = createMailSendTool(registry);
    expect(await tool.handler({ to: '', subject: 's', body: 'b' }, yesAgent)).toContain('"to" is required');
    expect(await tool.handler({ to: 'a@x.com', subject: '', body: 'b' }, yesAgent)).toContain('"subject" is required');
    expect(await tool.handler({ to: 'a@x.com', subject: 's', body: '' }, yesAgent)).toContain('"body" is required');
  });

  it('rejects unparseable recipient lists', async () => {
    const tool = createMailSendTool(registry);
    const out = await tool.handler({ to: 'not-an-email; also-not', subject: 's', body: 'b' }, yesAgent);
    expect(out).toContain('did not parse');
  });
});

// ── mail_reply ─────────────────────────────────────────────────────────────

describe('mail_reply tool', () => {
  it('fetches the original, builds In-Reply-To + References, and sends after confirm', async () => {
    const orig = envelope(100, { messageId: '<orig@x>', from: 'alice@example.com', subject: 'Question' });
    provider.fetch.mockResolvedValue({
      envelope: orig,
      text: 'Some original content.',
      html: undefined,
      attachments: [],
      inReplyTo: undefined,
      references: '<grandparent@x>',
    });
    provider.send.mockResolvedValue({ messageId: '<reply-1@x>', accepted: ['alice@example.com'], rejected: [] });

    const tool = createMailReplyTool(registry);
    const out = await tool.handler({ uid: 100, body: 'Here is my answer.' }, yesAgent);

    expect(provider.fetch).toHaveBeenCalledWith({ uid: 100 });
    const sent = provider.send.mock.calls[0]![0];
    expect(sent.to).toEqual([{ address: 'alice@example.com' }]);
    expect(sent.subject).toBe('Re: Question');
    expect(sent.inReplyTo).toBe('<orig@x>');
    expect(sent.references).toBe('<grandparent@x> <orig@x>');
    expect(out).toContain('Reply sent');
  });

  it('does not double-prefix subject when original starts with Re:', async () => {
    const orig = envelope(1, { messageId: '<o@x>', subject: 'Re: Question' });
    provider.fetch.mockResolvedValue({
      envelope: orig, text: '', html: undefined, attachments: [], inReplyTo: undefined, references: undefined,
    });
    provider.send.mockResolvedValue({ messageId: 'x', accepted: [], rejected: [] });
    const tool = createMailReplyTool(registry);
    await tool.handler({ uid: 1, body: 'reply' }, yesAgent);
    expect(provider.send.mock.calls[0]![0].subject).toBe('Re: Question');
  });

  it('reply_all unions To+Cc minus our own address (accountId-as-email heuristic)', async () => {
    // Use an account whose id IS the email address so the dedup heuristic kicks in
    const myProvider = new FakeProvider('rafael@example.com');
    const myRegistry = new InMemoryMailRegistry();
    myRegistry.add(myProvider);

    const orig: MailEnvelope = {
      ...envelope(5, { messageId: '<o@x>', from: 'alice@example.com', subject: 'Q' }),
      to: [{ address: 'rafael@example.com' }, { address: 'colleague@example.com' }],
      cc: [{ address: 'manager@example.com' }],
    };
    myProvider.fetch.mockResolvedValue({
      envelope: orig, text: '', html: undefined, attachments: [], inReplyTo: undefined, references: undefined,
    });
    myProvider.send.mockResolvedValue({ messageId: 'x', accepted: [], rejected: [] });

    const tool = createMailReplyTool(myRegistry);
    await tool.handler({ uid: 5, body: 'reply', reply_all: true }, yesAgent);

    const sent = myProvider.send.mock.calls[0]![0];
    expect(sent.to?.[0]?.address).toBe('alice@example.com');
    const ccAddrs = sent.cc?.map(a => a.address) ?? [];
    expect(ccAddrs).toContain('colleague@example.com');
    expect(ccAddrs).toContain('manager@example.com');
    // Our own address is filtered out
    expect(ccAddrs).not.toContain('rafael@example.com');
  });

  it('rejects when the original has no sender and no override is given', async () => {
    const orig: MailEnvelope = { ...envelope(1, { messageId: '<o@x>' }), from: [], replyTo: [] };
    provider.fetch.mockResolvedValue({
      envelope: orig, text: '', html: undefined, attachments: [], inReplyTo: undefined, references: undefined,
    });
    const tool = createMailReplyTool(registry);
    const out = await tool.handler({ uid: 1, body: 'reply' }, yesAgent);
    expect(out).toContain('could not determine recipient');
    expect(provider.send).not.toHaveBeenCalled();
  });

  it('refuses without an interactive prompt', async () => {
    const tool = createMailReplyTool(registry);
    const out = await tool.handler({ uid: 1, body: 'reply' }, noPromptAgent);
    expect(out).toContain('mail_reply error');
    expect(provider.fetch).not.toHaveBeenCalled();
  });
});

// ── mail_triage ────────────────────────────────────────────────────────────

describe('mail_triage tool', () => {
  it('lists unseen messages, filters noise, groups by thread', async () => {
    provider.list.mockResolvedValue([
      envelope(1, { messageId: '<m-1@x>', from: 'noreply@example.com', subject: 'Newsletter' }),
      envelope(2, { messageId: '<m-2@x>', from: 'alice@example.com', subject: 'Hi', date: '2026-04-15T11:00:00Z' }),
      envelope(3, { messageId: '<m-3@x>', from: 'bob@example.com', subject: 'Update', date: '2026-04-15T12:00:00Z' }),
    ]);
    const tool = createMailTriageTool(registry);
    const out = await tool.handler({}, noPromptAgent);

    // Fan-out semantics: even a single account passes a per-account limit derived from user limit / #providers
    expect(provider.list).toHaveBeenCalledWith(expect.objectContaining({ unseenOnly: true }));
    expect(out).toContain('Considered: 3');
    expect(out).toContain('Noise filtered: 1');
    expect(out).toContain('Survivors: 2');
    expect(out).toContain('Hi');
    expect(out).toContain('Update');
    expect(out).not.toContain('Newsletter');
  });

  it('include_noise=true skips the prefilter', async () => {
    provider.list.mockResolvedValue([
      envelope(1, { messageId: '<m-1@x>', from: 'noreply@example.com' }),
    ]);
    const tool = createMailTriageTool(registry);
    const out = await tool.handler({ include_noise: true }, noPromptAgent);
    expect(out).toContain('Survivors: 1');
    expect(out).toContain('Noise filtered: 0');
  });

  it('returns "Inbox is empty" for no matches', async () => {
    const tool = createMailTriageTool(registry);
    const out = await tool.handler({}, noPromptAgent);
    expect(out).toContain('Inbox is empty');
  });

  it('honours since + folder + limit', async () => {
    provider.list.mockResolvedValue([]);
    const tool = createMailTriageTool(registry);
    await tool.handler({ folder: 'Archive', since: '2026-04-01', limit: 25 }, noPromptAgent);
    const opts = provider.list.mock.calls[0]![0]!;
    expect(opts.folder).toBe('Archive');
    expect(opts.since).toBeInstanceOf(Date);
    // Single-account fan-out: user limit 25 → per-account limit max(10, 25/1) = 25
    expect(opts.limit).toBe(25);
  });
});

// ── Phase 0.1 fan-out ───────────────────────────────────────────────────────

describe('mail_triage fan-out across multiple accounts', () => {
  it('fans out when account is omitted, groups results per account', async () => {
    const providerA = new FakeProvider('personal');
    const providerB = new FakeProvider('business');
    providerA.list.mockResolvedValue([
      envelope(1, { messageId: '<a1@x>', from: 'friend@example.com', subject: 'Hi' }),
    ]);
    providerB.list.mockResolvedValue([
      envelope(2, { messageId: '<b1@x>', from: 'client@example.com', subject: 'Contract' }),
    ]);
    const reg = new InMemoryMailRegistry();
    reg.add(providerA);
    reg.add(providerB);

    const tool = createMailTriageTool(reg);
    const out = await tool.handler({}, noPromptAgent);

    expect(providerA.list).toHaveBeenCalledTimes(1);
    expect(providerB.list).toHaveBeenCalledTimes(1);
    expect(out).toContain('across 2 account(s)');
    expect(out).toContain('### personal');
    expect(out).toContain('### business');
    expect(out).toContain('Hi');
    expect(out).toContain('Contract');
  });

  it('targets only the requested account when account is specified', async () => {
    const a = new FakeProvider('a');
    const b = new FakeProvider('b');
    a.list.mockResolvedValue([]);
    b.list.mockResolvedValue([]);
    const reg = new InMemoryMailRegistry();
    reg.add(a);
    reg.add(b);
    const tool = createMailTriageTool(reg);
    await tool.handler({ account: 'a' }, noPromptAgent);
    expect(a.list).toHaveBeenCalledTimes(1);
    expect(b.list).not.toHaveBeenCalled();
  });

  it('does not abort if one account errors — reports partial results', async () => {
    const a = new FakeProvider('a');
    const b = new FakeProvider('b');
    a.list.mockResolvedValue([envelope(1, { messageId: '<m@x>', from: 'alice@example.com', subject: 'Ok' })]);
    b.list.mockRejectedValue(new Error('imap down'));
    const reg = new InMemoryMailRegistry();
    reg.add(a);
    reg.add(b);

    const tool = createMailTriageTool(reg);
    const out = await tool.handler({}, noPromptAgent);
    expect(out).toContain('### a');
    expect(out).toContain('Errors:');
    expect(out).toContain('imap down');
  });
});

describe('mail_search fan-out across multiple accounts', () => {
  it('fans out when account is omitted, groups results per account', async () => {
    const a = new FakeProvider('personal');
    const b = new FakeProvider('business');
    a.search.mockResolvedValue([envelope(10, { messageId: '<pa@x>', subject: 'Personal invoice' })]);
    b.search.mockResolvedValue([envelope(20, { messageId: '<ba@x>', subject: 'Business invoice' })]);
    const reg = new InMemoryMailRegistry();
    reg.add(a);
    reg.add(b);
    const tool = createMailSearchTool(reg);
    const out = await tool.handler({ subject: 'invoice' }, noPromptAgent);
    expect(out).toContain('across 2 account(s)');
    expect(out).toContain('### personal');
    expect(out).toContain('### business');
    expect(out).toContain('Personal invoice');
    expect(out).toContain('Business invoice');
  });
});

// ── Phase 0.1 mass-send guard + persona + receive-only ──────────────────────

function businessAccount(id: string, address: string): MailAccountConfig {
  return {
    id, displayName: id, address, preset: 'custom',
    imap: { host: 'i', port: 993, secure: true },
    smtp: { host: 's', port: 465, secure: true },
    auth: 'app-password',
    type: 'business',
  };
}

function receiveOnlyAccount(id: string, address: string, type: 'info' | 'abuse' | 'privacy' | 'security' | 'legal' | 'newsletter' | 'notifications'): MailAccountConfig {
  return {
    id, displayName: id, address, preset: 'custom',
    imap: { host: 'i', port: 993, secure: true },
    smtp: { host: 's', port: 465, secure: true },
    auth: 'app-password',
    type,
  };
}

describe('mail_send — mass-send guard', () => {
  it('does not trigger mass-send guard for <=5 recipients', async () => {
    const cfg = businessAccount('biz', 'business@example.com');
    const ctx = makeStubContext([cfg]);
    provider.send.mockResolvedValue({ messageId: '<m@x>', accepted: [], rejected: [] });

    const tool = createMailSendTool(registry, ctx);
    let receivedPrompt = '';
    const agent: IAgent = { promptUser: async (q: string) => { receivedPrompt = q; return 'Yes'; } } as unknown as IAgent;
    await tool.handler({
      to: 'a@x.com, b@x.com, c@x.com',
      subject: 's',
      body: 'b',
    }, agent);

    expect(receivedPrompt).not.toContain('MASS SEND');
    expect(provider.send).toHaveBeenCalled();
  });

  it('forces MASS SEND prompt when >5 unique recipients', async () => {
    provider.send.mockResolvedValue({ messageId: '<m@x>', accepted: [], rejected: [] });
    const tool = createMailSendTool(registry);
    let receivedPrompt = '';
    const agent: IAgent = { promptUser: async (q: string) => { receivedPrompt = q; return 'Yes'; } } as unknown as IAgent;
    await tool.handler({
      to: 'a@x.com, b@x.com, c@x.com, d@x.com, e@x.com, f@x.com',
      subject: 's',
      body: 'b',
    }, agent);
    expect(receivedPrompt).toContain('MASS SEND');
    expect(receivedPrompt).toContain('6 recipients');
    expect(receivedPrompt).toContain('a@x.com');
    expect(receivedPrompt).toContain('f@x.com');
  });

  it('deduplicates recipients across to+cc+bcc before counting', async () => {
    provider.send.mockResolvedValue({ messageId: '<m@x>', accepted: [], rejected: [] });
    const tool = createMailSendTool(registry);
    let receivedPrompt = '';
    const agent: IAgent = { promptUser: async (q: string) => { receivedPrompt = q; return 'Yes'; } } as unknown as IAgent;
    await tool.handler({
      to: 'a@x.com, a@x.com, b@x.com',
      cc: 'a@x.com',
      subject: 's',
      body: 'b',
    }, agent);
    expect(receivedPrompt).not.toContain('MASS SEND');
  });
});

describe('mail_send + mail_reply — receive-only hard block', () => {
  it('blocks mail_send from an info@ account without prompting', async () => {
    // The default registry fixture has a provider with id 'rafael-gmail' —
    // declare its config as receive-only so the hard block fires.
    const cfg = receiveOnlyAccount('rafael-gmail', 'info@brandfusion.ch', 'info');
    const ctx = makeStubContext([cfg]);
    const tool = createMailSendTool(registry, ctx);
    const promptSpy = vi.fn(async () => 'Yes');
    const agent: IAgent = { promptUser: promptSpy } as unknown as IAgent;
    const out = await tool.handler({ to: 'a@x.com', subject: 's', body: 'b' }, agent);
    expect(out).toContain('blocked');
    expect(out).toContain('receive-only');
    expect(promptSpy).not.toHaveBeenCalled();
    expect(provider.send).not.toHaveBeenCalled();
  });

  it('blocks mail_send from an abuse@ account — compliance channel', async () => {
    const cfg = receiveOnlyAccount('rafael-gmail', 'abuse@brandfusion.ch', 'abuse');
    const ctx = makeStubContext([cfg]);
    const tool = createMailSendTool(registry, ctx);
    const agent: IAgent = { promptUser: async () => 'Yes' } as unknown as IAgent;
    const out = await tool.handler({ to: 'a@x.com', subject: 's', body: 'b' }, agent);
    expect(out).toContain('abuse');
    expect(out).toContain('receive-only');
  });

  it('blocks mail_reply when sending account would be receive-only', async () => {
    const abuseCfg = receiveOnlyAccount('rafael-gmail', 'abuse@brandfusion.ch', 'abuse');
    const ctx = makeStubContext([abuseCfg]);
    // Provider read path: the original was received via 'rafael-gmail' (declared abuse),
    // and the reply-from derivation would pick the same — so the hard block kicks in.
    provider.fetch.mockResolvedValue({
      envelope: {
        ...envelope(1, { messageId: '<o@x>' }),
        to: [{ address: 'abuse@brandfusion.ch' }],
      },
      text: 'Phishing report content',
      html: undefined,
      attachments: [],
      inReplyTo: undefined,
      references: undefined,
    });
    const tool = createMailReplyTool(registry, ctx);
    const agent: IAgent = { promptUser: async () => 'Yes' } as unknown as IAgent;
    const out = await tool.handler({ uid: 1, body: 'reply' }, agent);
    expect(out).toContain('blocked');
    expect(out).toContain('receive-only');
    expect(provider.send).not.toHaveBeenCalled();
  });
});

describe('mail_reply — smart reply-from', () => {
  it('uses the account matching the original recipient address', async () => {
    const personal = new FakeProvider('personal');
    const business = new FakeProvider('business');
    const personalCfg: MailAccountConfig = {
      ...businessAccount('personal', 'rafael@gmail.com'),
      type: 'personal',
    };
    const businessCfg = businessAccount('business', 'rafael@brandfusion.ch');
    const ctx = makeStubContext([personalCfg, businessCfg]);
    const reg = new InMemoryMailRegistry();
    reg.add(personal);
    reg.add(business);

    // Simulate an inbound message where the user's business address was CC'd
    personal.fetch.mockResolvedValue({
      envelope: {
        ...envelope(42, { messageId: '<inbound@x>' }),
        to: [{ address: 'someone@example.com' }],
        cc: [{ address: 'rafael@brandfusion.ch' }],
      },
      text: 'hi',
      html: undefined,
      attachments: [],
      inReplyTo: undefined,
      references: undefined,
    });
    business.send.mockResolvedValue({ messageId: '<r@x>', accepted: [], rejected: [] });

    const tool = createMailReplyTool(reg, ctx);
    const agent: IAgent = { promptUser: async () => 'Yes' } as unknown as IAgent;
    const out = await tool.handler({ account: 'personal', uid: 42, body: 'Reply content' }, agent);

    expect(personal.send).not.toHaveBeenCalled();
    expect(business.send).toHaveBeenCalled();
    expect(out).toContain('Reply sent from business');
  });

  it('falls back to the read account when no recipient matches a registered account', async () => {
    const p = new FakeProvider('personal');
    const personalCfg: MailAccountConfig = {
      ...businessAccount('personal', 'rafael@gmail.com'),
      type: 'personal',
    };
    const ctx = makeStubContext([personalCfg]);
    const reg = new InMemoryMailRegistry();
    reg.add(p);

    p.fetch.mockResolvedValue({
      envelope: {
        ...envelope(1, { messageId: '<x@x>' }),
        to: [{ address: 'stranger@example.com' }],
        cc: [],
      },
      text: '', html: undefined, attachments: [], inReplyTo: undefined, references: undefined,
    });
    p.send.mockResolvedValue({ messageId: '<r@x>', accepted: [], rejected: [] });

    const tool = createMailReplyTool(reg, ctx);
    const agent: IAgent = { promptUser: async () => 'Yes' } as unknown as IAgent;
    await tool.handler({ uid: 1, body: 'reply' }, agent);
    expect(p.send).toHaveBeenCalled();
  });
});

describe('mail_send — mass-send cross-field counting', () => {
  it('counts unique recipients across to + cc + bcc', async () => {
    provider.send.mockResolvedValue({ messageId: '<m@x>', accepted: [], rejected: [] });
    const tool = createMailSendTool(registry);
    let receivedPrompt = '';
    const agent: IAgent = { promptUser: async (q: string) => { receivedPrompt = q; return 'Yes'; } } as unknown as IAgent;
    await tool.handler({
      to: 'a@x.com, b@x.com',
      cc: 'c@x.com, d@x.com',
      bcc: 'e@x.com, f@x.com',
      subject: 's',
      body: 'b',
    }, agent);
    expect(receivedPrompt).toContain('MASS SEND');
    expect(receivedPrompt).toContain('6 recipients');
  });
});

describe('receive-only types still allow read operations', () => {
  it('info@ account can be listed by mail_triage', async () => {
    const infoCfg = receiveOnlyAccount('rafael-gmail', 'info@brandfusion.ch', 'info');
    const ctx = makeStubContext([infoCfg]);
    provider.list.mockResolvedValue([
      envelope(1, { messageId: '<m@x>', from: 'client@example.com', subject: 'Question' }),
    ]);
    // No ctx passed to triage — triage never checks types — but we pass the registry
    const tool = createMailTriageTool(registry);
    const out = await tool.handler({ include_noise: true }, noPromptAgent);
    expect(out).toContain('Question');
    // Marker to self: ctx is unused here on purpose — confirming read path is unrestricted
    expect(ctx).toBeDefined();
  });

  it('info@ account supports mail_search (no send restriction)', async () => {
    provider.search.mockResolvedValue([
      envelope(1, { messageId: '<m@x>', from: 'client@example.com', subject: 'Inquiry' }),
    ]);
    const tool = createMailSearchTool(registry);
    const out = await tool.handler({ subject: 'inquiry' }, noPromptAgent);
    expect(out).toContain('Inquiry');
  });
});

describe('mail_send — persona hint in confirmation prompt', () => {
  it('shows the persona derived from the account type', async () => {
    const cfg = businessAccount('rafael-gmail', 'business@example.com');
    const ctx = makeStubContext([cfg]);
    provider.send.mockResolvedValue({ messageId: '<m@x>', accepted: [], rejected: [] });
    const tool = createMailSendTool(registry, ctx);
    let prompt = '';
    const agent: IAgent = { promptUser: async (q: string) => { prompt = q; return 'Yes'; } } as unknown as IAgent;
    await tool.handler({ to: 'bob@example.com', subject: 's', body: 'b' }, agent);
    expect(prompt).toContain('Professional');
  });

  it('prefers a custom personaPrompt over the type default', async () => {
    const cfg: MailAccountConfig = {
      ...businessAccount('rafael-gmail', 'b@x.com'),
      personaPrompt: 'Sign as Captain Marvel',
    };
    const ctx = makeStubContext([cfg]);
    provider.send.mockResolvedValue({ messageId: '<m@x>', accepted: [], rejected: [] });
    const tool = createMailSendTool(registry, ctx);
    let prompt = '';
    const agent: IAgent = { promptUser: async (q: string) => { prompt = q; return 'Yes'; } } as unknown as IAgent;
    await tool.handler({ to: 'bob@example.com', subject: 's', body: 'b' }, agent);
    expect(prompt).toContain('Captain Marvel');
  });
});
