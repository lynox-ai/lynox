import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkerLoop, FOREIGN_ANSWER_RESULT, FOREIGN_ANSWER_NEXT_RUN, FOREIGN_ANSWER_ONE_SHOT, dueOnItsOwn } from './worker-loop.js';
import { RunHistory } from './run-history.js';
import { EngineDb } from './engine-db.js';
import { TaskManager } from './task-manager.js';
import { PromptStore } from './prompt-store.js';
import { MandateEnds } from './mandate-ends.js';
import { AuditLog } from './audit-log.js';
import { OWNER_PRINCIPAL } from './request-principal.js';
import type { Engine } from './engine.js';
import type { Session } from './session.js';
import type { NotificationRouter } from './notification-router.js';

/**
 * A scheduled run that only an answer made due, where the answer was given in a chat the run is
 * not for (so it is released unread), does not start over: it would repeat what came before its
 * question and ask it again. Driven over real ticks with a real TaskManager, run history and
 * prompt store; only the agent session is a stub, so the proof is what lands on the row.
 */

const H = 3600;
const CRON = '0 9 * * 1';
const EVA = 'h@x.ch';
const tag = (email: string): string => `mandate:${email}`;
const nowS = (): number => Math.floor(Date.now() / 1000);
const ahead = (): string => new Date(Date.now() + 3 * 24 * H * 1000).toISOString();
const PAST = '2026-01-05T09:00:00.000Z';

const dirs: string[] = [];
const closers: Array<() => void> = [];

afterEach(async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
  vi.restoreAllMocks();
  for (const c of closers.splice(0).reverse()) c();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Proc {
  loop: WorkerLoop;
  history: RunHistory;
  db: ReturnType<EngineDb['getDb']>;
  prompts: PromptStore;
  ends: MandateEnds;
  /** The text of every agent turn the runs started, in order. */
  turns: string[];
  /** What went to the owner's devices. */
  notify: ReturnType<typeof vi.fn>;
}

function boot(threads: Record<string, string> = {}): Proc {
  const dir = mkdtempSync(join(tmpdir(), 'lynox-foreign-answer-'));
  dirs.push(dir);
  const history = new RunHistory(join(dir, 'history.db'));
  const engineDb = new EngineDb(join(dir, 'engine.db'));
  history.setVerbGraph(engineDb);
  closers.push(() => { try { history.close(); } catch { /* twice is fine */ } });
  closers.push(() => { try { engineDb.close(); } catch { /* twice is fine */ } });
  const manager = new TaskManager(history);
  const prompts = new PromptStore(history.getDb());
  const ends = new MandateEnds(engineDb.getDb());
  const audit = new AuditLog(engineDb.getDb());
  const turns: string[] = [];
  const session = {
    sessionId: 'thread-run', _recreateAgent: vi.fn(), getAgent: () => null, getLastRunStop: () => null, promptUser: undefined,
    abort: vi.fn(), run: vi.fn(async (text: string) => { turns.push(text); return 'done'; }),
  };
  // Which principal opened each chat; a chat not listed is no one's.
  const threadStore = {
    getThread: (id: string) => (threads[id] !== undefined ? { id, created_by: threads[id] } : undefined),
    isDeleted: () => false,
  };
  const engine = {
    getTaskManager: () => manager,
    getToolContext: () => ({ containment: null }),
    createSession: () => session as unknown as Session,
    getPromptStore: () => prompts,
    getRunHistory: () => history,
    getThreadStore: () => threadStore,
    getSecretStore: () => null,
    getBulkLedger: () => null,
    getUserConfig: () => ({}),
    workerRunModelOverride: () => ({}),
    escalateToUser: () => null,
    getEngineDb: () => engineDb,
    getMandateEnds: () => ends,
    getAuditLog: () => audit,
  } as unknown as Engine;
  // Channels on, so a push this change must not send would be seen.
  const notify = vi.fn(async () => []);
  const router = { hasChannels: () => true, notify } as unknown as NotificationRouter;
  const loop = new WorkerLoop(engine, router, 60_000);
  closers.push(() => loop.stop());
  return { loop, history, db: engineDb.getDb(), prompts, ends, turns, notify };
}

/** A stamped agent plan Eva shaped (it runs for her), parked on a question. */
function parkedPlan(p: Proc, over: { once?: boolean; nextRunAt?: string; createdBy?: string; webhook?: boolean } = {}): void {
  const createdBy = over.createdBy ?? tag(EVA);
  p.history.insertTrigger({
    id: 'p', title: 'Weekly report', source: over.webhook === true ? 'webhook' : 'cron', effect: 'run_agent',
    ...(over.once === true || over.webhook === true ? {} : { scheduleCron: CRON }),
    nextRunAt: over.nextRunAt ?? (over.once === true ? null : ahead()),
    confirmedAt: '2026-01-01T00:00:00.000Z', confirmedBy: 'owner',
    createdBy, ...(createdBy === tag(EVA) ? { createdMandateId: `g-${EVA}` } : {}),
  });
  p.history.updateTrigger('p', { status: 'waiting', waitingUntil: new Date(Date.now() + 24 * H * 1000).toISOString() });
  p.ends.record({ kind: 'mandate', email: EVA, mandateId: `g-${EVA}`, mandateExp: nowS() + 60 * 24 * H }, nowS() - H);
}

/** The run's question, asked in `chat` and answered there. `asker` stamps who asked it. */
function answeredIn(p: Proc, chat: string, asker?: { email: string; mandateId: string }): string {
  const id = p.prompts.insertAskUser(chat, 'Which week?', undefined, undefined, undefined, undefined, 'p',
    asker !== undefined ? { principal: { kind: 'mandate', email: asker.email, mandateId: asker.mandateId } } : undefined);
  expect(p.prompts.answerUser(id, 'Last week.', OWNER_PRINCIPAL), 'the question was answered').toBe(true);
  return id;
}

function row(p: Proc): { status: string; next_run_at: string | null; last_run_status: string | null; last_run_result: string | null } {
  return p.db.prepare('SELECT status, next_run_at, last_run_status, last_run_result FROM triggers WHERE id = ?').get('p') as never;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
}

async function tick(p: Proc): Promise<void> {
  await p.loop.tick();
  await settle();
}

describe('a run that only an answer from another chat made due', () => {
  it('does not run in either tick, and goes to its own next run: a cron', async () => {
    const p = boot({ 'thread-owner': 'owner' });
    parkedPlan(p);
    answeredIn(p, 'thread-owner');
    await tick(p);
    expect(p.turns, 'first tick: re-armed, not run').toEqual([]);
    expect(Date.parse(row(p).next_run_at!), 'made due by the answer').toBeLessThanOrEqual(Date.now());
    await tick(p);
    expect(p.turns, 'second tick: not run either').toEqual([]);
    const ended = row(p);
    expect(ended.last_run_status, 'recorded stopped').toBe('stopped');
    expect(ended.last_run_result).toBe(`${FOREIGN_ANSWER_RESULT} ${FOREIGN_ANSWER_NEXT_RUN}`);
    expect(Date.parse(ended.next_run_at!), 'the schedule\'s own next run, ahead').toBeGreaterThan(Date.now());
    expect(new Date(ended.next_run_at!).getUTCDay(), 'on the cron\'s weekday').toBe(1);
    expect(ended.status, 'the cron stays on').not.toBe('stopped');
    expect(p.prompts.getAnsweredForTrigger('p'), 'the answer was released').toBeUndefined();
    expect(p.notify, 'and nothing was pushed').not.toHaveBeenCalled();
    await tick(p);
    expect(p.turns, 'and nothing runs after').toEqual([]);
    expect(row(p).next_run_at).toBe(ended.next_run_at);
  });

  it('a one-shot ends, without a next run and without the sentence about one', async () => {
    const p = boot({ 'thread-owner': 'owner' });
    parkedPlan(p, { once: true });
    answeredIn(p, 'thread-owner');
    await tick(p);
    await tick(p);
    expect(p.turns, 'not run').toEqual([]);
    const ended = row(p);
    expect([ended.status, ended.next_run_at, ended.last_run_status]).toEqual(['stopped', null, 'stopped']);
    expect(ended.last_run_result).toBe(`${FOREIGN_ANSWER_RESULT} ${FOREIGN_ANSWER_ONE_SHOT}`);
    expect(p.notify, 'nothing was pushed').not.toHaveBeenCalled();
  });

  it('the owner\'s "Run now" between the re-arm and the pickup runs, without the answer', async () => {
    const p = boot({ 'thread-owner': 'owner' });
    parkedPlan(p);
    answeredIn(p, 'thread-owner');
    await tick(p);
    expect(await p.loop.runTriggerNow('p'), 'Run now went through').toEqual({ ok: true });
    await settle();
    expect(p.turns, 'the hand run ran').toHaveLength(1);
    expect(p.turns[0], 'without the answer from the other chat').not.toContain('Last week.');
    expect(row(p).last_run_status).not.toBe('stopped');
    await tick(p);
    expect(p.turns, 'and the schedule did not run it again').toHaveLength(1);
  });

  it('a run due on its own schedule (the next time its last run recorded has come) that finds such an answer runs its scheduled work', async () => {
    const p = boot({ 'thread-owner': 'owner' });
    parkedPlan(p, { nextRunAt: PAST });
    answeredIn(p, 'thread-owner');
    await tick(p);
    await tick(p);
    expect(p.turns, 'it ran').toHaveLength(1);
    expect(p.turns[0], 'without the answer').not.toContain('Last week.');
    expect(row(p).last_run_result).not.toBe(`${FOREIGN_ANSWER_RESULT} ${FOREIGN_ANSWER_NEXT_RUN}`);
  });

  it('a mark another process\'s run outlived is cleared when a later re-arm finds the row due on its own', async () => {
    const p = boot({ 'thread-owner': 'owner' });
    parkedPlan(p);
    answeredIn(p, 'thread-owner');
    await tick(p);
    // Another process holds the run's lease, so this one does not pick it up, and its mark stays.
    const until = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    p.db.prepare('UPDATE triggers SET lease_holder = ?, lease_until = ?, lease_since = ? WHERE id = ?').run('other-process', until, new Date().toISOString(), 'p');
    await tick(p);
    expect(p.turns, 'held by the other process: not run here').toEqual([]);
    // That process's run asked again and parked; meanwhile the schedule's own time came.
    p.db.prepare('UPDATE triggers SET lease_holder = NULL, lease_until = NULL, lease_since = NULL WHERE id = ?').run('p');
    p.history.updateTrigger('p', { status: 'waiting', waitingUntil: new Date(Date.now() + 24 * H * 1000).toISOString(), nextRunAt: PAST });
    await tick(p);
    await tick(p);
    expect(p.turns, 'due on its own: it ran').toHaveLength(1);
    expect(p.turns[0], 'without the answer').not.toContain('Last week.');
    expect(row(p).last_run_status, 'not stopped by the old mark').not.toBe('stopped');
  });

  it('a webhook\'s trigger is not marked: a later run of it runs, without the answer', async () => {
    const p = boot({ 'thread-owner': 'owner' });
    parkedPlan(p, { webhook: true });
    answeredIn(p, 'thread-owner');
    await tick(p);
    const trigger = p.history.getTrigger('p')!;
    await (p.loop as unknown as { executeTask: (t: typeof trigger, c: number | null) => Promise<void> }).executeTask(trigger, null);
    await settle();
    expect(p.turns, 'it ran').toHaveLength(1);
    expect(p.turns[0], 'without the answer').not.toContain('Last week.');
  });

  it('control: an answer given in the run\'s own chat is taken', async () => {
    const p = boot({ 'thread-eva': tag(EVA) });
    parkedPlan(p);
    answeredIn(p, 'thread-eva');
    await tick(p);
    await tick(p);
    expect(p.turns, 'it ran').toHaveLength(1);
    expect(p.turns[0], 'with the answer').toContain('Last week.');
  });
});

describe('an answer under an access that has ended', () => {
  it('a run only the schedule starts is still recorded failed, not run', async () => {
    const p = boot({ 'thread-owner': 'owner' });
    parkedPlan(p, { createdBy: 'owner' });
    answeredIn(p, 'thread-owner', { email: 'gone@x.ch', mandateId: 'g-gone' });
    p.ends.record({ kind: 'mandate', email: 'gone@x.ch', mandateId: 'g-gone', mandateExp: nowS() - H }, nowS() - 2 * H);
    await tick(p);
    await tick(p);
    expect(p.turns, 'not run').toEqual([]);
    expect(row(p).last_run_status).toBe('failed');
  });

  it('the owner\'s "Run now" runs, without the answer, instead of being recorded failed', async () => {
    const p = boot({ 'thread-owner': 'owner' });
    parkedPlan(p, { createdBy: 'owner' });
    answeredIn(p, 'thread-owner', { email: 'gone@x.ch', mandateId: 'g-gone' });
    p.ends.record({ kind: 'mandate', email: 'gone@x.ch', mandateId: 'g-gone', mandateExp: nowS() - H }, nowS() - 2 * H);
    await tick(p);
    expect(await p.loop.runTriggerNow('p')).toEqual({ ok: true });
    await settle();
    expect(p.turns, 'the hand run ran').toHaveLength(1);
    expect(p.turns[0], 'without the answer').not.toContain('Last week.');
    expect(row(p).last_run_status).not.toBe('failed');
  });
});

describe('the result sentences (U-484 N2)', () => {
  it('a cron or a watch says its next run asks again', () => {
    expect(`${FOREIGN_ANSWER_RESULT} ${FOREIGN_ANSWER_NEXT_RUN}`).toBe('The run did not continue: its question had been asked in another chat, and this task now runs under a delegated access, so it does not take an answer from there. The next scheduled run asks again if it needs to.');
  });
  it('a one-shot says it does not run again, and what starting it again does', () => {
    expect(`${FOREIGN_ANSWER_RESULT} ${FOREIGN_ANSWER_ONE_SHOT}`).toBe('The run did not continue: its question had been asked in another chat, and this task now runs under a delegated access, so it does not take an answer from there. It does not run again on its own. Starting it again runs it from the beginning, including the steps before the question; check first what it already did.');
  });
});

describe('dueOnItsOwn', () => {
  const now = Date.parse('2026-03-02T10:00:00.000Z');
  it('a one-shot never is; a cron or a watch is once its next run has come', () => {
    expect(dueOnItsOwn({ schedule_cron: undefined, watch_config: undefined, next_run_at: PAST }, now)).toBe(false);
    expect(dueOnItsOwn({ schedule_cron: CRON, watch_config: undefined, next_run_at: '2026-03-09T09:00:00.000Z' }, now)).toBe(false);
    expect(dueOnItsOwn({ schedule_cron: CRON, watch_config: undefined, next_run_at: '2026-03-02T09:00:00.000Z' }, now)).toBe(true);
    expect(dueOnItsOwn({ schedule_cron: undefined, watch_config: '{"interval_minutes":60}', next_run_at: '2026-03-02T10:30:00.000Z' }, now)).toBe(false);
    expect(dueOnItsOwn({ schedule_cron: undefined, watch_config: '{"interval_minutes":60}', next_run_at: '2026-03-02T09:30:00.000Z' }, now)).toBe(true);
  });
  it('a next run that cannot be read counts as due, so the row runs as before', () => {
    expect(dueOnItsOwn({ schedule_cron: CRON, watch_config: undefined, next_run_at: null }, now)).toBe(true);
    expect(dueOnItsOwn({ schedule_cron: CRON, watch_config: undefined, next_run_at: 'soon' }, now)).toBe(true);
  });
});
