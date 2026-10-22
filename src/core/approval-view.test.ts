import { describe, it, expect } from 'vitest';
import {
  approvalCard, approvalOutcome, approvalScopeOf, replyRecipientDiffers, setupLines, mandateAddressOf,
  type ApprovalCardSources, type MandateNamer, type SetupMarks,
} from './approval-view.js';
import type { ApprovalEntry, MailReplyPayload, MailSendPayload, StoredAddress } from './approval-store.js';
import { MASS_SEND_THRESHOLD } from '../integrations/mail/send-core.js';
import { OWNER_PRINCIPAL } from './request-principal.js';

const T0 = Date.parse('2026-10-21T08:00:00.000Z');

const reply = (over: Partial<MailReplyPayload> = {}): MailReplyPayload => ({
  accountId: 'acc-1',
  fromAddress: 'owner@example.com',
  to: [{ address: 'anna@example.com' }],
  cc: [],
  subject: 'Re: Angebot',
  bodyText: 'Guten Tag, danke für die Anfrage.',
  originalThreadKey: 'thread-1',
  originalFolderUid: 'INBOX:41',
  original: { from: 'Anna@Example.com, team@example.com', to: ['owner@example.com'], cc: ['carl@example.com'], subject: 'Angebot', date: '2026-10-20T10:00:00.000Z' },
  ...over,
});

const send = (over: Partial<MailSendPayload> = {}): MailSendPayload => ({
  accountId: 'acc-1', fromAddress: 'owner@example.com', to: [{ address: 'bob@example.com' }], cc: [], bcc: [],
  subject: 'Wochenbericht', bodyText: 'Hier der Bericht.', trackFollowup: null, ...over,
});

const entry = (over: Partial<ApprovalEntry> = {}): ApprovalEntry => ({
  id: 'e-1', kind: 'mail_send', status: 'pending',
  filing: { kind: 'mail_send', payload: send() },
  origin: { source: 'workflow', triggerId: 'trg-1', runId: 'run-1', rootRunId: 'run-1' },
  originJson: '{}', executable: true, checksum: 'CHECKSUM-VALUE', binding: 'keyed',
  createdBy: 'owner', mandateId: null, heldReason: null, heldAt: null,
  createdAt: new Date(T0).toISOString(), expiresAt: new Date(T0 + 72 * 3_600_000).toISOString(),
  decidedAt: null, decidedBy: null, decidedReason: null, claimedAt: null, executedAt: null,
  attempts: 0, resultJson: null, purgeAfter: null, tombstonedAt: null,
  ...over,
});

const NAMES: Record<string, string> = { 'grant-a': 'Anna A.', 'grant-b': 'Bea B.' };
const nameOf: MandateNamer = (id, tag) => (id !== null ? NAMES[id] : undefined) ?? mandateAddressOf(tag) ?? '?';
const owner: ApprovalCardSources = { scope: { viewer: 'owner' }, nameOf, now: T0 + 90_000 };
const asMandate: ApprovalCardSources = { scope: { viewer: 'mandate', mandateId: 'grant-a' }, nameOf, now: T0 + 90_000 };

const addresses = (n: number, f = (i: number): string => `r${String(i)}@example.com`): StoredAddress[] =>
  Array.from({ length: n }, (_, i) => ({ address: f(i) }));

describe('the card\'s mass-send warning', () => {
  it('fires above the send confirmation\'s threshold, counting To, Cc and Bcc together', () => {
    const over = send({ to: addresses(2), cc: addresses(2, (i) => `c${String(i)}@example.com`), bcc: addresses(MASS_SEND_THRESHOLD - 3, (i) => `b${String(i)}@example.com`) });
    expect(approvalCard(entry({ filing: { kind: 'mail_send', payload: over } }), owner).massSend).toBe(true);
  });

  it('does not fire at the threshold, and counts an address in another case once', () => {
    const at = send({ to: addresses(MASS_SEND_THRESHOLD) });
    expect(approvalCard(entry({ filing: { kind: 'mail_send', payload: at } }), owner).massSend).toBe(false);
    const dupes = send({ to: [...addresses(MASS_SEND_THRESHOLD), { address: 'R0@EXAMPLE.COM' }] });
    expect(approvalCard(entry({ filing: { kind: 'mail_send', payload: dupes } }), owner).massSend).toBe(false);
  });

  it('is off when the payload is gone', () => {
    expect(approvalCard(entry({ filing: null, executable: false }), owner).massSend).toBe(false);
  });
});

describe('a reply to someone the original did not name', () => {
  const asReply = (p: Partial<MailReplyPayload>): Pick<ApprovalEntry, 'filing'> => ({ filing: { kind: 'mail_reply', payload: reply(p) } });

  it('is off for the original\'s sender, its other senders, its To and its Cc, in any case', () => {
    expect(replyRecipientDiffers(asReply({ to: [{ address: 'anna@example.com' }] }))).toBe(false);
    expect(replyRecipientDiffers(asReply({ to: [{ address: 'TEAM@example.com' }], cc: [{ address: 'carl@example.com' }, { address: 'owner@example.com' }] }))).toBe(false);
  });

  it('fires for an address in To that the original did not name', () => {
    expect(replyRecipientDiffers(asReply({ to: [{ address: 'mallory@example.com' }] }))).toBe(true);
  });

  it('fires for an address added in Cc', () => {
    expect(replyRecipientDiffers(asReply({ cc: [{ address: 'mallory@example.com' }] }))).toBe(true);
  });

  it('never fires for a new mail, which has no original', () => {
    expect(replyRecipientDiffers({ filing: { kind: 'mail_send', payload: send({ to: [{ address: 'mallory@example.com' }] }) } })).toBe(false);
    expect(replyRecipientDiffers({ filing: null })).toBe(false);
  });

  it('reaches the card', () => {
    expect(approvalCard(entry({ kind: 'mail_reply', filing: { kind: 'mail_reply', payload: reply({ cc: [{ address: 'x@example.com' }] }) } }), owner).recipientDiffers).toBe(true);
  });
});

describe('how an entry ended, as a code', () => {
  const at = (status: ApprovalEntry['status'], resultJson: string | null, decidedReason: string | null = null): ReturnType<typeof approvalOutcome> =>
    approvalOutcome({ status, resultJson, decidedReason });

  it('is null while the entry is open', () => {
    expect([at('pending', null), at('approved', null), at('executing', null)]).toEqual([null, null, null]);
  });

  it('reads sent, the decision\'s reason, and the stored result\'s reason', () => {
    expect(at('done', '{"messageId":"<m@x>"}')).toBe('sent');
    expect(at('rejected', null, 'owner')).toBe('discarded');
    expect(at('rejected', null, 'moved_to_chat')).toBe('moved_to_chat');
    expect(at('rejected', null, 'mandate_ended')).toBe('mandate_ended');
    expect(at('rejected', null, 'cleared_unknown')).toBe('cleared_unknown');
    expect(at('failed', '{"reason":"account_changed"}')).toBe('account_changed');
    expect(at('unknown', '{"reason":"stale_claim"}')).toBe('stale_claim');
    expect(at('expired', '{"reason":"send_limit"}')).toBe('send_limit');
  });

  it('never passes the result\'s text on: an unknown reason, a message, or no result read as other', () => {
    const leaky = JSON.stringify({ reason: 'provider said: mailbox mallory@example.com full', message: 'mallory@example.com' });
    expect(at('unknown', leaky)).toBe('other');
    expect(at('failed', 'not json')).toBe('other');
    expect(at('unknown', null)).toBe('other');
    expect(at('rejected', null, 'something new')).toBe('other');
    const card = approvalCard(entry({ status: 'unknown', resultJson: JSON.stringify({ reason: 'send_threw', message: 'mallory@example.com rejected' }) }), owner);
    expect(card.outcome).toBe('send_threw');
    expect(JSON.stringify(card)).not.toContain('mallory');
  });
});

describe('the card\'s fields', () => {
  it('carries the checksum for the owner and none for a mandate', () => {
    expect(approvalCard(entry(), owner).checksum).toBe('CHECKSUM-VALUE');
    const m = approvalCard(entry({ createdBy: 'mandate:anna@example.com', mandateId: 'grant-a' }), asMandate);
    expect('checksum' in m).toBe(false);
    expect(JSON.stringify(m)).not.toContain('CHECKSUM-VALUE');
  });

  it('never carries the binding or the raw result, and only allowlisted fields', () => {
    const card = approvalCard(entry({ status: 'failed', resultJson: '{"reason":"rate_limit","message":"secret-ish"}' }), owner);
    expect(Object.keys(card).sort()).toEqual([
      'afterUntrusted', 'ageMs', 'checksum', 'createdAt', 'decidedAt', 'executable', 'executedAt', 'expiresAt', 'held',
      'id', 'kind', 'mail', 'massSend', 'origin', 'outcome', 'recipientDiffers', 'setup', 'status', 'tombstoned',
    ]);
    expect(JSON.stringify(card)).not.toContain('secret-ish');
    expect(JSON.stringify(card)).not.toContain('keyed');
  });

  it('shows a reply\'s original, persona and the origin it came from', () => {
    const card = approvalCard(entry({
      kind: 'mail_reply', filing: { kind: 'mail_reply', payload: reply({ persona: 'Sales' }) },
      origin: { source: 'task', triggerId: 'trg-9', runId: 'run-9', rootRunId: 'run-root', threadId: 'th-9', eventId: 'ev-9', afterUntrusted: true },
    }), owner);
    expect(card.mail).toMatchObject({
      from: 'owner@example.com', persona: 'Sales', bcc: [],
      original: { from: 'Anna@Example.com, team@example.com', subject: 'Angebot', date: '2026-10-20T10:00:00.000Z' },
    });
    expect(card.origin).toEqual({ source: 'task', triggerId: 'trg-9', runId: 'run-9', threadId: 'th-9', eventId: 'ev-9' });
    expect(card.afterUntrusted).toBe(true);
    expect(card.ageMs).toBe(90_000);
  });
});

describe('who set an entry up', () => {
  const marks = (over: Partial<SetupMarks>): SetupMarks => ({ createdBy: null, createdMandateId: null, mandateEditor: null, mandateEditorId: null, ...over });
  const A = { createdBy: 'mandate:anna@example.com', mandateId: 'grant-a' };
  const B = { createdBy: 'mandate:bea@example.com', mandateId: 'grant-b' };

  it('has no line for the owner\'s own setup', () => {
    expect(setupLines({ createdBy: 'owner', mandateId: null }, marks({ createdBy: 'owner' }), marks({ createdBy: null }), nameOf)).toEqual([]);
    expect(setupLines({ createdBy: 'owner', mandateId: null }, undefined, undefined, nameOf)).toEqual([]);
  });

  it('names the entry\'s mandate as the one whose test run it was when no mark of its grant is there', () => {
    expect(setupLines(A, marks({ createdBy: 'owner' }), undefined, nameOf)).toEqual([{ kind: 'test_run_by', name: 'Anna A.' }]);
  });

  it('names the entry\'s mandate as the one who set it up when its grant created the trigger', () => {
    expect(setupLines(A, marks({ createdBy: A.createdBy, createdMandateId: 'grant-a' }), undefined, nameOf))
      .toEqual([{ kind: 'set_up_by', name: 'Anna A.' }]);
  });

  it('names the entry\'s mandate as the one who changed it last when its grant edited the workflow', () => {
    expect(setupLines(A, marks({ createdBy: 'owner' }), marks({ mandateEditor: A.createdBy, mandateEditorId: 'grant-a' }), nameOf))
      .toEqual([{ kind: 'last_changed_by', name: 'Anna A.' }]);
  });

  it('a mark of the same address under an earlier grant is not the entry\'s grant', () => {
    expect(setupLines({ ...A, mandateId: 'grant-a2' }, marks({ createdBy: A.createdBy, createdMandateId: 'grant-a' }), undefined, nameOf))
      .toEqual([{ kind: 'test_run_by', name: 'anna@example.com' }, { kind: 'set_up_by', name: 'Anna A.' }]);
  });

  it('a trigger set up by one mandate, its workflow last changed by another, run as the second: both named', () => {
    const lines = setupLines(B,
      marks({ createdBy: A.createdBy, createdMandateId: 'grant-a' }),
      marks({ createdBy: 'owner', mandateEditor: B.createdBy, mandateEditorId: 'grant-b' }),
      nameOf);
    expect(lines).toEqual([{ kind: 'last_changed_by', name: 'Bea B.' }, { kind: 'set_up_by', name: 'Anna A.' }]);
  });

  it('names a mandate\'s marks on an owner-filed entry', () => {
    expect(setupLines({ createdBy: 'owner', mandateId: null },
      marks({ createdBy: A.createdBy, createdMandateId: 'grant-a', mandateEditor: B.createdBy, mandateEditorId: 'grant-b' }), undefined, nameOf))
      .toEqual([{ kind: 'set_up_by', name: 'Anna A.' }, { kind: 'last_changed_by', name: 'Bea B.' }]);
  });

  it('names a mandate that filed without a grant by its address, as a test run', () => {
    expect(setupLines({ createdBy: A.createdBy, mandateId: null }, undefined, undefined, nameOf)).toEqual([{ kind: 'test_run_by', name: 'anna@example.com' }]);
  });

  it('names the same mark once, when trigger and workflow both carry it', () => {
    const both = marks({ createdBy: A.createdBy, createdMandateId: 'grant-a' });
    expect(setupLines(A, both, both, nameOf)).toEqual([{ kind: 'set_up_by', name: 'Anna A.' }]);
  });

  it('reaches the card from the sources', () => {
    const card = approvalCard(entry(A), { ...owner, trigger: marks({ createdBy: 'owner' }) });
    expect(card.setup).toEqual([{ kind: 'test_run_by', name: 'Anna A.' }]);
  });
});

describe('the scope a principal reads in', () => {
  it('the owner reads everything; a mandate its grant; a mandate without a grant, and the control plane, nothing', () => {
    expect(approvalScopeOf(OWNER_PRINCIPAL)).toEqual({ viewer: 'owner' });
    expect(approvalScopeOf({ kind: 'mandate', email: 'a@example.com', mandateId: 'grant-a' })).toEqual({ viewer: 'mandate', mandateId: 'grant-a' });
    expect(approvalScopeOf({ kind: 'mandate', email: 'a@example.com' })).toBeNull();
    expect(approvalScopeOf({ kind: 'mandate', email: 'a@example.com', mandateId: '' })).toBeNull();
    expect(approvalScopeOf({ kind: 'cp-admin' })).toBeNull();
  });
});
