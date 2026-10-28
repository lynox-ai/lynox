import { describe, it, expect } from 'vitest';
import {
  approvalCard, approvalChatThread, approvalOutcome, approvalScopeOf, listScopeOf, mandateNamer, plainAddresses, replyRecipientDiffers, replyToElsewhere, setupLines, UNNAMED_MANDATE,
  type ApprovalCardSources, type DisplayNameOf, type MandateNamer, type SetupMarks,
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

const NAMES = new Map([['grant-a', 'Anna A.'], ['grant-b', 'Bea B.']]);
const displayNameOf: DisplayNameOf = (id) => NAMES.get(id) ?? null;
/** The owner's namer: every grant by its trail name. */
const nameOf: MandateNamer = mandateNamer({ viewer: 'owner' }, displayNameOf);
const owner: ApprovalCardSources = { scope: { viewer: 'owner' }, displayNameOf, now: T0 + 90_000 };
const asMandate: ApprovalCardSources = { scope: { viewer: 'mandate', mandateId: 'grant-a' }, displayNameOf, now: T0 + 90_000 };

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

  describe('with the original\'s Reply-To stored', () => {
    const shop = { from: 'shop@example.com', to: ['owner@example.com'], cc: [], replyTo: ['Support@Example.com'], subject: 'Bestellung', date: '' };

    it('is off for a reply that goes to the Reply-To, which is where a reply goes by default', () => {
      expect(replyRecipientDiffers(asReply({ original: shop, to: [{ address: 'support@example.com' }] }))).toBe(false);
      const card = approvalCard(entry({ kind: 'mail_reply', filing: { kind: 'mail_reply', payload: reply({ original: shop, to: [{ address: 'support@example.com' }] }) } }), owner);
      expect(card.recipientDiffers).toBe(false);
    });

    it('fires for an address that is neither the From, To, Cc nor Reply-To', () => {
      expect(replyRecipientDiffers(asReply({ original: shop, to: [{ address: 'support@example.com' }], cc: [{ address: 'mallory@example.com' }] }))).toBe(true);
    });

    it('an original filed before the Reply-To was stored is compared as before: the Reply-To is not known', () => {
      const { replyTo: _dropped, ...old } = shop;
      expect('replyTo' in old).toBe(false);
      expect(replyRecipientDiffers(asReply({ original: old, to: [{ address: 'support@example.com' }] }))).toBe(true);
      expect(replyRecipientDiffers(asReply({ original: old, to: [{ address: 'shop@example.com' }] }))).toBe(false);
    });
  });
});

describe('a reply that goes to the original\'s Reply-To, not to its sender', () => {
  const asReply = (p: Partial<MailReplyPayload>): Pick<ApprovalEntry, 'filing'> => ({ filing: { kind: 'mail_reply', payload: reply(p) } });
  const original = (from: string, replyTo?: string[]): MailReplyPayload['original'] => ({
    from, to: ['owner@example.com'], cc: [], subject: 'Bestellung', date: '', ...(replyTo !== undefined ? { replyTo } : {}),
  });

  it('names the Reply-To and the sender when the reply goes to a Reply-To that is not the sender', () => {
    expect(replyToElsewhere(asReply({ original: original('shop@example.com', ['help@service.example']), to: [{ address: 'help@service.example' }] })))
      .toEqual({ replyTo: ['help@service.example'], from: ['shop@example.com'] });
  });

  it('compares the whole address: the same domain with another local part is another address', () => {
    expect(replyToElsewhere(asReply({ original: original('shop@example.com', ['support@example.com']), to: [{ address: 'support@example.com' }] })))
      .toEqual({ replyTo: ['support@example.com'], from: ['shop@example.com'] });
  });

  it('is null when the Reply-To is the sender, in another case', () => {
    expect(replyToElsewhere(asReply({ original: original('Shop@Example.com', ['shop@EXAMPLE.com']), to: [{ address: 'shop@example.com' }] }))).toBeNull();
  });

  it('is null when the original has no Reply-To', () => {
    expect(replyToElsewhere(asReply({ original: original('shop@example.com', []), to: [{ address: 'shop@example.com' }] }))).toBeNull();
    expect(replyToElsewhere(asReply({ original: original('shop@example.com', []), to: [{ address: 'other@service.example' }] }))).toBeNull();
  });

  it('is null for an original filed before its Reply-To was stored', () => {
    expect(replyToElsewhere(asReply({ original: original('shop@example.com'), to: [{ address: 'help@service.example' }] }))).toBeNull();
  });

  it('names an address once when the reply has it in both To and Cc', () => {
    expect(replyToElsewhere(asReply({
      original: original('shop@example.com', ['help@service.example']),
      to: [{ address: 'help@service.example' }], cc: [{ address: 'Help@Service.example' }],
    }))).toEqual({ replyTo: ['help@service.example'], from: ['shop@example.com'] });
  });

  it('an original filed before its Reply-To was stored: the card has no line, even for a reply to one of the original\'s other recipients', () => {
    const old = (to: StoredAddress[]): ApprovalEntry => entry({ kind: 'mail_reply', filing: { kind: 'mail_reply', payload: reply({
      original: { from: 'shop@example.com', to: ['owner@example.com', 'team@example.com'], cc: ['partner@example.com'], subject: 'Bestellung', date: '' },
      to,
    }) } });
    expect(approvalCard(old([{ address: 'help@service.example' }]), owner).replyToElsewhere).toBeNull();
    expect(approvalCard(old([{ address: 'team@example.com' }, { address: 'partner@example.com' }]), owner).replyToElsewhere).toBeNull();
  });

  it('is null when the reply does not go to the Reply-To', () => {
    expect(replyToElsewhere(asReply({ original: original('shop@example.com', ['help@service.example']), to: [{ address: 'shop@example.com' }] }))).toBeNull();
  });

  it('names every Reply-To the reply goes to, the second one too, and a Cc', () => {
    expect(replyToElsewhere(asReply({
      original: original('shop@example.com', ['first@service.example', 'second@service.example']),
      to: [{ address: 'shop@example.com' }, { address: 'second@service.example' }],
    }))).toEqual({ replyTo: ['second@service.example'], from: ['shop@example.com'] });
    expect(replyToElsewhere(asReply({
      original: original('shop@example.com', ['first@service.example', 'second@service.example']),
      to: [{ address: 'First@Service.example' }], cc: [{ address: 'second@service.example' }],
    }))).toEqual({ replyTo: ['First@Service.example', 'second@service.example'], from: ['shop@example.com'] });
  });

  it('names a Reply-To that is the original\'s second sender: only the first From is the sender', () => {
    expect(replyToElsewhere(asReply({
      original: original('support@bank.example, evil@x.example', ['evil@x.example']),
      to: [{ address: 'evil@x.example' }],
    }))).toEqual({ replyTo: ['evil@x.example'], from: ['support@bank.example'] });
    expect(replyToElsewhere(asReply({
      original: original('Support@Bank.example, evil@x.example', ['support@bank.example']),
      to: [{ address: 'support@bank.example' }],
    }))).toBeNull();
  });

  it('reads the sender\'s address out of a joined line, with or without a display name', () => {
    expect(plainAddresses('anna@example.com, team@example.com')).toEqual(['anna@example.com', 'team@example.com']);
    expect(plainAddresses('"Doe, Jane" <jane@example.com>, Shop <shop@example.com>')).toEqual(['jane@example.com', 'shop@example.com']);
    expect(plainAddresses('Doe, Jane <jane@example.com>')).toEqual(['jane@example.com']);
    expect(plainAddresses('')).toEqual([]);
    // A comment after the brackets leaves the address inside them the sender's.
    expect(plainAddresses('Shop <shop@example.com> (Kundendienst)')).toEqual(['shop@example.com']);
    expect(replyToElsewhere(asReply({ original: original('Shop <shop@example.com> (Kundendienst)', ['shop@example.com']), to: [{ address: 'shop@example.com' }] }))).toBeNull();
  });

  it('is null for a new mail, and reaches the card of a reply', () => {
    expect(replyToElsewhere({ filing: { kind: 'mail_send', payload: send() } })).toBeNull();
    const card = approvalCard(entry({ kind: 'mail_reply', filing: { kind: 'mail_reply', payload: reply({ original: original('shop@example.com', ['help@service.example']), to: [{ address: 'help@service.example' }] }) } }), owner);
    expect(card.replyToElsewhere).toEqual({ replyTo: ['help@service.example'], from: ['shop@example.com'] });
    expect(Object.keys(card.replyToElsewhere!).sort()).toEqual(['from', 'replyTo']);
    expect(approvalCard(entry(), owner).replyToElsewhere).toBeNull();
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
    // A decision reason is a string from the database: an object's own names are not reasons.
    for (const key of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) expect(at('rejected', null, key), key).toBe('other');
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
      'afterUntrusted', 'ageMs', 'chatThreadId', 'checksum', 'createdAt', 'decidedAt', 'executable', 'executedAt', 'expiresAt', 'held',
      'id', 'kind', 'mail', 'massSend', 'origin', 'outcome', 'recipientDiffers', 'replyToElsewhere', 'setup', 'status', 'tombstoned',
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
    expect(Object.keys(card.origin!).sort()).toEqual(['eventId', 'runId', 'source', 'threadId', 'triggerId']);
    expect(card.afterUntrusted).toBe(true);
    expect(card.ageMs).toBe(90_000);
  });

  it('an origin without a thread or an event carries neither key', () => {
    const card = approvalCard(entry({ origin: { source: 'workflow', triggerId: 'trg-1', runId: 'run-1', rootRunId: 'run-root' } }), owner);
    expect(Object.keys(card.origin!).sort()).toEqual(['runId', 'source', 'triggerId']);
  });

  // A stored address with a key the card does not know: the copy must drop it.
  const stray = (address: string, name?: string): StoredAddress =>
    ({ ...(name !== undefined ? { name } : {}), address, stray: 'STRAY-KEY' }) as StoredAddress;
  const addressKeys = (list: ReadonlyArray<StoredAddress>): string[][] => list.map((a) => Object.keys(a).sort());

  it('a new mail\'s card carries exactly the mail\'s shown fields, and each address only its name and address', () => {
    const payload = send({
      to: [stray('bob@example.com', 'Bob')], cc: [stray('carl@example.com')], bcc: [stray('dora@example.com')],
      trackFollowup: { reminder_in_days: 3, reason: 'awaiting reply' },
    });
    const mail = approvalCard(entry({ filing: { kind: 'mail_send', payload } }), owner).mail!;
    expect(Object.keys(mail).sort()).toEqual(['accountId', 'bcc', 'bodyText', 'cc', 'from', 'subject', 'to']);
    expect([addressKeys(mail.to), addressKeys(mail.cc), addressKeys(mail.bcc)]).toEqual([[['address', 'name']], [['address']], [['address']]]);
    expect(JSON.stringify(mail)).not.toContain('STRAY-KEY');
  });

  it('a reply\'s card carries exactly the reply\'s shown fields, and of the original only its sender, subject and date', () => {
    const payload = reply({
      to: [stray('anna@example.com', 'Anna')], cc: [stray('carl@example.com')], persona: 'Sales',
      inReplyTo: '<m1@example.com>', references: '<m0@example.com> <m1@example.com>', originalMessageId: '<m1@example.com>',
      original: { from: 'anna@example.com', to: ['owner@example.com'], cc: ['carl@example.com'], replyTo: ['tickets@example.com'], subject: 'Angebot', date: '2026-10-20T10:00:00.000Z' },
    });
    const mail = approvalCard(entry({ kind: 'mail_reply', filing: { kind: 'mail_reply', payload } }), owner).mail!;
    expect(Object.keys(mail).sort()).toEqual(['accountId', 'bcc', 'bodyText', 'cc', 'from', 'original', 'persona', 'subject', 'to']);
    expect(Object.keys(mail.original!).sort()).toEqual(['date', 'from', 'subject']);
    expect([addressKeys(mail.to), addressKeys(mail.cc), mail.bcc]).toEqual([[['address', 'name']], [['address']], []]);
    expect(JSON.stringify(mail)).not.toContain('STRAY-KEY');
  });

  it('says why an approved entry waits, only for the two known holds', () => {
    const held = (heldReason: string | null): ReturnType<typeof approvalCard>['held'] =>
      approvalCard(entry({ status: 'approved', heldReason: heldReason as ApprovalEntry['heldReason'] }), owner).held;
    expect([held('send_limit'), held('retry'), held(null), held('something new')]).toEqual(['send_limit', 'retry', null, null]);
  });

  it('marks a tombstone, and only a tombstone', () => {
    expect(approvalCard(entry({ status: 'unknown', filing: null, executable: false, tombstonedAt: new Date(T0).toISOString() }), owner).tombstoned).toBe(true);
    expect(approvalCard(entry(), owner).tombstoned).toBe(false);
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

  it('names a grant with no stored name by its address, and one with neither by a neutral label, never by its grant id', () => {
    expect(nameOf('grant-x', 'mandate:xena@example.com')).toBe('xena@example.com');
    expect(mandateNamer({ viewer: 'owner' }, () => '')('grant-x', 'mandate:xena@example.com')).toBe('xena@example.com');
    const card = approvalCard(entry({ createdBy: null, mandateId: 'grant-x' }), owner);
    expect(card.setup).toEqual([{ kind: 'test_run_by', name: UNNAMED_MANDATE }]);
    expect(JSON.stringify(card.setup)).not.toContain('grant-x');
  });

  describe('a mandate\'s card names another grant by its address only', () => {
    // Both grants have a name in the trail. Bea's entry: Anna set the trigger up, Bea changed it last.
    const beaEntry = entry(B);
    const both = { trigger: marks({ createdBy: A.createdBy, createdMandateId: 'grant-a', mandateEditor: B.createdBy, mandateEditorId: 'grant-b' }) };

    it('the owner sees both grants by their names', () => {
      expect(approvalCard(beaEntry, { ...owner, ...both }).setup)
        .toEqual([{ kind: 'last_changed_by', name: 'Bea B.' }, { kind: 'set_up_by', name: 'Anna A.' }]);
    });

    it('Bea sees her own grant by its name and Anna\'s by its address, on the same entry', () => {
      const card = approvalCard(beaEntry, { ...owner, ...both, scope: { viewer: 'mandate', mandateId: 'grant-b' } });
      expect(card.setup).toEqual([{ kind: 'last_changed_by', name: 'Bea B.' }, { kind: 'set_up_by', name: 'anna@example.com' }]);
      expect(JSON.stringify(card)).not.toContain('Anna A.');
    });
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

  it('reads the store as every entry for the owner and the grant\'s own for a mandate', () => {
    expect(listScopeOf({ viewer: 'owner' })).toEqual({ kind: 'all' });
    expect(listScopeOf({ viewer: 'mandate', mandateId: 'grant-a' })).toEqual({ kind: 'grant', mandateId: 'grant-a' });
  });
});

describe('the thread "Im Chat ändern" continues', () => {
  const taskOrigin = { source: 'task' as const, triggerId: 'trg-1', runId: 'run-1', rootRunId: 'run-1', threadId: 'th-1' };
  const threads = new Map<string, { createdBy: string | null; contained: boolean }>([
    ['th-1', { createdBy: 'owner', contained: false }], ['th-old', { createdBy: null, contained: false }],
    ['th-m', { createdBy: 'mandate:anna@example.com', contained: false }], ['th-c', { createdBy: 'owner', contained: true }],
  ]);
  const threadOf = (id: string): { createdBy: string | null; contained: boolean } | undefined => threads.get(id);
  const withThreads: ApprovalCardSources = { ...owner, threadOf };

  it('is the run\'s own thread for a task the owner filed in a thread the owner opened', () => {
    expect(approvalCard(entry({ origin: taskOrigin }), withThreads).chatThreadId).toBe('th-1');
    // A thread from before the column is the owner's.
    expect(approvalChatThread(entry({ origin: { ...taskOrigin, threadId: 'th-old' } }), threadOf)).toBe('th-old');
  });

  it('is a new chat for an entry a mandate filed, even in a thread the owner opened', () => {
    const e = entry({ origin: taskOrigin, createdBy: 'mandate:anna@example.com', mandateId: 'grant-a' });
    expect(approvalCard(e, withThreads).chatThreadId).toBeNull();
    // A mandate's tag without a grant id is a mandate's entry too.
    expect(approvalChatThread(entry({ origin: taskOrigin, createdBy: 'mandate:anna@example.com', mandateId: null }), threadOf)).toBeNull();
  });

  it('is a new chat for a thread a mandate opened, a thread that is gone, and a reader that cannot tell', () => {
    expect(approvalChatThread(entry({ origin: { ...taskOrigin, threadId: 'th-m' } }), threadOf)).toBeNull();
    expect(approvalChatThread(entry({ origin: { ...taskOrigin, threadId: 'th-gone' } }), threadOf)).toBeNull();
    expect(approvalChatThread(entry({ origin: taskOrigin }), undefined)).toBeNull();
  });

  it('is a new chat for a contained thread, where the changed mail could not be sent', () => {
    expect(approvalChatThread(entry({ origin: { ...taskOrigin, threadId: 'th-c' } }), threadOf)).toBeNull();
    // Control: the same thread, not contained, is continued.
    expect(approvalChatThread(entry({ origin: { ...taskOrigin, threadId: 'th-c' } }), (id) => ({ ...threads.get(id)!, contained: false }))).toBe('th-c');
  });

  it('is named on a decided entry too, so a moved draft can be opened again', () => {
    const e = entry({ origin: taskOrigin, status: 'rejected', decidedReason: 'moved_to_chat' });
    expect(approvalCard(e, withThreads).chatThreadId).toBe('th-1');
    expect(approvalCard(e, { ...asMandate, threadOf }).chatThreadId).toBeNull();
  });

  it('is a new chat for a workflow run, which has no thread, and for an unknown origin', () => {
    expect(approvalChatThread(entry({ origin: { ...taskOrigin, source: 'workflow' } }), threadOf)).toBeNull();
    expect(approvalChatThread(entry({ origin: { ...taskOrigin, threadId: undefined } }), threadOf)).toBeNull();
    expect(approvalChatThread(entry({ origin: null }), threadOf)).toBeNull();
  });

  it('is not on a mandate\'s card, which offers no action', () => {
    const e = entry({ origin: taskOrigin, createdBy: 'mandate:anna@example.com', mandateId: 'grant-a' });
    expect(approvalCard(e, { ...asMandate, threadOf }).chatThreadId).toBeNull();
    // Control: the owner's own entry in the same thread would continue it, but not on a mandate's card.
    expect(approvalCard(entry({ origin: taskOrigin }), { ...asMandate, threadOf }).chatThreadId).toBeNull();
  });
});
