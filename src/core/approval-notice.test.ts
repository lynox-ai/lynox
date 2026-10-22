import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngineDb } from './engine-db.js';
import { Engine } from './engine.js';
import { reloadConfig } from './config.js';
import { ApprovalStore, type FileApprovalInput, type FiledEntry } from './approval-store.js';
import { APPROVAL_NOTICE_OWNER, APPROVAL_NOTICE_MANDATE, APPROVAL_NOTICE_MIN_GAP_MS, createApprovalNotifier } from './approval-notice.js';
import type { NotificationChannel, NotificationMessage } from './notification-router.js';
import type { LynoxConfig } from '../types/config.js';

// Every filed entry sends one push to the owner's devices and one to live mandates' devices, each with its own fixed sentence, none with a
// value from the entry, and only the owner's with the mark an approval view opens on.

const T0 = Date.parse('2026-10-22T08:00:00.000Z');

const filing = (n: number): FileApprovalInput => ({
  filing: {
    kind: 'mail_reply',
    payload: {
      accountId: 'acc-1',
      fromAddress: 'owner@example.com',
      to: [{ address: `kunde${n}@example.com` }],
      cc: [],
      subject: `Re: Anfrage ${n}`,
      bodyText: `Vertraulicher Text ${n}`,
      originalThreadKey: `thread-${n}`,
      originalMessageId: `<m${n}@example.com>`,
      originalFolderUid: `INBOX:${n}`,
      original: { from: `kunde${n}@example.com`, to: ['owner@example.com'], cc: [], subject: `Anfrage ${n}`, date: '2026-10-21T10:00:00.000Z' },
    },
  },
  origin: { source: 'workflow', triggerId: 'trg-1', runId: `run-${n}`, rootRunId: `run-${n}` },
  createdBy: 'owner',
  mandateId: null,
  now: T0,
});

function recordingRouter(): { notify: (msg: NotificationMessage) => Promise<never[]>; sent: NotificationMessage[] } {
  const sent: NotificationMessage[] = [];
  return { sent, notify: async (msg) => { sent.push(msg); return []; } };
}

describe('the approval push', () => {
  it('sends the owner and the mandates each a fixed sentence, one tag per side, no values', () => {
    const router = recordingRouter();
    createApprovalNotifier({ router, enabled: () => true, now: () => T0 })({ id: 'entry-1', kind: 'mail_reply' });
    expect(router.sent).toEqual([
      { title: 'lynox', body: 'Eine Mail wartet auf deine Freigabe', priority: 'normal', taskId: 'lynox-approval-queue', audience: 'owner', data: { approvals: '1' } },
      { title: 'lynox', body: 'Eine Mail wartet auf die Freigabe des Inhabers', priority: 'normal', taskId: 'lynox-approval-queue-mandate', audience: 'mandates' },
    ]);
    // Nothing of the entry travels: not its id, not its kind.
    expect(JSON.stringify(router.sent)).not.toMatch(/entry-1|mail_reply/);
  });

  it('speaks English to an instance set to English, German to any other, and reads it per round', () => {
    const router = recordingRouter();
    let language: string | undefined = 'en';
    let now = T0;
    const notify = createApprovalNotifier({ router, enabled: () => true, now: () => now, language: () => language });
    notify({ id: 'entry-1', kind: 'mail_reply' });
    expect(router.sent).toEqual([
      { title: 'lynox', body: 'An email is waiting for your approval.', priority: 'normal', taskId: 'lynox-approval-queue', audience: 'owner', data: { approvals: '1' } },
      { title: 'lynox', body: "An email is waiting for the owner's approval.", priority: 'normal', taskId: 'lynox-approval-queue-mandate', audience: 'mandates' },
    ]);
    language = ' EN ';
    now = T0 + APPROVAL_NOTICE_MIN_GAP_MS;
    notify({ id: 'entry-2', kind: 'mail_reply' });
    expect(router.sent.slice(2).map((m) => m.body)).toEqual(['An email is waiting for your approval.', "An email is waiting for the owner's approval."]);
    // Only exactly `en` is English: a regional tag or another language keeps German.
    for (const [i, other] of (['en-US', 'fr'] as const).entries()) {
      language = other;
      now = T0 + (2 + i) * APPROVAL_NOTICE_MIN_GAP_MS;
      notify({ id: `entry-${String(3 + i)}`, kind: 'mail_reply' });
      expect(router.sent.slice(4 + 2 * i).map((m) => m.body)).toEqual([APPROVAL_NOTICE_OWNER.body, APPROVAL_NOTICE_MANDATE.body]);
    }
  });

  // A tap on the mandate's push must not lead to an approval. The service worker deep-links only
  // on `data.itemId` or `data.threadId` (sw.js `notificationclick`); the mandate's push sets no data
  // of its own, so nothing it carries can ever be routed to an approval.
  it('gives the mandate\'s push no data, so its tap opens no approval view', () => {
    const router = recordingRouter();
    createApprovalNotifier({ router, enabled: () => true, now: () => T0 })({ id: 'entry-1', kind: 'mail_send' });
    const mandate = router.sent.find((m) => m.audience === 'mandates');
    expect(mandate).toBeDefined();
    expect(mandate!.data).toBeUndefined();
    expect(router.sent.find((m) => m.audience === 'owner')!.data).toEqual({ approvals: '1' });
  });

  it('sends nothing while the queue is off, and reads the switch at each filing', () => {
    const router = recordingRouter();
    let on = false;
    const notify = createApprovalNotifier({ router, enabled: () => on, now: () => T0 });
    notify({ id: 'a', kind: 'mail_reply' });
    expect(router.sent).toHaveLength(0);
    on = true;
    notify({ id: 'b', kind: 'mail_reply' });
    expect(router.sent).toHaveLength(2);
  });

  it(`sends at most one round per ${APPROVAL_NOTICE_MIN_GAP_MS / 1000} s, and the next one after the gap`, () => {
    const router = recordingRouter();
    let now = T0;
    const notify = createApprovalNotifier({ router, enabled: () => true, now: () => now, schedule: () => {} });
    notify({ id: 'a', kind: 'mail_reply' });
    now = T0 + APPROVAL_NOTICE_MIN_GAP_MS - 1;
    notify({ id: 'b', kind: 'mail_send' });
    expect(router.sent).toHaveLength(2);
    now = T0 + APPROVAL_NOTICE_MIN_GAP_MS;
    notify({ id: 'c', kind: 'mail_reply' });
    expect(router.sent).toHaveLength(4);
  });

  // An entry filed inside the minute is still announced: one round follows when the minute is up,
  // or the owner who already dismissed the first push would hear nothing of it.
  it('sends one held round at the end of the minute for every filing it held back', () => {
    const router = recordingRouter();
    let now = T0;
    const timers: Array<{ run: () => void; delay: number }> = [];
    const notify = createApprovalNotifier({ router, enabled: () => true, now: () => now, schedule: (run, delay) => { timers.push({ run, delay }); } });
    notify({ id: 'a', kind: 'mail_reply' });
    now = T0 + 1_000;
    notify({ id: 'b', kind: 'mail_reply' });
    now = T0 + 2_000;
    notify({ id: 'c', kind: 'mail_reply' });
    expect(router.sent).toHaveLength(2);
    expect(timers).toHaveLength(1);
    expect(timers[0]!.delay).toBe(APPROVAL_NOTICE_MIN_GAP_MS - 1_000);
    now = T0 + APPROVAL_NOTICE_MIN_GAP_MS;
    timers[0]!.run();
    expect(router.sent).toHaveLength(4);
  });

  // A timer that runs late (a busy event loop) must not add a round to one a filing just sent.
  it('lets a late timer stand down when a round went out after it was set', () => {
    const router = recordingRouter();
    let now = T0;
    const timers: Array<() => void> = [];
    const notify = createApprovalNotifier({ router, enabled: () => true, now: () => now, schedule: (run) => { timers.push(run); } });
    notify({ id: 'a', kind: 'mail_reply' });
    now = T0 + 1_000;
    notify({ id: 'b', kind: 'mail_reply' }); // held: timer 0
    now = T0 + APPROVAL_NOTICE_MIN_GAP_MS + 500;
    notify({ id: 'c', kind: 'mail_reply' }); // the minute is up: its own round
    now = T0 + APPROVAL_NOTICE_MIN_GAP_MS + 1_000;
    notify({ id: 'd', kind: 'mail_reply' }); // held again: timer 1
    expect(router.sent).toHaveLength(4);
    expect(timers).toHaveLength(2);
    timers[0]!(); // late: a round went out since it was set
    expect(router.sent).toHaveLength(4);
    now = T0 + 2 * APPROVAL_NOTICE_MIN_GAP_MS + 500;
    timers[1]!(); // d's round
    expect(router.sent).toHaveLength(6);
  });

  it('sends no held round once the queue was turned off, nor one a later filing already sent', () => {
    const router = recordingRouter();
    let now = T0;
    let on = true;
    const timers: Array<() => void> = [];
    const notify = createApprovalNotifier({ router, enabled: () => on, now: () => now, schedule: (run) => { timers.push(run); } });
    notify({ id: 'a', kind: 'mail_reply' });
    now = T0 + 1_000;
    notify({ id: 'b', kind: 'mail_reply' });
    on = false;
    timers[0]!();
    expect(router.sent).toHaveLength(2);
    // A filing after the minute sends its own round; the timer that was set before it adds none.
    on = true;
    now = T0 + 2 * APPROVAL_NOTICE_MIN_GAP_MS;
    notify({ id: 'c', kind: 'mail_reply' });
    now = T0 + 2 * APPROVAL_NOTICE_MIN_GAP_MS + 1_000;
    notify({ id: 'd', kind: 'mail_reply' });
    now = T0 + 3 * APPROVAL_NOTICE_MIN_GAP_MS;
    notify({ id: 'e', kind: 'mail_reply' });
    expect(router.sent).toHaveLength(6);
    timers[1]!();
    expect(router.sent).toHaveLength(6);
  });

  it('never throws and never leaves a rejected promise, whatever the router does', async () => {
    const rejected: unknown[] = [];
    const onRejection = (reason: unknown): void => { rejected.push(reason); };
    process.on('unhandledRejection', onRejection);
    try {
      const notify = createApprovalNotifier({ router: { notify: async () => { throw new Error('down'); } }, enabled: () => true, now: () => T0 });
      expect(() => notify({ id: 'a', kind: 'mail_reply' })).not.toThrow();
      await new Promise((r) => setTimeout(r, 10));
      expect(rejected).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });

  it('hands every caller its own copy, so a channel that edits the message cannot change the next one', () => {
    const router = recordingRouter();
    let now = T0;
    const notify = createApprovalNotifier({ router, enabled: () => true, now: () => now });
    notify({ id: 'a', kind: 'mail_reply' });
    router.sent[0]!.data!['approvals'] = 'x';
    router.sent[1]!.body = 'x';
    now += APPROVAL_NOTICE_MIN_GAP_MS;
    notify({ id: 'b', kind: 'mail_reply' });
    expect(router.sent[2]!.data).toEqual({ approvals: '1' });
    expect(router.sent[3]!.body).toBe(APPROVAL_NOTICE_MANDATE.body);
    expect(APPROVAL_NOTICE_OWNER.data).toEqual({ approvals: '1' });
  });
});

describe('the store tells its listener', () => {
  let dir: string;
  let engine: EngineDb;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-approval-notice-'));
    engine = new EngineDb(join(dir, 'engine.db'), 'test-vault-key');
  });
  afterEach(() => {
    engine.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('once per filed entry, after it is stored, and never for a refused filing', () => {
    const seen: Array<FiledEntry & { stored: boolean }> = [];
    const store: ApprovalStore = new ApprovalStore(engine, {
      onFiled: (entry) => { seen.push({ ...entry, stored: store.get(entry.id)?.status === 'pending' }); },
    });
    const first = store.file(filing(1));
    expect(first.ok).toBe(true);
    expect(seen).toEqual([{ id: (first as { id: string }).id, kind: 'mail_reply', stored: true }]);
    // The same mail again is a duplicate: refused, and nobody is told.
    expect(store.file(filing(1)).ok).toBe(false);
    expect(seen).toHaveLength(1);
    // A new mail names its own kind.
    const sent = store.file({
      filing: { kind: 'mail_send', payload: { accountId: 'acc-1', fromAddress: 'owner@example.com', to: [{ address: 'b@example.com' }], cc: [], bcc: [], subject: 'Bericht', bodyText: 'Text', trackFollowup: null } },
      origin: { source: 'task', triggerId: 'trg-2', runId: 'run-9', rootRunId: 'run-9' }, createdBy: 'owner', mandateId: null, now: T0,
    });
    expect(sent.ok).toBe(true);
    expect(seen[1]).toMatchObject({ id: (sent as { id: string }).id, kind: 'mail_send', stored: true });
  });

  it('keeps a filing that its listener throws on: the entry is filed and the caller is told so', () => {
    const store = new ApprovalStore(engine, { onFiled: () => { throw new Error('push down'); } });
    const result = store.file(filing(2));
    expect(result.ok).toBe(true);
    expect(store.get((result as { id: string }).id)?.status).toBe('pending');
  });
});

describe('a booted engine tells the owner of every filed entry', () => {
  const dirs: string[] = [];
  const engines: Engine[] = [];
  const ENV_KEYS = ['LYNOX_DATA_DIR', 'LYNOX_VAULT_KEY', 'LYNOX_FEATURE_APPROVAL_QUEUE', 'LYNOX_MANAGED_INSTANCE_ID'] as const;
  const saved = new Map<string, string | undefined>();
  function setEnv(key: string, value: string | undefined): void {
    if (!saved.has(key)) saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }

  afterEach(async () => {
    for (const e of engines) { try { await e.shutdown(); } catch { /* best effort */ } }
    engines.length = 0;
    for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    saved.clear();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
    reloadConfig();
  });

  async function boot(flag: string | undefined, language?: string): Promise<{ engine: Engine; received: NotificationMessage[] }> {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-approval-notice-boot-'));
    dirs.push(dir);
    for (const k of ENV_KEYS) setEnv(k, undefined);
    setEnv('LYNOX_DATA_DIR', dir);
    setEnv('LYNOX_FEATURE_APPROVAL_QUEUE', flag);
    reloadConfig();
    const engine = new Engine((language === undefined ? {} : { language }) as LynoxConfig);
    engines.push(engine);
    await engine.init();
    const received: NotificationMessage[] = [];
    const channel: NotificationChannel = { name: 'test-recorder', send: async (msg) => { received.push(msg); return 'delivered'; } };
    engine.getNotificationRouter().register(channel);
    return { engine, received };
  }

  it('through the router the engine notifies with, from the store every run files into', async () => {
    const { engine, received } = await boot('1');
    const result = engine.getApprovalStore()!.file(filing(3));
    expect(result.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(received.map((m) => [m.audience, m.body])).toEqual([
      ['owner', 'Eine Mail wartet auf deine Freigabe'],
      ['mandates', 'Eine Mail wartet auf die Freigabe des Inhabers'],
    ]);
    expect(JSON.stringify(received)).not.toMatch(/Vertraulicher|kunde3|Anfrage/);
  });

  it('in the language the engine was configured with', async () => {
    const { engine, received } = await boot('1', 'en');
    expect(engine.getApprovalStore()!.file(filing(5)).ok).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(received.map((m) => m.body)).toEqual(['An email is waiting for your approval.', "An email is waiting for the owner's approval."]);
  });

  it('not while the queue is off', async () => {
    const { engine, received } = await boot(undefined);
    expect(engine.getApprovalStore()!.file(filing(4)).ok).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(received).toHaveLength(0);
  });
});
