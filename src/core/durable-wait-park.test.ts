import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkerLoop } from './worker-loop.js';
import { RunHistory } from './run-history.js';
import { EngineDb } from './engine-db.js';
import { PromptStore } from './prompt-store.js';
import { TaskManager } from './task-manager.js';
import type { Engine } from './engine.js';
import type { Session } from './session.js';
import type { NotificationRouter } from './notification-router.js';

/**
 * THE PARK, driven through the real wiring (PRD-DURABLE-WAIT-STATE §0, wave 2).
 *
 * Everything here goes through `WorkerLoop.executeStandard` → the real
 * `session.promptUser` closure → a real `PromptStore` and `RunHistory`. Nothing
 * hands the park in: the only stub is the Session's `run`, which is what a real
 * agent turn would be, and it calls `promptUser` exactly as an `ask_user` tool
 * call does. A test that wrote the parked row itself would prove the store
 * works and say nothing about whether anything ever calls it.
 */
describe('durable wait state — the park (§0 T1/T2/A5/A6/A8/A11/A12)', () => {
  const tmpDirs: string[] = [];
  const closers: Array<() => void> = [];
  /** Every session-run promise a harness started, drained before teardown. */
  const inFlight: Array<Promise<unknown>> = [];
  /** Releases whatever question a harness's run is parked on, so teardown can
   *  drain it. Registered by the harness, called unconditionally in `afterEach`
   *  — a test body's own release would be SKIPPED by a failing assertion above
   *  it, and the run would then hang until vitest's hook timeout, turning one
   *  clear assertion failure into that failure plus a 10s timeout. */
  const releases: Array<() => void> = [];

  interface Harness {
    loop: WorkerLoop;
    history: RunHistory;
    prompts: PromptStore;
    manager: TaskManager;
    /** Resolves once the run has actually reached `promptUser` and parked. */
    parked: Promise<void>;
    /** The prompt id the run raised, once it has. */
    promptIdOf: () => string | undefined;
    run: Promise<void>;
    /** How many agent turns the loop has dispatched for this trigger. */
    dispatches: () => number;
  }

  /** A worker loop whose single trigger's run asks one question and waits.
   *
   *  `doctorExpiry` replaces the deadline the prompt row reports, and it is the
   *  only way to tell "read the row back" apart from "compute 24h yourself":
   *  both produce the same instant to the millisecond, so an equality assertion
   *  between them passes either way. A value no clock would produce does not. */
  function makeHarness(opts?: { doctorExpiry?: string; unreadableRow?: boolean }): Harness {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-park-'));
    tmpDirs.push(dir);
    const history = new RunHistory(join(dir, 'history.db'));
    const engineDb = new EngineDb(join(dir, 'engine.db'));
    history.setVerbGraph(engineDb);
    closers.push(() => { try { history.close(); } catch { /* twice is fine */ } });
    closers.push(() => { try { engineDb.close(); } catch { /* twice is fine */ } });
    const prompts = new PromptStore(history.getDb());
    const manager = new TaskManager(history);

    history.insertTrigger({
      id: 'trg-1', title: 'Daily report', source: 'cron', effect: 'run_agent',
      scheduleCron: '0 9 * * *', nextRunAt: '2026-01-01T09:00:00.000Z',
      confirmedAt: '2026-01-01T00:00:00.000Z',
    });

    let promptId: string | undefined;
    let signalParked: () => void;
    const parked = new Promise<void>(resolve => { signalParked = resolve; });

    const session = {
      sessionId: 'thread-park',
      _recreateAgent: vi.fn(),
      promptUser: undefined as ((q: string, o?: string[]) => Promise<string>) | undefined,
      run: vi.fn(async () => {
        // The agent turn: one `ask_user`, then whatever the answer was.
        const answering = session.promptUser!('Which client?', ['Acme', 'Globex']);
        // Give the closure a turn to insert + park before the test looks.
        await new Promise(r => setImmediate(r));
        promptId = prompts.getPending('thread-park')?.id;
        signalParked();
        return `answered: ${await answering}`;
      }),
    };

    const engine = {
      getTaskManager: () => manager,
      createSession: () => session as unknown as Session,
      getPromptStore: () => prompts,
      getRunHistory: () => history,
      getUserConfig: () => ({}),
      escalateToUser: () => null,
    } as unknown as Engine;

    const router = {
      hasChannels: () => false,
      notify: vi.fn().mockResolvedValue(undefined),
    } as unknown as NotificationRouter;

    if (opts?.unreadableRow === true) {
      // The park reads the row back to learn its deadline. If that read yields
      // nothing there is no deadline to park against — and a trigger parked
      // without one is invisible to the sweep, i.e. it would wait forever.
      // ONCE, and only for the park's own read-back. Mocking it for every call
      // also breaks `waitForSettled`, which resolves at once against a row it
      // cannot see — the run then resumes and its `finally` un-parks, so the
      // test observes the state AFTER the whole cycle and cannot tell "never
      // parked" from "parked and immediately released". Measured: the mutation
      // that deletes this branch survived exactly that version of the test.
      const realGetById = prompts.getById.bind(prompts);
      vi.spyOn(prompts, 'getById')
        .mockImplementationOnce(() => undefined)
        .mockImplementation((id: string) => realGetById(id));
    }
    if (opts?.doctorExpiry !== undefined) {
      const doctored = opts.doctorExpiry;
      const real = prompts.getById.bind(prompts);
      vi.spyOn(prompts, 'getById').mockImplementation((id: string) => {
        const row = real(id);
        return row === undefined ? undefined : { ...row, expires_at: doctored };
      });
    }

    releases.push(() => {
      const pending = prompts.getPending('thread-park');
      if (pending) prompts.expirePrompt(pending.id);
    });

    const loop = new WorkerLoop(engine, router, 60_000);
    const run = loop.tick();
    // The run mock's returned promise is exactly what `executeStandard` awaits,
    // so draining it drains the whole post-run chain (un-park, recordTaskRun).
    void run.then(() => {
      const last = session.run.mock.results.at(-1);
      if (last?.type === 'return') inFlight.push(Promise.resolve(last.value));
    });
    return {
      loop, history, prompts, manager, parked, run,
      promptIdOf: () => promptId,
      dispatches: () => session.run.mock.calls.length,
    };
  }

  /**
   * Wait for a condition the RUN produces, not for the tick.
   *
   * `tick()` dispatches fire-and-forget on purpose — it must not block on one
   * slow trigger — so `await loop.tick()` returns while the run is still going.
   * Asserting post-run state straight after it is a race that passes on a fast
   * machine and fails on CI, which is the worst kind of green.
   */
  async function waitUntil(what: string, cond: () => boolean, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!cond()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
      await new Promise(r => setTimeout(r, 5));
    }
  }

  afterEach(async () => {
    // Drain BEFORE closing. `tick()` dispatches fire-and-forget, so a run can
    // still be inside `recordTaskRun` when a test body ends, and closing the
    // sqlite handle under it raises an unhandled rejection belonging to no test:
    // a non-zero exit with every test reported green.
    //
    // `Promise.all`, no race, no budget of our own — and that is the third shape
    // this drain has had. A hand-rolled race has to pick a number, and both
    // numbers were wrong in different ways: resolving the timeout to `[]` made
    // the assertion behind it pass trivially in exactly the case it existed for,
    // and resolving it to a sentinel at 10s tied vitest's own `hookTimeout`, so
    // the generic "Hook timed out" won the race and the diagnostic never
    // printed. Waiting plainly delegates the deadline to the runner, which
    // already owns one and names the hook when it fires. `all` rather than
    // `allSettled` for the same reason: a rejected run should surface with its
    // own reason, not be counted and re-asserted.
    //
    // Cleanup goes in `finally`. It sat after the assertion, so a drain that
    // failed skipped it — leaving a live handle for the NEXT test's teardown to
    // close under, which is the exact hazard this block exists to prevent, just
    // moved onto an unrelated test.
    // All four lists — runs, closers, temp dirs and releases — are SNAPSHOTTED
    // before the wait, not spliced inside the
    // `finally`. vitest's hook timeout does not cancel the hook body: on a hang
    // it fails the test and moves on while this continues as a zombie, and a
    // zombie that spliced the shared arrays later would close the NEXT test's
    // freshly-registered handles. Taking the snapshot up front means it can only
    // ever clean up its own.
    const runs = inFlight.splice(0);
    const toClose = closers.splice(0);
    const toRemove = tmpDirs.splice(0);
    for (const release of releases.splice(0)) {
      try {
        release();
      } catch (err: unknown) {
        // Narrow enough to be worth a line: a release that throws leaves its run
        // parked, and the only remaining signal is the hook timeout ten seconds
        // later, which names the hook and not the reason. Mirrors the production
        // teardown in worker-loop.ts, which logs for the same reason.
        process.stderr.write(`[test] release failed: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
    try {
      await Promise.all(runs);
    } finally {
      for (const c of toClose) c();
      for (const dir of toRemove) rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── T2 / A8 / A11: what the park writes ──────────────────────────────────

  it('T2 — the prompt row carries the trigger that raised it', async () => {
    const h = makeHarness();
    await h.parked;
    const row = h.prompts.getById(h.promptIdOf()!);

    expect(row?.trigger_id).toBe('trg-1');

    h.prompts.answerUser(h.promptIdOf()!, 'Acme');
    await h.run;
  });

  it('A8/A11 — the deadline is the prompt row\'s own, read back rather than recomputed', async () => {
    // The requirement is ONE source. Asserting `waiting_until === row.expires_at`
    // looks like it proves that and does not: a park that computed its own 24h
    // lands in the same millisecond as the insert, so the equality holds under
    // both implementations — measured, the mutation survived it.
    //
    // A deadline no clock would produce is the discriminator. If the park reads
    // the row, this is what it writes; if it computes, it cannot be.
    const DOCTORED = '2031-03-03T03:03:03.000Z';
    const h = makeHarness({ doctorExpiry: DOCTORED });
    await h.parked;
    const trigger = h.history.getTrigger('trg-1');

    expect(trigger?.status).toBe('waiting');
    expect(trigger?.waiting_until).toBe(DOCTORED);

    h.prompts.answerUser(h.promptIdOf()!, 'Acme');
    await h.run;
  });

  it('a parked trigger is not due, and the sweep can see it', async () => {
    const h = makeHarness();
    await h.parked;

    expect(h.manager.getDueTriggers().map(t => t.id)).not.toContain('trg-1');
    // Its deadline is 24h out, so it is parked but not yet expired.
    expect(h.manager.getExpiredWaitingTriggers()).toEqual([]);
    const far = new Date(Date.now() + 48 * 3600_000).toISOString();
    expect(h.manager.getExpiredWaitingTriggers(far).map(t => t.id)).toEqual(['trg-1']);

    h.prompts.answerUser(h.promptIdOf()!, 'Acme');
    await h.run;
  });

  it('does NOT park when the deadline cannot be read back', async () => {
    // The safe direction, and the branch a mutation would otherwise walk right
    // past. Not parking degrades to the in-memory wait this slice replaced — the
    // run still blocks on its question — whereas parking without a deadline
    // creates a trigger no sweep can ever collect.
    const h = makeHarness({ unreadableRow: true });
    await h.parked;

    expect(h.history.getTrigger('trg-1')?.status).not.toBe('waiting');
    expect(h.history.getTrigger('trg-1')?.waiting_until).toBeUndefined();
    expect(h.manager.getExpiredWaitingTriggers('2099-01-01T00:00:00.000Z')).toEqual([]);

    // and the run is still genuinely waiting — not parked is not the same as
    // not waiting, which is the whole point of the fallback.
    expect(h.prompts.getPending('thread-park')?.status).toBe('pending');
    h.prompts.answerUser(h.promptIdOf()!, 'Acme');
    await h.run;
  });

  // ── A6: the wait ends, once ──────────────────────────────────────────────

  it('A6 — an answer ends the wait and the trigger is due-able again', async () => {
    const h = makeHarness();
    await h.parked;
    expect(h.history.getTrigger('trg-1')?.status).toBe('waiting');

    h.prompts.answerUser(h.promptIdOf()!, 'Acme');
    await h.run;
    await waitUntil('the run to un-park', () => h.history.getTrigger('trg-1')?.status !== 'waiting');

    const after = h.history.getTrigger('trg-1');
    expect(after?.status).not.toBe('waiting');
    expect(after?.waiting_until).toBeUndefined();
  });

  it('A6 — endWait takes exactly once; the loser reports false', async () => {
    const h = makeHarness();
    await h.parked;

    expect(h.manager.endWait('trg-1', 'failed')).toBe(true);
    expect(h.manager.endWait('trg-1', 'open')).toBe(false);   // the sweep and the run both fire
    expect(h.history.getTrigger('trg-1')?.status).toBe('failed');

    h.prompts.answerUser(h.promptIdOf()!, 'Acme');
    await h.run;
  });

  it('a status write from OUTSIDE takes the deadline with it', async () => {
    // `endWait` is the only CONDITIONAL way out of `waiting`, not the only way.
    // `TaskManager.complete()` and `.update()` write a status unconditionally and
    // cannot pass a deadline, so before this the row was left `completed` WITH a
    // `waiting_until` — two columns disagreeing about whether it is parked.
    // Found by review after the PR body claimed the opposite.
    const h = makeHarness();
    await h.parked;
    expect(h.history.getTrigger('trg-1')?.waiting_until).toBeDefined(); // fixture guard

    h.manager.complete('trg-1');

    const after = h.history.getTrigger('trg-1');
    expect(after?.status).toBe('completed');
    expect(after?.waiting_until).toBeUndefined();

    h.prompts.answerUser(h.promptIdOf()!, 'Acme');
    await h.run;
  });

  it('a terminal status WINS over a deadline supplied in the same write', async () => {
    // The combination no caller makes today and the type has always allowed.
    // Expressed as a second `waiting_until = NULL` in the status branch it
    // produced `SET waiting_until = NULL, waiting_until = ?`, and SQLite applies
    // the textually last clause — so the clear lost and the row came out
    // `completed` WITH a deadline. The invariant held only because nobody
    // combined them.
    const h = makeHarness();
    await h.parked;

    h.history.updateTrigger('trg-1', { status: 'completed', waitingUntil: '2030-01-01T00:00:00.000Z' });

    const after = h.history.getTrigger('trg-1');
    expect(after?.status).toBe('completed');
    expect(after?.waiting_until).toBeUndefined();

    h.prompts.answerUser(h.promptIdOf()!, 'Acme');
    await h.run;
  });

  it('but re-asserting `waiting` WITHOUT a deadline leaves the existing one alone', async () => {
    // The other direction, and the case that actually separates the two
    // implementations. Passing `waitingUntil` alongside makes the test pass even
    // if the clear were unconditional — the later assignment simply wins — so the
    // discriminator is a status write that does NOT carry a deadline. Measured:
    // the earlier version of this test survived exactly that mutation.
    //
    // Leaving it alone is also what `undefined` means everywhere else in
    // `updateFields`: absent field, column untouched.
    const h = makeHarness();
    await h.parked;
    const parkedUntil = h.history.getTrigger('trg-1')?.waiting_until;
    expect(parkedUntil).toBeDefined(); // fixture guard

    h.history.updateTrigger('trg-1', { status: 'waiting' });

    expect(h.history.getTrigger('trg-1')?.waiting_until).toBe(parkedUntil);

    h.prompts.answerUser(h.promptIdOf()!, 'Acme');
    await h.run;
  });

  it('reopening a parked trigger does NOT dispatch a second run of it', async () => {
    // The property the whole "do not gate complete()/reopen()/update()" decision
    // rests on, so it gets a test rather than an argument. Those three write a
    // status unconditionally, so a human CAN take a parked trigger back to `open`
    // while its run is still blocked on the question — deliberately: it is the
    // only way to release a trigger nobody is going to answer. `getDue`s wait
    // gate then stops excluding it, and the row still carries a past
    // `next_run_at`, so the next tick looks like it should fire it again.
    //
    // It does not, because `activeTasks` still holds the id for the whole of
    // `executeTask` — the parked run is inside it. Gating the three writers
    // instead would have removed the release valve to fix a problem that is
    // already closed one layer down.
    const h = makeHarness();
    await h.parked;
    expect(h.dispatches()).toBe(1);

    h.manager.reopen('trg-1');
    expect(h.history.getTrigger('trg-1')?.status).toBe('open');
    await h.loop.tick();

    expect(h.dispatches()).toBe(1);

    h.prompts.answerUser(h.promptIdOf()!, 'Acme');
    await h.run;
  });

  // ── T1 / A5: the status writers leave a wait alone ───────────────────────

  it('A5 — recordTaskRun does not end a wait, on the terminal branch', async () => {
    const h = makeHarness();
    await h.parked;
    // A one-shot trigger: the branch that would otherwise write `completed`.
    h.history.insertTrigger({ id: 'trg-2', title: 'One shot', source: 'manual', effect: 'run_agent' });
    h.history.updateTrigger('trg-2', { status: 'waiting', waitingUntil: '2026-12-01T00:00:00.000Z' });

    h.manager.recordTaskRun('trg-2', 'done', 'success');

    expect(h.history.getTrigger('trg-2')?.status).toBe('waiting');
    // The run still gets recorded — only the STATUS is withheld.
    expect(h.history.getTrigger('trg-2')?.last_run_result).toBe('done');

    h.prompts.answerUser(h.promptIdOf()!, 'Acme');
    await h.run;
  });

  it('A5 — nor on the terminal FAILED branch', async () => {
    // Three of the five branches write a status, and each needs its own witness:
    // a guard removed from one is invisible to a test that drives another. This
    // one survived until a mutation said so.
    const h = makeHarness();
    await h.parked;
    h.history.insertTrigger({ id: 'trg-4', title: 'One shot', source: 'manual', effect: 'run_agent' });
    h.history.updateTrigger('trg-4', { status: 'waiting', waitingUntil: '2026-12-01T00:00:00.000Z' });

    h.manager.recordTaskRun('trg-4', 'boom', 'failed');

    expect(h.history.getTrigger('trg-4')?.status).toBe('waiting');
    expect(h.history.getTrigger('trg-4')?.last_run_status).toBe('failed');

    h.prompts.answerUser(h.promptIdOf()!, 'Acme');
    await h.run;
  });

  it('A5 — recordTaskRun does not end a wait on the cron branch either', async () => {
    const h = makeHarness();
    await h.parked;

    h.manager.recordTaskRun('trg-1', 'done', 'failed');

    expect(h.history.getTrigger('trg-1')?.status).toBe('waiting');

    h.prompts.answerUser(h.promptIdOf()!, 'Acme');
    await h.run;
  });

  it('the guard is scoped to parked rows — an ordinary run still writes its status', async () => {
    // The other direction, without which the guard above could be "never write
    // a status" and every assertion here would still pass.
    const h = makeHarness();
    await h.parked;
    h.history.insertTrigger({ id: 'trg-3', title: 'One shot', source: 'manual', effect: 'run_agent' });

    h.manager.recordTaskRun('trg-3', 'done', 'success');

    expect(h.history.getTrigger('trg-3')?.status).toBe('completed');

    h.prompts.answerUser(h.promptIdOf()!, 'Acme');
    await h.run;
  });

  // ── A12 / E6: the sweep ──────────────────────────────────────────────────

  it('A12 — a tick leaves a wait that has NOT run out alone', async () => {
    // The other direction of the sweep, without which it could be "end every
    // parked trigger on the next tick" and every test above would still pass —
    // while every question a live run is waiting on died within a minute.
    //
    // At the TICK level rather than through a real Engine boot: the boot file
    // proves the wiring once, and a second boot only to re-assert a predicate
    // costs the suite a heavy Engine. That is not free — this file's siblings
    // share a 10s budget and one of them already runs at most of it.
    const h = makeHarness();
    await h.parked;

    await h.loop.tick();

    expect(h.history.getTrigger('trg-1')?.status).toBe('waiting');
    expect(h.prompts.getPending('thread-park')?.status).toBe('pending');
  });

  it('A12/E6 — a tick settles the prompt FIRST, then ends the abandoned wait', async () => {
    const h = makeHarness();
    await h.parked;
    const promptId = h.promptIdOf()!;
    // Backdate the deadline: the shape a process that died mid-question leaves.
    h.history.updateTrigger('trg-1', { waitingUntil: '2020-01-01T00:00:00.000Z' });

    await h.loop.tick();

    expect(h.history.getTrigger('trg-1')?.status).toBe('failed');
    expect(h.history.getTrigger('trg-1')?.waiting_until).toBeUndefined();
    // E6's order, and the reason for it: a row left `pending` stays answerable
    // for its full TTL, and an answer arriving after the sweep would revive a
    // trigger the sweep had just ended.
    expect(h.prompts.getById(promptId)?.status).toBe('expired');
    // The count is the only signal that a settle DID something; nothing reads it
    // in production, so without this it could return a constant.
    expect(h.prompts.expirePendingForTrigger('trg-1')).toBe(0); // already settled
    expect(h.prompts.answerUser(promptId, 'too late')).toBe(false);

    await h.run;
  });

  it('E6 — the ORDER is asserted directly, because its consequence is not here yet', async () => {
    // The sibling test above asserts both OUTCOMES: the trigger ends and the
    // prompt is settled. Both hold under either order, and a mutation that swaps
    // them survives it — measured, not assumed. The order only becomes visible
    // once an answer can make a trigger due again (§0 A10, a later slice); in the
    // window between "trigger ended" and "prompt settled" such an answer would
    // revive a trigger the sweep had just finished.
    //
    // So the ordering is asserted as an ordering. That is weaker than an
    // outcome, and it is the honest instrument for a requirement whose observable
    // consequence has not been built: the alternative is leaving §0's one binding
    // sequence with no test at all until the slice that trips over it.
    const h = makeHarness();
    await h.parked;
    h.history.updateTrigger('trg-1', { waitingUntil: '2020-01-01T00:00:00.000Z' });

    // Both spies DELEGATE. A recording no-op would have left the prompt pending,
    // so the run never resolves and hangs to the end of the suite — invisible
    // until the teardown drain started asserting that runs actually finish.
    const calls: string[] = [];
    const realSettle = PromptStore.prototype.expirePendingForTrigger;
    const settle = vi.spyOn(h.prompts, 'expirePendingForTrigger');
    settle.mockImplementation((id: string) => {
      calls.push('settle');
      return realSettle.call(h.prompts, id);
    });
    const end = vi.spyOn(h.manager, 'endWait');
    const realEnd = TaskManager.prototype.endWait;
    end.mockImplementation((id, to) => {
      calls.push('end');
      return realEnd.call(h.manager, id, to);
    });

    await h.loop.tick();

    expect(calls).toEqual(['settle', 'end']);
    settle.mockRestore();
    end.mockRestore();

    await h.run;
  });

  it('the LOSER of the endWait race writes no run result', async () => {
    // Why `recordTaskRun` sits INSIDE `if (endWait(...))`. An earlier comment
    // claimed the order mattered for scheduling; it does not — the parked guard
    // withholds only the status and `next_run_at` is written either way, so both
    // orders leave the same row, and a mutation that swapped them survived.
    //
    // The real reason is exactly-once: `endWait` is what resolves the race with a
    // live run's own un-park, so only the winner may stamp a result. Here the
    // race is decided against the sweep before it runs.
    // The race has to be lost BETWEEN the query and the write. Ending the wait
    // before the tick does not reproduce it: `endWait` clears the deadline too,
    // so the sweep's query stops returning the row and the loser path is never
    // entered at all — measured, an earlier version of this test asserted
    // against a loop body that never ran.
    const h = makeHarness();
    await h.parked;
    h.history.updateTrigger('trg-1', { waitingUntil: '2020-01-01T00:00:00.000Z' });
    const lost = vi.spyOn(h.manager, 'endWait').mockReturnValue(false);
    const recorded = vi.spyOn(h.manager, 'recordTaskRun');

    await h.loop.tick();

    expect(lost).toHaveBeenCalledWith('trg-1', 'failed'); // the sweep DID see it
    expect(recorded).not.toHaveBeenCalled();              // and wrote nothing
    lost.mockRestore();
    recorded.mockRestore();

    h.prompts.answerUser(h.promptIdOf()!, 'Acme');
    await h.run;
  });

  it('a sweep failure does not stop the tick from dispatching', async () => {
    // Collecting abandoned waits is housekeeping; firing triggers is the job.
    const h = makeHarness();
    await h.parked;
    const boom = vi.spyOn(h.manager, 'getExpiredWaitingTriggers').mockImplementation(() => {
      throw new Error('history.db is having a day');
    });
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    await expect(h.loop.tick()).resolves.toBeUndefined();

    expect(stderr.mock.calls.some(c => String(c[0]).includes('wait sweep failed'))).toBe(true);
    boom.mockRestore();
    stderr.mockRestore();

    h.prompts.answerUser(h.promptIdOf()!, 'Acme');
    await h.run;
  });

  it('a swept cron trigger is RESCHEDULED, not immediately due again', async () => {
    // The loop this nearly shipped: `getDue`'s denylist keeps a FAILED trigger due
    // while it has a cron schedule — that is the auto-recovery — and the sweep
    // leaves `next_run_at` pointing at the run that parked, i.e. the past. Ending
    // the wait without rescheduling therefore makes the trigger due on the VERY
    // NEXT tick, so it re-asks at once instead of at its next occurrence.
    const h = makeHarness();
    await h.parked;
    h.history.updateTrigger('trg-1', { waitingUntil: '2020-01-01T00:00:00.000Z' });

    await h.loop.tick();

    const after = h.history.getTrigger('trg-1');
    expect(after?.status).toBe('failed');
    expect(new Date(after!.next_run_at!).getTime()).toBeGreaterThan(Date.now());
    expect(h.manager.getDueTriggers().map(t => t.id)).not.toContain('trg-1');

    await h.run;
  });

  it('a swept ONE-SHOT trigger stops being due at all', async () => {
    // The other branch: no cron to reschedule against, so the run must clear
    // `next_run_at` instead — otherwise the same loop, without the 24h spacing.
    const h = makeHarness();
    await h.parked;
    h.history.insertTrigger({
      id: 'one-shot', title: 'Ask once', source: 'manual', effect: 'run_agent',
      nextRunAt: '2020-01-01T00:00:00.000Z', confirmedAt: '2020-01-01T00:00:00.000Z',
    });
    h.history.updateTrigger('one-shot', { status: 'waiting', waitingUntil: '2020-01-01T00:00:00.000Z' });

    await h.loop.tick();

    expect(h.history.getTrigger('one-shot')?.next_run_at).toBeUndefined();
    expect(h.manager.getDueTriggers().map(t => t.id)).not.toContain('one-shot');

    h.prompts.answerUser(h.promptIdOf()!, 'Acme');
    await h.run;
  });

  // ── the READ side: the model can ask for what it can see ─────────────────

  it('a parked trigger is filterable by status — the model can ask for what it sees', async () => {
    const h = makeHarness();
    await h.parked;

    expect(h.manager.listTriggers({ status: 'waiting' }).map(t => t.id)).toEqual(['trg-1']);
    expect(h.manager.listTriggers({ status: 'open' }).map(t => t.id)).not.toContain('trg-1');

    h.prompts.answerUser(h.promptIdOf()!, 'Acme');
    await h.run;
  });

  // ── Auflage 1: recurring is OUT of wave 1, and the test pins today's shape ──

  it('a park SHIFTS a cron trigger\'s cadence by the wait — wave 1 does not fix this', async () => {
    // Deliberately nailed rather than corrected. `next_run_at` is computed in
    // `recordTaskRun`, i.e. after the run returns, so a run that waited an hour
    // for its answer schedules the next occurrence from an hour later. Fixing it
    // means deciding what a cron trigger's schedule MEANS across a wait, which is
    // out of scope here. This test exists so the day someone changes it, they
    // change it on purpose.
    const h = makeHarness();
    await h.parked;
    const before = h.history.getTrigger('trg-1')?.next_run_at;

    h.prompts.answerUser(h.promptIdOf()!, 'Acme');
    await h.run;
    await waitUntil('the run to record its result', () => h.history.getTrigger('trg-1')?.last_run_at !== undefined);

    const after = h.history.getTrigger('trg-1')?.next_run_at;
    expect(after).not.toBe(before);
    expect(new Date(after!).getTime()).toBeGreaterThan(Date.now());
  });
});
