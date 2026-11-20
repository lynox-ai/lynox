import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';

// The pinned fetch is driven per case, so a watch's change is the case's and not the network's.
const mockFetchPinned = vi.fn();
vi.mock('./network-guard.js', async (importActual) => {
  const actual = await importActual<typeof import('./network-guard.js')>();
  return { ...actual, fetchPinned: (...args: unknown[]) => mockFetchPinned(...args) };
});

import { WorkerLoop, extractWatchSignal } from './worker-loop.js';
import { WORKER_NOTICES, notRunReason, resetWhen } from './worker-notices.js';
import { configurePersistentBudget, resetPersistentBudget } from './session-budget.js';
import type { Engine } from './engine.js';
import type { NotificationRouter, NotificationMessage } from './notification-router.js';
import type { Session } from './session.js';
import type { TaskManager } from './task-manager.js';
import type { TriggerRecord } from '../types/index.js';
import type { BudgetNoteRef } from './render-projection.js';

// A background run that never started — the spending cap refused it at admission, or the cap or
// a check before the run stopped it inside the session — is recorded `not_run` and told to the
// owner with the reason and the next step, once per period, and never as a success.

const DAY = '2026-06-15';

function makeTask(overrides?: Partial<TriggerRecord>): TriggerRecord {
  return {
    id: 'task-1', title: 'Daily Report', description: 'Generate the daily report', status: 'open', assignee: 'lynox',
    scope_type: 'context', scope_id: '', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
    schedule_cron: '0 9 * * *', next_run_at: `${DAY}T09:00:00.000Z`, source: 'cron', effect: 'run_agent',
    confirmed_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeTaskManager(tasks: TriggerRecord[]): TaskManager {
  return {
    getDueTriggers: vi.fn(() => tasks),
    getExpiredWaitingTriggers: vi.fn(() => []),
    getWaitingTriggers: vi.fn(() => []),
    endWait: vi.fn(() => false),
    claimLease: vi.fn(() => 'claimed'),
    renewLease: vi.fn(() => true),
    releaseLease: vi.fn(),
    getTrigger: vi.fn((id: string) => tasks.find((t) => t.id === id)),
    recordTaskRun: vi.fn(() => false),
    updateWatchConfig: vi.fn(),
    setEnabled: vi.fn(() => true),
  } as unknown as TaskManager;
}

/** A session whose run the cap or a hook blocked: lynox's sentence as the answer, the notice set. */
function blockedSession(said: string, budget: BudgetNoteRef | undefined): Session {
  return {
    sessionId: 'thread-blocked', run: vi.fn(async () => said), _recreateAgent: vi.fn(), getAgent: () => null,
    getLastRunStop: () => null, getLastRunNotice: () => 'run_blocked', getLastRunBudget: () => budget, promptUser: undefined,
  } as unknown as Session;
}

function makeEngine(tm: TaskManager, session: Session, language?: string): Engine {
  return {
    config: { language: language ?? 'en' },
    getTaskManager: vi.fn(() => tm),
    createSession: vi.fn(() => session),
    getThreadStore: vi.fn(() => ({ isDeleted: () => false })),
    getPromptStore: vi.fn(() => null),
    getUserConfig: vi.fn(() => ({})), escalateToUser: vi.fn(() => null), workerRunModelOverride: vi.fn(() => ({})),
    getSecretStore: vi.fn(() => null),
    escalationReporter: vi.fn(() => () => undefined),
    getMandateEnds: vi.fn(() => ({ isLive: () => true })),
    getAuditLog: vi.fn(() => ({ record: vi.fn() })),
    getToolContext: vi.fn(() => ({ containment: null })),
    getEngineDb: () => null,
  } as unknown as Engine;
}

function makeRouter(): NotificationRouter & { sent: NotificationMessage[] } {
  const sent: NotificationMessage[] = [];
  return {
    sent,
    hasChannels: vi.fn(() => true),
    notify: vi.fn(async (m: NotificationMessage) => { sent.push(m); }),
  } as unknown as NotificationRouter & { sent: NotificationMessage[] };
}

/** Spend held at `cost` on whatever day the clock says, so a new day is the same spend again. */
function spendToday(cost: number): { getCostByDay: () => Array<{ day: string; cost_usd: number; run_count: number }> } {
  return { getCostByDay: () => [{ day: new Date().toISOString().slice(0, 10), cost_usd: cost, run_count: 1 }] };
}

function quietStderr(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    lines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
    return true;
  }) as unknown as typeof process.stderr.write);
  return { lines, restore: () => { spy.mockRestore(); } };
}

const EN = WORKER_NOTICES.en;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(`${DAY}T12:00:00Z`));
  vi.stubEnv('LYNOX_BILLING_TIER', '');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  resetPersistentBudget();
  mockFetchPinned.mockReset();
});

describe('a run the admission refused', () => {
  it('too little headroom: recorded not_run with its schedule kept, told once, the log line kept', async () => {
    configurePersistentBudget({ costProvider: spendToday(99.98), dailyCapUSD: 100 });
    const tm = makeTaskManager([makeTask()]);
    const session = blockedSession('unused', undefined);
    const engine = makeEngine(tm, session);
    const router = makeRouter();
    const loop = new WorkerLoop(engine, router, 60_000);
    const { lines, restore } = quietStderr();
    try {
      await loop.tick();
      await loop.tick();
    } finally {
      restore();
    }
    expect(engine.createSession, 'nothing started').not.toHaveBeenCalled();
    const calls = vi.mocked(tm.recordTaskRun).mock.calls;
    expect(calls, 'recorded when told, not at every tick').toHaveLength(1);
    expect(calls[0]![2]).toBe('not_run');
    expect(calls[0]![3], 'the trigger stays due').toEqual({ keepSchedule: true });
    expect(calls[0]![1]).toContain('The daily limit of $100 is reached (today $99.98). It resets tomorrow at');
    expect(calls[0]![1]).toContain(EN.capNextSelf);
    expect(calls[0]![1]).toContain(EN.notRunWaits);
    expect(router.sent, 'one notice over two ticks').toHaveLength(1);
    expect(router.sent[0]!.title).toBe('⚠ Daily Report did not run');
    expect(router.sent[0]!.body).toBe(calls[0]![1]);
    expect(router.sent[0]!.title).not.toContain('✓');
    expect(router.sent[0]!.data, 'no thread to open').toBeUndefined();
    expect(router.sent[0]!.followUps).toBeUndefined();
    expect(lines.join(''), 'the log line stays').toContain('Not started');
  });

  it('the reservation refused: told with the cap the refusal named', async () => {
    // A workflow keeps the worst-case reservation, so $99 of $100 refuses at the reservation.
    configurePersistentBudget({ costProvider: spendToday(99), dailyCapUSD: 100, sessionCapUSD: 50 });
    const tm = makeTaskManager([makeTask({ effect: 'run_workflow' })]);
    const router = makeRouter();
    const loop = new WorkerLoop(makeEngine(tm, blockedSession('unused', undefined)), router, 60_000);
    const { restore } = quietStderr();
    try {
      await loop.tick();
      await loop.tick();
    } finally {
      restore();
    }
    expect(router.sent).toHaveLength(1);
    expect(router.sent[0]!.body).toContain('The daily limit of $100 is reached (today $99.00).');
    expect(vi.mocked(tm.recordTaskRun).mock.calls[0]![3]).toEqual({ keepSchedule: true });
  });

  it('a new period brings a new notice', async () => {
    configurePersistentBudget({ costProvider: spendToday(99.98), dailyCapUSD: 100 });
    const tm = makeTaskManager([makeTask()]);
    const router = makeRouter();
    const loop = new WorkerLoop(makeEngine(tm, blockedSession('unused', undefined)), router, 60_000);
    const { restore } = quietStderr();
    try {
      await loop.tick();
      vi.setSystemTime(new Date('2026-06-16T12:00:00Z'));
      await loop.tick();
    } finally {
      restore();
    }
    expect(router.sent).toHaveLength(2);
    expect(vi.mocked(tm.recordTaskRun)).toHaveBeenCalledTimes(2);
  });

  it('a monthly cap counts its month: a new day in it brings no second notice', async () => {
    configurePersistentBudget({ costProvider: spendToday(50), dailyCapUSD: 1000, monthlyCapUSD: 50 });
    const tm = makeTaskManager([makeTask()]);
    const router = makeRouter();
    const loop = new WorkerLoop(makeEngine(tm, blockedSession('unused', undefined)), router, 60_000);
    const { restore } = quietStderr();
    try {
      await loop.tick();
      vi.setSystemTime(new Date('2026-06-16T12:00:00Z'));
      await loop.tick();
    } finally {
      restore();
    }
    expect(router.sent).toHaveLength(1);
    expect(router.sent[0]!.body).toContain('The monthly limit of $50 is reached (this month $50.00). It resets on 1 July at');
  });

  it('in German, on an instance that says so', async () => {
    configurePersistentBudget({ costProvider: spendToday(99.98), dailyCapUSD: 100 });
    const router = makeRouter();
    const loop = new WorkerLoop(makeEngine(makeTaskManager([makeTask()]), blockedSession('unused', undefined), 'de'), router, 60_000);
    const { restore } = quietStderr();
    try { await loop.tick(); } finally { restore(); }
    expect(router.sent[0]!.title).toBe('⚠ Daily Report ist nicht gelaufen');
    expect(router.sent[0]!.body).toContain('Das Tageslimit von $100 ist erreicht (heute $99.98). Es gilt wieder ab morgen um');
    expect(router.sent[0]!.body).toContain(WORKER_NOTICES.de.capNextSelf);
  });
});

describe('a run the cap or a hook stopped inside the session', () => {
  async function runBlocked(session: Session, task: TriggerRecord = makeTask()): Promise<{ tm: TaskManager; router: ReturnType<typeof makeRouter>; lines: string[] }> {
    const tm = makeTaskManager([task]);
    const router = makeRouter();
    // English set explicitly: a provisioned instance without a language speaks German.
    const loop = new WorkerLoop(makeEngine(tm, session, 'en'), router, 60_000);
    const { lines, restore } = quietStderr();
    try {
      await loop.tick();
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      restore();
    }
    return { tm, router, lines };
  }

  it('a budget block: not_run, "did not run", the reason and the step, no thread, no chips', async () => {
    const { tm, router } = await runBlocked(blockedSession('Daily spending cap ($5) reached. Today: $5.12.', { cap: 'daily', limitUSD: 5, spentUSD: 5.12 }));
    const call = vi.mocked(tm.recordTaskRun).mock.calls.find((c) => c[2] === 'not_run');
    expect(call, 'recorded as not run').toBeDefined();
    expect(vi.mocked(tm.recordTaskRun).mock.calls.some((c) => c[2] === 'success'), 'never as a success').toBe(false);
    expect(call![3], 'the run happened, so its schedule moves on').toBeUndefined();
    expect(call![1]).toContain('The daily limit of $5 is reached (today $5.12). It resets tomorrow at');
    expect(call![1]).toContain(EN.capNextSelf);
    expect(call![1], 'a cron is told its time was skipped').toContain(EN.notRunSkipped);
    expect(router.sent).toHaveLength(1);
    expect(router.sent[0]!.title).toBe('⚠ Daily Report did not run');
    expect(router.sent[0]!.data).toBeUndefined();
    expect(router.sent[0]!.followUps).toBeUndefined();
  });

  it('a managed plan names support as the step', async () => {
    vi.stubEnv('LYNOX_BILLING_TIER', 'managed');
    const { router } = await runBlocked(blockedSession('Daily spending cap ($5) reached.', { cap: 'daily', limitUSD: 5, spentUSD: 5 }));
    expect(router.sent[0]!.body).toContain(EN.capNextPlan);
    expect(router.sent[0]!.body).not.toContain(EN.capNextSelf);
  });

  it('a hook block: lynox\'s own sentence, the hook\'s text only in the log', async () => {
    const { tm, router, lines } = await runBlocked(blockedSession('Run blocked: tenant credit exhausted', undefined));
    const call = vi.mocked(tm.recordTaskRun).mock.calls.find((c) => c[2] === 'not_run');
    expect(call![1]).toBe(`${EN.hookBlocked(false)} ${EN.notRunSkipped}`);
    expect(router.sent[0]!.title).toBe('⚠ Daily Report did not run');
    expect(router.sent[0]!.body).not.toContain('tenant credit');
    expect(lines.join(''), 'the reason is in the instance log').toContain('tenant credit exhausted');
  });

  it('a one-shot is told it stays due', async () => {
    const { tm } = await runBlocked(blockedSession('Run blocked: x', undefined), makeTask({ schedule_cron: undefined, source: 'task' }));
    expect(vi.mocked(tm.recordTaskRun).mock.calls.find((c) => c[2] === 'not_run')![1]).toContain(EN.notRunWaits);
  });

  it('a one-shot a hook stops at every tick is told once', async () => {
    const task = makeTask({ schedule_cron: undefined, source: 'task' });
    const tm = makeTaskManager([task]);
    const router = makeRouter();
    const loop = new WorkerLoop(makeEngine(tm, blockedSession('Run blocked: x', undefined)), router, 60_000);
    const { restore } = quietStderr();
    try {
      await loop.tick();
      await vi.advanceTimersByTimeAsync(0);
      await loop.tick();
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      restore();
    }
    expect(vi.mocked(tm.recordTaskRun).mock.calls.filter((c) => c[2] === 'not_run'), 'each run recorded').toHaveLength(2);
    expect(router.sent, 'told once').toHaveLength(1);
  });
});

describe('a watch whose analysis was blocked', () => {
  const URL = 'https://x.test/page';
  const hashOf = (html: string): string => createHash('sha256').update(extractWatchSignal(html)).digest('hex');

  it('keeps its baseline, and the next check that runs reports the change it missed', async () => {
    vi.useRealTimers();
    const config = { url: URL, interval_minutes: 60, last_hash: hashOf('<p>old price 10</p>'), last_summary: 'The price is 10.' };
    const task = makeTask({ id: 'w-1', title: 'Price', source: 'watch', schedule_cron: undefined, watch_config: JSON.stringify(config) });
    const tm = makeTaskManager([task]);
    let blocked = true;
    const analysis = {
      sessionId: 'thread-watch', _recreateAgent: vi.fn(), getAgent: () => null, getLastRunStop: () => null, promptUser: undefined,
      run: vi.fn(async () => (blocked ? 'Daily spending cap ($5) reached.' : 'The price went from 10 to 12.')),
      getLastRunNotice: () => (blocked ? 'run_blocked' : undefined),
      getLastRunBudget: () => (blocked ? { cap: 'daily', limitUSD: 5, spentUSD: 5 } : undefined),
    } as unknown as Session;
    const engine = makeEngine(tm, analysis);
    const router = makeRouter();
    const loop = new WorkerLoop(engine, router, 60_000);
    const fire = (loop as unknown as { executeWatch: (t: TriggerRecord) => Promise<void> }).executeWatch.bind(loop);
    const { restore } = quietStderr();
    try {
      mockFetchPinned.mockResolvedValueOnce(new Response('<p>new price 12</p>', { status: 200 }));
      await fire(task);
      expect(tm.updateWatchConfig, 'the baseline did not move').not.toHaveBeenCalled();
      const first = vi.mocked(tm.recordTaskRun).mock.calls[0]!;
      expect(first[2]).toBe('not_run');
      expect(first[1]).toContain(EN.notRunWatchNext);
      expect(engine.escalateToUser, 'no change reported from a run that compared nothing').not.toHaveBeenCalled();

      // The cap opened again: the same page, against the same old baseline.
      blocked = false;
      mockFetchPinned.mockResolvedValueOnce(new Response('<p>new price 12</p>', { status: 200 }));
      await fire(task);
    } finally {
      restore();
    }
    const prompt = String(vi.mocked(analysis.run).mock.calls[1]![0]);
    expect(prompt, 'compared against the old baseline').toContain('The content changed since the last check');
    expect(prompt).toContain('The price is 10.');
    expect(vi.mocked(tm.recordTaskRun).mock.calls[1]![2]).toBe('success');
    expect(tm.updateWatchConfig).toHaveBeenCalledTimes(1);
    expect(engine.escalateToUser).toHaveBeenCalledWith(expect.objectContaining({ body: expect.stringContaining('The price went from 10 to 12.') as unknown }));
  });
});

describe('the sentences', () => {
  const now = new Date('2026-06-15T12:00:00Z');

  it('say when the cap opens again, in the zone they name', () => {
    expect(resetWhen(new Date('2026-06-16T00:00:00Z'), now, 'en', 'UTC')).toBe('tomorrow at 12:00 AM UTC');
    expect(resetWhen(new Date('2026-06-16T00:00:00Z'), now, 'de', 'Europe/Zurich')).toBe('morgen um 02:00 MESZ');
    expect(resetWhen(new Date('2026-07-01T00:00:00Z'), now, 'de', 'UTC')).toBe('dem 1. Juli um 00:00 UTC');
  });

  it('name no amount for spend that cannot be checked, and the step by who runs the instance', () => {
    expect(notRunReason('en', { cap: 'unknown' }, { managed: false, selfHosted: true, now })).toBe(`${EN.capUnverifiable} ${EN.capRestart}`);
    expect(notRunReason('en', { cap: 'unknown' }, { managed: false, selfHosted: false, now })).toBe(`${EN.capUnverifiable} ${EN.capSupportIfStays}`);
    expect(notRunReason('de', 'hook', { managed: true, selfHosted: false, now })).toBe(WORKER_NOTICES.de.hookBlocked(true));
  });
});
