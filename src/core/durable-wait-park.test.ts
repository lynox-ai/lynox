import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkerLoop } from './worker-loop.js';
import { RunHistory } from './run-history.js';
import { EngineDb } from './engine-db.js';
import { PromptStore } from './prompt-store.js';
import { TaskManager } from './task-manager.js';
import { maskSecretsAndPatterns } from './secret-store.js';
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
    /** The arguments each dispatched turn was given — [0] is the prompt text. */
    sessionRunArgs: () => unknown[][];
    /** The options each `createSession` was called with. */
    sessionOpts: () => Array<{ sessionId?: string } | undefined>;
    /** The same engine, so a test can build a SECOND loop over the same stores —
     *  which is what "after the restart" means when the process does not actually
     *  restart. A second `tick()` on the FIRST loop would not do: it is the object
     *  whose in-memory state the restart is supposed to lose. */
    engine: Engine;
    router: NotificationRouter;
  }

  /** A worker loop whose single trigger's run asks one question and waits.
   *
   *  `doctorExpiry` replaces the deadline the prompt row reports, and it is the
   *  only way to tell "read the row back" apart from "compute 24h yourself":
   *  both produce the same instant to the millisecond, so an equality assertion
   *  between them passes either way. A value no clock would produce does not. */
  function makeHarness(opts?: { doctorExpiry?: string; unreadableRow?: boolean; secretValues?: string[]; maxToolResultChars?: number; question?: string }): Harness {
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
      // The real Session always has these, and `executeStandard` reads the run's ending
      // off `getLastRunStop`. Without the method the read is a TypeError the task-failure
      // path swallows into the recorded result; `null` is a production shape (nothing ran,
      // or the send threw) and the caller handles it.
      getAgent: () => null,
      getLastRunStop: () => null,
      promptUser: undefined as ((q: string, o?: string[]) => Promise<string>) | undefined,
      // EVERY dispatch registers itself for the teardown drain, from inside the
      // mock. Registering from the tick's `.then` only ever caught the first: a
      // test that ticks again — an answer re-arming a trigger does exactly that —
      // left the second run unwatched, and closing the sqlite handle under it
      // raised an unhandled rejection belonging to no test.
      run: vi.fn(() => {
        const turn = (async () => {
          // The agent turn: one `ask_user`, then whatever the answer was.
          const answering = session.promptUser!(opts?.question ?? 'Which client?', ['Acme', 'Globex']);
          // Give the closure a turn to insert + park before the test looks.
          await new Promise(r => setImmediate(r));
          promptId = prompts.getPending(session.sessionId)?.id;
          signalParked();
          return `answered: ${await answering}`;
        })();
        inFlight.push(turn);
        return turn;
      }),
    };

    const createdWith: Array<{ sessionId?: string } | undefined> = [];
    const engine = {
      getTaskManager: () => manager,
      // Honours the `sessionId` it is handed. A mock that always answered
      // 'thread-park' made "same thread" untestable in BEHAVIOUR — the only
      // assertion left was on the options object — and it also made the second
      // dispatch collide with the first run's still-pending question on the
      // per-session unique index.
      createSession: (o?: { sessionId?: string }) => {
        createdWith.push(o);
        session.sessionId = o?.sessionId ?? 'thread-park';
        return session as unknown as Session;
      },
      getPromptStore: () => prompts,
      getRunHistory: () => history,
      // `null` is a real production shape (an engine with no vault), and the
      // masking path handles it by falling back to shape-only. A mock that
      // simply LACKED the method made `executeStandard` throw before it ever
      // dispatched, and the only symptom was a test timing out waiting for a
      // run that never started.
      // A real deterministic effect for the Run-now positive control: without it
      // `executeBackup` throws on its first line ("getBackupManager is not a function"),
      // so the control drained an instant failure while its comment claimed a backup.
      getBackupManager: () => ({
        createBackup: () => Promise.resolve({ success: true, path: '/tmp/none.db', duration_ms: 1 }),
        pruneBackups: () => { /* noop */ },
      }),
      getSecretStore: () => opts?.secretValues
        ? ({ maskAll: (t: string) => maskSecretsAndPatterns(t, opts.secretValues!) } as unknown as ReturnType<Engine['getSecretStore']>)
        : null,
      getUserConfig: () => (opts?.maxToolResultChars !== undefined ? { max_tool_result_chars: opts.maxToolResultChars } : {}),
      workerRunModelOverride: () => ({}),
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
      for (const thread of ['thread-park', 'thread-dead']) {
        const pending = prompts.getPending(thread);
        if (pending) prompts.expirePrompt(pending.id);
      }
    });

    const loop = new WorkerLoop(engine, router, 60_000);
    const run = loop.tick();

    return {
      loop, history, prompts, manager, parked, run, engine, router,
      promptIdOf: () => promptId,
      dispatches: () => session.run.mock.calls.length,
      sessionRunArgs: () => session.run.mock.calls as unknown[][],
      sessionOpts: () => createdWith,
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

  it('the question is masked where it LEAVES the box, and not where the owner reads it', async () => {
    // ⛔ THREE CONSUMERS, TWO OF WHICH NEED THE MASK. The question is model-authored from
    // the run's context — files, mail, the data store — and the notification is the one
    // that leaves the machine: the escalation channel puts it in an email body and the
    // web-push payload carries it. The same string was already masked for the MODEL, on
    // the stated reasoning that an `ask_user` exchange is where someone pastes an API
    // key; the off-box path had no mask at all, which is the half of that judgement that
    // was wrong.
    //
    // ⚠ And the stored row is deliberately NOT masked: the owner reads it on their own
    // machine, through their own UI, and masking it would cost them the question's detail
    // to protect them from themselves. Masking at the source would have taken it with it,
    // which is why this test asserts both directions.
    // ⚠ Deliberately NOT key-shaped. The mask is driven by the vault's own VALUES, so any
    // string exercises it — and a realistic `sk-live-…` literal is a finding to gitleaks
    // (measured: it refused the commit, correctly). A test that has to look like a
    // credential to work would be a test that cannot be committed.
    const secret = 'vault-value-that-must-not-leave-the-box';
    const h = makeHarness({ secretValues: [secret], question: `Use ${secret} for the call?` });
    await h.parked;

    const sent = vi.mocked(h.router.notify).mock.calls[0]?.[0] as { body?: string; inquiry?: { question?: string } } | undefined;
    expect(sent?.body, 'the notification body leaves the box').not.toContain(secret);
    expect(sent?.body).toContain('***');
    expect(sent?.inquiry?.question, 'and so does the inquiry payload').not.toContain(secret);
    // The owner's own copy keeps its detail.
    expect(h.prompts.getById(h.promptIdOf()!)?.question).toContain(secret);
  });

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

    // Restored BEFORE the assertions, because neither spy gates them and a
    // failing assertion would otherwise leave `process.stderr.write` stubbed for
    // the rest of the file — swallowing the diagnostics of every later test, at
    // the exact moment something has already gone wrong.
    const wrote = stderr.mock.calls.map(c => String(c[0]));
    boom.mockRestore();
    stderr.mockRestore();
    expect(wrote.some(line => line.includes('wait sweep failed'))).toBe(true);

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

  // ── A7 / A10: what the answer decides ───────────────────────────────────

  /**
   * The state a dead process leaves: a trigger still `waiting`, and its question
   * ANSWERED with the pointer intact because no run was there to consume it.
   *
   * Built directly rather than by answering the harness's live question — which
   * is what an earlier version of these tests did, and it stopped being the same
   * state the moment the in-process answer path started releasing the pointer.
   * Answering a question someone is waiting for is precisely NOT the case A10
   * exists for.
   */
  function seedAnsweredPark(h: Harness, id: string, thread: string, q: string, a: string): string {
    h.history.insertTrigger({
      id, title: `Ask (${id})`, source: 'cron', effect: 'run_agent',
      // FUTURE `next_run_at` on purpose. Seeding it in the past makes the
      // trigger due whether or not the re-arm moves it, and the mutation that
      // re-arms without stamping a new time then changes nothing observable —
      // measured, it survived exactly that fixture.
      scheduleCron: '0 9 * * *', nextRunAt: '2099-06-01T00:00:00.000Z',
      confirmedAt: '2020-01-01T00:00:00.000Z',
    });
    h.history.updateTrigger(id, { status: 'waiting', waitingUntil: '2099-01-01T00:00:00.000Z' });
    const promptId = h.prompts.insertAskUser(thread, q, undefined, undefined, undefined, undefined, id);
    expect(h.prompts.answerUser(promptId, a), 'fixture guard: the answer must land').toBe(true);
    return promptId;
  }

  it('A7 — a run whose question went unanswered does NOT report success', async () => {
    // The failure this whole arc started from. `DISMISSED_ANSWER` is a RETURN
    // VALUE: the agent gets `'__dismissed__'`, reasons on it, produces something,
    // and the trigger reported `success` for work built on an answer nobody gave.
    const h = makeHarness();
    await h.parked;
    const recorded = vi.spyOn(h.manager, 'recordTaskRun');

    // Expire the question rather than answering it — the run resumes with the
    // fabricated answer, exactly as before this slice.
    h.prompts.expirePrompt(h.promptIdOf()!);
    await waitUntil('the run to finish', () => recorded.mock.calls.length > 0);

    expect(recorded.mock.calls[0]?.[2]).toBe('failed');
    recorded.mockRestore();
  });

  it('A7 — an ANSWERED question still reports success', async () => {
    // The other direction, without which the guard could be "never report
    // success" and the test above would still pass.
    const h = makeHarness();
    await h.parked;
    const recorded = vi.spyOn(h.manager, 'recordTaskRun');

    h.prompts.answerUser(h.promptIdOf()!, 'Acme');
    await waitUntil('the run to finish', () => recorded.mock.calls.length > 0);

    expect(recorded.mock.calls[0]?.[2]).toBe('success');
    recorded.mockRestore();
  });

  it('W2-13 — a GRACEFUL SHUTDOWN leaves the question standing, and its answer makes the trigger DUE again', async () => {
    // ⛔ WHY THIS IS THE COMMON PATH AND NOT A CORNER. `Engine.shutdown()` calls
    // `WorkerLoop.stop()` FIRST and `runHistory.close()` much later, with awaits in between
    // (an in-flight inbox rebootstrap, the inbox runtime, every shutdown hook — the
    // managed billing hook is registered whenever the tier env var is set). So the abort
    // settles this wait and the continuation runs while the database is still OPEN: the
    // prompt was expired, its trigger pointer released and the trigger un-parked, all
    // successfully. On managed that is every deploy, and the product states the opposite
    // promise — the question "must survive the restart it is waiting across".
    //
    // ⚠ The barrier is `last_run_at`, not a sleep: it is written after the turn returns,
    // which is after the closure's `finally` — the very block under test. Waiting for
    // the ROW's absence of change would be waiting for nothing, which passes against any
    // implementation.
    const h = makeHarness();
    await h.parked;
    const promptId = h.promptIdOf()!;
    expect(h.history.getTrigger('trg-1')?.status, 'the fixture must really be parked').toBe('waiting');

    h.loop.stop();
    await waitUntil('the aborted wait to unwind through its finally',
      () => (h.history.getTrigger('trg-1')?.last_run_at ?? null) !== null);

    // ── what the next process needs to find
    //
    // ⛔ FIRST: the run did not report SUCCESS. The teardown branch sets
    // `questionWentUnanswered`, which is the only thing standing between this path and
    // a `success` record — and deleting that line passed every other test in both
    // files. §0 A7 ("a run whose question went unanswered does NOT report success") is
    // the invariant the whole arc started from, and the new branch had to re-earn it.
    expect(h.history.getTrigger('trg-1')?.last_run_status).not.toBe('success');
    expect(h.prompts.getById(promptId)?.status).toBe('pending');
    // The POINTER is the half a reader would not think to check, and it is the half the
    // resume path reads: `getAnsweredForTrigger` finds nothing once it is released.
    expect(h.prompts.getById(promptId)?.trigger_id).toBe('trg-1');
    const parkedAfter = h.history.getTrigger('trg-1');
    expect(parkedAfter?.status).toBe('waiting');
    expect(parkedAfter?.waiting_until).toBeTruthy();

    // ── the restart: a new loop over the same stores, and the answer arrives
    expect(h.prompts.answerUser(promptId, 'Acme'),
      'an expired row cannot be answered — this is false if the shutdown drained it').toBe(true);
    const next = new WorkerLoop(h.engine, h.router, 60_000);
    await next.tick();

    // ⚠ DUE, which is as far as this reaches: whether the run then starts depends on
    // the lease, which a SIGKILLed process holds for up to its TTL after the last
    // heartbeat (this harness reaches its `finally`, so the lease is free here). And the
    // question's own bound is wall-clock from the ask — 24 hours, downtime included, no
    // grace period — so a long enough outage has the boot sweep collect it first.
    const revived = h.history.getTrigger('trg-1');
    expect(revived?.status).toBe('open');
    expect(revived?.waiting_until).toBeUndefined();
    expect(new Date(revived!.next_run_at!).getTime()).toBeLessThanOrEqual(Date.now());
    next.stop();
  });

  it('W2-13 — "Run now" refuses a trigger that is still waiting, instead of starting a SECOND run', async () => {
    // ⛔ THE DEFECT THE TEARDOWN FIX MADE REACHABLE. `runTriggerNow` guards on
    // `activeTasks` and the lease, and after a restart the map is empty and the lease
    // frees 15 minutes after the last heartbeat — while the trigger now stays `waiting`
    // by design. A second run then mints a FRESH session id, so the per-session unique
    // index does not collide: the trigger ends up with two pending prompts, the second
    // park overwrites the `waiting_until` that bounded the first, and the second run's
    // `finally` un-parks the trigger — leaving the first question collectable by
    // neither sweep (it has a pointer; its trigger is no longer `waiting`) for its full
    // 24-hour TTL.
    //
    // `stop()` here IS the restart, as far as this guard can tell: it clears the map and
    // leaves the row waiting, which is exactly the state the next process boots into.
    const h = makeHarness();
    await h.parked;
    h.loop.stop();
    await waitUntil('the teardown to unwind', () => (h.history.getTrigger('trg-1')?.last_run_at ?? null) !== null);
    expect(h.history.getTrigger('trg-1')?.status, 'the fixture must be in the state the fix creates').toBe('waiting');

    // ⛔ And the REASON, not just the refusal. Without the check this does NOT fall
    // through to a polite `already_running` — measured: it returns `{ok:true}` and starts
    // the second run, because the dying run's own `finally` released the lease. (An
    // earlier version of this comment said the lease would catch it, which is the shape
    // of a bound that sounds reassuring and is not there.)
    await expect(h.loop.runTriggerNow('trg-1')).resolves.toEqual({ ok: false, reason: 'awaiting_answer' });
    // ⛔ AND THE REFUSAL TOOK NO LEASE. The guard sits before `takeLease` on purpose:
    // `claimLease` writes `lease_holder`/`lease_until` unless the lease is held, and
    // nothing releases one taken by a call that then refused — so the trigger would be
    // withheld from `getDueTriggers` for up to the lease TTL, including from the sweep
    // that re-arms it once its answer lands.
    //
    // ⚠ Observed through a SECOND CLAIMANT, because `lease_until` is a column on the
    // triggers table and NOT a field on the record: an earlier version of this assertion
    // read `getTrigger(...)?.lease_until`, which is always `undefined`, so it passed
    // against a guard moved below the lease. Found by mutating that move — which is what
    // a mutation round is for.
    expect(
      h.manager.claimLease('trg-1', 'a-different-holder', new Date(Date.now() + 60_000).toISOString(), new Date().toISOString()),
      'a refusal that took the lease would answer `held` here',
    ).not.toBe('held');

    // THE POSITIVE CONTROL, or the check above would be satisfied by refusing
    // everything. On a SECOND trigger that is not waiting, and a deterministic effect
    // rather than an agent turn: dispatching `trg-1` again would mint a session with the
    // same id as the parked one and collide on the per-session unique index — the test
    // would then fail on its own fixture, with the error of the defect one test up.
    h.history.insertTrigger({
      id: 'trg-2', title: 'Nightly backup', source: 'cron', effect: 'backup',
      scheduleCron: '0 3 * * *', nextRunAt: '2026-01-01T03:00:00.000Z',
    });
    const next = new WorkerLoop(h.engine, h.router, 60_000);
    const control = await next.runTriggerNow('trg-2');
    expect(control, 'a trigger that is not waiting still runs on request').toEqual({ ok: true });
    // Drained before teardown closes the handles: the dispatch is fire-and-forget, and
    // a run still unwinding when sqlite closes raises a rejection belonging to no test.
    await waitUntil('the control run to finish', () => next.activeTaskCount === 0);
    next.stop();
  });

  it('W2-13 — a teardown that RACES a committed answer keeps the pointer, so the answer survives', async () => {
    // ⛔ THE ONE STATE WHERE THE RELEASE GUARD HAS AN EFFECT, and it needs no race to
    // win: `answerUser` commits synchronously, `settle()` only queues a microtask, and
    // `stop()` is synchronous throughout — so answering and stopping in the same tick
    // puts the answer in the row and the teardown flag up before the continuation runs.
    // Without the guard the release takes (the row is `answered`, not `pending`, so its
    // SQL no longer refuses) and the answer is discarded: the next process finds no
    // pointer and never re-arms the run.
    const h = makeHarness();
    await h.parked;
    const promptId = h.promptIdOf()!;

    expect(h.prompts.answerUser(promptId, 'Acme')).toBe(true);
    h.loop.stop();
    await waitUntil('the run to unwind', () => (h.history.getTrigger('trg-1')?.last_run_at ?? null) !== null);

    // The EFFECT, not the call: the pointer is still there, so the next process can find
    // the answer and re-arm.
    expect(h.prompts.getById(promptId)?.trigger_id).toBe('trg-1');
    expect(h.prompts.getAnsweredForTrigger('trg-1')?.id).toBe(promptId);
  });

  it('W2-13 — a trigger COMPLETED while parked is startable, and its orphan question is settled', async () => {
    // ⛔ THE MIRROR OF THE STATE ABOVE, and the first version of the guard locked the
    // owner out of it. `complete`/`update` take a trigger out of `waiting` through
    // `updateFields` and touch `pending_prompts` not at all — the bypass
    // `TriggerStore.endWait`'s docblock names — so a pending row can point at a trigger
    // that is no longer waiting. A guard that asked only the ROW refused there: for 24
    // hours, "Run now" told the owner to answer a question no view surfaces, on a
    // trigger they had just completed.
    //
    // ⛔ And the orphan has to be SETTLED, not stepped over: nothing else collects it.
    // The boot sweep spares any row with a live pointer, the expiry and answer-rearm
    // passes iterate `waiting` triggers only, and `expireOld` waits for its own 24-hour
    // clock. Until then it holds the thread's slot in the partial unique index, so the
    // next `ask_user` in that chat throws — uncaught on that path. Before the teardown
    // fix a deploy drained it; now it survives, which is what makes this a repair.
    const h = makeHarness();
    await h.parked;
    const promptId = h.promptIdOf()!;

    // What the owner's "complete" does to a parked trigger, through the real path.
    //
    // ⚠ And then the process goes away. In the SAME process `activeTasks` still holds the
    // run, so Run-now is refused as `already_running` whatever this guard does — the
    // lockout only bites in the next process, which is also the only place the surviving
    // row can be found. A fixture that skipped the restart would have passed against the
    // guard it is meant to catch.
    h.manager.complete('trg-1');
    h.loop.stop();
    await waitUntil('the first run to release its lease', () => (h.history.getTrigger('trg-1')?.last_run_at ?? null) !== null);
    expect(h.history.getTrigger('trg-1')?.status, 'out of waiting').not.toBe('waiting');
    expect(h.prompts.getPendingForTrigger('trg-1')?.id, 'with its question orphaned').toBe(promptId);

    const next = new WorkerLoop(h.engine, h.router, 60_000);
    await expect(next.runTriggerNow('trg-1')).resolves.toEqual({ ok: true });
    // THE REPAIR, asserted on the ORPHAN by id rather than on "no pending row": the
    // hand-started run parks on a question of its own, so there IS one again — and an
    // assertion that counted rows would have failed for the right reason by accident.
    expect(h.prompts.getById(promptId)?.status, 'the orphan is settled on the way through').toBe('expired');

    next.stop();
    await waitUntil('the hand-started run to unwind', () => next.activeTaskCount === 0);
  });

  it('W2-13 — a trigger stuck `waiting` with no open question is still startable by hand', async () => {
    // ⛔ THE REGRESSION THE FIRST VERSION OF THAT GUARD SHIPPED, and it is the reason the
    // guard now asks the PROMPT STORE instead of the trigger's status. `endTriggerWait`
    // has a swallowed catch — its own sibling comment names SQLITE_BUSY and schema drift
    // — and when it fails the trigger stays `waiting` while the prompt is already
    // `answered` and its pointer released. Then: the answered-re-arm sweep finds nothing
    // (no pointer), the expiry sweep skips it (`waiting_until` is 24h out), and
    // `recordTaskRun` cannot write its status either (it withholds for a parked row). So
    // "Run now" was the only way forward — and a guard keyed on `waiting` took it away
    // for up to 24 hours while the refusal told the owner to answer a question that was
    // answered and consumed.
    //
    // A recovery path must not be blocked by the state it exists to recover from.
    const h = makeHarness();
    await h.parked;
    const promptId = h.promptIdOf()!;

    // The stuck state, built the way it arises. The order matters: the answer lands and
    // its pointer is consumed, then the process goes away — so the trigger is left
    // `waiting` (the teardown deliberately does not un-park) with nothing open against
    // it, which is the shape a swallowed `endTriggerWait` failure also produces.
    //
    // ⚠ And the first process really has to be GONE, not just stopped: its run holds the
    // trigger's lease until `executeTask`'s `finally`, so without waiting for it the
    // second call is refused by the LEASE and the test would pass against any guard.
    expect(h.prompts.answerUser(promptId, 'Acme')).toBe(true);
    expect(h.prompts.releaseTrigger(promptId)).toBe(true);
    h.loop.stop();
    await waitUntil('the first run to release its lease', () => (h.history.getTrigger('trg-1')?.last_run_at ?? null) !== null);
    expect(h.history.getTrigger('trg-1')?.status, 'the fixture is in the stuck state').toBe('waiting');
    expect(h.prompts.getPendingForTrigger('trg-1'), 'and nothing is open any more').toBeUndefined();

    const next = new WorkerLoop(h.engine, h.router, 60_000);
    await expect(next.runTriggerNow('trg-1')).resolves.toEqual({ ok: true });

    // The hand-started run asks its own question and parks on it — which is the forward
    // progress this test is about, and also why it cannot simply be drained: nothing
    // would ever answer it. `stop()` ends that wait the way a shutdown does.
    next.stop();
    await waitUntil('the hand-started run to unwind', () => next.activeTaskCount === 0);
  });

  it('A10 — an answer makes a parked trigger due again', async () => {
    const h = makeHarness();
    await h.parked;
    seedAnsweredPark(h, 'trg-dead', 'thread-dead', 'Which client?', 'Acme');

    await h.loop.tick();

    const after = h.history.getTrigger('trg-dead');
    expect(after?.status).toBe('open');
    expect(after?.waiting_until).toBeUndefined();
    expect(new Date(after!.next_run_at!).getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('A10 — a long answer is CAPPED before it reaches the autonomous turn', async () => {
    // ⛔ THE ONE CONSUMER OF AN ANSWER THAT HAD NO BOUND. The live tool-result path
    // truncates at `max_tool_result_chars`; this path composed the stored string
    // verbatim, and `answerUser` stores what the request body carried — bounded only by
    // the 30 MB body cap. The teardown fix promotes this path from the crash-only one to
    // the every-deploy one, so the missing bound became the ordinary case.
    const h = makeHarness({ maxToolResultChars: 40 });
    await h.parked;
    seedAnsweredPark(h, 'trg-dead', 'thread-dead', 'Which client?', 'G'.repeat(500));

    await h.loop.tick();   // re-arms it
    await h.loop.tick();   // dispatches it
    await waitUntil('the second run to start', () => h.dispatches() >= 2);

    const secondPrompt = String(h.sessionRunArgs()[1]?.[0] ?? '');
    expect(secondPrompt).toContain('[truncated]');
    // The bound itself, not just the marker: the answer's own text is cut to the cap, so
    // a 500-character reply cannot carry 500 characters into the turn.
    expect(secondPrompt).not.toContain('G'.repeat(60));
  });

  it('A10 — a long QUESTION is capped like the answer (N12-4: a write question carries its body)', async () => {
    const h = makeHarness({ maxToolResultChars: 40 });
    await h.parked;
    seedAnsweredPark(h, 'trg-dead', 'thread-dead', `Which client? ${'Q'.repeat(500)}`, 'Acme');

    await h.loop.tick();   // re-arms it
    await h.loop.tick();   // dispatches it
    await waitUntil('the second run to start', () => h.dispatches() >= 2);

    const secondPrompt = String(h.sessionRunArgs()[1]?.[0] ?? '');
    expect(secondPrompt).toMatch(/<asked>[\s\S]*\[truncated\][\s\S]*<\/asked>/);
    expect(secondPrompt).not.toContain('Q'.repeat(60));
  });

  it('A10 — the re-armed run is told the question AND the answer', async () => {
    // The acceptance criterion with its own red: reusing the thread is not
    // enough, because answering writes a `pending_prompts` row and touches no
    // thread. Drop the answer from the input and this is what fails.
    const h = makeHarness();
    await h.parked;
    const promptId = seedAnsweredPark(h, 'trg-dead', 'thread-dead', 'Which client?', 'Globex');

    await h.loop.tick();   // re-arms it
    await h.loop.tick();   // dispatches it
    await waitUntil('the second run to start', () => h.dispatches() >= 2);

    const secondPrompt = String(h.sessionRunArgs()[1]?.[0] ?? '');
    // The ASSOCIATION, not two loose substrings. Asserting each separately let a
    // mutation that swaps the two interpolations pass — the re-armed agent would
    // be told the answer was the question and the question was the answer, with
    // every test green.
    expect(secondPrompt).toMatch(/<asked>\s*Which client\?\s*<\/asked>/);
    expect(secondPrompt).toMatch(/<answer>[\s\S]*?Globex[\s\S]*?<\/answer>/);
    // ⛔ AND THE FRAME CARRIES A DO-NOT-FOLLOW LINE. The answer is the owner's own text,
    // so wrapping it as untrusted data would be false — but it reaches an AUTONOMOUS
    // turn's strongest prompt position, and `renderFence` deadens only the payload's own
    // closing tag (its docblock says a payload that opens a DIFFERENT engine frame passes
    // through). The preamble is the proportionate control, and the same one
    // `<retrieved_context>` already carries.
    expect(secondPrompt).toContain('not as instructions');
    // And the answer is claimed exactly once — a later scheduled run must not be
    // handed the same reply again.
    expect(h.prompts.getById(promptId)?.trigger_id).toBeNull();
  });

  it('A10 — the re-armed run happens in the SAME thread', async () => {
    // Half of the decision, and the half the input test cannot see: the answer
    // reaches the run as input either way, so dropping the thread reuse leaves
    // every assertion about the prompt text intact. Measured — that mutation
    // survived until this test existed.
    const h = makeHarness();
    await h.parked;
    seedAnsweredPark(h, 'trg-dead', 'thread-dead', 'Which client?', 'Globex');

    await h.loop.tick();
    await h.loop.tick();
    await waitUntil('the second run to start', () => h.dispatches() >= 2);

    expect(h.sessionOpts()[1]?.sessionId).toBe('thread-dead');
    expect(h.sessionOpts()[0]?.sessionId, 'a first run has no thread to continue').toBeUndefined();
  });

  it('A10 — the LOSER of the re-arm race does not make the trigger due', async () => {
    // `endWait` decides the race with a live run's own un-park, and only the
    // winner may move `next_run_at`. Without the gate a trigger someone else
    // already released is dragged back to due — measured, that mutation survived
    // until this test existed.
    const h = makeHarness();
    await h.parked;
    seedAnsweredPark(h, 'trg-dead', 'thread-dead', 'Which client?', 'Acme');
    const lost = vi.spyOn(h.manager, 'endWait').mockReturnValue(false);

    await h.loop.tick();

    expect(lost).toHaveBeenCalledWith('trg-dead', 'open');        // the pass DID see it
    expect(h.history.getTrigger('trg-dead')?.next_run_at).toBe('2099-06-01T00:00:00.000Z');
    lost.mockRestore();
  });

  it('an answer consumed in-process detaches its prompt, so a SECOND question is not confused for it', async () => {
    // The chain this closes: a run asks twice. Q1 is answered in-process and the
    // run reads it directly. If that row stays attached, the tick's re-arm pass
    // finds an ANSWERED row for a trigger that is now parked on Q2, ends Q2's
    // wait while the run is still genuinely waiting on it, and stamps it due —
    // and a restart before Q2 settles leaves it `open`, so Q2's real answer can
    // never re-arm anything.
    const h = makeHarness();
    await h.parked;
    const q1 = h.promptIdOf()!;

    h.prompts.answerUser(q1, 'Acme');
    await waitUntil('the run to consume the answer', () => h.prompts.getById(q1)?.trigger_id === null);

    expect(h.prompts.getById(q1)?.status).toBe('answered');   // still answered
    expect(h.prompts.getById(q1)?.trigger_id).toBeNull();     // but no longer the trigger's
  });

  it('an answered prompt nobody came for is detached on its own clock', async () => {
    // The bound on the durable pointer. After the re-arm the row is `answered`
    // with the pointer live, waiting for a dispatch that may never come — the
    // trigger can be disabled, its consent revoked, or deleted outright, and
    // nothing across the two databases would ever release it.
    const h = makeHarness();
    await h.parked;
    const promptId = seedAnsweredPark(h, 'trg-dead', 'thread-dead', 'Which client?', 'Acme');
    // Backdate it past its own expiry — the shape an unclaimed answer reaches.
    h.history.getDb().prepare("UPDATE pending_prompts SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(promptId);

    h.prompts.expireOld();

    expect(h.prompts.getById(promptId)?.trigger_id).toBeNull();
    expect(h.prompts.getById(promptId)?.status, 'it WAS answered — that does not change').toBe('answered');
  });

  it('but an answer still within its window keeps its pointer', async () => {
    // Without this the detach could be unconditional and the feature would never
    // deliver an answer at all.
    const h = makeHarness();
    await h.parked;
    const promptId = seedAnsweredPark(h, 'trg-dead', 'thread-dead', 'Which client?', 'Acme');

    h.prompts.expireOld();

    expect(h.prompts.getById(promptId)?.trigger_id).toBe('trg-dead');
  });

  it('a secret-shaped answer is MASKED before it enters the prompt', async () => {
    // The live path already does this: `agent.ts` runs an `ask_user` reply through
    // `maskSecretPatterns` before the model sees it again, because an ask_user
    // reply is exactly where someone pastes an API key. Here the same text lands
    // in the OPENING task prose of an autonomous turn — a stronger position than
    // the tool result it replaces — so it cannot have less protection.
    const h = makeHarness();
    await h.parked;
    const key = `sk-ant-${'A'.repeat(40)}`;
    seedAnsweredPark(h, 'trg-dead', 'thread-dead', 'Which key?', `it is ${key} thanks`);

    await h.loop.tick();
    await h.loop.tick();
    await waitUntil('the second run to start', () => h.dispatches() >= 2);

    const secondPrompt = String(h.sessionRunArgs()[1]?.[0] ?? '');
    expect(secondPrompt).not.toContain(key);
    expect(secondPrompt).toContain('***AAAA');   // masked, not dropped
  });

  it('the answer lookup is scoped to ITS trigger, not just the newest answered row', async () => {
    // Every other test here has exactly one answered row, so an implementation
    // that dropped `WHERE trigger_id = ?` and simply took the newest answered
    // prompt would pass all of them — measured. Two triggers, two answers, and
    // the newer one belongs to the OTHER trigger.
    const h = makeHarness();
    await h.parked;
    seedAnsweredPark(h, 'trg-mine', 'thread-mine', 'Which client?', 'Acme');
    // Answered second, so it is the newest by `answered_at`.
    seedAnsweredPark(h, 'trg-other', 'thread-other', 'Which colour?', 'Teal');

    expect(h.prompts.getAnsweredForTrigger('trg-mine')?.answer).toBe('Acme');
    expect(h.prompts.getAnsweredForTrigger('trg-other')?.answer).toBe('Teal');
  });

  it('a masked VALUE is caught too, not only a recognisable shape', async () => {
    // Shapes alone was the first attempt. A stored secret with no shape — a
    // generic token, a database URL, a password — would have shipped in
    // cleartext to the re-armed model.
    const h = makeHarness({ secretValues: ['hunter2-correct-horse'] });
    await h.parked;
    seedAnsweredPark(h, 'trg-dead', 'thread-dead', 'Which password?', 'it is hunter2-correct-horse ok');

    await h.loop.tick();
    await h.loop.tick();
    await waitUntil('the second run to start', () => h.dispatches() >= 2);

    const secondPrompt = String(h.sessionRunArgs()[1]?.[0] ?? '');
    expect(secondPrompt).not.toContain('hunter2-correct-horse');
    // Masked, not blanked. Asserting only the absence would also pass for a
    // `mask()` that returned the empty string, which would take the answer with
    // it — the run would be told nothing and ask again.
    expect(secondPrompt).toContain('***orse');
    expect(secondPrompt).toContain('Which password?');
  });

  it('a teardown does not even TRY to drain the row, and the pointer survives it', async () => {
    // ⛔ THIS TEST MOVED WITH THE BEHAVIOUR, and the old version is why the move has to
    // be written down. It used to drive a FAILING settle: `stop()` aborted the wait, the
    // abort branch called `expirePrompt` — throwing here, exactly as its swallowed catch
    // anticipates (it names SQLITE_BUSY and schema drift) — and the `finally` then
    // detached the row unconditionally, so the claim was that a pointer survives even
    // that. W2-13 makes the teardown path skip the drain entirely, which leaves the
    // throwing settle UNREACHABLE from `stop()` — `stop()` is the only thing that aborts
    // a parked wait today, measured: one production caller, `Engine.shutdown()`.
    //
    // Two things would have been wrong to do instead. Re-aiming only the BARRIER: the
    // old one waited for the trigger to leave `waiting`, which no longer happens, so it
    // timed out — but fixing the wait and keeping the scenario leaves a spy that never
    // fires standing in for a guarantee. And deleting the test: the pointer-orphan
    // question is real, it just has a different answer now.
    //
    // So the claim is what holds and is still worth pinning: at teardown the drain is
    // NOT ATTEMPTED and the pointer is kept. The throwing spy stays as a belt — if the
    // code ever tries again, it both throws and is counted.
    //
    // ⚠ FOR WHOEVER ADDS A SECOND ABORT CAUSE (an owner's explicit stop of a running
    // task): the drain becomes reachable again on THAT path, and with it the question
    // this test used to ask. It will need its own case; this one will not cover it,
    // because `tearingDown` is false there by design.
    const h = makeHarness();
    await h.parked;
    const promptId = h.promptIdOf()!;
    expect(h.prompts.getById(promptId)?.status).toBe('pending');           // fixture guard
    expect(h.history.getTrigger('trg-1')?.status).toBe('waiting');         // and the park really happened
    const settleFails = vi.spyOn(h.prompts, 'expirePrompt').mockImplementation(() => {
      throw new Error('database is locked');
    });
    // ⚠ A CALL assertion here, because against a row the teardown leaves `pending` the
    // release is a no-op by its own SQL — there is no effect in THIS state to observe.
    // The state where the effect is real (a teardown racing a committed answer) has its
    // own test below, which asserts the effect; an earlier version of this comment
    // claimed that race could not be sequenced, which was wrong.
    const detach = vi.spyOn(h.prompts, 'releaseTrigger');
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    h.loop.stop();
    // The barrier is the RUN finishing, not the trigger being un-parked: the un-park is
    // the thing under test and waiting for it would be waiting for the defect.
    await waitUntil('the aborted run to finish',
      () => h.dispatches() > 0 && (h.history.getTrigger('trg-1')?.last_run_at ?? null) !== null);

    // Read the state, THEN restore, THEN assert — a failing assertion must not
    // leave stderr stubbed for the rest of the file.
    const row = h.prompts.getById(promptId);
    const drainAttempts = settleFails.mock.calls.length;
    const detachAttempts = detach.mock.calls.length;
    settleFails.mockRestore();
    detach.mockRestore();
    stderr.mockRestore();
    expect(drainAttempts, 'a teardown must not drain the question it is leaving behind').toBe(0);
    expect(detachAttempts, 'nor detach it from the trigger that will need it').toBe(0);
    expect(row?.status).toBe('pending');
    expect(row?.trigger_id).toBe('trg-1');
  });

  // ── Recurring triggers: the test pins today's shape ──

  it('a park SHIFTS a cron trigger\'s cadence by the wait', async () => {
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
