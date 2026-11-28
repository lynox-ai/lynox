import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MailStateDb } from '../mail/state.js';
import { MailContext } from '../mail/context.js';
import type { MailCredentialBackend } from '../mail/auth/app-password.js';
import type { MailAccountConfig, MailAuthType, MailEnvelope, MailProvider, MailWatchHandle, MailWatchHandler, MailWatchEvent } from '../mail/provider.js';
import { InboxStateDb } from './state.js';
import { InboxRulesLoader } from './rules-loader.js';
import { buildInboxRunner, type InboxQueuePayload } from './runner.js';
import { createInboxClassifierHook, type AccountResolver } from './watcher-hook.js';
import { followUpsOf } from './follow-ups.js';
import { DrainedForShutdownError, type ClassifierQueue } from './classifier/queue.js';
import type { LLMCaller } from './classifier/index.js';
import type { InboxNotifier, InboxNotifyOptions } from './notifier.js';
import type { InboxItem } from '../../types/index.js';
import type { SensitiveMode } from './sensitive-content.js';
import { itemFollowUps } from './follow-ups.js';

/**
 * Two mails of one thread reach the classifier before either is filed. The real hook builds the
 * payloads, the real runner and queue classify them, and the classifier answers in an order the
 * test controls. The mail that arrived first becomes the item; the other is filed into it with its
 * own verdict, and nothing of it is written over the item.
 */

const ACCOUNT: MailAccountConfig = {
  id: 'acct-1', displayName: 'Me', address: 'me@acme.example', preset: 'custom',
  imap: { host: 'i', port: 993, secure: true }, smtp: { host: 's', port: 465, secure: true },
  authType: 'imap', type: 'personal', isDefault: true,
};

let mail: MailStateDb;
let inbox: InboxStateDb;
let pushes: Array<{ item: InboxItem; opts: InboxNotifyOptions | undefined }>;
let notifier: InboxNotifier;

beforeEach(() => {
  mail = new MailStateDb({ path: ':memory:' });
  mail.upsertAccount(ACCOUNT);
  inbox = new InboxStateDb(mail.getConnection());
  pushes = [];
  notifier = { notifyNewItem: vi.fn(async (item: InboxItem, opts?: InboxNotifyOptions) => { pushes.push({ item, opts }); return true; }) };
});
afterEach(() => mail.close());

/** The classifier: each mail's answer waits until the test releases it by the mail's tag. */
function gatedLlm() {
  const gates = new Map<string, { promise: Promise<string>; resolve: (raw: string) => void; reject: (e: Error) => void }>();
  const started: string[] = [];
  const gate = (tag: string) => {
    let entry = gates.get(tag);
    if (entry === undefined) {
      let resolve: (raw: string) => void = () => undefined;
      let reject: (e: Error) => void = () => undefined;
      const promise = new Promise<string>((res, rej) => { resolve = res; reject = rej; });
      entry = { promise, resolve, reject };
      gates.set(tag, entry);
    }
    return entry;
  };
  const llm: LLMCaller = async ({ user }) => {
    const tag = ['ZEBRA', 'QUOKKA', 'OKAPI'].find((t) => user.includes(t));
    if (tag === undefined) throw new Error('unknown mail');
    started.push(tag);
    return gate(tag).promise;
  };
  const release = (tag: string, bucket: 'requires_user' | 'auto_handled'): void => {
    gate(tag).resolve(JSON.stringify({ bucket, confidence: 0.9, one_line_why_de: `Grund ${tag}` }));
  };
  const fail = (tag: string): void => { gate(tag).reject(new Error('classifier down')); };
  return { llm, release, fail, started };
}

const accounts = (authType: MailAuthType): AccountResolver => ({
  resolve: (id) => (id === ACCOUNT.id ? { address: ACCOUNT.address, displayName: ACCOUNT.displayName, authType } : null),
});

interface SetupExtras {
  sensitiveMode?: SensitiveMode;
  confirmAutoReply?: (accountId: string, env: MailEnvelope) => Promise<boolean>;
}

function setup(authType: MailAuthType, llm: LLMCaller, extras: SetupExtras = {}): { queue: ClassifierQueue<InboxQueuePayload>; hook: (env: MailEnvelope) => Promise<unknown> } {
  const resolver = accounts(authType);
  const followUps = { accounts: resolver, sensitiveMode: extras.sensitiveMode, ...(extras.confirmAutoReply ? { confirmAutoReply: extras.confirmAutoReply } : {}) };
  const queue = buildInboxRunner({ state: inbox, llm, notifier, policy: { retryOnce: false }, followUps });
  const hook = createInboxClassifierHook({
    state: inbox, rules: new InboxRulesLoader(inbox), queue, accounts: resolver, notifier, sensitiveMode: extras.sensitiveMode,
    ...(extras.confirmAutoReply ? { confirmAutoReply: extras.confirmAutoReply } : {}),
  });
  return { queue, hook: (env) => hook(ACCOUNT.id, env) };
}

function envelope(o: { tag: string; uid: number; from: string; name: string; threadKey: string; date: Date; arrivedAt?: Date; subject?: string; snippet?: string }): MailEnvelope {
  return {
    uid: o.uid, messageId: `<${o.tag.toLowerCase()}@x>`, folder: 'INBOX', threadKey: o.threadKey, inReplyTo: undefined,
    from: [{ address: o.from, name: o.name }], to: [{ address: ACCOUNT.address }], cc: [], replyTo: [],
    subject: o.subject ?? 'Bestellung 1043', date: o.date, ...(o.arrivedAt !== undefined ? { arrivedAt: o.arrivedAt } : {}),
    flags: [], snippet: o.snippet ?? `Text ${o.tag}: wo bleibt die Lieferung?`, hasAttachments: false, attachmentCount: 0, sizeBytes: 0,
    isAutoReply: false,
  };
}

const T0 = new Date('2026-11-20T09:00:00Z');
const T1 = new Date('2026-11-20T09:05:00Z');
const EARLIER = new Date('2026-11-01T09:00:00Z');

/** The thread keys of the two providers that name a thread themselves. */
const PROVIDERS: ReadonlyArray<{ name: string; authType: MailAuthType; threadKey: string }> = [
  { name: 'gmail', authType: 'oauth_google', threadKey: 'gmail:thread-77' },
  { name: 'imap with server thread ids', authType: 'imap', threadKey: 'imap-thrid-4711' },
];

function actions(itemId: string): string[] {
  return inbox.listAuditForItem(itemId).map((a) => a.action);
}

describe('two mails of one thread classified before either is filed', () => {
  const cases = PROVIDERS.flatMap((p) => (['first', 'second'] as const).flatMap((finishesFirst) =>
    ([false, true] as const).map((olderDate) => ({ ...p, finishesFirst, olderDate }))));

  it.each(cases)('$name: the first-arrived mail is the item, the second a follow-up (finishes first: $finishesFirst, second dated older: $olderDate)', async ({ authType, threadKey, finishesFirst, olderDate }) => {
    const { llm, release } = gatedLlm();
    const { queue, hook } = setup(authType, llm);
    const first = envelope({ tag: 'ZEBRA', uid: 10, from: 'anna@kunde.example', name: 'Anna', threadKey, date: T0, arrivedAt: T0 });
    const second = envelope({ tag: 'QUOKKA', uid: 11, from: 'ben@kunde.example', name: 'Ben', threadKey, date: olderDate ? EARLIER : T1, arrivedAt: T1 });
    expect(await hook(first)).toBe('enqueued');
    expect(await hook(second)).toBe('enqueued');

    if (finishesFirst === 'second') {
      release('QUOKKA', 'requires_user');
      for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
      release('ZEBRA', 'requires_user');
    } else {
      release('ZEBRA', 'requires_user');
      release('QUOKKA', 'requires_user');
    }
    await queue.drain();

    const items = inbox.listItems();
    expect(items, 'one item for the thread').toHaveLength(1);
    const item = items[0]!;
    expect(item.fromAddress, 'the first-arrived sender is kept').toBe('anna@kunde.example');
    expect(item.messageId).toBe('<zebra@x>');
    expect(inbox.getItemBody(item.id)?.bodyMd, 'the first-arrived body is kept').toContain('ZEBRA');
    expect(actions(item.id).filter((a) => a === 'classified'), 'exactly one classified audit').toHaveLength(1);
    expect(actions(item.id).filter((a) => a === 'joined_thread')).toHaveLength(1);
    expect(pushes, 'exactly one push').toHaveLength(1);
    expect(followUpsOf(inbox, item).map((m) => m.messageId), 'the second mail is a follow-up').toEqual(['<quokka@x>']);
  });
});

describe('a joined mail brings its own verdict', () => {
  const THREAD = 'gmail:thread-9';

  it('a requires_user verdict raises an auto_handled item, with one push naming the joining sender', async () => {
    const { llm, release } = gatedLlm();
    const { queue, hook } = setup('oauth_google', llm);
    await hook(envelope({ tag: 'ZEBRA', uid: 1, from: 'shop@laden.example', name: 'Laden', threadKey: THREAD, date: T0, arrivedAt: T0 }));
    await hook(envelope({ tag: 'QUOKKA', uid: 2, from: 'ben@kunde.example', name: 'Ben', threadKey: THREAD, date: T1, arrivedAt: T1 }));
    release('ZEBRA', 'auto_handled');
    release('QUOKKA', 'requires_user');
    await queue.drain();

    const item = inbox.listItems()[0]!;
    expect(item.bucket).toBe('requires_user');
    expect(item.fromAddress, 'the item keeps its own sender').toBe('shop@laden.example');
    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.opts?.sender?.address, 'the push names the joining sender').toBe('ben@kunde.example');
    const joined = inbox.listAuditForItem(item.id).find((a) => a.action === 'joined_thread');
    expect(JSON.parse(joined!.payloadJson)).toMatchObject({
      message_id: '<quokka@x>', bucket: 'requires_user', confidence: 0.9, fail_reason: null, raised: true, announced: true, prior_bucket: 'auto_handled',
      reason_de: 'Grund QUOKKA', prior_reason_de: 'Grund ZEBRA',
    });
    // The item keeps its own verdict text: the joined mail's reason is only in the audit.
    expect(item.reasonDe).toBe('Grund ZEBRA');
    expect(JSON.parse(joined!.payloadJson).prior_classifier_version).toBe(item.classifierVersion);
  });

  it('a joined mail classified as handled leaves an auto_handled item where it is, without a push', async () => {
    const { llm, release } = gatedLlm();
    const { queue, hook } = setup('oauth_google', llm);
    await hook(envelope({ tag: 'ZEBRA', uid: 1, from: 'shop@laden.example', name: 'Laden', threadKey: THREAD, date: T0, arrivedAt: T0 }));
    await hook(envelope({ tag: 'QUOKKA', uid: 2, from: 'shop@laden.example', name: 'Laden', threadKey: THREAD, date: T1, arrivedAt: T1 }));
    release('ZEBRA', 'auto_handled');
    release('QUOKKA', 'auto_handled');
    await queue.drain();
    const item = inbox.listItems()[0]!;
    expect(item.bucket).toBe('auto_handled');
    expect(pushes).toHaveLength(0);
    const joined = inbox.listAuditForItem(item.id).find((a) => a.action === 'joined_thread');
    expect(JSON.parse(joined!.payloadJson)).toMatchObject({ bucket: 'auto_handled', raised: false });
  });

  it('a joined mail whose classification failed raises the item and pushes once', async () => {
    const { llm, release, fail } = gatedLlm();
    const { queue, hook } = setup('oauth_google', llm);
    await hook(envelope({ tag: 'ZEBRA', uid: 1, from: 'shop@laden.example', name: 'Laden', threadKey: THREAD, date: T0, arrivedAt: T0 }));
    await hook(envelope({ tag: 'QUOKKA', uid: 2, from: 'ben@kunde.example', name: 'Ben', threadKey: THREAD, date: T1, arrivedAt: T1 }));
    release('ZEBRA', 'auto_handled');
    fail('QUOKKA');
    await queue.drain();
    const item = inbox.listItems()[0]!;
    expect(item.bucket).toBe('requires_user');
    expect(item.fromAddress).toBe('shop@laden.example');
    expect(actions(item.id).filter((a) => a === 'classified')).toHaveLength(1);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.opts?.sender?.address).toBe('ben@kunde.example');
    const joined = inbox.listAuditForItem(item.id).find((a) => a.action === 'joined_thread');
    expect(JSON.parse(joined!.payloadJson)).toMatchObject({ fail_reason: 'dead_letter', dead_letter: 'classifier_failed', raised: true });
  });

  it('a joined mail drained at shutdown raises the item without a push', async () => {
    const { llm, release } = gatedLlm();
    const { queue, hook } = setup('oauth_google', llm);
    await hook(envelope({ tag: 'ZEBRA', uid: 1, from: 'shop@laden.example', name: 'Laden', threadKey: THREAD, date: T0, arrivedAt: T0 }));
    release('ZEBRA', 'auto_handled');
    for (let i = 0; i < 50 && inbox.listItems().length === 0; i++) await new Promise((r) => setImmediate(r));
    expect(inbox.listItems()).toHaveLength(1);
    // A mail of the thread queued before the first was filed, still waiting when the process stops.
    const env = envelope({ tag: 'OKAPI', uid: 3, from: 'cleo@kunde.example', name: 'Cleo', threadKey: THREAD, date: T1, arrivedAt: T1 });
    const payload: InboxQueuePayload = {
      accountId: ACCOUNT.id, channel: 'email', threadKey: THREAD,
      classifierInput: { accountAddress: ACCOUNT.address, accountDisplayName: 'Me', subject: env.subject, fromAddress: 'cleo@kunde.example', fromDisplayName: 'Cleo', body: env.snippet },
      envelope: { fromAddress: 'cleo@kunde.example', fromName: 'Cleo', subject: env.subject, mailDate: T1, snippet: env.snippet, messageId: '<okapi@x>', inReplyTo: undefined },
      mail: env,
    };
    expect(queue.enqueue(payload)).toBe(true);
    await queue.drain({ deadLetterPending: new DrainedForShutdownError() });

    const item = inbox.listItems()[0]!;
    expect(item.bucket).toBe('requires_user');
    expect(item.fromAddress).toBe('shop@laden.example');
    expect(pushes, 'no push while the process ends').toHaveLength(0);
    const joined = inbox.listAuditForItem(item.id).filter((a) => a.action === 'joined_thread');
    expect(joined).toHaveLength(1);
    expect(JSON.parse(joined[0]!.payloadJson)).toMatchObject({ message_id: '<okapi@x>', dead_letter: 'shutdown_drain', raised: true });
    expect(followUpsOf(inbox, item).map((m) => m.messageId)).toEqual(['<okapi@x>']);
  });
});

describe('a newest-first list through the mail watcher', () => {
  class EmittingProvider {
    readonly accountId = ACCOUNT.id;
    emit: (event: MailWatchEvent) => Promise<void> = async () => { /* not attached */ };
    async list(): Promise<ReadonlyArray<MailEnvelope>> { return []; }
    async fetch(): Promise<never> { throw new Error('not used'); }
    async search(): Promise<ReadonlyArray<MailEnvelope>> { return []; }
    async send(): Promise<never> { throw new Error('not used'); }
    async close(): Promise<void> { /* no-op */ }
    async watch(_opts: unknown, handler: MailWatchHandler): Promise<MailWatchHandle> {
      this.emit = async (event) => { await handler(event); };
      return { stop: async () => { this.emit = async () => { /* stopped */ }; } };
    }
  }
  const backend: MailCredentialBackend = { set: () => undefined, get: () => null, delete: () => false, has: () => false };

  it('files the earliest-arrived mail as the item, though the later one carries an older Date header', async () => {
    const { llm, release } = gatedLlm();
    const { queue, hook } = setup('oauth_google', llm);
    const ctx = new MailContext(mail, backend, undefined, { onInboundMail: async (_id, env) => { await hook(env); } });
    const provider = new EmittingProvider();
    try {
      await ctx.watcher.attach(provider as unknown as MailProvider);
      const THREAD = 'gmail:thread-backdated';
      const firstArrived = envelope({ tag: 'ZEBRA', uid: 7, from: 'anna@kunde.example', name: 'Anna', threadKey: THREAD, date: T0, arrivedAt: T0 });
      // Arrived later, but its sender dated it weeks back; listed first, as the newest.
      const backdated = envelope({ tag: 'QUOKKA', uid: 8, from: 'ines@fremd.example', name: 'Ines', threadKey: THREAD, date: EARLIER, arrivedAt: T1 });
      await provider.emit({ type: 'new', envelopes: [backdated, firstArrived] });
      release('QUOKKA', 'auto_handled');
      release('ZEBRA', 'requires_user');
      await queue.drain();
    } finally {
      await ctx.close();
    }
    const items = inbox.listItems();
    expect(items).toHaveLength(1);
    expect(items[0]!.fromAddress).toBe('anna@kunde.example');
    expect(items[0]!.bucket).toBe('requires_user');
    expect(followUpsOf(inbox, items[0]!).map((m) => m.messageId)).toEqual(['<quokka@x>']);
  });
});

/** Lets queued work run until `done` holds, or fails the test. */
async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (done()) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error('condition not met');
}

describe('an item created without a push is announced once by a joined mail that needs the owner', () => {
  const THREAD = 'gmail:thread-bounce';
  const bounce = (): MailEnvelope => envelope({
    tag: 'BOUNCE', uid: 5, from: 'mailer-daemon@post.example', name: 'Mail Delivery System', threadKey: THREAD,
    date: T1, arrivedAt: T1, subject: 'Undelivered Mail Returned to Sender', snippet: 'Delivery to the following recipient failed.',
  });

  it('a delivery notice first, then the queued real mail: one push, under the real sender and subject', async () => {
    const { llm, release } = gatedLlm();
    const { queue, hook } = setup('oauth_google', llm);
    expect(await hook(envelope({ tag: 'ZEBRA', uid: 1, from: 'anna@kunde.example', name: 'Anna', threadKey: THREAD, date: T0, arrivedAt: T0, subject: 'Frage zur Offerte' }))).toBe('enqueued');
    expect(await hook(envelope({ tag: 'QUOKKA', uid: 2, from: 'ben@kunde.example', name: 'Ben', threadKey: THREAD, date: T0, arrivedAt: T0, subject: 'Auch eine Frage' }))).toBe('enqueued');
    // Filed at once by the prefilter, in "requires you", without a push.
    expect(await hook(bounce())).toBe('prefilter_filed');
    const item = inbox.listItems()[0]!;
    expect(item.classifierVersion).toBe('prefilter');
    expect(pushes).toHaveLength(0);

    release('ZEBRA', 'requires_user');
    release('QUOKKA', 'requires_user');
    await queue.drain();

    expect(pushes, 'announced once, the second joined mail pushes no more').toHaveLength(1);
    expect(pushes[0]!.opts?.sender?.address).toBe('anna@kunde.example');
    expect(pushes[0]!.opts?.sender?.name).toBe('Anna');
    expect(pushes[0]!.opts?.subject).toBe('Frage zur Offerte');
    const joined = inbox.listAuditForItem(item.id).filter((a) => a.action === 'joined_thread').map((a) => JSON.parse(a.payloadJson) as Record<string, unknown>);
    expect(joined.map((j) => [j['message_id'], j['announced']])).toEqual([['<zebra@x>', true], ['<quokka@x>', false]]);
  });

  it('the real mail filed first and the delivery notice after it: still one push', async () => {
    const { llm, release } = gatedLlm();
    const { queue, hook } = setup('oauth_google', llm);
    await hook(envelope({ tag: 'ZEBRA', uid: 1, from: 'anna@kunde.example', name: 'Anna', threadKey: THREAD, date: T0, arrivedAt: T0 }));
    release('ZEBRA', 'requires_user');
    await until(() => inbox.listItems().length === 1);
    expect(await hook(bounce())).toBe('duplicate');
    await queue.drain();
    expect(pushes).toHaveLength(1);
    expect(inbox.listItems()[0]!.fromAddress).toBe('anna@kunde.example');
  });
});

describe('a joined mail after the owner dealt with the item', () => {
  it('counts in the item follow-ups by when it was stored, not by its Date header', async () => {
    const THREAD = 'gmail:thread-archived';
    const { llm, release } = gatedLlm();
    const { queue, hook } = setup('oauth_google', llm);
    await hook(envelope({ tag: 'ZEBRA', uid: 1, from: 'shop@laden.example', name: 'Laden', threadKey: THREAD, date: T0, arrivedAt: T0 }));
    await hook(envelope({ tag: 'QUOKKA', uid: 2, from: 'ben@kunde.example', name: 'Ben', threadKey: THREAD, date: EARLIER, arrivedAt: T1 }));
    release('ZEBRA', 'auto_handled');
    await until(() => inbox.listItems().length === 1);
    const filed = inbox.listItems()[0]!;
    inbox.updateUserAction(filed.id, 'archived', new Date(), filed.tenantId);
    inbox.appendAudit({ tenantId: filed.tenantId, itemId: filed.id, action: 'archived', actor: 'user', payloadJson: JSON.stringify({ undo_logged: true }) });
    release('QUOKKA', 'requires_user');
    await queue.drain();

    const item = inbox.getItem(filed.id)!;
    expect(item.bucket).toBe('requires_user');
    expect(item.userAction).toBeUndefined();
    const shown = itemFollowUps(inbox, item);
    expect(shown?.count).toBeGreaterThanOrEqual(1);
    expect(shown?.latestFromName).toBe('Ben');
  });
});

describe('a joined mail drained at shutdown on an account whose envelope cannot tell an automatic reply', () => {
  it('does not wait for the provider: the drain ends and the mail is recorded, its automatic-reply answer unknown', async () => {
    const THREAD = 'graph:conv-drain';
    const { llm, release } = gatedLlm();
    const confirmAutoReply = vi.fn(() => new Promise<boolean>(() => { /* the provider never answers */ }));
    const { queue, hook } = setup('oauth_microsoft', llm, { confirmAutoReply });
    await hook(envelope({ tag: 'ZEBRA', uid: 1, from: 'shop@laden.example', name: 'Laden', threadKey: THREAD, date: T0, arrivedAt: T0 }));
    release('ZEBRA', 'auto_handled');
    await until(() => inbox.listItems().length === 1);
    const env = envelope({ tag: 'OKAPI', uid: 3, from: 'cleo@kunde.example', name: 'Cleo', threadKey: THREAD, date: T1, arrivedAt: T1 });
    queue.enqueue({
      accountId: ACCOUNT.id, channel: 'email', threadKey: THREAD,
      classifierInput: { accountAddress: ACCOUNT.address, accountDisplayName: 'Me', subject: env.subject, fromAddress: 'cleo@kunde.example', fromDisplayName: 'Cleo', body: env.snippet },
      envelope: { fromAddress: 'cleo@kunde.example', fromName: 'Cleo', subject: env.subject, mailDate: T1, snippet: env.snippet, messageId: '<okapi@x>', inReplyTo: undefined },
      mail: env,
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    // run-group-starter: a test deadline, cleared below; it only settles a local promise.
    const deadline = new Promise<'timed out'>((r) => { timer = setTimeout(() => r('timed out'), 2_000); });
    const drained = queue.drain({ deadLetterPending: new DrainedForShutdownError() }).then(() => 'drained' as const);
    const outcome = await Promise.race([drained, deadline]);
    clearTimeout(timer);
    expect(outcome).toBe('drained');
    expect(confirmAutoReply).not.toHaveBeenCalled();
    const item = inbox.listItems()[0]!;
    expect(inbox.listAuditForItem(item.id).filter((a) => a.action === 'joined_thread')).toHaveLength(1);
    const stored = inbox.listThreadMessages(ACCOUNT.id, THREAD).find((m) => m.messageId === '<okapi@x>');
    expect(stored).toBeDefined();
    expect(stored?.autoReply).toBeUndefined();
  });
});

describe('a mail handed to the classifier twice', () => {
  it('is filed once: one item, one audit, one push, one stored message, no joined entry', async () => {
    const THREAD = 'gmail:thread-redelivered';
    const { llm, release } = gatedLlm();
    const { queue, hook } = setup('oauth_google', llm);
    const env = envelope({ tag: 'ZEBRA', uid: 1, from: 'anna@kunde.example', name: 'Anna', threadKey: THREAD, date: T0, arrivedAt: T0 });
    expect(await hook(env)).toBe('enqueued');
    expect(await hook({ ...env, uid: 2 })).toBe('enqueued');
    release('ZEBRA', 'requires_user');
    await queue.drain();
    const items = inbox.listItems();
    expect(items).toHaveLength(1);
    expect(actions(items[0]!.id)).toEqual(['classified']);
    expect(pushes).toHaveLength(1);
    expect(inbox.listThreadMessages(ACCOUNT.id, THREAD)).toHaveLength(1);
  });
});

describe('a joined mail the sensitive check flagged', () => {
  it.each(['mask', 'allow'] as const)('under %s: raises with a flagged push, stores it as the mode says, and leaves the item\'s own mail unflagged', async (mode) => {
    const THREAD = `gmail:thread-sensitive-${mode}`;
    const { llm, release } = gatedLlm();
    const { queue, hook } = setup('oauth_google', llm, { sensitiveMode: mode });
    await hook(envelope({ tag: 'ZEBRA', uid: 1, from: 'shop@laden.example', name: 'Laden', threadKey: THREAD, date: T0, arrivedAt: T0 }));
    expect(await hook(envelope({
      tag: 'QUOKKA', uid: 2, from: 'ben@kunde.example', name: 'Ben', threadKey: THREAD, date: T1, arrivedAt: T1,
      snippet: 'Text QUOKKA: bitte überweisen auf CH9300762011623852957.',
    }))).toBe('enqueued');
    release('ZEBRA', 'auto_handled');
    release('QUOKKA', 'auto_handled');
    await queue.drain();

    const item = inbox.listItems()[0]!;
    expect(item.bucket).toBe('requires_user');
    expect(item.fromAddress).toBe('shop@laden.example');
    expect(inbox.sensitiveCategoriesAtIngest(item), 'the item\'s own mail is not flagged by the joined one').toEqual([]);
    expect(actions(item.id)).toContain('raised_on_sensitive_follow_up');
    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.opts?.flagged).toBe(true);
    const joined = JSON.parse(inbox.listAuditForItem(item.id).find((a) => a.action === 'joined_thread')!.payloadJson) as Record<string, unknown>;
    expect(joined).toMatchObject({ joined_sensitive_categories: ['iban'], joined_sensitive_masked: mode === 'mask', bucket: 'requires_user', classifier_bucket: 'auto_handled' });
    const stored = inbox.listThreadMessages(ACCOUNT.id, THREAD).find((m) => m.messageId === '<quokka@x>');
    if (mode === 'mask') expect(stored?.snippet).not.toContain('CH9300762011623852957');
    else expect(stored?.snippet).toContain('CH9300762011623852957');
  });
});
