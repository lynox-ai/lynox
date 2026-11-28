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

function setup(authType: MailAuthType, llm: LLMCaller): { queue: ClassifierQueue<InboxQueuePayload>; hook: (env: MailEnvelope) => Promise<unknown> } {
  const resolver = accounts(authType);
  const queue = buildInboxRunner({ state: inbox, llm, notifier, policy: { retryOnce: false }, followUps: { accounts: resolver } });
  const hook = createInboxClassifierHook({ state: inbox, rules: new InboxRulesLoader(inbox), queue, accounts: resolver, notifier });
  return { queue, hook: (env) => hook(ACCOUNT.id, env) };
}

function envelope(o: { tag: string; uid: number; from: string; name: string; threadKey: string; date: Date; arrivedAt?: Date }): MailEnvelope {
  return {
    uid: o.uid, messageId: `<${o.tag.toLowerCase()}@x>`, folder: 'INBOX', threadKey: o.threadKey, inReplyTo: undefined,
    from: [{ address: o.from, name: o.name }], to: [{ address: ACCOUNT.address }], cc: [], replyTo: [],
    subject: 'Bestellung 1043', date: o.date, ...(o.arrivedAt !== undefined ? { arrivedAt: o.arrivedAt } : {}),
    flags: [], snippet: `Text ${o.tag}: wo bleibt die Lieferung?`, hasAttachments: false, attachmentCount: 0, sizeBytes: 0,
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
      message_id: '<quokka@x>', bucket: 'requires_user', confidence: 0.9, fail_reason: null, raised: true, prior_bucket: 'auto_handled',
    });
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
