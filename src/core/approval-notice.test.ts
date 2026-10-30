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
import { currentRunGroup, openRunGroup } from './run-group.js';
import { listScopeOf } from './approval-view.js';
import type { LynoxConfig } from '../types/config.js';

// Every filed entry sends one push to the owner's devices and, when a mandate's run filed it, one to
// that grant's devices only, each with its own fixed sentence, none with a value from the entry, and
// only the owner's with the mark an approval view opens on.

const T0 = Date.parse('2026-10-22T08:00:00.000Z');

/** A filed entry; by default one a mandate's run filed under `grant-1`, so a round sends two pushes. */
const entry = (id: string, kind: FiledEntry['kind'] = 'mail_reply', mandateId: string | null = 'grant-1'): FiledEntry => ({ id, kind, mandateId });

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
  it('sends the owner and the filing grant each a fixed sentence, one tag per side, no values', () => {
    const router = recordingRouter();
    createApprovalNotifier({ router, enabled: () => true, now: () => T0 })(entry('entry-1', 'mail_reply'));
    expect(router.sent).toEqual([
      { title: 'lynox', body: 'Eine Mail wartet auf deine Freigabe', priority: 'normal', taskId: 'lynox-approval-queue', audience: 'owner', data: { approvals: '1' } },
      { title: 'lynox', body: 'Deine Mail wartet auf die Freigabe des Inhabers.', priority: 'normal', taskId: 'lynox-approval-queue-mandate', audience: 'mandates', mandateId: 'grant-1' },
    ]);
    // Nothing of the entry travels: not its id, not its kind.
    expect(JSON.stringify(router.sent)).not.toMatch(/entry-1|mail_reply/);
  });

  // A mandate sees only its own grant's entries, so it hears only of those: an entry the owner's
  // run filed reaches no mandate, and one grant's entry reaches only that grant.
  it('tells no mandate of an entry the owner\'s run filed, and only the filing grant of its own', () => {
    const router = recordingRouter();
    let now = T0;
    const notify = createApprovalNotifier({ router, enabled: () => true, now: () => now });
    notify(entry('a', 'mail_reply', null));
    expect(router.sent.map((m) => [m.audience, m.mandateId])).toEqual([['owner', undefined]]);
    now = T0 + APPROVAL_NOTICE_MIN_GAP_MS;
    notify(entry('b', 'mail_reply', 'grant-2'));
    expect(router.sent.slice(1).map((m) => [m.audience, m.mandateId])).toEqual([['owner', undefined], ['mandates', 'grant-2']]);
  });

  // The held round tells every grant that filed inside the minute, each once, and the owner once;
  // a grant that filed before that round is not told again by the next one.
  it('tells each grant that filed inside the minute once in the held round, and not again after', () => {
    const router = recordingRouter();
    let now = T0;
    const timers: Array<() => void> = [];
    const notify = createApprovalNotifier({ router, enabled: () => true, now: () => now, schedule: (run) => { timers.push(run); } });
    notify(entry('a', 'mail_reply', 'grant-1'));
    now = T0 + 1_000;
    notify(entry('b', 'mail_reply', 'grant-2'));
    notify(entry('c', 'mail_reply', null));
    notify(entry('d', 'mail_send', 'grant-2'));
    notify(entry('e', 'mail_reply', 'grant-3'));
    expect(router.sent).toHaveLength(2);
    now = T0 + APPROVAL_NOTICE_MIN_GAP_MS;
    timers[0]!();
    expect(router.sent.slice(2).map((m) => [m.audience, m.mandateId])).toEqual([['owner', undefined], ['mandates', 'grant-2'], ['mandates', 'grant-3']]);
    now = T0 + 2 * APPROVAL_NOTICE_MIN_GAP_MS;
    notify(entry('f', 'mail_reply', null));
    expect(router.sent.slice(5).map((m) => [m.audience, m.mandateId])).toEqual([['owner', undefined]]);
  });

  it('drops the grants a held round kept when the queue was turned off before it fired', () => {
    const router = recordingRouter();
    let now = T0;
    let on = true;
    const timers: Array<() => void> = [];
    const notify = createApprovalNotifier({ router, enabled: () => on, now: () => now, schedule: (run) => { timers.push(run); } });
    notify(entry('a', 'mail_reply', null));
    now = T0 + 1_000;
    notify(entry('b', 'mail_reply', 'grant-2'));
    on = false;
    now = T0 + APPROVAL_NOTICE_MIN_GAP_MS;
    timers[0]!();
    expect(router.sent).toHaveLength(1);
    on = true;
    now = T0 + 2 * APPROVAL_NOTICE_MIN_GAP_MS;
    notify(entry('c', 'mail_reply', null));
    expect(router.sent.slice(1).map((m) => [m.audience, m.mandateId])).toEqual([['owner', undefined]]);
  });

  it('speaks English to an instance set to English, German to any other, and reads it per round', () => {
    const router = recordingRouter();
    let language: string | undefined = 'en';
    let now = T0;
    const notify = createApprovalNotifier({ router, enabled: () => true, now: () => now, language: () => language });
    notify(entry('entry-1', 'mail_reply'));
    expect(router.sent).toEqual([
      { title: 'lynox', body: 'An email is waiting for your approval.', priority: 'normal', taskId: 'lynox-approval-queue', audience: 'owner', data: { approvals: '1' } },
      { title: 'lynox', body: "Your email is waiting for the owner's approval.", priority: 'normal', taskId: 'lynox-approval-queue-mandate', audience: 'mandates', mandateId: 'grant-1' },
    ]);
    language = ' EN ';
    now = T0 + APPROVAL_NOTICE_MIN_GAP_MS;
    notify(entry('entry-2', 'mail_reply'));
    expect(router.sent.slice(2).map((m) => m.body)).toEqual(['An email is waiting for your approval.', "Your email is waiting for the owner's approval."]);
    // Only exactly `en` is English: a regional tag or another language keeps German.
    for (const [i, other] of (['en-US', 'fr'] as const).entries()) {
      language = other;
      now = T0 + (2 + i) * APPROVAL_NOTICE_MIN_GAP_MS;
      notify(entry(`entry-${String(3 + i)}`));
      expect(router.sent.slice(4 + 2 * i).map((m) => m.body)).toEqual([APPROVAL_NOTICE_OWNER.body, APPROVAL_NOTICE_MANDATE.body]);
    }
  });

  // A tap on the mandate's push must not lead to an approval. The service worker deep-links only
  // on `data.itemId` or `data.threadId` (sw.js `notificationclick`); the mandate's push sets no data
  // of its own, so nothing it carries can ever be routed to an approval.
  it('gives the mandate\'s push no data, so its tap opens no approval view', () => {
    const router = recordingRouter();
    createApprovalNotifier({ router, enabled: () => true, now: () => T0 })(entry('entry-1', 'mail_send'));
    const mandate = router.sent.find((m) => m.audience === 'mandates');
    expect(mandate).toBeDefined();
    expect(mandate!.data).toBeUndefined();
    expect(router.sent.find((m) => m.audience === 'owner')!.data).toEqual({ approvals: '1' });
  });

  it('sends nothing while the queue is off, and reads the switch at each filing', () => {
    const router = recordingRouter();
    let on = false;
    const notify = createApprovalNotifier({ router, enabled: () => on, now: () => T0 });
    notify(entry('a', 'mail_reply'));
    expect(router.sent).toHaveLength(0);
    on = true;
    notify(entry('b', 'mail_reply'));
    expect(router.sent).toHaveLength(2);
  });

  it(`sends at most one round per ${APPROVAL_NOTICE_MIN_GAP_MS / 1000} s, and the next one after the gap`, () => {
    const router = recordingRouter();
    let now = T0;
    const notify = createApprovalNotifier({ router, enabled: () => true, now: () => now, schedule: () => {} });
    notify(entry('a', 'mail_reply'));
    now = T0 + APPROVAL_NOTICE_MIN_GAP_MS - 1;
    notify(entry('b', 'mail_send'));
    expect(router.sent).toHaveLength(2);
    now = T0 + APPROVAL_NOTICE_MIN_GAP_MS;
    notify(entry('c', 'mail_reply'));
    expect(router.sent).toHaveLength(4);
  });

  // The held round may fire after the run that filed the entry has ended, so it carries no run's
  // group: anything it spends must not be booked to that run.
  it('sends the held round outside the run group of the filing that held it', async () => {
    const groups: Array<string | null> = [];
    let now = T0;
    const router = { notify: async (_m: NotificationMessage) => { groups.push(currentRunGroup()); } };
    const notify = createApprovalNotifier({ router, enabled: () => true, now: () => now });
    openRunGroup('run-1', () => {
      notify(entry('a', 'mail_reply'));
      now = T0 + APPROVAL_NOTICE_MIN_GAP_MS - 5;
      notify(entry('b', 'mail_reply'));
    });
    expect(groups, 'positive control: the first round ran inside the run').toEqual(['run-1', 'run-1']);
    now = T0 + APPROVAL_NOTICE_MIN_GAP_MS;
    await new Promise((r) => setTimeout(r, 50));
    expect(groups).toEqual(['run-1', 'run-1', null, null]);
  });

  // An entry filed inside the minute is still announced: one round follows when the minute is up,
  // or the owner who already dismissed the first push would hear nothing of it.
  it('sends one held round at the end of the minute for every filing it held back', () => {
    const router = recordingRouter();
    let now = T0;
    const timers: Array<{ run: () => void; delay: number }> = [];
    const notify = createApprovalNotifier({ router, enabled: () => true, now: () => now, schedule: (run, delay) => { timers.push({ run, delay }); } });
    notify(entry('a', 'mail_reply'));
    now = T0 + 1_000;
    notify(entry('b', 'mail_reply'));
    now = T0 + 2_000;
    notify(entry('c', 'mail_reply'));
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
    notify(entry('a', 'mail_reply'));
    now = T0 + 1_000;
    notify(entry('b', 'mail_reply')); // held: timer 0
    now = T0 + APPROVAL_NOTICE_MIN_GAP_MS + 500;
    notify(entry('c', 'mail_reply')); // the minute is up: its own round
    now = T0 + APPROVAL_NOTICE_MIN_GAP_MS + 1_000;
    notify(entry('d', 'mail_reply')); // held again: timer 1
    expect(router.sent).toHaveLength(4);
    expect(timers).toHaveLength(2);
    timers[0]!(); // late: a round went out since it was set
    expect(router.sent).toHaveLength(4);
    now = T0 + 2 * APPROVAL_NOTICE_MIN_GAP_MS + 500;
    timers[1]!(); // d's round
    expect(router.sent).toHaveLength(6);
  });

  // The round in between takes the grant the late timer held, and the late timer standing down
  // takes nothing from the grants held after that round.
  it('lets the round in between tell the grant a late timer held, and the late timer keep later grants', () => {
    const router = recordingRouter();
    let now = T0;
    const timers: Array<() => void> = [];
    const notify = createApprovalNotifier({ router, enabled: () => true, now: () => now, schedule: (run) => { timers.push(run); } });
    const grantsOf = (from: number): Array<string | undefined> => router.sent.slice(from).map((m) => m.mandateId);
    notify(entry('a', 'mail_reply', 'grant-1'));
    now = T0 + 1_000;
    notify(entry('b', 'mail_reply', 'grant-2')); // held: timer 0
    now = T0 + APPROVAL_NOTICE_MIN_GAP_MS + 500;
    notify(entry('c', 'mail_reply', 'grant-3')); // its own round, which also tells grant-2
    expect(grantsOf(2)).toEqual([undefined, 'grant-2', 'grant-3']);
    now = T0 + APPROVAL_NOTICE_MIN_GAP_MS + 1_000;
    notify(entry('d', 'mail_reply', 'grant-4')); // held: timer 1
    timers[0]!(); // late: stands down
    expect(router.sent).toHaveLength(5);
    now = T0 + 2 * APPROVAL_NOTICE_MIN_GAP_MS + 500;
    timers[1]!();
    expect(grantsOf(5)).toEqual([undefined, 'grant-4']);
  });

  it('sends no held round once the queue was turned off, nor one a later filing already sent', () => {
    const router = recordingRouter();
    let now = T0;
    let on = true;
    const timers: Array<() => void> = [];
    const notify = createApprovalNotifier({ router, enabled: () => on, now: () => now, schedule: (run) => { timers.push(run); } });
    notify(entry('a', 'mail_reply'));
    now = T0 + 1_000;
    notify(entry('b', 'mail_reply'));
    on = false;
    timers[0]!();
    expect(router.sent).toHaveLength(2);
    // A filing after the minute sends its own round; the timer that was set before it adds none.
    on = true;
    now = T0 + 2 * APPROVAL_NOTICE_MIN_GAP_MS;
    notify(entry('c', 'mail_reply'));
    now = T0 + 2 * APPROVAL_NOTICE_MIN_GAP_MS + 1_000;
    notify(entry('d', 'mail_reply'));
    now = T0 + 3 * APPROVAL_NOTICE_MIN_GAP_MS;
    notify(entry('e', 'mail_reply'));
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
      expect(() => notify(entry('a', 'mail_reply'))).not.toThrow();
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
    notify(entry('a', 'mail_reply'));
    router.sent[0]!.data!['approvals'] = 'x';
    router.sent[1]!.body = 'x';
    now += APPROVAL_NOTICE_MIN_GAP_MS;
    notify(entry('b', 'mail_reply'));
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
    expect(seen).toEqual([{ id: (first as { id: string }).id, kind: 'mail_reply', mandateId: null, stored: true }]);
    // The same mail again is a duplicate: refused, and nobody is told.
    expect(store.file(filing(1)).ok).toBe(false);
    expect(seen).toHaveLength(1);
    // A new mail names its own kind.
    const sent = store.file({
      filing: { kind: 'mail_send', payload: { accountId: 'acc-1', fromAddress: 'owner@example.com', to: [{ address: 'b@example.com' }], cc: [], bcc: [], subject: 'Bericht', bodyText: 'Text', trackFollowup: null } },
      origin: { source: 'task', triggerId: 'trg-2', runId: 'run-9', rootRunId: 'run-9' }, createdBy: 'mandate:anna@example.com', mandateId: 'grant-7', now: T0,
    });
    expect(sent.ok).toBe(true);
    // ...and the grant its run was filed under.
    expect(seen[1]).toEqual({ id: (sent as { id: string }).id, kind: 'mail_send', mandateId: 'grant-7', stored: true });
  });

  it('keeps a filing that its listener throws on: the entry is filed and the caller is told so', () => {
    const store = new ApprovalStore(engine, { onFiled: () => { throw new Error('push down'); } });
    const result = store.file(filing(2));
    expect(result.ok).toBe(true);
    expect(store.get((result as { id: string }).id)?.status).toBe('pending');
  });

  // The push and the list must tell each viewer the same thing: a grant hears of exactly the
  // entries its list shows, and the owner of all of them.
  it('pushes to a grant exactly the entries that grant\'s list shows', () => {
    const router = recordingRouter();
    let now = T0;
    const store = new ApprovalStore(engine, { onFiled: createApprovalNotifier({ router, enabled: () => true, now: () => now }) });
    const filers: Array<string | null> = [null, 'grant-a', 'grant-b', 'grant-a'];
    for (const [i, grant] of filers.entries()) {
      now = T0 + i * APPROVAL_NOTICE_MIN_GAP_MS;
      const f = filing(10 + i);
      expect(store.file({ ...f, createdBy: grant === null ? 'owner' : `mandate:${grant}@example.com`, mandateId: grant }).ok).toBe(true);
    }
    for (const grant of ['grant-a', 'grant-b', 'grant-c']) {
      const pushed = router.sent.filter((m) => m.audience === 'mandates' && m.mandateId === grant).length;
      const listed = store.list({ view: 'open', scope: listScopeOf({ viewer: 'mandate', mandateId: grant }) }).length;
      expect(pushed, grant).toBe(listed);
    }
    // Control: the owner hears of every entry and lists every one.
    expect(router.sent.filter((m) => m.audience === 'owner')).toHaveLength(filers.length);
    expect(store.list({ view: 'open', scope: listScopeOf({ viewer: 'owner' }) })).toHaveLength(filers.length);
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
    const result = engine.getApprovalStore()!.file({ ...filing(3), createdBy: 'mandate:anna@example.com', mandateId: 'grant-5' });
    expect(result.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(received.map((m) => [m.audience, m.mandateId, m.body])).toEqual([
      ['owner', undefined, 'Eine Mail wartet auf deine Freigabe'],
      ['mandates', 'grant-5', 'Deine Mail wartet auf die Freigabe des Inhabers.'],
    ]);
    expect(JSON.stringify(received)).not.toMatch(/Vertraulicher|kunde3|Anfrage/);
  });

  it('in the language the engine was configured with, and to no mandate for the owner\'s own entry', async () => {
    const { engine, received } = await boot('1', 'en');
    expect(engine.getApprovalStore()!.file(filing(5)).ok).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(received.map((m) => [m.audience, m.body])).toEqual([['owner', 'An email is waiting for your approval.']]);
  });

  it('not while the queue is off', async () => {
    const { engine, received } = await boot(undefined);
    expect(engine.getApprovalStore()!.file(filing(4)).ok).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(received).toHaveLength(0);
  });
});
