import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkerLoop } from './worker-loop.js';
import { RunAbortedError } from './agent.js';
import { RunHistory } from './run-history.js';
import { EngineDb } from './engine-db.js';
import { TaskManager } from './task-manager.js';
import { PromptStore } from './prompt-store.js';
import { MandateEnds } from './mandate-ends.js';
import { AuditLog } from './audit-log.js';
import { pauseEndedPlans, pausedForOf, setPlanPauseForTests } from './plan-pause.js';
import type { Engine } from './engine.js';
import type { Session } from './session.js';
import type { ChannelOutcome, NotificationRouter, NotificationMessage } from './notification-router.js';
import type { TriggerRecord } from '../types/index.js';

/**
 * The plan pause through the real worker loop (`worker-loop.ts`): the gate, its fresh read, Run
 * now, the owner's notice in the tick, a wait that ends, and a run stopped part-way. A real
 * TaskManager, RunHistory, engine.db, MandateEnds and AuditLog; only the agent session and the
 * notification router are doubles.
 */

const H = 3600;
const DUE = '2026-01-05T09:00:00.000Z';
const ENDED = 'This schedule, or the workflow it runs, was set up or changed by someone whose access has ended, so it does not run.';

const dirs: string[] = [];
const closers: Array<() => void> = [];
const turns: Array<() => void> = [];
let restore: () => void = () => undefined;

beforeEach(() => { restore = setPlanPauseForTests(true); });
afterEach(async () => {
  for (const t of turns.splice(0)) t();
  // A held run ends after its turn is released, and records its end: before the files close.
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
  restore();
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const c of closers.splice(0).reverse()) c();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Proc {
  loop: WorkerLoop;
  manager: TaskManager;
  history: RunHistory;
  db: ReturnType<EngineDb['getDb']>;
  ends: MandateEnds;
  prompts: PromptStore;
  sent: NotificationMessage[];
  /** `outcome`: what the one channel reports for every message; `hold`: notify never settles. */
  channels: { on: boolean; outcome: ChannelOutcome; hold: boolean };
  dispatches: () => number;
  /** Resolves when an agent turn has started and is waiting; `abort` then ends it as a stop. */
  turnStarted: Promise<void>;
}

const nowS = (): number => Math.floor(Date.now() / 1000);

function boot(dir = mkdtempSync(join(tmpdir(), 'lynox-pause-w-')), opts: { hold?: boolean; language?: string } = {}): Proc {
  if (!dirs.includes(dir)) dirs.push(dir);
  const history = new RunHistory(join(dir, 'history.db'));
  const engineDb = new EngineDb(join(dir, 'engine.db'));
  history.setVerbGraph(engineDb);
  closers.push(() => { try { history.close(); } catch { /* twice is fine */ } });
  closers.push(() => { try { engineDb.close(); } catch { /* twice is fine */ } });
  const manager = new TaskManager(history);
  const prompts = new PromptStore(history.getDb());
  const ends = new MandateEnds(engineDb.getDb());
  const audit = new AuditLog(engineDb.getDb());
  let started: () => void = () => undefined;
  const turnStarted = new Promise<void>((r) => { started = r; });
  let rejectTurn: ((e: Error) => void) | undefined;
  const run = vi.fn(async () => {
    if (opts.hold !== true) return 'done';
    const turn = new Promise<string>((_resolve, reject) => { rejectTurn = reject; });
    setImmediate(() => started());
    turns.push(() => rejectTurn?.(new RunAbortedError()));
    return turn;
  });
  const session = {
    sessionId: 'thread-pause', _recreateAgent: vi.fn(), getAgent: () => null, getLastRunStop: () => null, promptUser: undefined,
    abort: vi.fn(() => { rejectTurn?.(new RunAbortedError()); }), run,
  };
  const engine = {
    getTaskManager: () => manager,
    getToolContext: () => ({ containment: null }),
    createSession: () => session as unknown as Session,
    getPromptStore: () => prompts,
    getRunHistory: () => history,
    getSecretStore: () => null,
    getBulkLedger: () => null,
    getUserConfig: () => ({}),
    workerRunModelOverride: () => ({}),
    escalateToUser: () => null,
    getEngineDb: () => engineDb,
    getMandateEnds: () => ends,
    getAuditLog: () => audit,
    ...(opts.language !== undefined ? { config: { language: opts.language } } : {}),
  } as unknown as Engine;
  const channels: Proc['channels'] = { on: true, outcome: 'delivered', hold: false };
  const sent: NotificationMessage[] = [];
  const router = {
    hasChannels: () => channels.on,
    notify: vi.fn(async (m: NotificationMessage) => {
      sent.push(m);
      if (channels.hold) await new Promise(() => undefined);
      return [{ channel: 'push', outcome: channels.outcome }];
    }),
  } as unknown as NotificationRouter;
  const loop = new WorkerLoop(engine, router, 60_000);
  closers.push(() => loop.stop());
  return { loop, manager, history, db: engineDb.getDb(), ends, prompts, sent, channels, dispatches: () => run.mock.calls.length, turnStarted };
}

const tag = (email: string): string => `mandate:${email}`;

/** A stamped weekly agent plan a mandate created. */
function plan(p: Proc, id = 'p', email = 'h@x.ch', over: { grant?: string | null; effect?: 'run_agent' | 'notify'; once?: boolean } = {}): string {
  p.history.insertTrigger({
    id, title: `Plan ${id}`, source: 'cron', effect: over.effect ?? 'run_agent',
    ...(over.once === true ? {} : { scheduleCron: '0 9 * * 1' }), nextRunAt: DUE,
    confirmedAt: '2026-01-01T00:00:00.000Z', confirmedBy: 'owner',
    createdBy: tag(email), ...(over.grant !== null ? { createdMandateId: over.grant ?? `g-${email}` } : {}),
  });
  return id;
}

function login(p: Proc, email: string, endsAt: number, issuedAt: number): void {
  p.ends.record({ kind: 'mandate', email, mandateId: `g-${email}`, mandateExp: endsAt }, issuedAt);
}

function row(p: Proc, id = 'p'): { status: string; next_run_at: string | null; paused_at: number | null; last_run_status: string | null; last_run_result: string | null; paused_for: string | null } {
  return p.db.prepare('SELECT status, next_run_at, paused_at, last_run_status, last_run_result, paused_for FROM triggers WHERE id = ?').get(id) as never;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}

async function tick(p: Proc): Promise<void> {
  await p.loop.tick();
  await settle();
}

const pauseNotices = (p: Proc): NotificationMessage[] => p.sent.filter((m) => m.title.includes('paused'));

describe('the gate', () => {
  it('pauses a plan whose member provably ended, keeps its schedule, and does not push', async () => {
    const p = boot();
    plan(p);
    login(p, 'h@x.ch', nowS() - H, nowS() - 2 * H);
    await tick(p);
    expect(p.dispatches()).toBe(0);
    const r = row(p);
    expect(r.paused_at).not.toBeNull();
    // Kept: the next run is the one it was due for, and the status is not `stopped`.
    expect(r.next_run_at).toBe(DUE);
    expect(r.status).not.toBe('stopped');
    expect([r.last_run_status, r.last_run_result]).toEqual(['stopped', ENDED]);
    expect(p.sent).toEqual([]);
  });

  it('an unproven end is refused as on main: through the stopped path, once pushed, and nothing sticks', async () => {
    const p = boot();
    plan(p, 'p', 'h@x.ch', { grant: null });
    await tick(p);
    expect(p.dispatches()).toBe(0);
    const r = row(p);
    expect(r.paused_at).toBeNull();
    expect(r.next_run_at).not.toBe(DUE);
    expect(r.last_run_result).toBe(ENDED);
    expect(p.sent.filter((m) => m.body.includes('whose access has ended'))).toHaveLength(1);
  });

  it('a live plan still runs', async () => {
    const p = boot();
    plan(p);
    login(p, 'h@x.ch', nowS() + H, nowS() - H);
    await tick(p);
    expect(p.dispatches()).toBe(1);
  });

  it('a paused plan stays paused once a login extended the grant: nothing runs', async () => {
    const p = boot();
    p.ends.onExtendAfterEnd((mandateId, before, now) => {
      pauseEndedPlans({ db: p.db, endOf: (id) => (id === mandateId ? before : undefined), onlyMandate: mandateId, nowS: now });
    });
    plan(p);
    login(p, 'h@x.ch', nowS() - H, nowS() - 2 * H);
    login(p, 'h@x.ch', nowS() + 30 * 24 * H, nowS() - 1);
    expect(p.ends.isLive('g-h@x.ch')).toBe(true);
    await tick(p);
    await tick(p);
    expect(p.dispatches()).toBe(0);
    expect(row(p).paused_at).not.toBeNull();
  });

  it('reads the pause fresh, not from the record it was handed: a pause written after getDue keeps the run from starting', async () => {
    const p = boot();
    plan(p);
    login(p, 'h@x.ch', nowS() + H, nowS() - H);
    const old = p.manager.getTrigger('p') as TriggerRecord;
    expect(old.paused_at).toBeUndefined();
    p.db.prepare('UPDATE triggers SET paused_at = ? WHERE id = ?').run(nowS(), 'p');
    await (p.loop as unknown as { executeTask: (t: TriggerRecord, c: number | null) => Promise<void> }).executeTask(old, null);
    expect(p.dispatches()).toBe(0);
    expect(row(p).last_run_result).toBe(ENDED);
    expect(row(p).next_run_at).toBe(DUE);
  });
});

describe('Run now', () => {
  it('a paused plan is refused before anything is recorded', async () => {
    const p = boot();
    plan(p);
    p.db.prepare('UPDATE triggers SET paused_at = ? WHERE id = ?').run(nowS(), 'p');
    expect(await p.loop.runTriggerNow('p')).toEqual({ ok: false, reason: 'paused' });
    await settle();
    expect(p.dispatches()).toBe(0);
    expect(row(p).last_run_status).toBeNull();
  });

  it('a plan that is not paused is not refused for it', async () => {
    const p = boot();
    plan(p);
    login(p, 'h@x.ch', nowS() + H, nowS() - H);
    expect(await p.loop.runTriggerNow('p')).toEqual({ ok: true });
  });
});

describe("the owner's notice in the tick", () => {
  it('comes once, on the tick after the pause, and not again over later ticks', async () => {
    const p = boot();
    plan(p);
    login(p, 'h@x.ch', nowS() - H, nowS() - 2 * H);
    await tick(p);
    expect(pauseNotices(p)).toHaveLength(0);
    await tick(p);
    await tick(p);
    await tick(p);
    expect(pauseNotices(p)).toHaveLength(1);
    expect(pauseNotices(p)[0]!.body).toContain('h@x.ch had access until');
  });

  it('two plans of one mandate are one notice that counts two', async () => {
    const p = boot();
    plan(p, 'a');
    plan(p, 'b');
    login(p, 'h@x.ch', nowS() - H, nowS() - 2 * H);
    pauseEndedPlans({ db: p.db, endOf: (id) => p.ends.endRow(id) });
    await tick(p);
    expect(pauseNotices(p).map((m) => m.title)).toEqual(['⏸ 2 plans are paused']);
  });

  it('a tick without a channel claims nothing; the first tick with one tells', async () => {
    const p = boot();
    plan(p);
    login(p, 'h@x.ch', nowS() - H, nowS() - 2 * H);
    pauseEndedPlans({ db: p.db, endOf: (id) => p.ends.endRow(id) });
    p.channels.on = false;
    await tick(p);
    expect(p.db.prepare('SELECT pause_noticed_at FROM triggers WHERE id = ?').get('p')).toEqual({ pause_noticed_at: null });
    p.channels.on = true;
    await tick(p);
    expect(pauseNotices(p)).toHaveLength(1);
  });

  it('two loops on one engine.db send it once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-pause-w2-'));
    const a = boot(dir);
    const b = boot(dir);
    plan(a);
    login(a, 'h@x.ch', nowS() - H, nowS() - 2 * H);
    pauseEndedPlans({ db: a.db, endOf: (id) => a.ends.endRow(id) });
    await Promise.all([a.loop.tick(), b.loop.tick()]);
    await settle();
    expect(pauseNotices(a).length + pauseNotices(b).length).toBe(1);
  });
});

describe("the pause notice and the advance warning follow the engine's notice language", () => {
  it('a German instance tells the pause and warns in German, an English one in English', async () => {
    for (const [language, pause, warn] of [['de', '⏸ Plan pausiert: Zugang von h@x.ch', 'Plan pausiert bald: Zugang von w@x.ch'], ['en', '⏸ A plan is paused', 'A plan will pause soon']] as const) {
      const p = boot(undefined, { language });
      plan(p, 'a', 'h@x.ch');
      login(p, 'h@x.ch', nowS() - H, nowS() - 2 * H);
      plan(p, 'b', 'w@x.ch');
      login(p, 'w@x.ch', nowS() + H, nowS() - H);
      pauseEndedPlans({ db: p.db, endOf: (id) => p.ends.endRow(id) });
      await tick(p);
      await tick(p);
      // Plan b is live and runs; only the pause notice and the warning are asked about here.
      expect(p.sent.map((m) => m.title).filter((t) => /paus/i.test(t)).sort(), language).toEqual([pause, warn].sort());
    }
  });
});

describe("the owner's advance warning in the tick (641c-2b)", () => {
  const warnings = (p: Proc): NotificationMessage[] => p.sent.filter((m) => m.title.includes('will pause'));
  const rows = (p: Proc): Array<{ trigger_id: string; delivered_at: number | null }> =>
    p.db.prepare('SELECT trigger_id, delivered_at FROM plan_advance_warnings ORDER BY trigger_id').all() as never;

  it('goes once, and counts as given once a channel of the owner accepted it', async () => {
    const p = boot();
    plan(p, 'a');
    plan(p, 'b');
    login(p, 'h@x.ch', nowS() + H, nowS() - H);
    await tick(p);
    await tick(p);
    expect(warnings(p).map((m) => m.title)).toEqual(['Plans will pause soon']);
    expect(warnings(p)[0]!.audience).toBe('owner');
    expect(rows(p).map((r) => [r.trigger_id, r.delivered_at !== null])).toEqual([['a', true], ['b', true]]);
  });

  it('a warning no channel of the owner accepted is not given and not sent again', async () => {
    for (const outcome of ['failed', 'reached_others', 'skipped'] as const) {
      const p = boot();
      plan(p);
      login(p, 'h@x.ch', nowS() + H, nowS() - H);
      p.channels.outcome = outcome;
      await tick(p);
      await tick(p);
      expect(warnings(p), outcome).toHaveLength(1);
      expect(rows(p), outcome).toEqual([{ trigger_id: 'p', delivered_at: null }]);
    }
  });

  it('a tick without a channel claims nothing; the first tick with one warns', async () => {
    const p = boot();
    plan(p);
    login(p, 'h@x.ch', nowS() + H, nowS() - H);
    p.channels.on = false;
    await tick(p);
    expect(rows(p)).toEqual([]);
    p.channels.on = true;
    await tick(p);
    expect(warnings(p)).toHaveLength(1);
  });

  it('a channel that does not answer holds up neither the tick nor the due plans', async () => {
    const p = boot();
    plan(p, 'warned');
    p.history.insertTrigger({ id: 'due', title: 'Plan due', source: 'cron', effect: 'run_agent', scheduleCron: '0 9 * * 1', nextRunAt: DUE, confirmedAt: '2026-01-01T00:00:00.000Z', confirmedBy: 'owner' });
    login(p, 'h@x.ch', nowS() + 2 * H, nowS() - H);
    p.channels.hold = true;
    await tick(p);
    expect(warnings(p)).toHaveLength(1);
    expect(p.dispatches()).toBeGreaterThan(0);
    expect(rows(p).map((r) => r.delivered_at)).toEqual([null]);
  });

  it('two loops on one engine.db warn once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-warn-w2-'));
    const a = boot(dir);
    const b = boot(dir);
    plan(a);
    login(a, 'h@x.ch', nowS() + H, nowS() - H);
    await Promise.all([a.loop.tick(), b.loop.tick()]);
    await settle();
    expect(warnings(a).length + warnings(b).length).toBe(1);
  });
});

describe('a wait that ends', () => {
  it('a parked plan whose member provably ended ends its wait paused, not failed, and keeps its schedule', async () => {
    const p = boot();
    plan(p);
    p.db.prepare("UPDATE triggers SET status = 'waiting', waiting_until = '2026-01-01T00:00:00.000Z' WHERE id = 'p'").run();
    login(p, 'h@x.ch', nowS() - H, nowS() - 2 * H);
    await tick(p);
    const r = row(p);
    expect(r.status).toBe('open');
    expect(r.paused_at).not.toBeNull();
    expect(r.next_run_at).toBe(DUE);
    expect(r.last_run_status).toBe('stopped');
    expect(p.dispatches()).toBe(0);
  });

  it('without a proven end it is recorded as failed, as on main', async () => {
    const p = boot();
    plan(p, 'p', 'h@x.ch', { grant: null });
    p.db.prepare("UPDATE triggers SET status = 'waiting', waiting_until = '2026-01-01T00:00:00.000Z' WHERE id = 'p'").run();
    await tick(p);
    expect(row(p).paused_at).toBeNull();
    expect(row(p).status).toBe('failed');
  });
});

describe('a run stopped part-way', () => {
  it('a run whose plan is paused while it goes on stops, even with its member live again, and keeps its schedule', async () => {
    const p = boot(undefined, { hold: true });
    plan(p);
    login(p, 'h@x.ch', nowS() + H, nowS() - H);
    await tick(p);
    await p.turnStarted;
    expect(p.dispatches()).toBe(1);
    p.db.prepare('UPDATE triggers SET paused_at = ? WHERE id = ?').run(nowS(), 'p');
    expect(p.loop.stopEndedStarters((id) => p.ends.isLive(id))).toEqual(['p']);
    await settle();
    const r = row(p);
    expect(r.last_run_status).toBe('stopped');
    expect(r.last_run_result).toContain('access of someone who set up or changed this plan ended');
    expect(r.last_run_result).toContain('paused until the owner takes it over');
    expect(r.next_run_at).toBe(DUE);
    // Not "on your instruction", and not pushed: the tick tells the owner.
    expect(p.sent.filter((m) => m.body.includes('Stopped on your instruction'))).toEqual([]);
  });

  it('a run whose member provably ends part-way pauses its plan', async () => {
    const p = boot(undefined, { hold: true });
    plan(p);
    login(p, 'h@x.ch', nowS() + H, nowS() - H);
    await tick(p);
    await p.turnStarted;
    p.ends.revoke('g-h@x.ch');
    expect(p.loop.stopEndedStarters((id) => p.ends.isLive(id))).toEqual(['p']);
    await settle();
    expect(row(p).paused_at).not.toBeNull();
    expect(pausedForOf(row(p).paused_for).entries[0]!.reason).toBe('revoked');
  });
});

describe('every way of starting a paused plan', () => {
  it('starts nothing, before and after a login extends the grant', async () => {
    const p = boot();
    p.ends.onExtendAfterEnd((mandateId, before, now) => {
      pauseEndedPlans({ db: p.db, endOf: (id) => (id === mandateId ? before : undefined), onlyMandate: mandateId, nowS: now });
    });
    plan(p, 'cron');
    plan(p, 'once', 'h@x.ch', { once: true });
    plan(p, 'parked');
    p.db.prepare("UPDATE triggers SET status = 'waiting', waiting_until = '2099-01-01T00:00:00.000Z' WHERE id = 'parked'").run();
    p.history.insertTrigger({
      id: 'watch', title: 'Watch', source: 'watch', effect: 'run_agent', nextRunAt: DUE,
      watchConfig: JSON.stringify({ url: 'https://example.test/', interval_minutes: 60 }),
      confirmedAt: '2026-01-01T00:00:00.000Z', createdBy: tag('h@x.ch'), createdMandateId: 'g-h@x.ch',
    });
    login(p, 'h@x.ch', nowS() - H, nowS() - 2 * H);
    pauseEndedPlans({ db: p.db, endOf: (id) => p.ends.endRow(id) });
    const ids = ['cron', 'once', 'parked', 'watch'];
    const tryAll = async (): Promise<void> => {
      await tick(p);
      for (const id of ids) expect(await p.loop.runTriggerNow(id)).toEqual({ ok: false, reason: 'paused' });
      for (const id of ids) { p.manager.setEnabled(id, false); p.manager.setEnabled(id, true); }
      await tick(p);
      p.manager.complete('once');
      p.manager.reopen('once');
      await tick(p);
    };
    await tryAll();
    login(p, 'h@x.ch', nowS() + 30 * 24 * H, nowS() - 1);
    await tryAll();
    expect(p.dispatches()).toBe(0);
  });
});

describe('with the switch off, no path writes a pause', () => {
  it('the gate, a wait that ends, a run stopped part-way and Run now behave as on main', async () => {
    restore();
    restore = setPlanPauseForTests(false);
    const p = boot(undefined, { hold: true });
    plan(p, 'gate');
    plan(p, 'wait');
    p.db.prepare("UPDATE triggers SET status = 'waiting', waiting_until = '2026-01-01T00:00:00.000Z' WHERE id = 'wait'").run();
    login(p, 'h@x.ch', nowS() - H, nowS() - 2 * H);
    await tick(p);
    expect(p.dispatches()).toBe(0);
    expect(row(p, 'gate').last_run_result).toBe(ENDED);
    expect(row(p, 'gate').next_run_at).not.toBe(DUE);
    expect(row(p, 'wait').status).toBe('failed');
    expect(p.db.prepare('SELECT COUNT(*) AS n FROM triggers WHERE paused_at IS NOT NULL').get()).toEqual({ n: 0 });
    expect(pauseNotices(p)).toEqual([]);
  });

  it('a run of a live plan with a stale paused_at from an on-period runs and is not stopped for it', async () => {
    restore();
    restore = setPlanPauseForTests(false);
    const p = boot(undefined, { hold: true });
    plan(p);
    login(p, 'h@x.ch', nowS() + H, nowS() - H);
    p.db.prepare('UPDATE triggers SET paused_at = 1 WHERE id = ?').run('p');
    expect(await p.loop.runTriggerNow('p')).toEqual({ ok: true });
    await p.turnStarted;
    expect(p.loop.stopEndedStarters((id) => p.ends.isLive(id))).toEqual([]);
  });
});
