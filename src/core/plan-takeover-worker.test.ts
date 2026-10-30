import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkerLoop, watchReader } from './worker-loop.js';
import { RunAbortedError } from './agent.js';
import { RunHistory } from './run-history.js';
import { EngineDb } from './engine-db.js';
import { TaskManager } from './task-manager.js';
import { PromptStore } from './prompt-store.js';
import { MandateEnds } from './mandate-ends.js';
import { AuditLog } from './audit-log.js';
import { TriggerStore } from './trigger-store.js';
import { setPlanPauseForTests, writePause } from './plan-pause.js';
import { takeOver, takeoverPreview, type TakeoverDeps } from './plan-takeover.js';
import type { Engine } from './engine.js';
import type { Session } from './session.js';
import type { NotificationRouter, NotificationMessage } from './notification-router.js';
import type { TriggerRecord } from '../types/index.js';

/**
 * The owner's takeover (`plan-takeover.ts`) through the real worker loop: a plan taken over runs
 * for the owner, also when the takeover commits between `getDue` and the gate, and a watch taken
 * over reads as the owner's. The harness is the one of `plan-pause-worker.test.ts`.
 */

const H = 3600;
const DUE = '2026-01-05T09:00:00.000Z';

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
  channels: { on: boolean };
  dispatches: () => number;
  /** Resolves when an agent turn has started and is waiting; `abort` then ends it as a stop. */
  turnStarted: Promise<void>;
}

const nowS = (): number => Math.floor(Date.now() / 1000);

function boot(dir = mkdtempSync(join(tmpdir(), 'lynox-pause-w-')), opts: { hold?: boolean } = {}): Proc {
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
  } as unknown as Engine;
  const channels = { on: true };
  const sent: NotificationMessage[] = [];
  const router = {
    hasChannels: () => channels.on,
    notify: vi.fn(async (m: NotificationMessage) => { sent.push(m); }),
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


const executeTask = (p: Proc, t: TriggerRecord): Promise<void> =>
  (p.loop as unknown as { executeTask: (t: TriggerRecord, c: number | null) => Promise<void> }).executeTask(t, null);

function takeoverDeps(p: Proc): TakeoverDeps {
  const engineDb = { getDb: () => p.db } as unknown as EngineDb;
  return { db: p.db, triggers: new TriggerStore(engineDb), isLive: (id) => p.ends.isLive(id), audit: new AuditLog(p.db), prompts: p.prompts };
}

function pauseFor(p: Proc, id: string, email = 'h@x.ch'): void {
  writePause(p.db, id, [{ mandateId: `g-${email}`, email, reason: 'expired', endsAt: nowS() - H, roles: ['created'], closedPrompt: false }]);
}

function take(p: Proc, id = 'p'): void {
  const d = takeoverDeps(p);
  const pre = takeoverPreview(d, id);
  if (pre.kind !== 'preview') throw new Error(`no preview: ${JSON.stringify(pre)}`);
  const out = takeOver(d, id, pre.preview.expect);
  if (out.kind !== 'taken_over') throw new Error(`not taken over: ${JSON.stringify(out)}`);
}

const mandateRows = (p: Proc): unknown[] => p.db.prepare("SELECT action FROM audit_log WHERE mandate_id = 'g-h@x.ch'").all();

describe('a plan taken over runs for the owner', () => {
  it('on its next tick: one run, nothing on the ended mandate’s trail', async () => {
    const p = boot();
    plan(p);
    login(p, 'h@x.ch', nowS() - H, nowS() - 2 * H);
    await tick(p);
    expect(row(p).paused_at).not.toBeNull();
    take(p);
    p.db.prepare('UPDATE triggers SET next_run_at = ? WHERE id = ?').run(DUE, 'p');
    await tick(p);
    expect(p.dispatches()).toBe(1);
    expect(mandateRows(p)).toEqual([]);
    expect(row(p).paused_at).toBeNull();
  });

  it('a takeover that commits after getDue: the gate reads the row as it is now, and a one-shot does not end stopped', async () => {
    const p = boot();
    plan(p, 'p', 'h@x.ch', { once: true });
    login(p, 'h@x.ch', nowS() - H, nowS() - 2 * H);
    const old = p.manager.getTrigger('p') as TriggerRecord;
    pauseFor(p, 'p');
    take(p);
    await executeTask(p, old);
    expect(p.dispatches()).toBe(1);
    expect(row(p).status).not.toBe('stopped');
    expect(mandateRows(p)).toEqual([]);
  });

  it('a one-shot whose time passed runs on Run now', async () => {
    const p = boot();
    plan(p, 'p', 'h@x.ch', { once: true });
    login(p, 'h@x.ch', nowS() - H, nowS() - 2 * H);
    pauseFor(p, 'p');
    take(p);
    expect([row(p).next_run_at, row(p).status]).toEqual([null, 'open']);
    expect(await p.loop.runTriggerNow('p')).toEqual({ ok: true });
    await settle();
    expect(p.dispatches()).toBe(1);
  });

  it('a watch taken over is read as the owner’s, not as the ended mandate’s', () => {
    const p = boot();
    p.history.insertTrigger({
      id: 'w', title: 'Watch', source: 'watch', effect: 'run_agent', nextRunAt: DUE,
      watchConfig: JSON.stringify({ url: 'https://example.test/', interval_minutes: 60 }),
      confirmedAt: '2026-01-01T00:00:00.000Z', confirmedBy: 'owner', createdBy: tag('h@x.ch'), createdMandateId: 'g-h@x.ch',
    });
    login(p, 'h@x.ch', nowS() - H, nowS() - 2 * H);
    expect(watchReader(p.manager.getTrigger('w')!, undefined)).toEqual({ kind: 'mandate', email: 'h@x.ch', mandateId: 'g-h@x.ch' });
    pauseFor(p, 'w');
    take(p, 'w');
    expect(watchReader(p.manager.getTrigger('w')!, undefined)).toBeNull();
  });
});
