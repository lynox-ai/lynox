// The mail tools' consent step in a call the danger check marked `filing`: the tool files the
// exact mail it would have asked about, sends nothing, and keeps every check it runs before
// consent.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  MailEnvelope, MailFetchOptions, MailListOptions, MailMessage, MailProvider,
  MailSearchOptions, MailSearchQuery, MailSendInput, MailSendResult, MailWatchHandle,
} from '../provider.js';
import type { IAgent } from '../../../types/index.js';
import { InMemoryMailRegistry } from './registry.js';
import { createMailSendTool } from './mail-send.js';
import { createMailReplyTool } from './mail-reply.js';
import { resetMailRateLimits } from './rate-limit.js';
import { runInCallSlot } from '../../../core/call-connection.js';
import { NOT_MARKED_MESSAGE, type FilingOutcome } from '../../../core/approval-filing.js';
import type { ApprovalFiling } from '../../../core/approval-store.js';
import { replyRecipientDiffers } from '../../../core/approval-view.js';

class FakeProvider implements MailProvider {
  readonly accountId: string;
  readonly address: string;
  list = vi.fn(async (_opts?: MailListOptions): Promise<ReadonlyArray<MailEnvelope>> => []);
  fetch = vi.fn(async (_opts: MailFetchOptions): Promise<MailMessage> => { throw new Error('not configured'); });
  search = vi.fn(async (_q: MailSearchQuery, _o?: MailSearchOptions): Promise<ReadonlyArray<MailEnvelope>> => []);
  send = vi.fn(async (_input: MailSendInput): Promise<MailSendResult> => ({ messageId: '<sent@x>', accepted: [], rejected: [] }));
  watch = vi.fn(async (): Promise<MailWatchHandle> => ({ stop: async () => {} }));
  close = vi.fn(async () => {});
  constructor(id: string, address = `${id}@example.com`) { this.accountId = id; this.address = address; }
}

function envelope(uid: number, over: Partial<MailEnvelope> = {}): MailEnvelope {
  return {
    uid, messageId: `<${String(uid)}@x>`, folder: 'Kunden', threadKey: `<${String(uid)}@x>`, inReplyTo: undefined,
    from: [{ name: 'Alice', address: 'alice@example.com' }], to: [{ address: 'me@example.com' }], cc: [{ address: 'carl@example.com' }],
    replyTo: [], subject: 'Angebot', date: new Date('2026-10-20T10:00:00Z'), flags: [], snippet: 's',
    hasAttachments: false, attachmentCount: 0, sizeBytes: 1, isAutoReply: false, ...over,
  };
}

let provider: FakeProvider;
let registry: InMemoryMailRegistry;

beforeEach(() => {
  provider = new FakeProvider('acc-1');
  registry = new InMemoryMailRegistry();
  registry.add(provider);
  registry.setDefault(provider.accountId);
  resetMailRateLimits();
});

/** An agent of a run nobody watches: no one to ask, a filing method that records what it got. */
function filingAgent(outcome: FilingOutcome = { ok: true, id: 'e-1', message: 'Queued for the owner\'s approval (entry e-1). Nothing was sent.' }) {
  const filed: ApprovalFiling[] = [];
  const agent = { fileApproval: vi.fn((f: ApprovalFiling) => { filed.push(f); return outcome; }) } as unknown as IAgent;
  return { agent, filed };
}

const marked = <T>(fn: () => Promise<T>): Promise<T> => runInCallSlot({ filing: true }, fn);

describe('mail_send in a marked call', () => {
  it('files the mail as it would go out, and sends nothing', async () => {
    const { agent, filed } = filingAgent();
    const body = 'Guten Tag,\nhier der Bericht\nfür die Woche.';
    const out = await marked(() => createMailSendTool(registry).handler({
      to: 'Bob <bob@example.com>', cc: 'carl@example.com', bcc: 'dora@example.com', subject: 'Wochenbericht', body,
      track_followup: { reminder_in_days: 3, reason: 'awaiting reply', type: 'awaiting_reply' },
    }, agent));
    expect(out).toBe('Queued for the owner\'s approval (entry e-1). Nothing was sent.');
    expect(provider.send).not.toHaveBeenCalled();
    expect(filed).toEqual([{
      kind: 'mail_send',
      payload: {
        accountId: 'acc-1', fromAddress: 'acc-1@example.com',
        to: [{ name: 'Bob', address: 'bob@example.com' }], cc: [{ address: 'carl@example.com' }], bcc: [{ address: 'dora@example.com' }],
        subject: 'Wochenbericht', bodyText: 'Guten Tag, hier der Bericht für die Woche.',
        trackFollowup: { reminder_in_days: 3, reason: 'awaiting reply', type: 'awaiting_reply' },
      },
    }]);
  });

  it('a refusal of the queue is the result, and nothing is sent', async () => {
    const { agent } = filingAgent({ ok: false, message: 'Not queued: the owner discarded this mail (entry e-0). Nothing was sent.' });
    const out = await marked(() => createMailSendTool(registry).handler({ to: 'bob@example.com', subject: 's', body: 'b' }, agent));
    expect(out).toBe('Not queued: the owner discarded this mail (entry e-0). Nothing was sent.');
    expect(provider.send).not.toHaveBeenCalled();
  });

  it('the checks before consent still refuse: a secret in the body is not filed', async () => {
    const { agent, filed } = filingAgent();
    const out = await marked(() => createMailSendTool(registry).handler({ to: 'bob@example.com', subject: 's', body: 'key sk-ant-api03-' + 'a'.repeat(90) }, agent));
    expect(out).not.toMatch(/^Queued/);
    expect(filed).toEqual([]);
    expect(provider.send).not.toHaveBeenCalled();
  });

  it('an agent without the filing method files nothing and sends nothing', async () => {
    const out = await marked(() => createMailSendTool(registry).handler({ to: 'bob@example.com', subject: 's', body: 'b' }, {} as IAgent));
    expect(out).toBe(NOT_MARKED_MESSAGE);
    expect(provider.send).not.toHaveBeenCalled();
  });

  it('unmarked and with no one to ask, it is refused as before', async () => {
    const { agent, filed } = filingAgent();
    const out = await createMailSendTool(registry).handler({ to: 'bob@example.com', subject: 's', body: 'b' }, agent);
    expect(out).toContain('mail_send error');
    expect(filed).toEqual([]);
  });
});

describe('mail_reply in a marked call', () => {
  it('files the reply with what binds it to the original, and sends nothing', async () => {
    provider.fetch.mockResolvedValue({ envelope: envelope(41), text: 'Original.', html: undefined, attachments: [], inReplyTo: undefined, references: '<0@x>' });
    const { agent, filed } = filingAgent();
    const out = await marked(() => createMailReplyTool(registry).handler({ uid: 41, folder: 'Kunden', body: 'Danke,\nwir melden uns.', reply_all: true }, agent));
    expect(out).toBe('Queued for the owner\'s approval (entry e-1). Nothing was sent.');
    expect(provider.send).not.toHaveBeenCalled();
    expect(filed).toEqual([{
      kind: 'mail_reply',
      payload: {
        accountId: 'acc-1', fromAddress: 'acc-1@example.com',
        to: [{ name: 'Alice', address: 'alice@example.com' }],
        // Reply-all: the original's To and Cc, without the sending address.
        cc: [{ address: 'me@example.com' }, { address: 'carl@example.com' }],
        subject: 'Re: Angebot', bodyText: 'Danke, wir melden uns.',
        inReplyTo: '<41@x>', references: '<0@x> <41@x>',
        originalThreadKey: '<41@x>', originalMessageId: '<41@x>', originalFolderUid: 'Kunden:41',
        original: { from: 'alice@example.com', to: ['me@example.com'], cc: ['carl@example.com'], replyTo: [], subject: 'Angebot', date: '2026-10-20T10:00:00.000Z' },
      },
    }]);
  });

  it('keeps the original\'s Reply-To, where the reply goes by default, so the card knows the address', async () => {
    provider.fetch.mockResolvedValue({ envelope: envelope(43, { replyTo: [{ address: 'tickets@example.com' }] }), text: 'Original.', html: undefined, attachments: [], inReplyTo: undefined, references: undefined });
    const { agent, filed } = filingAgent();
    await marked(() => createMailReplyTool(registry).handler({ uid: 43, folder: 'Kunden', body: 'Danke.' }, agent));
    expect(filed).toHaveLength(1);
    const f = filed[0]!;
    if (f.kind !== 'mail_reply') throw new Error('not a reply');
    expect(f.payload.to).toEqual([{ address: 'tickets@example.com' }]);
    expect(f.payload.original.replyTo).toEqual(['tickets@example.com']);
    expect(replyRecipientDiffers({ filing: f })).toBe(false);
  });

  it('the checks before consent still refuse: an auto-reply is not answered or filed', async () => {
    provider.fetch.mockResolvedValue({ envelope: envelope(42, { isAutoReply: true }), text: 'Out of office.', html: undefined, attachments: [], inReplyTo: undefined, references: undefined });
    const { agent, filed } = filingAgent();
    const out = await marked(() => createMailReplyTool(registry).handler({ uid: 42, body: 'Hi' }, agent));
    expect(out).toMatch(/^mail_reply blocked: original message has Auto-Submitted header/);
    expect(filed).toEqual([]);
  });

  it('unmarked and with no one to ask, it is refused as before, before reading the original', async () => {
    const { agent, filed } = filingAgent();
    const out = await createMailReplyTool(registry).handler({ uid: 41, body: 'Hi' }, agent);
    expect(out).toContain('mail_reply error');
    expect(provider.fetch).not.toHaveBeenCalled();
    expect(filed).toEqual([]);
  });
});

/**
 * Every input field of the two tools is bound by the payload, or listed here with the reason it
 * is not stored as itself. A new input field fails this until it is bound or listed; a payload
 * field the filing stops writing fails it too.
 */
describe('what a filing binds: the input fields against the payload', () => {
  const SEND_INPUT_TO_PAYLOAD: Record<string, string> = {
    account: 'accountId', to: 'to', cc: 'cc', bcc: 'bcc', subject: 'subject', body: 'bodyText', track_followup: 'trackFollowup',
  };
  const REPLY_INPUT_TO_PAYLOAD: Record<string, string> = {
    // The account the reply is sent from: the one read from, or the one an original recipient names.
    account: 'accountId',
    // The original is named by Message-ID, or by folder and UID when it has none.
    uid: 'originalFolderUid', folder: 'originalFolderUid',
    body: 'bodyText', to: 'to', cc: 'cc',
    // Reply-all is resolved into the stored Cc before filing.
    reply_all: 'cc',
  };
  /** Payload fields no input field names: derived by the tool from the account or the original. */
  const SEND_DERIVED = ['fromAddress'];
  const REPLY_DERIVED = ['fromAddress', 'subject', 'inReplyTo', 'references', 'originalThreadKey', 'originalMessageId', 'original', 'persona'];

  it('mail_send', async () => {
    const props = Object.keys(createMailSendTool(registry).definition.input_schema.properties ?? {}).sort();
    expect(props).toEqual(Object.keys(SEND_INPUT_TO_PAYLOAD).sort());
    const { agent, filed } = filingAgent();
    await marked(() => createMailSendTool(registry).handler({
      account: 'acc-1', to: 'bob@example.com', cc: 'c@example.com', bcc: 'd@example.com', subject: 's', body: 'b',
      track_followup: { reminder_in_days: 1, reason: 'r' },
    }, agent));
    const keys = Object.keys(filed[0]!.payload).sort();
    expect(keys).toEqual([...new Set([...Object.values(SEND_INPUT_TO_PAYLOAD), ...SEND_DERIVED])].sort());
  });

  it('mail_reply', async () => {
    const props = Object.keys(createMailReplyTool(registry).definition.input_schema.properties ?? {}).sort();
    expect(props).toEqual(Object.keys(REPLY_INPUT_TO_PAYLOAD).sort());
    provider.fetch.mockResolvedValue({ envelope: envelope(41), text: 'o', html: undefined, attachments: [], inReplyTo: undefined, references: undefined });
    const { agent, filed } = filingAgent();
    await marked(() => createMailReplyTool(registry, {
      getAccountConfig: () => ({ id: 'acc-1', address: 'acc-1@example.com', type: 'business' }),
      findAccountByAddress: () => null,
      notifyOutboundSent: async () => {},
    } as never).handler({ uid: 41, body: 'b' }, agent));
    const keys = Object.keys(filed[0]!.payload).sort();
    expect(keys).toEqual([...new Set([...Object.values(REPLY_INPUT_TO_PAYLOAD), ...REPLY_DERIVED])].sort());
  });
});
