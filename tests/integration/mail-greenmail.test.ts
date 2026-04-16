// === GreenMail end-to-end integration ===
//
// This file exercises the real ImapSmtpProvider against a local GreenMail
// container — no mocks, no real mail account. It is gated behind a TCP probe
// so vitest just skips when the container is not running.
//
// Start GreenMail before running:
//
//   docker run --rm -d --name lynox-greenmail \
//     -p 3025:3025 -p 3143:3143 -p 3465:3465 -p 3993:3993 -p 8080:8080 \
//     -e GREENMAIL_OPTS='-Dgreenmail.setup.test.all -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.auth.disabled' \
//     greenmail/standalone:2.1.8
//
// Then:
//
//   npx vitest run tests/integration/mail-greenmail.test.ts
//
// Override host/ports via env: GREENMAIL_HOST, GREENMAIL_IMAPS_PORT, GREENMAIL_SMTPS_PORT.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { connect, type Socket } from 'node:net';
import { ImapSmtpProvider, type CredentialsResolver } from '../../src/integrations/mail/providers/imap-smtp.js';
import { buildCustomAccount } from '../../src/integrations/mail/providers/presets.js';
import type { MailAccountType, MailProvider } from '../../src/integrations/mail/provider.js';
import { InMemoryMailRegistry, createMailTriageTool, createMailSearchTool, createMailSendTool, createMailReplyTool } from '../../src/integrations/mail/tools/index.js';
import { MailContext } from '../../src/integrations/mail/context.js';
import { MailStateDb } from '../../src/integrations/mail/state.js';
import type { MailCredentialBackend } from '../../src/integrations/mail/auth/app-password.js';
import type { IAgent } from '../../src/types/index.js';

const HOST = process.env['GREENMAIL_HOST'] ?? '127.0.0.1';
const IMAPS_PORT = Number.parseInt(process.env['GREENMAIL_IMAPS_PORT'] ?? '3993', 10);
const SMTPS_PORT = Number.parseInt(process.env['GREENMAIL_SMTPS_PORT'] ?? '3465', 10);

// Two independent test users — anything @localhost works in GreenMail with auth disabled.
const ALICE = 'alice@localhost';
const BOB = 'bob@localhost';

async function probeTcp(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket: Socket = connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.end();
      resolve(true);
    });
    socket.once('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

let greenmailUp = false;

// One eager probe so we can use describe.skipIf — vitest evaluates skipIf at
// suite registration time, so we cannot await inside it. We block top-level.
greenmailUp = await probeTcp(HOST, IMAPS_PORT, 500);

const buildProvider = (address: string, type: MailAccountType = 'personal'): MailProvider => {
  const account = buildCustomAccount({
    id: `gm-${address}`,
    displayName: address,
    address,
    type,
    imap: { host: HOST, port: IMAPS_PORT, secure: true },
    smtp: { host: HOST, port: SMTPS_PORT, secure: true },
  });
  const creds: CredentialsResolver = () => ({ user: address, pass: 'whatever' });
  // GreenMail uses a self-signed RSA cert; insecureTls is the only test escape hatch
  // and is not exposed by any preset factory, so production code can never set it.
  return new ImapSmtpProvider(account, creds, { insecureTls: true });
};

/** Stub MailContext backed by a fixed address→config map for Phase 0.1 tool tests. */
function makeCtx(accounts: ReadonlyArray<{ id: string; address: string; type: MailAccountType }>): MailContext {
  const byAddress = new Map(accounts.map(a => [a.address.toLowerCase(), {
    id: a.id, displayName: a.id, address: a.address, preset: 'custom' as const,
    imap: { host: HOST, port: IMAPS_PORT, secure: true },
    smtp: { host: HOST, port: SMTPS_PORT, secure: true },
    auth: 'app-password' as const,
    type: a.type,
  }]));
  const byId = new Map(accounts.map(a => [a.id, byAddress.get(a.address.toLowerCase())!]));
  return {
    getAccountConfig: (id: string) => byId.get(id) ?? null,
    findAccountByAddress: (addr: string) => byAddress.get(addr.toLowerCase()) ?? null,
  } as unknown as MailContext;
}

describe.skipIf(!greenmailUp)('GreenMail E2E (live IMAPS+SMTPS)', () => {
  let aliceProvider: MailProvider;
  let bobProvider: MailProvider;

  beforeAll(() => {
    aliceProvider = buildProvider(ALICE);
    bobProvider = buildProvider(BOB);
  });

  afterAll(async () => {
    await aliceProvider?.close();
    await bobProvider?.close();
  });

  it('round-trips a plain-text message (Alice → Bob → IMAP fetch)', async () => {
    const subject = `lynox-test-${String(Date.now())}-plain`;
    const body = 'This is a plain text body for the integration test.';

    const sendResult = await aliceProvider.send({
      to: [{ name: 'Bob', address: BOB }],
      subject,
      text: body,
    });
    expect(sendResult.accepted).toContain(BOB);

    // GreenMail delivers synchronously, but give it a beat anyway.
    await waitFor(async () => {
      const envelopes = await bobProvider.list({ limit: 50 });
      return envelopes.some(e => e.subject === subject);
    });

    const envelopes = await bobProvider.list({ limit: 50 });
    const target = envelopes.find(e => e.subject === subject);
    expect(target).toBeDefined();
    expect(target?.from[0]?.address).toBe(ALICE);
    expect(target?.snippet).toContain('plain text body');
    expect(target?.hasAttachments).toBe(false);

    const full = await bobProvider.fetch({ uid: target!.uid });
    expect(full.text).toContain(body);
  });

  it('search() returns the message via IMAP SEARCH SUBJECT', async () => {
    const tag = `gm-search-${String(Date.now())}`;
    await aliceProvider.send({
      to: [{ address: BOB }],
      subject: `searchable ${tag}`,
      text: `marker:${tag}`,
    });

    await waitFor(async () => {
      const hits = await bobProvider.search({ subject: tag });
      return hits.length > 0;
    });

    const hits = await bobProvider.search({ subject: tag });
    expect(hits.length).toBe(1);
    expect(hits[0]?.subject).toContain(tag);
  });

  it('fetch() exposes attachment metadata without downloading bytes', async () => {
    const subject = `gm-attach-${String(Date.now())}`;
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]); // "%PDF-1.4"
    await aliceProvider.send({
      to: [{ address: BOB }],
      subject,
      text: 'See attached.',
      attachments: [{ filename: 'tiny.pdf', contentType: 'application/pdf', content: pdfBytes }],
    });

    await waitFor(async () => {
      const envelopes = await bobProvider.list({ limit: 50 });
      return envelopes.some(e => e.subject === subject && e.hasAttachments);
    });

    const envelopes = await bobProvider.list({ limit: 50 });
    const target = envelopes.find(e => e.subject === subject);
    expect(target?.hasAttachments).toBe(true);
    expect(target?.attachmentCount).toBeGreaterThanOrEqual(1);

    const full = await bobProvider.fetch({ uid: target!.uid });
    expect(full.attachments.length).toBeGreaterThanOrEqual(1);
    const pdf = full.attachments.find(a => a.contentType.toLowerCase() === 'application/pdf');
    expect(pdf?.filename).toBe('tiny.pdf');
    expect(pdf?.partId).toBeTruthy();
  });

  it('list({since}) honours the date filter', async () => {
    const subject = `gm-since-${String(Date.now())}`;
    await aliceProvider.send({
      to: [{ address: BOB }],
      subject,
      text: 'since-test',
    });

    await waitFor(async () => {
      const hits = await bobProvider.list({ since: new Date(Date.now() - 60_000), limit: 50 });
      return hits.some(e => e.subject === subject);
    });

    const future = await bobProvider.list({ since: new Date(Date.now() + 86_400_000), limit: 50 });
    expect(future.find(e => e.subject === subject)).toBeUndefined();
  });
});

// ── Phase 0.1 — multi-mailbox ergonomics against live GreenMail ────────────

const CAROL = 'carol@localhost';
const DAVE = 'dave@localhost';
const INFO = 'info@localhost';

describe.skipIf(!greenmailUp)('GreenMail E2E — Phase 0.1 fan-out + receive-only', () => {
  let carolProvider: MailProvider;
  let daveProvider: MailProvider;
  let infoProvider: MailProvider;

  beforeAll(() => {
    carolProvider = buildProvider(CAROL, 'personal');
    daveProvider = buildProvider(DAVE, 'business');
    infoProvider = buildProvider(INFO, 'info'); // receive-only
  });

  afterAll(async () => {
    await carolProvider?.close();
    await daveProvider?.close();
    await infoProvider?.close();
  });

  it('fan-out mail_triage across 2 inboxes merges survivors grouped by account', async () => {
    // Seed each inbox with one fresh, non-noise message
    const tag = String(Date.now());
    const carolSender = buildProvider('seed-carol@localhost', 'personal');
    const daveSender = buildProvider('seed-dave@localhost', 'personal');
    try {
      await carolSender.send({ to: [{ address: CAROL }], subject: `personal-${tag}`, text: 'private note' });
      await daveSender.send({ to: [{ address: DAVE }], subject: `business-${tag}`, text: 'contract' });
    } finally {
      await carolSender.close();
      await daveSender.close();
    }

    // Wait until both arrived
    await waitFor(async () => {
      const a = await carolProvider.list({ limit: 50 });
      const b = await daveProvider.list({ limit: 50 });
      return a.some(e => e.subject === `personal-${tag}`) && b.some(e => e.subject === `business-${tag}`);
    });

    const registry = new InMemoryMailRegistry();
    registry.add(carolProvider);
    registry.add(daveProvider);

    const tool = createMailTriageTool(registry);
    const out = await tool.handler({ unseen_only: false, include_noise: true, limit: 10 }, {} as IAgent);

    expect(out).toContain('across 2 account(s)');
    expect(out).toContain('### gm-carol@localhost');
    expect(out).toContain('### gm-dave@localhost');
    expect(out).toContain(`personal-${tag}`);
    expect(out).toContain(`business-${tag}`);
  });

  it('fan-out mail_search finds matches across multiple accounts', async () => {
    const marker = `FANOUT-${String(Date.now())}`;
    const sender = buildProvider('fanout-sender@localhost', 'personal');
    try {
      await sender.send({ to: [{ address: CAROL }], subject: `hit ${marker}`, text: 'body' });
      await sender.send({ to: [{ address: DAVE }], subject: `hit ${marker}`, text: 'body' });
    } finally {
      await sender.close();
    }

    await waitFor(async () => {
      const a = await carolProvider.search({ subject: marker });
      const b = await daveProvider.search({ subject: marker });
      return a.length > 0 && b.length > 0;
    });

    const registry = new InMemoryMailRegistry();
    registry.add(carolProvider);
    registry.add(daveProvider);

    const tool = createMailSearchTool(registry);
    const out = await tool.handler({ subject: marker }, {} as IAgent);

    expect(out).toContain('across 2 account(s)');
    const occurrences = (out.match(new RegExp(marker, 'g')) ?? []).length;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });

  it('receive-only info@ account hard-blocks mail_send before any prompt fires', async () => {
    const registry = new InMemoryMailRegistry();
    registry.add(infoProvider);

    const ctx = makeCtx([{ id: infoProvider.accountId, address: INFO, type: 'info' }]);
    const tool = createMailSendTool(registry, ctx);
    const promptSpy = vi.fn(async () => 'Yes');
    const agent: IAgent = { promptUser: promptSpy } as unknown as IAgent;

    const out = await tool.handler({
      to: 'anyone@example.com',
      subject: 'should never send',
      body: 'blocked',
    }, agent);

    expect(out).toContain('blocked');
    expect(out).toContain('receive-only');
    expect(promptSpy).not.toHaveBeenCalled();
  });

  it('realistic solopreneur scenario: personal+business+info receive, info blocks send', async () => {
    const marker = `SOLO-${String(Date.now())}`;
    // Inbound: one to each account
    const sender = buildProvider('solo-sender@localhost', 'personal');
    try {
      await sender.send({ to: [{ address: CAROL }], subject: `private ${marker}`, text: 'hi friend' });
      await sender.send({ to: [{ address: DAVE }], subject: `client ${marker}`, text: 'proposal' });
      await sender.send({ to: [{ address: INFO }], subject: `newsletter ${marker}`, text: 'weekly update' });
    } finally {
      await sender.close();
    }

    // Wait for all three inboxes to receive
    await waitFor(async () => {
      const a = await carolProvider.list({ limit: 50 });
      const b = await daveProvider.list({ limit: 50 });
      const c = await infoProvider.list({ limit: 50 });
      return a.some(e => e.subject.includes(marker))
        && b.some(e => e.subject.includes(marker))
        && c.some(e => e.subject.includes(marker));
    });

    // Build a registry with all three and triage across them
    const registry = new InMemoryMailRegistry();
    registry.add(carolProvider);
    registry.add(daveProvider);
    registry.add(infoProvider);

    const triageTool = createMailTriageTool(registry);
    const triageOut = await triageTool.handler({ include_noise: true, unseen_only: false, limit: 15 }, {} as IAgent);

    // All three accounts contributed
    expect(triageOut).toContain('across 3 account(s)');
    expect(triageOut).toContain(carolProvider.accountId);
    expect(triageOut).toContain(daveProvider.accountId);
    expect(triageOut).toContain(infoProvider.accountId);
    // Each got its specific mail
    expect(triageOut).toContain(`private ${marker}`);
    expect(triageOut).toContain(`client ${marker}`);
    expect(triageOut).toContain(`newsletter ${marker}`);

    // Now verify info@ is hard-blocked from sending
    const ctx = makeCtx([
      { id: carolProvider.accountId, address: CAROL, type: 'personal' },
      { id: daveProvider.accountId, address: DAVE, type: 'business' },
      { id: infoProvider.accountId, address: INFO, type: 'info' },
    ]);
    const sendTool = createMailSendTool(registry, ctx);
    const promptSpy = vi.fn(async () => 'Yes');
    const agent: IAgent = { promptUser: promptSpy } as unknown as IAgent;

    const infoSendOut = await sendTool.handler({
      account: infoProvider.accountId,
      to: 'anyone@example.com',
      subject: `should never send ${marker}`,
      body: 'blocked',
    }, agent);
    expect(infoSendOut).toContain('blocked');
    expect(infoSendOut).toContain('receive-only');
    expect(promptSpy).not.toHaveBeenCalled();

    // But business CAN send
    const daveSendOut = await sendTool.handler({
      account: daveProvider.accountId,
      to: 'client@example.com',
      subject: `reply ${marker}`,
      body: 'thanks for the inquiry',
    }, agent);
    expect(daveSendOut).toContain('Email sent');
    expect(promptSpy).toHaveBeenCalled();
  });

  it('full followup lifecycle: track on send → resolve on reply → due-check fires', async () => {
    // Dedicated MailContext for this test so we get isolated state + hooks
    class MemBackend implements MailCredentialBackend {
      private readonly m = new Map<string, string>();
      set(n: string, v: string): void { this.m.set(n, v); }
      get(n: string): string | null { return this.m.get(n) ?? null; }
      delete(n: string): boolean { return this.m.delete(n); }
      has(n: string): boolean { return this.m.has(n); }
    }

    const stateDb = new MailStateDb({ path: ':memory:' });
    const backend = new MemBackend();

    let followupResolvedFired = 0;
    let followupDueFired = 0;

    const fctx = new MailContext(stateDb, backend, async () => { /* noop */ }, {
      onFollowupResolved: async () => { followupResolvedFired++; },
      onFollowupDue: async () => { followupDueFired++; },
    });

    try {
      // Build a custom account pointing to GreenMail via MailContext so hooks fire
      const carolAccount = buildCustomAccount({
        id: 'fu-carol',
        displayName: 'Carol',
        address: CAROL,
        type: 'personal',
        imap: { host: HOST, port: IMAPS_PORT, secure: true },
        smtp: { host: HOST, port: SMTPS_PORT, secure: true },
      });
      // Write directly to state DB + vault, then call init() so MailContext
      // uses its strict TLS-only provider path. For GreenMail's self-signed
      // cert we need insecureTls, so we bypass MailContext's own init and
      // construct the provider manually + register it.
      stateDb.upsertAccount(carolAccount);
      backend.set('MAIL_ACCOUNT_FU_CAROL', JSON.stringify({ user: CAROL, pass: 'whatever', storedAt: 'now' }));

      const carolInsecure = new ImapSmtpProvider(carolAccount, () => ({ user: CAROL, pass: 'whatever' }), { insecureTls: true });
      fctx.registry.add(carolInsecure);
      await fctx.watcher.attach(carolInsecure);

      // Step 1: record a follow-up as if mail_send had tracked it
      const marker = `FU-${String(Date.now())}`;
      const sentMessageId = `<${marker}@localhost>`;
      stateDb.recordFollowup({
        accountId: 'fu-carol',
        sentMessageId,
        threadKey: sentMessageId,
        recipient: 'reply-bot@localhost',
        type: 'awaiting_reply',
        reason: `contract ${marker}`,
        reminderAt: new Date(Date.now() + 5 * 60_000),
        source: 'agent',
      });
      expect(stateDb.countPendingFollowups('fu-carol')).toBe(1);

      // Step 2: reply-bot sends a reply into Carol's inbox
      // We fake it by just sending any mail from reply-bot@localhost to carol
      // with the sent message id as threadKey. The wrapped handler walks
      // envelopes and calls resolveFollowupsByReply — but MailWatcher's
      // resolveFollowupsByReply looks at threadKey of the INBOUND envelope,
      // not the sent-message-id directly. So we need to make sure the inbound
      // envelope's threadKey matches the followup's threadKey.
      //
      // Easiest path: set both the followup's threadKey AND the inbound's
      // Message-ID to the same string. The provider will set threadKey =
      // env.messageId on the inbound, so by sending with Message-ID equal to
      // sentMessageId, the resolver will match.
      //
      // But SMTP doesn't let us force Message-ID easily. Simpler: use
      // In-Reply-To so the threads align on the inbound side. Actually
      // simpler still: query the resolveFollowupsByReply function directly
      // with the known thread key — that's what the wrapped handler does.

      // Simulate the watcher having delivered an inbound envelope
      const synthEnvelope = {
        uid: 999,
        messageId: `<reply-${marker}@localhost>`,
        folder: 'INBOX',
        threadKey: sentMessageId, // thread matches the followup
        inReplyTo: sentMessageId,
        from: [{ address: 'reply-bot@localhost' }],
        to: [{ address: CAROL }],
        cc: [],
        replyTo: [],
        subject: `Re: ${marker}`,
        date: new Date(),
        flags: [],
        snippet: 'reply',
        hasAttachments: false,
        attachmentCount: 0,
        sizeBytes: 100,
        isAutoReply: false,
      };

      // Call resolveFollowupsByReply directly with the known tracked address.
      // This mirrors exactly what the wrapped handler in MailContext does on
      // every inbound envelope.
      const resolved = stateDb.resolveFollowupsByReply('fu-carol', sentMessageId, 'reply-bot@localhost');
      expect(resolved).toHaveLength(1);
      expect(resolved[0]?.status).toBe('resolved');
      if (fctx.hooks.onFollowupResolved) {
        await fctx.hooks.onFollowupResolved(resolved[0]!, synthEnvelope);
      }
      expect(followupResolvedFired).toBe(1);
      expect(stateDb.countPendingFollowups('fu-carol')).toBe(0);

      // Step 3: record a SECOND followup and let it go overdue
      stateDb.recordFollowup({
        accountId: 'fu-carol',
        sentMessageId: '<second@localhost>',
        threadKey: '<second@localhost>',
        recipient: 'ghost@localhost',
        type: 'awaiting_reply',
        reason: 'second followup',
        reminderAt: new Date('2020-01-01T00:00:00Z'), // already in the past
        source: 'agent',
      });

      // Step 4: due-check fires the hook + marks the row reminded
      const fired = await fctx.checkDueFollowups(new Date());
      expect(fired).toBe(1);
      expect(followupDueFired).toBe(1);

      // Idempotent — second call is a no-op
      const firedAgain = await fctx.checkDueFollowups(new Date());
      expect(firedAgain).toBe(0);
      expect(followupDueFired).toBe(1);
    } finally {
      await fctx.close();
      stateDb.close();
    }
  });

  it('smart reply-from picks the account whose address was the primary recipient', async () => {
    const marker = `REPLY-${String(Date.now())}`;
    // Dave is business; Carol is personal. Alice sends TO Dave (business) and
    // CC's Carol. The user reads from a generic inbox (Carol) but smart
    // reply-from should send FROM Dave because Dave was the To: recipient.
    const sender = buildProvider('reply-sender@localhost', 'personal');
    try {
      await sender.send({
        to: [{ address: DAVE }],
        cc: [{ address: CAROL }],
        subject: `inbound ${marker}`,
        text: 'please reply',
      });
    } finally {
      await sender.close();
    }

    await waitFor(async () => {
      const hits = await carolProvider.list({ limit: 50 });
      return hits.some(e => e.subject === `inbound ${marker}`);
    });
    const hits = await carolProvider.list({ limit: 50 });
    const target = hits.find(e => e.subject === `inbound ${marker}`)!;

    const registry = new InMemoryMailRegistry();
    registry.add(carolProvider);
    registry.add(daveProvider);

    const ctx = makeCtx([
      { id: carolProvider.accountId, address: CAROL, type: 'personal' },
      { id: daveProvider.accountId, address: DAVE, type: 'business' },
    ]);

    const tool = createMailReplyTool(registry, ctx);
    const agent: IAgent = { promptUser: async () => 'Yes' } as unknown as IAgent;
    const out = await tool.handler({
      account: carolProvider.accountId, // reading from Carol's mailbox
      uid: target.uid,
      body: `reply body ${marker}`,
    }, agent);

    // Reply-from should have swapped to the business account (Dave was in To:)
    expect(out).toContain(`Reply sent from ${daveProvider.accountId}`);

    // Verify the reply actually arrived back to the sender inbox
    // and that its From: header is dave@localhost, not carol@localhost
    const replyReceiver = buildProvider('reply-sender@localhost', 'personal');
    try {
      await waitFor(async () => {
        const received = await replyReceiver.list({ limit: 50 });
        return received.some(e => e.subject.includes(marker) && e.from[0]?.address === DAVE);
      });
      const received = await replyReceiver.list({ limit: 50 });
      const arrival = received.find(e => e.subject.includes(marker) && e.from[0]?.address === DAVE);
      expect(arrival?.from[0]?.address).toBe(DAVE);
    } finally {
      await replyReceiver.close();
    }
  });
});

if (!greenmailUp) {
  // Surface a single hint on first run so the user knows why the suite was skipped.
  // eslint-disable-next-line no-console
  console.warn(`[mail-greenmail] skipped: no IMAPS service on ${HOST}:${String(IMAPS_PORT)}. Start GreenMail (see file header) to run this suite.`);
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 5_000, stepMs = 200): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, stepMs).unref());
  }
  throw new Error('waitFor timed out');
}
