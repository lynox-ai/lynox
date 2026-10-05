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
import { RunAbortedError } from './agent.js';
import { RunHistory } from './run-history.js';
import { EngineDb } from './engine-db.js';
import { PromptStore } from './prompt-store.js';
import { TaskManager } from './task-manager.js';
import type { Engine } from './engine.js';
import type { Session } from './session.js';
import type { NotificationRouter } from './notification-router.js';
import type { TriggerRecord, TriggerEffect, PlannedPipeline } from '../types/index.js';
import { stopHandleOf } from './worker-loop.js';
import { getPipelineStore } from '../tools/builtin/pipeline.js';

/**
 * The saved-workflow runner, gated — the one collaborator a `run_workflow` test has to
 * replace, because `executePipeline` awaits it and nothing else for long enough to ask
 * a question about the run.
 *
 * ⛔ It stands BELOW the claim under test, which is what makes replacing it legitimate:
 * the dispatch case, the entry construction, the autonomous-only gate and the
 * first-run-confirm gate all still run for real. And what the mock RECORDS is the claim
 * itself — the arguments `executePipeline` hands over. A stop handle would have to be
 * among them, and the test asserts that none is. Replacing `executePipeline` would have
 * removed the only thing able to falsify that.
 */
const wf = vi.hoisted(() => ({
  calls: [] as unknown[][],
  signal: undefined as (() => void) | undefined,
  wait: undefined as Promise<void> | undefined,
}));
/**
 * The pinned fetch, gated — so a WATCH run can be caught in the window before its
 * session exists. The watch path awaits this for up to 30 seconds with nothing to
 * abort, and that window is a claim this file has to be able to make.
 *
 * ⚠ Spread over the real module: `network-guard` is imported by other code in this
 * graph, so a bare factory would delete exports nothing here asks for but something
 * there does. And `await undefined` resolves, so with no gate set this is an ordinary
 * immediate fetch for every other test in the file.
 */
const net = vi.hoisted(() => ({
  signal: undefined as (() => void) | undefined,
  wait: undefined as Promise<void> | undefined,
}));
vi.mock('./network-guard.js', async (orig) => ({
  ...(await orig() as Record<string, unknown>),
  fetchPinned: async () => {
    net.signal?.();
    await net.wait;
    return new Response('<p>the page has changed</p>', {
      status: 200, headers: { 'content-type': 'text/html' },
    });
  },
}));
vi.mock('./saved-workflow-runner.js', () => ({
  runGuardedSavedWorkflow: async (...args: unknown[]) => {
    wf.calls.push(args);
    wf.signal?.();
    await wf.wait;
    return { ok: true, status: 'completed', runId: 'wf-run-1' };
  },
}));

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
  /** Resolves once the run is PARKED on its question — `park: true` only. */
  parked: Promise<void>;
  tick: Promise<void> | undefined;
  abortCalls: () => number;
  /** Ends the in-flight turn with a chosen error — for the causes that are NOT an
   *  abort, which is the distinction the recorded word now rests on. */
  failTurn: (err: Error) => void;
  /** Resolves once the watch run is INSIDE its fetch — `watch: true` only. */
  fetching: Promise<void>;
  /** Lets the gated fetch return — `watch: true` only. */
  finishFetch: () => void;
  /** True once a parked turn has come back from its question. */
  resumed: () => boolean;
  /** What the notification router was asked to send — `withChannels` only. */
  notifications: () => Array<{ title: string; body: string; priority?: string; followUps?: Array<{ label: string }> }>;
}

function makeHarness(opts?: { dispatch?: boolean; retriable?: boolean; park?: boolean; abortThrows?: boolean; withChannels?: boolean; watch?: boolean; abortMisses?: boolean }): Harness {
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
  if (opts?.watch === true) {
    history.insertTrigger({
      id: 'trg-stop', title: 'Watch a page', source: 'watch', effect: 'run_agent',
      watchConfig: JSON.stringify({ url: 'https://example.test/p', interval_minutes: 60 }),
      nextRunAt: '2026-01-01T09:00:00.000Z', confirmedAt: '2026-01-01T00:00:00.000Z',
    });
  } else history.insertTrigger(opts?.retriable === true
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
  let signalFetching: () => void;
  const fetching = new Promise<void>(resolve => { signalFetching = resolve; });
  let openFetch: () => void;
  const fetchGate = new Promise<void>(resolve => { openFetch = resolve; });
  if (opts?.watch === true) {
    net.signal = () => signalFetching();
    net.wait = fetchGate;
    // Unconditionally, like every other release in this file: a gate left shut by a
    // failing assertion above it hangs the run until vitest's hook timeout.
    releases.push(() => { openFetch(); net.signal = undefined; net.wait = undefined; });
  }

  let resumed = false;
  const session = {
    sessionId: 'thread-stop',
    _recreateAgent: vi.fn(),
    promptUser: undefined as ((q: string, o?: string[]) => Promise<string>) | undefined,
    // The only thing that ends a COMPUTING run. Aborting the controller does not.
    //
    // ⚠ `abortThrows` models a `Session.abort()` that raises — it reaches into the
    // agent, so it can. The turn is then left to the CONTROLLER, which is the whole
    // point of the test that uses it: a parked run must still come back.
    abort: vi.fn(() => {
      if (opts?.abortThrows === true) throw new Error('abort exploded inside the agent');
      // ⛔ `abortMisses` is the REAL no-op, not a convenience: `Session.abort()` reaches
      // `Agent.send`'s controller, and that controller is null whenever no send is in
      // flight — before the first one, between them, and after the last. The call
      // happens and nothing is cancelled, which is the only way to model the window the
      // route's 202 warns about. Without it this fixture cannot express a stop that was
      // delivered and landed nowhere.
      if (opts?.abortMisses === true) return;
      // ⛔ `RunAbortedError`, not a plain `Error`, because that is what the real chain
      // produces: `Agent.send` throws it from its catch exactly when its controller was
      // aborted. The fake used a plain Error, and that divergence pointed the wrong way
      // — the loop now requires the abort SHAPE before it calls a run the owner's stop,
      // and a fake that cannot produce the shape would have made every one of these
      // tests fail for a reason that is the fake's, not the code's.
      rejectTurn?.(new RunAbortedError());
    }),
    run: vi.fn(async () => {
      // A PARKED run: it asks its question through the loop's own `promptUser` wiring,
      // so `pendingPromptId` is set by the real code path and `waitForSettled` awaits
      // the real controller signal. Nothing here simulates the park.
      if (opts?.park === true) {
        const answer = await session.promptUser!('ready to continue?');
        resumed = true;
        return answer;
      }
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

  // ⚠ `hasChannels` decides whether the loop even composes a notification, so a
  // harness without channels cannot see the suppression bug: the run ends silently
  // either way. The test that needs it turns them on.
  const sent: Array<{ title: string; body: string; priority?: string; followUps?: Array<{ label: string }> }> = [];
  const router = {
    hasChannels: () => opts?.withChannels === true,
    notify: vi.fn((payload: { title: string; body: string; priority?: string; followUps?: Array<{ label: string }> }) => {
      sent.push(payload);
      return Promise.resolve(undefined);
    }),
  } as unknown as NotificationRouter;

  releases.push(() => { rejectTurn?.(new Error('released by teardown')); });

  const loop = new WorkerLoop(engine, router, 60_000);
  loops.push(loop);
  // ⚠ `dispatch: false` for the case that needs NO run — asking about a task that is
  // not running. Starting a run there left a turn nothing would ever settle, and the
  // only symptom was a 10-second hook timeout on a test whose assertion had passed.
  const tick = opts?.dispatch === false ? undefined : loop.tick();
  // Polled, because the park has no event of its own: the row appears inside the
  // loop's `promptUser`, two awaits below the fake's call, and `running` fires before
  // that. Waiting for the ROW is waiting for `pendingPromptId` to exist.
  const parked = opts?.park === true
    ? waitUntil('the run to park on its question', () => prompts.getPending('thread-stop') !== undefined)
    : Promise.resolve();
  return {
    loop, history, running, parked, tick,
    abortCalls: () => session.abort.mock.calls.length,
    failTurn: (err: Error) => { rejectTurn?.(err); },
    fetching,
    finishFetch: () => openFetch(),
    resumed: () => resumed,
    notifications: () => sent,
  };
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
    //
    // ⚠ EXCEPT FOR A TEST THAT CALLED `stop()`, where that last sentence is false:
    // `stop()` clears the map, so the barrier is already satisfied while the turn is
    // unsettled. Probed — 10 repeats produced no closed-handle rejection, so it is
    // latent rather than observed, and the flush below is a BOUND on it, not a proof.
    // The honest reading of this hook: it waits for the loop's bookkeeping in every test
    // that did not shut its loop down, and gives the others a window.
    await Promise.all(runs);
    await waitUntil(
      'the loop to finish recording and release its entry',
      () => toSettle.every(l => l.activeTaskCount === 0),
    );
    await new Promise(r => setTimeout(r, 25));
  } finally {
    for (const c of toClose) c();
    for (const d of toRemove) rmSync(d, { recursive: true, force: true });
  }
});

describe('stopping a running background task', () => {
  it('ends the RUN, and records it as stopped rather than failed', async () => {
    const h = makeHarness();
    await h.running;

    expect(h.loop.stopTask('trg-stop')).toEqual({ kind: 'requested', via: 'session' });
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

    // ⛔ This fixture is a CRON, and the retry branch is unreachable for one: the
    // assertion below therefore pins the counter staying put, not the branch. An earlier
    // comment here called it "the load-bearing assertion", which a mutation round
    // disproved — the mutant that sends a stop INTO the backoff is killed by the next
    // test only, whose one-shot fixture can execute that line. Corrected rather than
    // deleted, because a wrong claim about which assertion carries a test is how a
    // mutant survives a file that looks covered.
    expect(after.retry_count ?? 0).toBe(before.retry_count ?? 0);
    // THE killer here: a recurring trigger's status is derived from its latest run, and
    // a stop is not a failing schedule. Writing `failed` would mark a healthy cron
    // broken because one run was halted.
    expect(after.status).toBe(before.status);
    // The schedule itself survives and MOVES ON: pausing a schedule is
    // `PATCH {enabled:false}` and a stop is not that, so the cron's next occurrence is
    // computed as usual. Asserting merely "not empty" passed for every implementation —
    // the cron branch always writes a timestamp — so the assertion is that it ADVANCED.
    expect(after.next_run_at ?? '').not.toBe('');
    expect(after.next_run_at).not.toBe(before.next_run_at);
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
    expect(h.loop.stopTask('no-such-trigger')).toEqual({ kind: 'not_running' });
  });

  it('SHUTDOWN does not abort the session — the deadline path stays as it was', async () => {
    // ⛔ This asserts an ABSENCE, and deliberately. Whether the execution deadline should
    // end a computing run is a decision nobody has taken, and the measurement points away
    // from it — the production reading is quoted once, at `worker-loop.ts`'s NOTE ON
    // REACH, and not restated here. So `stop()` and the deadline still abort only the
    // controller, and this test fails the day someone wires the session into either of
    // them without that decision.
    //
    // ⚠ Its positive twin is the first test in this file, on the same machinery: there the
    // same `session.abort` path IS exercised and observed. A negative assertion without
    // one proves only that nothing happened.
    const h = makeHarness();
    await h.running;

    h.loop.stop();
    expect(h.abortCalls()).toBe(0);

    // ⚠ A BOUNDED WINDOW, not a read on the next statement. This assertion used to run
    // one line after `stop()`, where no implementation could have recorded anything yet
    // — so it passed just as well against a `stop()` that DID abort the session. An
    // absence has no event to wait for, so the honest form is a window inside which the
    // recording would have happened: in the first test of this file the same rejection
    // reaches `recordTaskRun` through four awaits, well under this.
    await new Promise(r => setTimeout(r, 50));
    expect(h.abortCalls()).toBe(0);
    expect(h.history.getTrigger('trg-stop')?.last_run_status ?? null).toBe(null);
  });

  it('a SHUTDOWN racing the stop does not turn it back into a RETRIED FAILURE', async () => {
    // ⛔ The owner's next move after stopping a runaway task is to restart the
    // container, so this race is the normal case rather than a corner. `stop()` CLEARS
    // the map, and the stopped run's error is still unwinding — in the real system
    // through `Session.run`'s own catch, which awaits a dynamic import, a run update,
    // the after-run hook loop and a totals rollup before it rethrows.
    //
    // Read `stopRequested` through a fresh `activeTasks.get()` and the miss reads as
    // "not stopped": status `failed`, into the backoff branch, and the run the owner
    // stopped RESTARTS. The fixture is the retriable one-shot because that is the only
    // shape whose retry branch can execute.
    const h = makeHarness({ retriable: true });
    await h.running;

    h.loop.stopTask('trg-stop');
    h.loop.stop();
    await h.tick;

    await waitUntil(
      'the stopped run to be recorded after the shutdown',
      () => (h.history.getTrigger('trg-stop')?.last_run_status ?? null) !== null,
    );
    const after = h.history.getTrigger('trg-stop')!;
    expect(after.last_run_status).toBe('stopped');
    expect(after.retry_count ?? 0).toBe(0);
    expect(after.next_run_at ?? '').toBe('');
  });

  it('a stopped retriable one-shot is NOT retried and NOT silent', async () => {
    // ⛔ Two outcomes that used to disagree. `willRetry` was computed from the retry
    // counters alone, so after a stop it still read "it will try again" — while
    // `recordTaskRun` sends only `failed` and `timeout` into the backoff. Its SECOND
    // job is to suppress the failure notification, so the run ended in total silence:
    // no retry, and no word to the owner that nothing would happen again.
    const h = makeHarness({ retriable: true, withChannels: true });
    await h.running;

    h.loop.stopTask('trg-stop');
    await h.tick;

    await waitUntil('the owner to be told', () => h.notifications().length > 0);
    const note = h.notifications()[0]!;
    // And it says the right thing: "Explain why this failed" is the wrong offer for a
    // run that did what it was told.
    expect(note.body).toContain('Stopped on your instruction');
    expect(note.body).not.toContain('Task failed');
    expect(note.title).not.toContain('\u2717');
    // The shape too, because it is chosen and was pinned by nothing: a stop is not
    // high-priority news for the person who just asked for it, and "Explain why this
    // failed" is the wrong offer for a run that did what it was told.
    expect(note.priority).toBe('normal');
    expect(note.followUps?.map(f => f.label)).toEqual(['Run again']);
    expect((h.history.getTrigger('trg-stop')?.retry_count ?? 0)).toBe(0);
  });

  it('a stop that MISSED has no effect — a later provider failure stays the run\'s own', async () => {
    // ⛔ THE CASE THE FLAG ALONE GOT WRONG, and it is not a corner: `Session.abort()`
    // reaches `Agent.send`'s controller, which exists only while a send is in flight, so
    // a stop between sends lands nowhere. Nothing clears the flag afterwards. The run
    // then failed twenty minutes later on a provider error and was recorded as the
    // owner's stop: the model was told "STOPPED BY ITS OWNER: <provider error>", and the
    // retry it was owed was suppressed.
    //
    // The fixture: the harness's fake rejects with the ERROR SHAPE of the thing that
    // actually happened — a provider failure, not an abort — while `stopRequested` is
    // set. A stop request that never arrived has no effect, which is exactly what the
    // route's 202 says it is.
    const h = makeHarness({ retriable: true, withChannels: true, abortMisses: true });
    await h.running;

    h.loop.stopTask('trg-stop');
    // The abort was delivered and reached nothing; the run carries on and dies of its
    // own cause. The ERROR SHAPE is what tells the two apart.
    h.failTurn(new Error('Overloaded: the provider is at capacity'));
    await h.tick;

    await waitUntil('the run to be recorded', () => (h.history.getTrigger('trg-stop')?.last_run_status ?? null) !== null);
    const after = h.history.getTrigger('trg-stop')!;
    expect(after.last_run_status).toBe('failed');
    // …and the retry it was owed really happens: this is the half that silently went
    // missing, because `willRetry` keys on the status word.
    expect(after.retry_count ?? 0).toBe(1);
    expect(after.next_run_at ?? '').not.toBe('');
    // No notification: a run that will try again does not report a final failure, and
    // calling it a stop would have reported one in the owner's name.
    expect(h.notifications()).toHaveLength(0);
  });

  it('a PARKED run is stopped through its WAIT — the one handle that certainly ends', async () => {
    const h = makeHarness({ park: true });
    await h.parked;

    // `wait` outranks `session` even though both are present: `waitForSettled` awaits
    // this controller's signal, so the abort ENDS the wait, while `session.abort()`
    // reaches a null agent controller whenever no model call is in flight.
    expect(h.loop.stopTask('trg-stop')).toEqual({ kind: 'requested', via: 'wait' });

    // ⛔ THE ASSERTION: the park is over. Remove the `controller.abort()` from
    // `stopTask` and the turn waits for its answer until the 24-hour TTL.
    await waitUntil('the parked turn to come back', () => h.resumed());

    // …and it is RECORDED as the owner's stop, which is the standard this file's header
    // sets and these two tests did not meet. A parked run's stop throws NO error — the
    // question is dismissed and the turn finishes — so it is recorded on a different
    // path from the one the catch takes, and that path had to learn the word separately.
    // Without it a stopped parked run read `failed` and was re-fired by the backoff.
    await h.tick;
    await waitUntil('the stop to be recorded',
      () => (h.history.getTrigger('trg-stop')?.last_run_status ?? null) !== null);
    expect(h.history.getTrigger('trg-stop')?.last_run_status).toBe('stopped');
  });

  it('a session whose abort THROWS still has its controller aborted, and still answers', async () => {
    // ⛔ The mutation this exists for: `stopTask` used to let a throwing
    // `Session.abort()` propagate, which skipped the controller abort AND answered the
    // owner 500 — for a stop that would have landed on the wait. No test made the abort
    // throw, so the ⚠ comment at the call site was certified by nothing.
    const h = makeHarness({ park: true, abortThrows: true });
    await h.parked;

    expect(h.loop.stopTask('trg-stop')).toEqual({ kind: 'requested', via: 'wait' });
    await waitUntil('the parked turn to come back despite the throwing abort', () => h.resumed());
  });
});

/** A deferred the test holds open, so a REAL handler can be caught mid-run. */
function gate(): { wait: Promise<void>; open: () => void } {
  let openIt: () => void;
  const wait = new Promise<void>(resolve => { openIt = resolve; });
  return { wait, open: () => openIt() };
}

interface ClassHarness {
  loop: WorkerLoop;
  /** Resolves once the handler is INSIDE the gate — the run is really in flight. */
  running: Promise<void>;
  tick: Promise<void>;
  /** How many sessions the run created. The no-handle claim is false if this is > 0. */
  sessionCreations: () => number;
  /** Lets the paused handler continue, so its real OUTCOME can be observed. */
  release: () => void;
  /** Every `recordTaskRun` the run made, as [id, result, status]. */
  records: () => Array<[string, string, string]>;
  /** Every halt reason written to the bulk ledger. */
  halts: () => string[];
  /** Every `updateTrigger` the handler made — a re-arm is what must NOT happen. */
  reArms: () => unknown[];
}

/**
 * One run of ONE effect, held inside its real handler so a stop can be asked about it.
 *
 * ⛔ WHERE IT PAUSES, and why that is not a fake of the subject. The pause is always a
 * collaborator the stop handle does not pass through — the notification router, the
 * backup manager, the external-client factory, the workflow runner. Everything the claim
 * is about runs for real: the dispatch switch that builds the entry, the case clause that
 * does or does not hand over `controller.signal`, and the handler's own head down to the
 * pause. If a handler DID create a session, `sessionCreations` sees it; pausing the
 * HANDLER instead would have removed the only witness that could say so.
 *
 * ⛔ AND IT USES A FAKE TaskManager DELIBERATELY. These tests assert what a stop REACHES,
 * which is a property of the live entry and needs no database. The tests above, whose
 * subject is what gets RECORDED, use a real one — that is the observable there, and the
 * two are not interchangeable.
 */
function makeClassHarness(opts: {
  effect: TriggerEffect;
  source?: string;
  pauseAt: 'notify' | 'backup' | 'bulkClient' | 'workflow';
  record?: Partial<TriggerRecord>;
  /** A ledger whose run really is previewable, so `runBulkPreview` is entered. */
  previewReady?: boolean;
  /** The paused collaborator throws after release — for the run that ends on its OWN
   *  cause while a stop is outstanding. */
  failAfterRelease?: boolean;
}): ClassHarness {
  const g = gate();
  releases.push(g.open);
  let signalRunning: () => void;
  const running = new Promise<void>(resolve => { signalRunning = resolve; });
  const hold = async <T>(value: T): Promise<T> => {
    signalRunning();
    await g.wait;
    if (opts.failAfterRelease === true) throw new Error('the handler failed on its own');
    return value;
  };

  const task = {
    id: 'trg-class', title: 'A run of its own kind', description: '',
    status: 'open', assignee: 'lynox', scope_type: 'context', scope_id: '',
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
    next_run_at: '2026-01-01T09:00:00.000Z',
    source: opts.source ?? 'cron',
    effect: opts.effect,
    confirmed_at: '2026-01-01T00:00:00.000Z',
    ...opts.record,
  } as unknown as TriggerRecord;

  const records: Array<[string, string, string]> = [];
  const manager = {
    getDueTriggers: () => [task],
    getExpiredWaitingTriggers: () => [],
    endWait: () => false,
    claimLease: () => 'claimed',
    renewLease: () => true,
    releaseLease: () => { /* no lease store in this harness */ },
    getTrigger: (id: string) => (task.id === id || task.id.startsWith(id) ? task : undefined),
    // Recorded, not discarded: for the effects whose handler ENDS inside this harness
    // (a stopped preview, a run that fails on its own) the status word is the subject.
    recordTaskRun: (id: string, result: string, status: string) => { records.push([id, result, status]); },
    setEnabled: () => true,
  } as unknown as TaskManager;

  if (opts.pauseAt === 'workflow') {
    // The planned workflow the two gates read, placed in the module cache rather than
    // the database: `getPipeline` checks the cache first, and a trigger inserted through
    // the store would have its `target_workflow_id` nulled by an FK it cannot satisfy
    // here. Removed again in teardown — module-level state outlives a test.
    getPipelineStore().set('wf-1', {
      id: 'wf-1', mode: 'autonomous', confirmedAt: '2026-01-01T00:00:00.000Z', steps: [],
    } as unknown as PlannedPipeline);
    releases.push(() => { getPipelineStore().delete('wf-1'); });
    wf.calls.length = 0;
    wf.signal = () => signalRunning();
    wf.wait = g.wait;
  }
  if (opts.pauseAt === 'bulkClient') {
    // The external-client factory: three dynamic imports and a few store reads, and
    // nothing to do with a stop handle. Both bulk handlers await it before their own
    // work, which makes it the pause point that leaves the most of them real.
    const proto = WorkerLoop.prototype as unknown as { bulkClientFactory: () => Promise<unknown> };
    // A truthy client when the preview must really run: `runBulkPreview` halts on a null
    // one before it ever reaches its signal check, which would have made the test pass
    // against a handler that still snoozed.
    const spy = vi.spyOn(proto, 'bulkClientFactory')
      .mockImplementation(() => hold(opts.previewReady === true ? () => ({}) : () => null));
    releases.push(() => { spy.mockRestore(); });
  }

  const halts: string[] = [];
  const reArms: unknown[] = [];
  const previewRun = {
    targetSystem: 'http://example.test/orders', kind: 'apply', phase: 'planned',
    haltReason: null, contractJson: null,
  };
  const sessions: number[] = [];
  const engine = {
    getTaskManager: () => manager,
    getRunHistory: () => ({
      getTrigger: () => task,
      updateTrigger: (_id: string, patch: unknown) => { reArms.push(patch); },
    }),
    getUserConfig: () => ({}),
    escalateToUser: () => null,
    getPromptStore: () => null,
    getSecretStore: () => null,
    getDataStore: () => null,
    getApiStore: () => null,
    getToolContext: () => null,
    getBackupManager: () => (opts.pauseAt === 'backup'
      ? { createBackup: () => hold({ success: true, path: '/tmp/none.db', duration_ms: 1 }), pruneBackups: () => { /* noop */ } }
      : null),
    getBulkLedger: () => (opts.pauseAt === 'bulkClient'
      ? {
        getRunForApply: () => ({ targetSystem: 'http://example.test' }),
        // `undefined` keeps `runBulkPreview` out (it refuses an unknown run); the ready
        // variant is what carries a test INTO it, which is where the stop is decided.
        getRunForPreview: () => (opts.previewReady === true ? previewRun : undefined),
        listUnread: () => [1],
        getStatus: () => undefined,
        haltPreview: (_id: string, reason: string) => { halts.push(reason); },
      }
      : null),
    // A WITNESS, not a stub: every effect in this harness is claimed to create no
    // session, so a creation here is the claim failing rather than the test needing one.
    createSession: () => {
      sessions.push(1);
      return { run: () => hold('unexpected'), abort: () => { /* noop */ }, _recreateAgent: () => { /* noop */ } } as unknown as Session;
    },
  } as unknown as Engine;

  const router = {
    hasChannels: () => false,
    notify: () => (opts.pauseAt === 'notify' ? hold(undefined) : Promise.resolve(undefined)),
  } as unknown as NotificationRouter;

  const loop = new WorkerLoop(engine, router, 60_000);
  loops.push(loop);
  return {
    loop, running, tick: loop.tick(),
    sessionCreations: () => sessions.length,
    release: () => { g.open(); },
    records: () => records,
    halts: () => halts,
    reArms: () => reArms,
  };
}

describe('what a stop can reach — one case per effect class', () => {
  it('a REMINDER run has nothing to interrupt, and the stop SAYS so', async () => {
    const h = makeClassHarness({ effect: 'notify', pauseAt: 'notify' });
    await h.running;
    expect(h.loop.stopTask('trg-class')).toEqual({ kind: 'unstoppable', effect: 'notify' });
    expect(h.sessionCreations()).toBe(0);
  });

  it('a BACKUP run likewise — the owner is told, not answered 200', async () => {
    const h = makeClassHarness({ effect: 'backup', pauseAt: 'backup' });
    await h.running;
    expect(h.loop.stopTask('trg-class')).toEqual({ kind: 'unstoppable', effect: 'backup' });
    expect(h.sessionCreations()).toBe(0);
  });

  it('a BULK WRITE cannot be interrupted — the case where a false 200 lets it keep writing', async () => {
    // ⛔ The worst of the seven to answer wrongly: `bulk_apply` writes its targets, so
    // `{stopped:true}` over a run that carries on is not a cosmetic lie — the owner stops
    // watching a write they asked to end.
    //
    // ⚠ TWO LIMITS, stated rather than implied. This pauses at the client factory, which
    // `executeBulk` awaits BEFORE its write loop — so `sessionCreations()` witnesses "no
    // session before the pause", not "none in the whole run"; threading a signal into
    // `executeBulk` later would leave this green while the comment above it went stale.
    // And `bulk_undo` has no case of its own because it rides this same case clause: a
    // twin would pin one line twice.
    const h = makeClassHarness({ effect: 'bulk_apply', pauseAt: 'bulkClient', record: { bulk_run_id: 'bulk-1' } });
    await h.running;
    expect(h.loop.stopTask('trg-class')).toEqual({ kind: 'unstoppable', effect: 'bulk_apply' });
    expect(h.sessionCreations()).toBe(0);
  });

  it('a stopped BULK PREVIEW is HALTED, not snoozed for 30 seconds and recorded a success', async () => {
    // ⛔ THE WORST OUTCOME THE 202 COULD HAVE, and it was the only effect that answers
    // `via: 'signal'`. `runBulkPreview` reads an aborted signal as a PAUSE and returns
    // `pending(now + 30s)`; the handler's pending branch then recorded `success` and
    // re-armed the trigger. So the one stop the route called delivered bought a
    // half-minute snooze, told the ledger the run succeeded, and restarted the read —
    // with no error thrown, so none of the stop machinery downstream ever saw it.
    //
    // Driven all the way INTO `runBulkPreview` (the previous case stops before it), so
    // the assertion is the handler's real outcome and not the route's answer.
    const h = makeClassHarness({
      effect: 'bulk_preview', pauseAt: 'bulkClient', previewReady: true,
      record: { bulk_run_id: 'bulk-1' },
    });
    await h.running;
    expect(h.loop.stopTask('trg-class')).toEqual({ kind: 'requested', via: 'signal' });
    h.release();

    await waitUntil('the preview to settle', () => h.records().length > 0);
    expect(h.records()[0]?.[2], 'a stop is not a success').toBe('stopped');
    // The state the owner resumes from, rather than one that resumes itself.
    expect(h.halts()).toEqual(['the owner stopped the run']);
    expect(h.reArms(), 'nothing re-armed the trigger it just stopped').toHaveLength(0);
  });

  it('a BULK PREVIEW is stoppable through its SIGNAL — the one handler that polls it', async () => {
    // One case clause apart from the write above, and the opposite answer: the preview
    // is handed `controller.signal` and `runBulkPreview` checks it between targets. This
    // is the test that kills the `readsSignal` line — without it the preview reports
    // `unstoppable` and an owner is told to wait out a read that would have stopped.
    const h = makeClassHarness({ effect: 'bulk_preview', pauseAt: 'bulkClient', record: { bulk_run_id: 'bulk-1' } });
    await h.running;
    expect(h.loop.stopTask('trg-class')).toEqual({ kind: 'requested', via: 'signal' });
  });

  it('a SAVED WORKFLOW run has no handle at all — and is handed nothing that could become one', async () => {
    const h = makeClassHarness({ effect: 'run_workflow', pauseAt: 'workflow', record: { pipeline_id: 'wf-1' } });
    await h.running;
    expect(h.loop.stopTask('trg-class')).toEqual({ kind: 'unstoppable', effect: 'run_workflow' });

    // ⛔ THE POSITIVE HALF, and the reason this test mocks the runner rather than the
    // handler: it is not merely that nothing was ATTACHED — nothing was PASSED. Three
    // arguments, none of them a signal; a fix that threads one in changes this
    // assertion, which is where the next reader will find the gap named.
    expect(wf.calls).toHaveLength(1);
    expect(wf.calls[0]).toHaveLength(3);
    expect(wf.calls[0]!.some(a => a instanceof AbortSignal)).toBe(false);
    expect(JSON.stringify(wf.calls[0]![2] ?? null)).not.toContain('signal');
    expect(h.sessionCreations()).toBe(0);
  });

  it('a WATCH run is unstoppable while it FETCHES and stoppable once it analyses', async () => {
    // ⛔ Two answers for one effect, which is why the question is per PHASE and not per
    // effect name. Everything before the analysis session — the config parse, a fetch
    // with a 30-second ceiling, the body read, the hash compare — runs with nothing to
    // abort. Telling the owner "stopped" there would be the same false success as for a
    // bulk write, only harder to notice because the same task is stoppable a moment
    // later.
    const h = makeHarness({ watch: true });
    await h.fetching;
    expect(h.loop.stopTask('trg-stop')).toEqual({ kind: 'unstoppable', effect: 'run_agent' });
    // …and the refusal changed nothing: the run is still going.
    expect(h.abortCalls()).toBe(0);

    h.finishFetch();
    await h.running;

    // ⛔ THE SECOND HALF, and the mutant it exists for: delete the `attachSession` call
    // in `executeWatch` and the watch path keeps NO stop handle at all — every answer
    // here stays `unstoppable` and nobody notices, because the only other test of this
    // path is the standard one.
    expect(h.loop.stopTask('trg-stop')).toEqual({ kind: 'requested', via: 'session' });
    await waitUntil(
      'the watch analysis to end as a stop',
      () => h.history.getTrigger('trg-stop')?.last_run_status === 'stopped',
    );
  });

  it('an UNSTOPPABLE run that later fails on its own is recorded as a failure, and retries', async () => {
    // ⛔ THE PROMISE OF THE `unstoppable` BRANCH — "report that, and change NOTHING" —
    // was pinned by no test: a mutant that set `stopRequested` there survived the whole
    // suite. What it would cost is exactly what the branch's comment describes: the
    // run's own ending stamped as the owner's stop, its retry suppressed, and its
    // notification relabelled, for a stop that by definition reached nothing.
    const h = makeClassHarness({
      effect: 'notify', pauseAt: 'notify', failAfterRelease: true,
      record: { max_retries: 2 },
    });
    await h.running;
    expect(h.loop.stopTask('trg-class')).toEqual({ kind: 'unstoppable', effect: 'notify' });
    h.release();

    await waitUntil('the run to be recorded', () => h.records().length > 0);
    expect(h.records()[0]?.[2]).toBe('failed');
  });

  it('stopHandleOf prefers the CERTAIN handle and reports none when there is none', () => {
    // The route's decision function, in isolation. The precedence is the claim: a parked
    // run has a session too, and reporting `session` for it would call the one certain
    // handle by the name of the uncertain one.
    const base = {
      controller: new AbortController(),
      effect: 'run_agent',
      pauseDeadline: (): void => { /* noop */ },
      resumeDeadline: (): void => { /* noop */ },
    };
    const someSession = {} as unknown as Session;
    expect(stopHandleOf({ ...base })).toBeUndefined();
    expect(stopHandleOf({ ...base, readsSignal: true })).toBe('signal');
    expect(stopHandleOf({ ...base, session: someSession })).toBe('session');
    expect(stopHandleOf({ ...base, pendingPromptId: 'p-1' })).toBe('wait');
    expect(stopHandleOf({ ...base, session: someSession, readsSignal: true })).toBe('session');
    expect(stopHandleOf({ ...base, session: someSession, pendingPromptId: 'p-1', readsSignal: true })).toBe('wait');
  });
});
