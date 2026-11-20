import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// The pinned fetch is driven per case, so a watch's change is the case's and not the network's.
const mockFetchPinned = vi.fn();
vi.mock('./network-guard.js', async (importActual) => {
  const actual = await importActual<typeof import('./network-guard.js')>();
  return { ...actual, fetchPinned: (...args: unknown[]) => mockFetchPinned(...args) };
});

import { WorkerLoop, extractWatchSignal, NOT_RUN_KEYS_MAX } from './worker-loop.js';
import { WORKER_NOTICES, notRunReason, resetWhen } from './worker-notices.js';
import { admissionShortfall, configurePersistentBudget, releasePersistentBudget, resetPersistentBudget, reservePersistentBudget } from './session-budget.js';
import { RunHistory } from './run-history.js';
import { EngineDb } from './engine-db.js';
import { TaskManager as RealTaskManager } from './task-manager.js';
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

/** A session whose run ran. */
function ranSession(): Session {
  return {
    sessionId: 'thread-ran', run: vi.fn(async () => 'Done.'), _recreateAgent: vi.fn(), getAgent: () => null,
    getLastRunStop: () => null, getLastRunNotice: () => undefined, getLastRunBudget: () => undefined, promptUser: undefined,
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

/** Spend held at `cost()` on whatever day the clock says, so a new day is the same spend again. */
function spendToday(cost: number | (() => number)): { getCostByDay: () => Array<{ day: string; cost_usd: number; run_count: number }> } {
  return { getCostByDay: () => [{ day: new Date().toISOString().slice(0, 10), cost_usd: typeof cost === 'number' ? cost : cost(), run_count: 1 }] };
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
const notRunCalls = (tm: TaskManager): unknown[][] => vi.mocked(tm.recordTaskRun).mock.calls.filter((c) => c[2] === 'not_run');

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
  async function ticks(tm: TaskManager, router: ReturnType<typeof makeRouter>, n: number, language?: string): Promise<{ engine: Engine; lines: string[] }> {
    const engine = makeEngine(tm, blockedSession('unused', undefined), language);
    const loop = new WorkerLoop(engine, router, 60_000);
    const { lines, restore } = quietStderr();
    try {
      for (let i = 0; i < n; i++) await loop.tick();
    } finally {
      restore();
    }
    return { engine, lines };
  }

  it('a cap its recorded spend reached: not_run with its schedule kept, told once, the log line kept', async () => {
    configurePersistentBudget({ costProvider: spendToday(100), dailyCapUSD: 100 });
    const tm = makeTaskManager([makeTask()]);
    const router = makeRouter();
    const { engine, lines } = await ticks(tm, router, 2);
    expect(engine.createSession, 'nothing started').not.toHaveBeenCalled();
    const calls = vi.mocked(tm.recordTaskRun).mock.calls;
    expect(calls, 'recorded when told, not at every tick').toHaveLength(1);
    expect(calls[0]![2]).toBe('not_run');
    expect(calls[0]![3], 'the trigger stays due').toEqual({ keepSchedule: true });
    expect(calls[0]![1]).toContain('The daily budget of $100.00 is reached (today $100.00). A new day starts tomorrow at');
    expect(calls[0]![1]).toContain(EN.capNextSelf);
    expect(calls[0]![1]).toContain(EN.notRunWaits);
    expect(router.sent, 'one notice over two ticks').toHaveLength(1);
    expect(router.sent[0]!.title).toBe('⚠ Daily Report did not run');
    expect(router.sent[0]!.body).toBe(calls[0]![1]);
    expect(router.sent[0]!.data, 'no thread to open').toBeUndefined();
    expect(router.sent[0]!.followUps).toBeUndefined();
    expect(lines.join(''), 'the log line stays').toContain('Not started');
  });

  it('less left under a cap not reached than a run is started with: told so, with the least it needs', async () => {
    configurePersistentBudget({ costProvider: spendToday(99.98), dailyCapUSD: 100 });
    const tm = makeTaskManager([makeTask()]);
    const router = makeRouter();
    const { lines } = await ticks(tm, router, 2);
    expect(notRunCalls(tm), 'recorded once over two ticks').toHaveLength(1);
    expect(router.sent).toHaveLength(1);
    expect(router.sent[0]!.body).toContain('Only $0.02 of the daily budget of $100.00 is left today, too little for a run of this kind (at least $0.05). A new day starts tomorrow at');
    expect(router.sent[0]!.body).toContain(EN.capNextSelf);
    expect(router.sent[0]!.body).not.toContain('is reached');
    expect(lines.join('')).toContain('Not started');
  });

  it('a workflow whose ceiling is more than the rest of the cap: told so, once over two ticks', async () => {
    // A workflow reserves the session ceiling, so $99 of $100 refuses at every tick until the reset.
    configurePersistentBudget({ costProvider: spendToday(99), dailyCapUSD: 100, sessionCapUSD: 50 });
    const tm = makeTaskManager([makeTask({ effect: 'run_workflow' })]);
    const router = makeRouter();
    await ticks(tm, router, 2);
    expect(notRunCalls(tm)).toHaveLength(1);
    expect(vi.mocked(tm.recordTaskRun).mock.calls[0]![3]).toEqual({ keepSchedule: true });
    expect(router.sent).toHaveLength(1);
    expect(router.sent[0]!.body).toContain('Only $1.00 of the daily budget of $100.00 is left today, too little for a run of this kind (up to $50.00). A new day starts tomorrow at');
  });

  /** One tick a minute for `minutes` minutes, as the loop ticks at its 60 s interval. */
  async function everyMinute(loop: WorkerLoop, minutes: number): Promise<void> {
    for (let i = 0; i < minutes; i++) {
      vi.setSystemTime(new Date(Date.now() + 60_000));
      await loop.tick();
    }
  }

  /** A loop over one workflow trigger while another run in flight holds $95 of the $100 cap. */
  function heldByOthers(): { tm: TaskManager; router: ReturnType<typeof makeRouter>; loop: WorkerLoop } {
    configurePersistentBudget({ costProvider: spendToday(0), dailyCapUSD: 100, sessionCapUSD: 50 });
    expect(reservePersistentBudget(95).allowed).toBe(true);
    const tm = makeTaskManager([makeTask({ effect: 'run_workflow' })]);
    const router = makeRouter();
    return { tm, router, loop: new WorkerLoop(makeEngine(tm, ranSession()), router, 60_000) };
  }

  it('only other runs in flight in the way: the log line alone for the hour, then told with no advice', async () => {
    const { tm, router, loop } = heldByOthers();
    const { lines, restore } = quietStderr();
    try {
      await loop.tick();
      // Past the lease's lifetime of 15 minutes: the heartbeat renews it, so a healthy run may last that long.
      await everyMinute(loop, 20);
      expect(tm.recordTaskRun, 'silent past the lease lifetime').not.toHaveBeenCalled();
      await everyMinute(loop, 39);
      expect(tm.recordTaskRun, 'silent short of the hour').not.toHaveBeenCalled();
      expect(router.sent).toHaveLength(0);
      expect(lines.join('')).toContain('would be exceeded by in-flight tasks');
      await everyMinute(loop, 2);
    } finally {
      restore();
    }
    expect(notRunCalls(tm)).toHaveLength(1);
    expect(router.sent).toHaveLength(1);
    const body = router.sent[0]!.body;
    expect(body).toMatch(/^Waiting since today at .+ for other runs, which hold the rest of the budget\. Runs once the other runs end\.$/);
    expect(body).not.toContain(EN.capRestart);
    expect(body).not.toContain(EN.capSupportIfStays);
    expect(body).not.toContain('support@');
    expect(body, 'one close, not two').not.toContain(EN.notRunWaits);
  });

  it('a wait for other runs is told with no advice on a managed plan either', () => {
    const now = new Date(`${DAY}T12:00:00Z`);
    const since = new Date(`${DAY}T11:00:00Z`);
    for (const lang of ['en', 'de'] as const) {
      const n = WORKER_NOTICES[lang];
      for (const ctx of [{ managed: true, selfHosted: false, now }, { managed: false, selfHosted: false, now }, { managed: false, selfHosted: true, now }]) {
        const said = notRunReason(lang, { kind: 'waiting', since }, ctx);
        expect(said.endsWith(n.waitingNext)).toBe(true);
        expect(said).not.toContain(n.capRestart);
        expect(said).not.toContain(n.capSupportIfStays);
      }
    }
    expect(WORKER_NOTICES.de.waitingNext).toBe('Läuft, sobald die anderen Läufe enden.');
  });

  it('a gap of more than two ticks without a refusal starts the wait again', async () => {
    const { tm, router, loop } = heldByOthers();
    const { restore } = quietStderr();
    try {
      await loop.tick();
      await everyMinute(loop, 30);
      // Paused, deleted, or its event dropped: ten minutes without a refusal.
      vi.setSystemTime(new Date(Date.now() + 10 * 60_000));
      await everyMinute(loop, 40);
      expect(tm.recordTaskRun, 'the hour counts from the second wait, not the first').not.toHaveBeenCalled();
      await everyMinute(loop, 21);
    } finally {
      restore();
    }
    expect(notRunCalls(tm)).toHaveLength(1);
    expect(router.sent).toHaveLength(1);
  });

  it('a real run between two waits starts the wait again', async () => {
    configurePersistentBudget({ costProvider: spendToday(0), dailyCapUSD: 100 });
    // Others hold all but $0.03, less than a run is started with.
    expect(reservePersistentBudget(99.97).allowed).toBe(true);
    const tm = makeTaskManager([makeTask()]);
    const router = makeRouter();
    const engine = makeEngine(tm, ranSession());
    const loop = new WorkerLoop(engine, router, 60_000);
    const { restore } = quietStderr();
    try {
      await loop.tick();
      await everyMinute(loop, 50);
      expect(engine.createSession).not.toHaveBeenCalled();
      releasePersistentBudget(99.97);
      await everyMinute(loop, 1);
      await vi.advanceTimersByTimeAsync(0);
      expect(engine.createSession, 'it ran').toHaveBeenCalled();
      expect(reservePersistentBudget(99.97).allowed).toBe(true);
      await everyMinute(loop, 30);
    } finally {
      restore();
    }
    expect(notRunCalls(tm), 'the hour counts from after the run').toHaveLength(0);
    expect(router.sent.map((m) => m.title), 'the run told, the wait not').toEqual(['✓ Daily Report']);
  });

  it('a cap reached between two waits starts the wait again', async () => {
    let cost = 0;
    configurePersistentBudget({ costProvider: spendToday(() => cost), dailyCapUSD: 100, sessionCapUSD: 50 });
    expect(reservePersistentBudget(95).allowed).toBe(true);
    const tm = makeTaskManager([makeTask({ effect: 'run_workflow' })]);
    const router = makeRouter();
    const loop = new WorkerLoop(makeEngine(tm, ranSession()), router, 60_000);
    const { restore } = quietStderr();
    try {
      await loop.tick();
      await everyMinute(loop, 30);
      cost = 100;
      await everyMinute(loop, 1);
      cost = 0;
      await everyMinute(loop, 40);
    } finally {
      restore();
    }
    expect(notRunCalls(tm), 'told the cap, not the wait').toHaveLength(1);
    expect(router.sent).toHaveLength(1);
    expect(router.sent[0]!.body).toContain('The daily budget of $100.00 is reached');
  });

  it('too little left under a cap between two waits starts the wait again', async () => {
    let cost = 0;
    configurePersistentBudget({ costProvider: spendToday(() => cost), dailyCapUSD: 100, sessionCapUSD: 50 });
    expect(reservePersistentBudget(45).allowed).toBe(true);
    const tm = makeTaskManager([makeTask({ effect: 'run_workflow' })]);
    const router = makeRouter();
    const loop = new WorkerLoop(makeEngine(tm, ranSession()), router, 60_000);
    const { restore } = quietStderr();
    try {
      // $10 spent and $45 held by others: the $50 run waits for them.
      cost = 10;
      await loop.tick();
      await everyMinute(loop, 30);
      // $60 spent: recorded spend alone leaves too little.
      cost = 60;
      await everyMinute(loop, 1);
      cost = 10;
      await everyMinute(loop, 40);
    } finally {
      restore();
    }
    expect(notRunCalls(tm), 'told too little, not the wait').toHaveLength(1);
    expect(router.sent).toHaveLength(1);
    expect(router.sent[0]!.body).toContain('Only $40.00 of the daily budget of $100.00 is left today');
  });

  it('a reservation refused on a cap its recorded spend reached: told with that cap', async () => {
    configurePersistentBudget({ costProvider: spendToday(100), dailyCapUSD: 100, sessionCapUSD: 50 });
    const tm = makeTaskManager([makeTask({ effect: 'run_workflow' })]);
    const router = makeRouter();
    await ticks(tm, router, 1);
    expect(router.sent).toHaveLength(1);
    expect(router.sent[0]!.body).toContain('The daily budget of $100.00 is reached (today $100.00).');
    expect(vi.mocked(tm.recordTaskRun).mock.calls[0]![3]).toEqual({ keepSchedule: true });
  });

  it('a new period brings a new notice', async () => {
    configurePersistentBudget({ costProvider: spendToday(100), dailyCapUSD: 100 });
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

  it('refused, then run, then refused again the same day: told again', async () => {
    let cost = 100;
    configurePersistentBudget({ costProvider: spendToday(() => cost), dailyCapUSD: 100 });
    const tm = makeTaskManager([makeTask()]);
    const router = makeRouter();
    const loop = new WorkerLoop(makeEngine(tm, ranSession()), router, 60_000);
    const { restore } = quietStderr();
    try {
      await loop.tick();
      cost = 10; // the owner raised the cap, or spend was corrected
      await loop.tick();
      await vi.advanceTimersByTimeAsync(0);
      cost = 100;
      await loop.tick();
    } finally {
      restore();
    }
    expect(vi.mocked(tm.recordTaskRun).mock.calls.map((c) => c[2])).toEqual(['not_run', 'success', 'not_run']);
    expect(router.sent.filter((m) => m.title.includes('did not run')), 'the second refusal is told too').toHaveLength(2);
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
    expect(router.sent[0]!.body).toContain('The monthly budget of $50.00 is reached (this month $50.00). A new month starts on July 1 at');
  });

  it('in German, on an instance that says so', async () => {
    configurePersistentBudget({ costProvider: spendToday(100), dailyCapUSD: 100 });
    const router = makeRouter();
    await ticks(makeTaskManager([makeTask()]), router, 1, 'de');
    expect(router.sent[0]!.title).toBe('⚠ Daily Report ist nicht gelaufen');
    expect(router.sent[0]!.body).toContain('Das Tagesbudget von $100.00 ist erreicht (heute $100.00). Morgen um');
    expect(router.sent[0]!.body).toContain(WORKER_NOTICES.de.capNextSelf);
  });
});

describe('a run the cap or a hook stopped inside the session', () => {
  async function runBlocked(session: Session, task: TriggerRecord = makeTask()): Promise<{ tm: TaskManager; router: ReturnType<typeof makeRouter>; lines: string[] }> {
    const tm = makeTaskManager([task]);
    const router = makeRouter();
    const loop = new WorkerLoop(makeEngine(tm, session), router, 60_000);
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
    const call = notRunCalls(tm)[0];
    expect(call, 'recorded as not run').toBeDefined();
    expect(vi.mocked(tm.recordTaskRun).mock.calls.some((c) => c[2] === 'success'), 'never as a success').toBe(false);
    expect(call![3], 'a cron moves on as after any run').toBeUndefined();
    expect(call![1]).toContain('The daily budget of $5.00 is reached (today $5.12). A new day starts tomorrow at');
    expect(call![1]).toContain(EN.capNextSelf);
    expect(call![1], 'a cron is told its time was skipped').toContain(EN.notRunSkipped);
    expect(router.sent).toHaveLength(1);
    expect(router.sent[0]!.title).toBe('⚠ Daily Report did not run');
    expect(router.sent[0]!.data).toBeUndefined();
    expect(router.sent[0]!.followUps).toBeUndefined();
  });

  it('names the limits page only where the owner sets the budget: self-hosted, not hosted or managed', async () => {
    for (const [tier, named] of [['', true], ['hosted', false], ['managed', false]] as const) {
      vi.stubEnv('LYNOX_BILLING_TIER', tier);
      const { router } = await runBlocked(blockedSession('Daily spending cap ($5) reached.', { cap: 'daily', limitUSD: 5, spentUSD: 5 }));
      const body = router.sent[0]!.body;
      expect(body.includes(EN.capNextSelf), `tier '${tier}'`).toBe(named);
      expect(body, `tier '${tier}'`).not.toContain('support@');
      expect(body).toContain('The daily budget of $5.00 is reached (today $5.00). A new day starts tomorrow at');
    }
  });

  it('a hook block: lynox\'s own sentence, the hook\'s text only in the log', async () => {
    const { tm, router, lines } = await runBlocked(blockedSession('Run blocked: tenant credit exhausted', undefined));
    expect(notRunCalls(tm)[0]![1]).toBe(`${EN.hookBlocked(false)} ${EN.notRunSkipped}`);
    expect(router.sent[0]!.title).toBe('⚠ Daily Report did not run');
    expect(router.sent[0]!.body).not.toContain('tenant credit');
    expect(lines.join(''), 'the reason is in the instance log').toContain('tenant credit exhausted');
  });

  it('a cron a hook stops at two runs within the relog interval says so once in the log', async () => {
    const tm = makeTaskManager([makeTask({ schedule_cron: '* * * * *' })]);
    const session = blockedSession('Run blocked: tenant credit exhausted', undefined);
    const loop = new WorkerLoop(makeEngine(tm, session), makeRouter(), 60_000);
    const { lines, restore } = quietStderr();
    try {
      await loop.tick();
      await vi.advanceTimersByTimeAsync(0);
      vi.setSystemTime(new Date(Date.now() + 60_000));
      await loop.tick();
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      restore();
    }
    expect(session.run, 'both runs started').toHaveBeenCalledTimes(2);
    expect(notRunCalls(tm), 'both recorded').toHaveLength(2);
    expect(lines.filter((l) => l.includes('Did not run')), 'one log line').toHaveLength(1);
  });

  it('a one-shot a cap stopped is due again when the cap opens, and says so', async () => {
    const { tm } = await runBlocked(blockedSession('cap', { cap: 'daily', limitUSD: 5, spentUSD: 5 }), makeTask({ schedule_cron: undefined, source: 'task' }));
    const call = notRunCalls(tm)[0]!;
    expect(call[3]).toEqual({ retryAt: '2026-06-16T00:00:00.000Z' });
    expect(call[1]).toContain('Next try tomorrow at');
  });

  it('a one-shot a hook stopped is due again in an hour', async () => {
    const { tm } = await runBlocked(blockedSession('Run blocked: x', undefined), makeTask({ schedule_cron: undefined, source: 'task' }));
    expect(notRunCalls(tm)[0]![3]).toEqual({ retryAt: '2026-06-15T13:00:00.000Z' });
  });
});

describe('a one-shot a hook stops, on a real schedule', () => {
  let dir: string;
  let history: RunHistory;
  let engineDb: EngineDb;
  let tm: RealTaskManager;

  beforeEach(() => {
    vi.useRealTimers();
    dir = mkdtempSync(join(tmpdir(), 'lynox-wl-notrun-'));
    history = new RunHistory(join(dir, 'history.db'));
    engineDb = new EngineDb(join(dir, 'engine.db'));
    history.setVerbGraph(engineDb);
    tm = new RealTaskManager(history);
  });
  afterEach(() => {
    try { history.close(); } catch { /* closed */ }
    try { engineDb.close(); } catch { /* closed */ }
    rmSync(dir, { recursive: true, force: true });
  });

  async function until(check: () => boolean): Promise<void> {
    for (let i = 0; i < 400 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
    if (!check()) throw new Error('until(): condition never held');
  }

  it('is not run again at the next tick: its next run is the backoff', async () => {
    const t = tm.create({
      title: 'Once', taskType: 'scheduled', nextRunAt: '2020-01-01T00:00:00.000Z',
      createdBy: 'owner', confirmedAt: '2026-06-01T00:00:00.000Z', confirmedBy: 'owner',
    }) as TriggerRecord;
    const session = blockedSession('Run blocked: x', undefined);
    const loop = new WorkerLoop(makeEngine(tm as unknown as TaskManager, session), makeRouter(), 60_000);
    const { lines, restore } = quietStderr();
    const before = Date.now();
    try {
      await loop.tick();
      await until(() => tm.getTrigger(t.id)?.last_run_status === 'not_run');
      await until(() => !(loop as unknown as { activeTasks: Map<string, unknown> }).activeTasks.has(t.id));
      await loop.tick();
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      restore();
      loop.stop();
    }
    expect(session.run, 'the second tick started no run').toHaveBeenCalledTimes(1);
    const next = Date.parse(tm.getTrigger(t.id)!.next_run_at!);
    expect(next).toBeGreaterThanOrEqual(before + 60 * 60_000 - 1000);
    expect(next).toBeLessThanOrEqual(Date.now() + 60 * 60_000);
    expect(tm.getTrigger(t.id)!.status).toBe('open');
    expect(lines.filter((l) => l.includes('Did not run')), 'one log line').toHaveLength(1);
  });

  it('started by hand, keeps its schedule and is told to be started again by hand', async () => {
    const at = '2030-01-01T00:00:00.000Z';
    const t = tm.create({
      title: 'Once', taskType: 'scheduled', nextRunAt: at,
      createdBy: 'owner', confirmedAt: '2026-06-01T00:00:00.000Z', confirmedBy: 'owner',
    }) as TriggerRecord;
    const loop = new WorkerLoop(makeEngine(tm as unknown as TaskManager, blockedSession('Run blocked: x', undefined)), makeRouter(), 60_000);
    const { restore } = quietStderr();
    try {
      expect(await loop.runTriggerNow(t.id)).toEqual({ ok: true });
      await until(() => tm.getTrigger(t.id)?.last_run_status === 'not_run');
    } finally {
      restore();
      loop.stop();
    }
    const after = tm.getTrigger(t.id)!;
    expect(after.next_run_at).toBe(at);
    expect(after.last_run_result).toContain(EN.notRunByHand);
    expect(after.last_run_result).not.toContain(EN.notRunWaits);
  });
});

describe('a watch whose analysis was blocked', () => {
  const URL = 'https://x.test/page';
  const hashOf = (html: string): string => createHash('sha256').update(extractWatchSignal(html)).digest('hex');

  function watchSession(blocked: () => boolean, answer: string): Session {
    return {
      sessionId: 'thread-watch', _recreateAgent: vi.fn(), getAgent: () => null, getLastRunStop: () => null, promptUser: undefined,
      run: vi.fn(async () => (blocked() ? 'Daily spending cap ($5) reached.' : answer)),
      getLastRunNotice: () => (blocked() ? 'run_blocked' : undefined),
      getLastRunBudget: () => (blocked() ? { cap: 'daily', limitUSD: 5, spentUSD: 5 } : undefined),
    } as unknown as Session;
  }

  it('keeps its baseline, and the next check that runs reports the change it missed', async () => {
    vi.useRealTimers();
    const config = { url: URL, interval_minutes: 60, last_hash: hashOf('<p>old price 10</p>'), last_summary: 'The price is 10.' };
    const task = makeTask({ id: 'w-1', title: 'Price', source: 'watch', schedule_cron: undefined, watch_config: JSON.stringify(config) });
    const tm = makeTaskManager([task]);
    let blocked = true;
    const analysis = watchSession(() => blocked, 'The price went from 10 to 12.');
    const engine = makeEngine(tm, analysis);
    const loop = new WorkerLoop(engine, makeRouter(), 60_000);
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

  it('on its first check names no last one', async () => {
    vi.useRealTimers();
    const task = makeTask({ id: 'w-2', title: 'Price', source: 'watch', schedule_cron: undefined, watch_config: JSON.stringify({ url: URL, interval_minutes: 60 }) });
    const tm = makeTaskManager([task]);
    const loop = new WorkerLoop(makeEngine(tm, watchSession(() => true, 'unused')), makeRouter(), 60_000);
    const fire = (loop as unknown as { executeWatch: (t: TriggerRecord) => Promise<void> }).executeWatch.bind(loop);
    const { restore } = quietStderr();
    try {
      mockFetchPinned.mockResolvedValueOnce(new Response('<p>price 12</p>', { status: 200 }));
      await fire(task);
    } finally {
      restore();
    }
    const said = String(notRunCalls(tm)[0]![1]);
    expect(said).toContain(EN.notRunWatchFirst);
    expect(said).not.toContain(EN.notRunWatchNext);
  });

  it('the content check refused the page: the baseline stays, and the page is named as the cause', async () => {
    vi.useRealTimers();
    const config = { url: URL, interval_minutes: 60, last_hash: hashOf('<p>old</p>'), last_summary: 'Old.' };
    const task = makeTask({ id: 'w-3', title: 'Page', source: 'watch', schedule_cron: undefined, watch_config: JSON.stringify(config) });
    const tm = makeTaskManager([task]);
    const analysis = contentRefusedSession('⚠ Request blocked by content policy: x. This request was not sent to the AI model.');
    const engine = makeEngine(tm, analysis);
    const loop = new WorkerLoop(engine, makeRouter(), 60_000);
    const fire = (loop as unknown as { executeWatch: (t: TriggerRecord) => Promise<void> }).executeWatch.bind(loop);
    const { lines, restore } = quietStderr();
    try {
      mockFetchPinned.mockResolvedValueOnce(new Response('<p>new</p>', { status: 200 }));
      await fire(task);
    } finally {
      restore();
    }
    expect(tm.updateWatchConfig, 'the baseline did not move').not.toHaveBeenCalled();
    expect(engine.escalateToUser).not.toHaveBeenCalled();
    const said = String(notRunCalls(tm)[0]![1]);
    expect(said).toContain(EN.contentRefused);
    expect(said).toContain(EN.contentNextWatch);
    expect(said, 'the check\'s own text only in the log').not.toContain('content policy');
    expect(lines.join('')).toContain('content policy');
  });
});

/** A session whose task the content check refused before the model. */
function contentRefusedSession(said: string): Session {
  return {
    sessionId: 'thread-refused', run: vi.fn(async () => said), _recreateAgent: vi.fn(), getAgent: () => null,
    getLastRunStop: () => null, getLastRunNotice: () => 'content_refused', getLastRunBudget: () => undefined, promptUser: undefined,
  } as unknown as Session;
}

describe('a task the content check refused', () => {
  it('is recorded not_run with lynox\'s own sentence, never as a success, and a one-shot backs off', async () => {
    const tm = makeTaskManager([makeTask({ schedule_cron: undefined, source: 'task' })]);
    const router = makeRouter();
    const loop = new WorkerLoop(makeEngine(tm, contentRefusedSession('⚠ Request blocked by content policy: x.')), router, 60_000);
    const { restore } = quietStderr();
    try {
      await loop.tick();
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      restore();
    }
    expect(vi.mocked(tm.recordTaskRun).mock.calls.some((c) => c[2] === 'success')).toBe(false);
    const call = notRunCalls(tm)[0]!;
    expect(call[1]).toBe(`${EN.contentRefused} ${EN.contentNextTask} ${EN.notRunRetryAt(resetWhen(new Date('2026-06-15T13:00:00.000Z'), new Date(), 'en'))}`);
    expect(call[3]).toEqual({ retryAt: '2026-06-15T13:00:00.000Z' });
    expect(router.sent).toHaveLength(1);
    expect(router.sent[0]!.title).toBe('⚠ Daily Report did not run');
    expect(router.sent[0]!.title).not.toContain('✓');
  });
});

describe('the edges', () => {
  it('a webhook trigger stopped in its run is not given a one-shot\'s retry time', async () => {
    // The due loop leaves webhook triggers to the drain, so the run is handed in directly: its
    // work comes from the events it receives, not from a time of its own.
    const task = makeTask({ schedule_cron: undefined, source: 'webhook' });
    const tm = makeTaskManager([task]);
    const loop = new WorkerLoop(makeEngine(tm, blockedSession('Run blocked: x', undefined)), makeRouter(), 60_000);
    const run = (loop as unknown as { executeStandard: (t: TriggerRecord) => Promise<void> }).executeStandard.bind(loop);
    const { restore } = quietStderr();
    try {
      await run(task);
    } finally {
      restore();
    }
    const call = notRunCalls(tm)[0]!;
    expect(call[3]).toBeUndefined();
    expect(call[1], 'a check, not the budget, held it back').toBe(`${EN.hookBlocked(false)} ${EN.notRunWaitsCheck}`);
  });

  it('an update of a trigger already told does not clear what the others were told', async () => {
    configurePersistentBudget({ costProvider: spendToday(100), dailyCapUSD: 100 });
    const tasks = Array.from({ length: NOT_RUN_KEYS_MAX }, (_, i) => makeTask({ id: `t-${String(i)}`, title: `T${String(i)}` }));
    const tm = makeTaskManager(tasks);
    const router = makeRouter();
    const loop = new WorkerLoop(makeEngine(tm, ranSession()), router, 60_000);
    const { restore } = quietStderr();
    try {
      await loop.tick();
      expect(router.sent).toHaveLength(NOT_RUN_KEYS_MAX);
      // A new day for the first trigger only: its own key is replaced, the map is full.
      vi.setSystemTime(new Date('2026-06-16T12:00:00Z'));
      vi.mocked(tm.getDueTriggers).mockReturnValue([tasks[0]!]);
      await loop.tick();
      expect(router.sent).toHaveLength(NOT_RUN_KEYS_MAX + 1);
      // Back on the first day, the second trigger's refusal was already told.
      vi.setSystemTime(new Date(`${DAY}T12:00:00Z`));
      vi.mocked(tm.getDueTriggers).mockReturnValue([tasks[1]!]);
      await loop.tick();
    } finally {
      restore();
    }
    expect(router.sent, 'not told again').toHaveLength(NOT_RUN_KEYS_MAX + 1);
  });

  it('a wait started again on a full memory does not start the others again', async () => {
    configurePersistentBudget({ costProvider: spendToday(0), dailyCapUSD: 100, sessionCapUSD: 50 });
    expect(reservePersistentBudget(95).allowed).toBe(true);
    const tasks = Array.from({ length: NOT_RUN_KEYS_MAX }, (_, i) => makeTask({ id: `t-${String(i)}`, title: `T${String(i)}`, effect: 'run_workflow' }));
    const tm = makeTaskManager(tasks);
    const router = makeRouter();
    const loop = new WorkerLoop(makeEngine(tm, ranSession()), router, 60_000);
    const { restore } = quietStderr();
    const minutes = async (n: number): Promise<void> => {
      for (let i = 0; i < n; i++) { vi.setSystemTime(new Date(Date.now() + 60_000)); await loop.tick(); }
    };
    try {
      await loop.tick();
      // The first trigger is not due for a while, so its wait starts again while the memory is full.
      vi.mocked(tm.getDueTriggers).mockReturnValue(tasks.slice(1));
      await minutes(5);
      vi.mocked(tm.getDueTriggers).mockReturnValue(tasks);
      await minutes(56);
    } finally {
      restore();
    }
    expect(router.sent, 'the others told at their hour, the first not yet').toHaveLength(NOT_RUN_KEYS_MAX - 1);
  });
});

describe('the sentences', () => {
  const now = new Date('2026-06-15T12:00:00Z');

  it('say when the cap opens again, in the zone they name', () => {
    expect(resetWhen(new Date('2026-06-16T00:00:00Z'), now, 'en', 'UTC')).toBe('tomorrow at 12:00 AM UTC');
    expect(resetWhen(new Date('2026-06-16T00:00:00Z'), now, 'de', 'Europe/Zurich')).toBe('morgen um 02:00 MESZ');
    expect(resetWhen(new Date('2026-07-01T00:00:00Z'), now, 'de', 'UTC')).toBe('dem 1. Juli um 00:00 UTC');
  });

  it('say every cause in full, in both languages and for each kind of instance', () => {
    const nov = new Date('2026-11-20T12:00:00Z');
    const zone = 'Europe/Zurich';
    const self = { managed: false, selfHosted: true, now: nov, timeZone: zone };
    const hosted = { managed: false, selfHosted: false, now: nov, timeZone: zone };
    const managed = { managed: true, selfHosted: false, now: nov, timeZone: zone };
    const daily = { kind: 'cap', ref: { cap: 'daily', limitUSD: 1.2, spentUSD: 1 } } as const;
    const monthly = { kind: 'cap', ref: { cap: 'monthly', limitUSD: 50, spentUSD: 50.1 } } as const;
    const small = { kind: 'too_small', cap: 'daily', limitUSD: 100, spentUSD: 99.98, needUSD: 0.05, atLeast: true } as const;
    const waiting = { kind: 'waiting', since: new Date('2026-11-20T10:30:00Z') } as const;

    expect(notRunReason('de', daily, self)).toBe('Das Tagesbudget von $1.20 ist erreicht (heute $1.00). Morgen um 01:00 MEZ beginnt ein neuer Tag. Du kannst das Limit unter Einstellungen → Limits ändern.');
    expect(notRunReason('en', daily, self)).toBe('The daily budget of $1.20 is reached (today $1.00). A new day starts tomorrow at 01:00 AM GMT+1. You can change the limit under Settings → Limits.');
    expect(notRunReason('de', daily, managed)).toBe('Das Tagesbudget von $1.20 ist erreicht (heute $1.00). Morgen um 01:00 MEZ beginnt ein neuer Tag.');
    expect(notRunReason('en', daily, hosted)).toBe('The daily budget of $1.20 is reached (today $1.00). A new day starts tomorrow at 01:00 AM GMT+1.');
    expect(notRunReason('de', monthly, managed)).toBe('Das Monatsbudget von $50.00 ist erreicht (diesen Monat $50.10). Am 1. Dezember um 01:00 MEZ beginnt ein neuer Monat.');
    expect(notRunReason('en', monthly, managed)).toBe('The monthly budget of $50.00 is reached (this month $50.10). A new month starts on December 1 at 01:00 AM GMT+1.');
    expect(notRunReason('de', small, self)).toBe('Vom Tagesbudget von $100.00 ist heute nur noch $0.02 übrig, zu wenig für einen Lauf dieser Art (mindestens $0.05). Morgen um 01:00 MEZ beginnt ein neuer Tag. Du kannst das Limit unter Einstellungen → Limits ändern.');
    expect(notRunReason('en', small, hosted)).toBe('Only $0.02 of the daily budget of $100.00 is left today, too little for a run of this kind (at least $0.05). A new day starts tomorrow at 01:00 AM GMT+1.');
    expect(notRunReason('de', waiting, self)).toBe('Wartet seit heute um 11:30 MEZ auf andere Läufe, die den Rest des Budgets belegen. Läuft, sobald die anderen Läufe enden.');
    expect(notRunReason('en', waiting, managed)).toBe('Waiting since today at 11:30 AM GMT+1 for other runs, which hold the rest of the budget. Runs once the other runs end.');
    expect(notRunReason('de', { kind: 'content' }, self)).toBe('Die Inhaltsprüfung hat den Auftrag nicht ans Modell weitergegeben. Prüf den Text des Auftrags unter Automation → Trigger.');
    expect(notRunReason('en', { kind: 'content' }, managed)).toBe('The content check did not pass the task on to the model. Check the task\'s text under Automation → Triggers.');
    expect(notRunReason('de', { kind: 'content' }, { ...self, watch: true })).toBe('Die Inhaltsprüfung hat den Auftrag nicht ans Modell weitergegeben. Abgelehnt wurde der Inhalt der beobachteten Seite.');
    expect(notRunReason('en', { kind: 'content' }, { ...managed, watch: true })).toBe('The content check did not pass the task on to the model. The content of the watched page was refused.');
    expect(WORKER_NOTICES.de.notRunWaits).toBe('Der Lauf bleibt fällig und startet, sobald das Budget es zulässt.');
    expect(EN.notRunWaits).toBe('The run stays due and starts as soon as the budget allows.');
  });

  it('name no amount for spend that cannot be checked, and the step by who runs the instance', () => {
    expect(notRunReason('en', { kind: 'cap', ref: { cap: 'unknown' } }, { managed: false, selfHosted: true, now })).toBe(`${EN.capUnverifiable} ${EN.capRestart}`);
    expect(notRunReason('en', { kind: 'cap', ref: { cap: 'unknown' } }, { managed: false, selfHosted: false, now })).toBe(`${EN.capUnverifiable} ${EN.capSupportIfStays}`);
    expect(notRunReason('de', { kind: 'hook' }, { managed: true, selfHosted: false, now })).toBe(WORKER_NOTICES.de.hookBlocked(true));
  });
});

describe('what holds a run back at admission', () => {
  it('too little left under the monthly cap while the daily cap has room', () => {
    configurePersistentBudget({ costProvider: spendToday(49.5), dailyCapUSD: 1000, monthlyCapUSD: 50 });
    expect(admissionShortfall(1)).toEqual({ kind: 'too_small', cap: 'monthly', limitUSD: 50, spentUSD: 49.5 });
  });

  it('a run that fits the rest of the cap to the cent is not too small', () => {
    configurePersistentBudget({ costProvider: spendToday(50), dailyCapUSD: 100, monthlyCapUSD: 200 });
    expect(admissionShortfall(50)).toEqual({ kind: 'in_flight' });
    configurePersistentBudget({ costProvider: spendToday(150), dailyCapUSD: 1000, monthlyCapUSD: 200 });
    expect(admissionShortfall(50)).toEqual({ kind: 'in_flight' });
  });
});
