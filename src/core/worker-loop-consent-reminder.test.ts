import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkerLoop, consentReminderMessages, reminderTitle, REMINDER_BODY_MAX } from './worker-loop.js';
import { RunHistory } from './run-history.js';
import { EngineDb } from './engine-db.js';
import { TaskManager } from './task-manager.js';
import { TriggerStore, triggerRecordToRow } from './trigger-store.js';
import type { Engine } from './engine.js';
import type { Session } from './session.js';
import type { NotificationRouter } from './notification-router.js';
import type { TriggerRecord } from '../types/index.js';

/**
 * The consent reminder: an unconfirmed `run_agent` trigger that comes due is held back by
 * `getDue` without being touched, so without this nothing would ever tell its owner that it
 * waits. Driven through a REAL TaskManager + RunHistory + engine.db and the real tick; only
 * the agent session and the notification router are doubles.
 */

const T0 = Date.parse('2026-01-01T09:00:30.000Z');
const DUE = '2026-01-01T09:00:00.000Z';
const MIN = 60_000;

const dirs: string[] = [];
const closers: Array<() => void> = [];

afterEach(() => {
  vi.useRealTimers();
  for (const c of closers.splice(0).reverse()) c();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function newDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lynox-consent-'));
  dirs.push(dir);
  return dir;
}

interface Proc {
  loop: WorkerLoop;
  manager: TaskManager;
  history: RunHistory;
  engineDb: EngineDb;
  notify: ReturnType<typeof vi.fn>;
  channels: { on: boolean };
  dispatches: () => number;
}

/** One engine process on `dir`. Agent turns resolve at once; the router records what it sent. */
function boot(dir: string, channelsOn = true): Proc {
  const history = new RunHistory(join(dir, 'history.db'));
  const engineDb = new EngineDb(join(dir, 'engine.db'));
  history.setVerbGraph(engineDb);
  closers.push(() => { try { history.close(); } catch { /* twice is fine */ } });
  closers.push(() => { try { engineDb.close(); } catch { /* twice is fine */ } });
  const manager = new TaskManager(history);
  const run = vi.fn(async () => 'done');
  const session = { sessionId: 'thread-consent', _recreateAgent: vi.fn(), getAgent: () => null, getLastRunStop: () => null, promptUser: undefined, run };
  const engine = {
    getTaskManager: () => manager,
    createSession: () => session as unknown as Session,
    getPromptStore: () => null,
    getRunHistory: () => history,
    getSecretStore: () => null,
    getBulkLedger: () => null,
    getUserConfig: () => ({}),
    workerRunModelOverride: () => ({}),
    escalateToUser: () => null,
  } as unknown as Engine;
  const channels = { on: channelsOn };
  const notify = vi.fn().mockResolvedValue(undefined);
  const router = { hasChannels: () => channels.on, notify } as unknown as NotificationRouter;
  const loop = new WorkerLoop(engine, router, 60_000);
  closers.push(() => loop.stop());
  return { loop, manager, history, engineDb, notify, channels, dispatches: () => run.mock.calls.length };
}

function seed(p: Proc, over: { id?: string; confirmedAt?: string; nextRunAt?: string; effect?: 'run_agent' | 'notify' } = {}): string {
  const id = over.id ?? 'trg-1';
  p.history.insertTrigger({
    id, title: 'Weekly digest', source: 'cron', effect: over.effect ?? 'run_agent',
    scheduleCron: '0 9 * * 1', nextRunAt: over.nextRunAt ?? DUE,
    ...(over.confirmedAt ? { confirmedAt: over.confirmedAt } : {}),
  });
  return id;
}

interface Row {
  enabled: number; status: string; next_run_at: string | null; last_run_at: string | null;
  last_run_status: string | null; consent_reminded_at: string | null;
}
function row(p: Proc, id = 'trg-1'): Row {
  return p.engineDb.getDb().prepare(
    'SELECT enabled, status, next_run_at, last_run_at, last_run_status, consent_reminded_at FROM triggers WHERE id = ?',
  ).get(id) as Row;
}

/** The reminders sent so far — told apart from every other notification by their headline. */
function reminders(p: Proc): Array<{ title: string; body: string; taskId?: string; priority: string }> {
  return (p.notify.mock.calls.map((c) => c[0]) as Array<{ title: string; body: string; taskId?: string; priority: string }>)
    .filter((m) => m.title.startsWith('\u23F8 '));
}

async function tickAt(p: Proc, t: number): Promise<void> {
  vi.setSystemTime(t);
  await p.loop.tick();
  await new Promise((r) => setImmediate(r));
}

describe('the consent reminder', () => {
  it('tells the owner once when an unconfirmed agent trigger comes due, and leaves the trigger as it was', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const p = boot(newDir());
    seed(p);
    const before = row(p);

    await tickAt(p, T0);
    const sent = reminders(p);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ taskId: 'trg-1', priority: 'normal' });
    // The headline is the engine's sentence; the trigger's own title only appears quoted in
    // the body, next to where to look before confirming.
    expect(sent[0]!.title).not.toContain('Weekly digest');
    expect(sent[0]!.body).toContain('came due and has not run');
    expect(sent[0]!.body).toContain('Review \u201CWeekly digest\u201D under Automation \u203A Triggers before you confirm it.');
    expect(sent[0]!.body).not.toContain('outside');

    // No run, no failure, no disable, the due time kept so confirming makes it due in place.
    expect(p.dispatches()).toBe(0);
    const after = row(p);
    expect(after.enabled).toBe(before.enabled);
    expect(after.status).toBe(before.status);
    expect(after.next_run_at).toBe(before.next_run_at);
    expect(after.last_run_at).toBeNull();
    expect(after.last_run_status).toBeNull();

    // Once: the next ticks are silent.
    await tickAt(p, T0 + MIN);
    await tickAt(p, T0 + 60 * MIN);
    expect(reminders(p)).toHaveLength(1);
  });

  it('stays told across a restart — the marker is on the row, not in the process', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const dir = newDir();
    const a = boot(dir);
    seed(a);
    await tickAt(a, T0);
    expect(reminders(a)).toHaveLength(1);

    const b = boot(dir);
    await tickAt(b, T0 + 5 * MIN);
    expect(reminders(b)).toHaveLength(0);
  });

  it('a trigger that came due while the engine was down is reminded at the first tick after', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const p = boot(newDir());
    seed(p);
    await tickAt(p, T0 + 3 * 24 * 60 * MIN);
    expect(reminders(p)).toHaveLength(1);
  });

  it('says nothing before the trigger is due', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const p = boot(newDir());
    seed(p, { nextRunAt: '2026-01-01T10:00:00.000Z' });
    await tickAt(p, T0);
    expect(reminders(p)).toHaveLength(0);
    expect(row(p).consent_reminded_at).toBeNull();
    await tickAt(p, Date.parse('2026-01-01T10:00:30.000Z'));
    expect(reminders(p)).toHaveLength(1);
  });

  it('says nothing about a confirmed trigger, which simply runs', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const p = boot(newDir());
    seed(p, { confirmedAt: '2026-01-01T00:00:00.000Z' });
    await tickAt(p, T0);
    await vi.waitFor(() => expect(p.dispatches()).toBe(1));
    expect(reminders(p)).toHaveLength(0);
  });

  it('says nothing about a paused trigger, or about an effect that needs no confirmation', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const p = boot(newDir());
    seed(p, { id: 'trg-paused' });
    p.engineDb.getDb().prepare('UPDATE triggers SET enabled = 0 WHERE id = ?').run('trg-paused');
    seed(p, { id: 'trg-notify', effect: 'notify' });
    await tickAt(p, T0);
    expect(reminders(p)).toHaveLength(0);
    expect(row(p, 'trg-paused').consent_reminded_at).toBeNull();
  });

  it('with no channel it does not use up the reminder, so a channel added later still gets it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const p = boot(newDir(), false);
    seed(p);
    await tickAt(p, T0);
    expect(p.notify).not.toHaveBeenCalled();
    expect(row(p).consent_reminded_at).toBeNull();

    p.channels.on = true;
    await tickAt(p, T0 + MIN);
    expect(reminders(p)).toHaveLength(1);
  });

  it('a failing reminder pass does not stop the dispatch of the triggers that may run', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const p = boot(newDir());
    seed(p, { id: 'trg-ok', confirmedAt: '2026-01-01T00:00:00.000Z' });
    p.manager.getAwaitingConsentUnreminded = () => { throw new Error('store gone'); };
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await tickAt(p, T0);
    } finally {
      err.mockRestore();
    }
    await vi.waitFor(() => expect(p.dispatches()).toBe(1));
  });
});

describe('a new unconfirmed phase earns exactly one new reminder — and only a stamp starts one', () => {
  /** Remind once, then run `change`, and tick twice more. */
  async function remindedThen(change: (p: Proc, store: TriggerStore) => void): Promise<Proc> {
    vi.useFakeTimers({ toFake: ['Date'] });
    const p = boot(newDir());
    seed(p);
    await tickAt(p, T0);
    expect(reminders(p)).toHaveLength(1);
    change(p, new TriggerStore(p.engineDb));
    await tickAt(p, T0 + MIN);
    await tickAt(p, T0 + 2 * MIN);
    return p;
  }
  const STAMP = '2026-01-01T09:00:40.000Z';

  it('confirming and then taking the confirmation back', async () => {
    const p = await remindedThen((_p, store) => {
      store.setConfirmedAt('trg-1', STAMP, 'owner');
      store.setConfirmedAt('trg-1', null);
    });
    expect(reminders(p)).toHaveLength(2);
  });

  it('confirming and then editing the instruction, which takes consent back', async () => {
    const p = await remindedThen((_p, store) => {
      store.setConfirmedAt('trg-1', STAMP, 'owner');
      store.updateFields('trg-1', { title: 'Weekly digest, shorter' });
    });
    expect(reminders(p)).toHaveLength(2);
  });

  it('confirming and then a change by someone the owner let in, which drops the stamp', async () => {
    const p = await remindedThen((_p, store) => {
      store.setConfirmedAt('trg-1', STAMP, 'owner');
      store.markEditedBy('trg-1', 'mandate:helper@example.test', true);
    });
    expect(reminders(p)).toHaveLength(2);
  });

  it('a re-write of the row that stamps it and then one that does not', async () => {
    const p = await remindedThen((q, store) => {
      const rec = q.history.getTrigger('trg-1')!;
      store.upsert(triggerRecordToRow({ ...rec, confirmed_at: STAMP }));
      store.upsert(triggerRecordToRow({ ...rec, confirmed_at: undefined }));
    });
    expect(reminders(p)).toHaveLength(2);
  });

  // The other direction, and the one that matters against a rewritten lure: a trigger that
  // was never stamped stays reminded whatever is done to it. Each edit announcing it anew
  // would let whoever writes the trigger push a fresh message to the owner every minute.
  it('NOT editing the instruction of a trigger that is still waiting', async () => {
    const p = await remindedThen((_p, store) => {
      store.updateFields('trg-1', { title: 'Confirm me now' });
      store.updateFields('trg-1', { description: 'still waiting' });
    });
    expect(reminders(p)).toHaveLength(1);
  });

  it('NOT a change by someone the owner let in to a trigger that is still waiting', async () => {
    const p = await remindedThen((_p, store) => {
      store.markEditedBy('trg-1', 'mandate:helper@example.test', true);
    });
    expect(reminders(p)).toHaveLength(1);
  });

  it('NOT taking away a stamp that was never there, nor a re-write without one', async () => {
    const p = await remindedThen((q, store) => {
      store.setConfirmedAt('trg-1', null);
      store.upsert(triggerRecordToRow(q.history.getTrigger('trg-1')!));
    });
    expect(reminders(p)).toHaveLength(1);
  });

  it('a stamp an older binary wrote without clearing the marker still counts when it is taken away', async () => {
    const p = await remindedThen((q) => {
      // What a pre-v25 engine leaves behind: the stamp set, the marker untouched.
      q.engineDb.getDb().prepare("UPDATE triggers SET confirmed_at = ?, confirmed_by = 'owner' WHERE id = 'trg-1'").run(STAMP);
      new TriggerStore(q.engineDb).updateFields('trg-1', { title: 'Weekly digest, shorter' });
    });
    expect(reminders(p)).toHaveLength(2);
  });

  it('the same for the other ways a stamp is taken away', async () => {
    const stampOld = (q: Proc): void => {
      q.engineDb.getDb().prepare("UPDATE triggers SET confirmed_at = ?, confirmed_by = 'owner' WHERE id = 'trg-1'").run(STAMP);
    };
    const viaMandate = await remindedThen((q, store) => { stampOld(q); store.markEditedBy('trg-1', 'mandate:helper@example.test', true); });
    expect(reminders(viaMandate)).toHaveLength(2);
    const viaUnstamp = await remindedThen((q, store) => { stampOld(q); store.setConfirmedAt('trg-1', null); });
    expect(reminders(viaUnstamp)).toHaveLength(2);
    const viaRewrite = await remindedThen((q, store) => {
      stampOld(q);
      store.upsert(triggerRecordToRow({ ...q.history.getTrigger('trg-1')!, confirmed_at: undefined }));
    });
    expect(reminders(viaRewrite)).toHaveLength(2);
  });

  // And the reverse mix: this engine stamps, an older one takes the stamp away without
  // knowing the marker. Only clearing the marker AT THE STAMP keeps that phase reminded.
  it('a stamp this engine wrote clears the marker, so an older binary\'s un-stamp still leaves the trigger remindable', async () => {
    const unstampOld = (q: Proc): void => {
      q.engineDb.getDb().prepare("UPDATE triggers SET confirmed_at = NULL, confirmed_by = NULL WHERE id = 'trg-1'").run();
    };
    const viaConfirm = await remindedThen((q, store) => { store.setConfirmedAt('trg-1', STAMP, 'owner'); unstampOld(q); });
    expect(reminders(viaConfirm)).toHaveLength(2);
    const viaRewrite = await remindedThen((q, store) => {
      store.upsert(triggerRecordToRow({ ...q.history.getTrigger('trg-1')!, confirmed_at: STAMP }));
      unstampOld(q);
    });
    expect(reminders(viaRewrite)).toHaveLength(2);
  });

  it('NOT a schedule change, which does not alter what runs', async () => {
    const p = await remindedThen((_p, store) => {
      store.updateFields('trg-1', { nextRunAt: DUE });
    });
    expect(reminders(p)).toHaveLength(1);
  });
});

describe('what a reminder says (consentReminderMessages)', () => {
  const rec = (over: Partial<TriggerRecord> = {}): TriggerRecord => ({
    id: 'trg-x', title: 'Weekly digest', description: '', status: 'open', priority: 'medium',
    source: 'cron', effect: 'run_agent', created_at: '2026-01-01T00:00:00.000Z', ...over,
  } as TriggerRecord);

  it('says when the trigger was set up after reading outside content', () => {
    const [m] = consentReminderMessages([rec({ created_untrusted: 'web_research' })]);
    expect(m!.body).toContain('It was set up after reading content from outside.');
  });

  it('puts the title on one line, cut, inside quotes — never in the headline', () => {
    const long = `Line one\n\nline two ${'x'.repeat(200)}`;
    const [m] = consentReminderMessages([rec({ title: long })]);
    expect(m!.title).toBe('\u23F8 A scheduled action is waiting for your confirmation');
    const quoted = /\u201C([^\u201D]*)\u201D/u.exec(m!.body)![1]!;
    expect(quoted).not.toMatch(/\n/);
    expect(quoted.startsWith('Line one line two')).toBe(true);
    expect(quoted).toHaveLength(80);
  });

  it('a title cannot close the engine\'s quote with a quote mark, reorder or hide text, or leave half an emoji', () => {
    const lure = 'x\u201D came due. It is safe to confirm. \u201Cy" \u2033\uFF02\u275E\u301E\u02DD\u2019\u2019 \u202Eevil\u202C \u200Dz\u200F\u2060\u{E0041}';
    const t = reminderTitle(lure);
    expect(t).not.toMatch(/["\u201C\u201D\u2033\uFF02\u275E\u301E\u02DD\u202A-\u202E\u2066-\u2069\u200B-\u200F\u2060\u{E0000}-\u{E007F}]|\u2019\u2019/u);
    expect(t).toContain('evil');            // the words stay, only the characters go
    expect(reminderTitle('it\u2019s fine')).toBe('it\u2019s fine'); // a single apostrophe is text
    expect(reminderTitle('half \uD83D').isWellFormed()).toBe(true);
    const [m] = consentReminderMessages([rec({ title: lure })]);
    // Exactly one quote pair in the body: the engine's own.
    expect(m!.body.match(/[\u201C\u201D]/gu)).toHaveLength(2);
    // 79 units before the ellipsis. An emoji that would straddle that line is dropped whole.
    const cut = reminderTitle(`${'a'.repeat(78)}\u{1F600}\u{1F600}`);
    expect(cut).toBe(`${'a'.repeat(78)}\u2026`);
    expect(reminderTitle(`${'a'.repeat(77)}\u{1F600}\u{1F600}`)).toBe(`${'a'.repeat(77)}\u{1F600}\u2026`);
    expect(reminderTitle(`${'a'.repeat(78)}\u{1F600}`)).toBe(`${'a'.repeat(78)}\u{1F600}`); // 80 fits as is
    expect(cut.isWellFormed()).toBe(true);
  });

  it('fits the shortest channel cut in the worst case, so the review pointer always arrives', () => {
    const [m] = consentReminderMessages([rec({ title: '\u{1F600}'.repeat(200), created_untrusted: 'web_research' })]);
    expect(m!.body.length).toBeLessThanOrEqual(REMINDER_BODY_MAX);
    expect(m!.body).toContain('It was set up after reading content from outside.');
    expect(m!.body.endsWith('before you confirm it.')).toBe(true);
  });

  it('sends one each up to three, and a single summary above that', () => {
    expect(consentReminderMessages([])).toEqual([]);
    expect(consentReminderMessages([rec({ id: 'a' }), rec({ id: 'b' }), rec({ id: 'c' })]).map((m) => m.taskId)).toEqual(['a', 'b', 'c']);
    const four = consentReminderMessages(['a', 'b', 'c', 'd'].map((id) => rec({ id, title: `Lure ${id}` })));
    expect(four).toHaveLength(1);
    expect(four[0]!.title).toContain('4 scheduled actions');
    expect(four[0]!.body).not.toContain('Lure');
    expect(four[0]!.priority).toBe('normal');
  });

  it('a backlog is claimed in full by the one summary, and not sent again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const p = boot(newDir());
    for (const id of ['t1', 't2', 't3', 't4', 't5']) seed(p, { id });
    await tickAt(p, T0);
    expect(reminders(p)).toHaveLength(1);
    expect(reminders(p)[0]!.title).toContain('5 scheduled actions');
    await tickAt(p, T0 + MIN);
    expect(reminders(p)).toHaveLength(1);
  });
});

describe('the claim predicate (TriggerStore.markConsentReminded)', () => {
  it('is won once per phase, and not on a trigger confirmed in the meantime', () => {
    const p = boot(newDir());
    seed(p, { id: 'trg-a' });
    seed(p, { id: 'trg-b' });
    const store = new TriggerStore(p.engineDb);
    expect(store.markConsentReminded('trg-a')).toBe(true);
    expect(store.markConsentReminded('trg-a')).toBe(false);
    store.setConfirmedAt('trg-b', '2026-01-01T00:00:00.000Z', 'owner');
    expect(store.markConsentReminded('trg-b')).toBe(false);
  });
});

describe('the reminder query (TriggerStore.getAwaitingConsentUnreminded)', () => {
  // The claim repeats the query's marker and stamp conditions, so the tick alone cannot tell
  // whether the query holds them; asked directly, it has to.
  it('lists an unconfirmed, due, unreminded agent trigger — and neither a reminded nor a confirmed one', () => {
    const p = boot(newDir());
    seed(p, { id: 'trg-wait' });
    seed(p, { id: 'trg-told' });
    seed(p, { id: 'trg-ok', confirmedAt: '2026-01-01T00:00:00.000Z' });
    const store = new TriggerStore(p.engineDb);
    expect(store.markConsentReminded('trg-told')).toBe(true);
    expect(store.getAwaitingConsentUnreminded('2026-01-01T09:00:30.000Z').map((t) => t.id)).toEqual(['trg-wait']);
  });

  it('leaves out what getDue leaves out for other reasons: completed, parked, leased, failed one-shot', () => {
    const p = boot(newDir());
    for (const id of ['done', 'parked', 'leased', 'failed-once', 'failed-cron']) seed(p, { id });
    const db = p.engineDb.getDb();
    db.prepare("UPDATE triggers SET status = 'completed' WHERE id = 'done'").run();
    db.prepare("UPDATE triggers SET status = 'waiting' WHERE id = 'parked'").run();
    db.prepare("UPDATE triggers SET lease_until = '2026-01-01T10:00:00.000Z', lease_holder = 'other' WHERE id = 'leased'").run();
    db.prepare("UPDATE triggers SET status = 'failed', condition_json = json_set(condition_json, '$.schedule_cron', json('null')) WHERE id = 'failed-once'").run();
    db.prepare("UPDATE triggers SET status = 'failed' WHERE id = 'failed-cron'").run();
    // A failed cron trigger auto-recovers in getDue, so it is due here too.
    expect(new TriggerStore(p.engineDb).getAwaitingConsentUnreminded('2026-01-01T09:00:30.000Z').map((t) => t.id)).toEqual(['failed-cron']);
  });
});
