/**
 * Stopping a RUNNING background task — the owner's handle on a computing run.
 *
 * ⛔ WHAT THESE TESTS HAVE TO OBSERVE, because the obvious assertion is worthless here.
 * A test that asserts `session.abort()` WAS CALLED passes while the run carries on
 * computing, and a test that asserts the route returned 200 passes while nothing stops
 * at all. The register row says it in those words: *the test shows that the run itself
 * has ended, not that `abort()` was called.* So the observable is the RECORDED OUTCOME
 * of the run — a value that only exists once the run has settled.
 *
 * ⭐ AND THE FAKE IS BUILT SO THAT THE CONTROLLER ALONE CANNOT END THE RUN. Its turn is
 * a promise that settles only on `session.abort()`; aborting the controller does
 * nothing to it. That is not a convenience, it is the modelled reality — no tool
 * handler checks the abort signal, which is exactly why a stop route built on the
 * controller (as the row originally prescribed) would answer 200 and change nothing.
 * It is also what makes the mutation lethal: remove the `session.abort()` call from
 * `stopTask` and the run never ends, so the recorded outcome never appears.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerLoop } from './worker-loop.js';
import { RunHistory } from './run-history.js';
import { EngineDb } from './engine-db.js';
import { PromptStore } from './prompt-store.js';
import { TaskManager } from './task-manager.js';
import type { Engine } from './engine.js';
import type { Session } from './session.js';
import type { NotificationRouter } from './notification-router.js';

const tmpDirs: string[] = [];
const closers: Array<() => void> = [];
/** Turns still in flight, drained before any sqlite handle closes. */
const inFlight: Array<Promise<unknown>> = [];
/**
 * Settles whatever turn a harness left computing, so teardown can drain it.
 *
 * ⚠ Registered by the harness and called UNCONDITIONALLY in `afterEach`, never by a
 * test body: a release written at the end of a test is skipped by a failing assertion
 * above it, and the run then hangs until vitest's hook timeout — turning one clear
 * assertion failure into that failure plus a 10-second timeout. Two tests here leave
 * the turn deliberately unsettled (a stop on a task that is not running, and a
 * shutdown that must NOT abort the session), so this is not an edge case but the
 * normal path for half the file.
 */
const releases: Array<() => void> = [];
/** Every loop a harness built, so teardown can wait for its bookkeeping to finish. */
const loops: WorkerLoop[] = [];

interface Harness {
  loop: WorkerLoop;
  /** `undefined` when the harness was built without dispatching a run. */
  history: RunHistory;
  /** Resolves once the run is actually COMPUTING — not once the tick returned. */
  running: Promise<void>;
  tick: Promise<void> | undefined;
  abortCalls: () => number;
}

function makeHarness(opts?: { dispatch?: boolean; retriable?: boolean }): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'lynox-stop-'));
  tmpDirs.push(dir);
  const history = new RunHistory(join(dir, 'history.db'));
  const engineDb = new EngineDb(join(dir, 'engine.db'));
  history.setVerbGraph(engineDb);
  closers.push(() => { try { history.close(); } catch { /* twice is fine */ } });
  closers.push(() => { try { engineDb.close(); } catch { /* twice is fine */ } });
  const prompts = new PromptStore(history.getDb());
  const manager = new TaskManager(history);

  // TWO shapes, because they reach different branches of `recordTaskRun` and each
  // hides the other's question.
  //
  // ⛔ A cron trigger CANNOT reach the retry branch at all — that branch is the third
  // `else if`, guarded on having neither a cron nor a watch config. A mutation round
  // found this: a mutant that sent a stop INTO the backoff re-fire survived a
  // `retry_count` assertion written against a cron fixture, because the fixture could
  // never execute the line being mutated. The retriable one-shot below is the witness.
  history.insertTrigger(opts?.retriable === true
    ? {
        id: 'trg-stop', title: 'One-shot import', source: 'user', effect: 'run_agent',
        nextRunAt: '2026-01-01T09:00:00.000Z', confirmedAt: '2026-01-01T00:00:00.000Z',
        maxRetries: 2,
      }
    : {
        id: 'trg-stop', title: 'Long report', source: 'cron', effect: 'run_agent',
        scheduleCron: '0 9 * * *', nextRunAt: '2026-01-01T09:00:00.000Z',
        confirmedAt: '2026-01-01T00:00:00.000Z',
      });

  let signalRunning: () => void;
  const running = new Promise<void>(resolve => { signalRunning = resolve; });
  let rejectTurn: ((e: Error) => void) | undefined;

  const session = {
    sessionId: 'thread-stop',
    _recreateAgent: vi.fn(),
    promptUser: undefined as ((q: string, o?: string[]) => Promise<string>) | undefined,
    // The only thing that ends this run. Aborting the controller does not.
    abort: vi.fn(() => { rejectTurn?.(new Error('run aborted by its owner')); }),
    run: vi.fn(() => {
      const turn = new Promise<string>((_resolve, reject) => { rejectTurn = reject; });
      // Let the loop finish wiring (and attaching the session) before the test looks.
      setImmediate(() => signalRunning());
      inFlight.push(turn.catch(() => { /* the rejection IS the stop; the loop handles it */ }));
      return turn;
    }),
  };

  const engine = {
    getTaskManager: () => manager,
    createSession: () => session as unknown as Session,
    getPromptStore: () => prompts,
    getRunHistory: () => history,
    getSecretStore: () => null,
    getUserConfig: () => ({}),
    escalateToUser: () => null,
  } as unknown as Engine;

  const router = {
    hasChannels: () => false,
    notify: vi.fn().mockResolvedValue(undefined),
  } as unknown as NotificationRouter;

  releases.push(() => { rejectTurn?.(new Error('released by teardown')); });

  const loop = new WorkerLoop(engine, router, 60_000);
  loops.push(loop);
  // ⚠ `dispatch: false` for the case that needs NO run — asking about a task that is
  // not running. Starting a run there left a turn nothing would ever settle, and the
  // only symptom was a 10-second hook timeout on a test whose assertion had passed.
  const tick = opts?.dispatch === false ? undefined : loop.tick();
  return { loop, history, running, tick, abortCalls: () => session.abort.mock.calls.length };
}

/**
 * Wait for something the RUN produces, never for the tick.
 *
 * `tick()` dispatches fire-and-forget on purpose, so it returns while the run is still
 * going. Asserting straight after it is a race that passes on a fast machine and fails
 * on CI — the worst kind of green.
 */
async function waitUntil(what: string, cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await new Promise(r => setTimeout(r, 5));
  }
}

afterEach(async () => {
  // ⚠ SNAPSHOT all five lists before any waiting. vitest's hook timeout does not
  // cancel the hook body: on a hang it fails the test and moves on while this
  // continues as a zombie, and a zombie that spliced the shared arrays later would
  // close the NEXT test's freshly-registered handles.
  const runs = inFlight.splice(0);
  const toClose = closers.splice(0);
  const toRemove = tmpDirs.splice(0);
  const toRelease = releases.splice(0);
  const toSettle = loops.splice(0);
  for (const release of toRelease) {
    try {
      release();
    } catch (err: unknown) {
      // A release that throws leaves its run computing, and the only remaining signal
      // is the hook timeout, which names the hook and not the reason.
      process.stderr.write(`[test] release failed: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
  try {
    // The turn settling is NOT the end of the run: the loop still has a `catch` that
    // records the outcome and a `finally` that clears the entry, and both touch sqlite.
    // Draining only the turns closed the handle underneath them — four green tests and
    // a non-zero exit with two `The database connection is not open` rejections
    // belonging to no test. `activeTaskCount` reaching zero is that `finally`.
    await Promise.all(runs);
    await waitUntil(
      'the loop to finish recording and release its entry',
      () => toSettle.every(l => l.activeTaskCount === 0),
    );
  } finally {
    for (const c of toClose) c();
    for (const d of toRemove) rmSync(d, { recursive: true, force: true });
  }
});

describe('stopping a running background task', () => {
  it('ends the RUN, and records it as stopped rather than failed', async () => {
    const h = makeHarness();
    await h.running;

    expect(h.loop.stopTask('trg-stop')).toBe('stopped');
    await h.tick;

    // ⛔ THE ASSERTION THAT MATTERS: a value that exists only once the run has settled.
    // With the `session.abort()` call removed from `stopTask`, the turn never rejects,
    // the run never reaches `recordTaskRun`, and this wait times out.
    await waitUntil(
      'the run to be recorded as finished',
      () => h.history.getTrigger('trg-stop')?.last_run_status !== null
         && h.history.getTrigger('trg-stop')?.last_run_status !== undefined,
    );
    const t = h.history.getTrigger('trg-stop')!;
    expect(t.last_run_status).toBe('stopped');
  });

  it('does not falsify the trigger, and does not re-fire it as a retry', async () => {
    const h = makeHarness();
    await h.running;
    const before = h.history.getTrigger('trg-stop')!;

    h.loop.stopTask('trg-stop');
    await h.tick;
    await waitUntil('the stop to be recorded', () => h.history.getTrigger('trg-stop')?.last_run_status === 'stopped');
    const after = h.history.getTrigger('trg-stop')!;

    // ⛔ `failed` and `timeout` both enter the backoff re-fire in `recordTaskRun`. A stop
    // recorded as either would restart the run its owner just stopped — so the retry
    // counter is the load-bearing assertion here, not the status word.
    expect(after.retry_count ?? 0).toBe(before.retry_count ?? 0);
    // And the trigger's own status is not rewritten to a word that is untrue: none of
    // `open | in_progress | completed | failed` describes a run its owner stopped.
    expect(after.status).toBe(before.status);
    // The schedule itself survives: pausing a SCHEDULE is `PATCH {enabled:false}`, and a
    // stop is not that. A cron's next occurrence is still ahead of it.
    expect(after.next_run_at).not.toBe('');
    expect(after.next_run_at).not.toBe(null);
  });

  it('a RETRIABLE one-shot is not re-fired by a stop — the branch a cron cannot reach', async () => {
    // ⛔ This is the assertion the cron fixture could not make. `failed` and `timeout`
    // enter the backoff re-fire; `stopped` must not, or a stop restarts the very run its
    // owner stopped. The trigger here has `max_retries: 2` and no schedule, which is the
    // only shape that executes that branch.
    const h = makeHarness({ retriable: true });
    await h.running;
    const before = h.history.getTrigger('trg-stop')!;
    expect(before.max_retries).toBe(2); // the fixture really is retriable — else this proves nothing

    h.loop.stopTask('trg-stop');
    await h.tick;
    await waitUntil('the stop to be recorded', () => h.history.getTrigger('trg-stop')?.last_run_status === 'stopped');
    const after = h.history.getTrigger('trg-stop')!;

    expect(after.retry_count ?? 0).toBe(before.retry_count ?? 0);
    // A one-shot that was stopped is over: no backoff instant was written for it.
    expect(after.next_run_at ?? '').toBe('');
  });

  it('answers not_running for a task that is not running — the route turns this into 409', () => {
    const h = makeHarness({ dispatch: false });
    expect(h.loop.stopTask('no-such-trigger')).toBe('not_running');
  });

  it('SHUTDOWN does not abort the session — the deadline path stays as it was', async () => {
    // ⛔ This asserts an ABSENCE, and deliberately. Whether the execution deadline should
    // end a computing run is a decision nobody has taken, and the measurement points away
    // from it: 1 of 17 pipeline and 1 of 58 headless runs on one production instance ran
    // past the five-minute default, the longest (15.2 min) SUCCEEDING. So `stop()` and the
    // deadline still abort only the controller, and this test fails the day someone wires
    // the session into either of them without that decision.
    //
    // ⚠ Its positive twin is the first test in this file, on the same machinery: there the
    // same `session.abort` path IS exercised and observed. A negative assertion without
    // one proves only that nothing happened.
    const h = makeHarness();
    await h.running;

    h.loop.stop();
    expect(h.abortCalls()).toBe(0);

    // and the run is still going, because nothing it observes has been aborted
    expect(h.history.getTrigger('trg-stop')?.last_run_status ?? null).toBe(null);
  });
});
