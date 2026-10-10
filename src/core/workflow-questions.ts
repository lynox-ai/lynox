import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages.js';
import type { PromptMeta, PromptText, PromptUserFn } from '../types/index.js';
import type { AbortScope } from '../types/config.js';
import type { PromptStore } from './prompt-store.js';
import { promptOriginOf } from './prompt-store.js';
import type { ThreadStore } from './thread-store.js';
import type { NotificationMessage, NotifyReport, DeliverySummary } from './notification-router.js';
import { summarizeDelivery } from './notification-router.js';
import { flattenPrompt, offBoxPrompt, promptSegments } from './prompt-value.js';

/** What the runner reads off a scheduled workflow run that may ask its owner (PRD 3b-2 §4.5, G5). */
export interface WorkflowQuestionWait {
  /** A question of this run went unanswered until its TTL ran out: the run halts. */
  readonly unanswered: boolean;
  /** Milliseconds this run has spent waiting for an answer, so the wall clock leaves them out. */
  pausedMs(now?: number): number;
}

export interface WorkflowQuestionDeps {
  /** The run's id. The question's session and the run's thread carry it. */
  runId: string;
  /** The schedule that fired the run, named on the notification. */
  scheduleId: string;
  /** The schedule's title: the thread's title and the notification's. */
  title: string;
  /** Who started the run (`principalTag`), stamped on the prompt row and the thread. */
  createdBy: string;
  handRun: boolean;
  /** Read when a question is asked, not when the run starts: both stores can come and go
   *  with the engine's init. */
  promptStore: () => PromptStore | null;
  threadStore: () => ThreadStore | null;
  /** Masks what is known to be a secret, for the copy that leaves the box. */
  maskOffBox: (text: string) => string;
  notify: (msg: NotificationMessage) => Promise<NotifyReport>;
  /** Starts the delivery record on the schedule and returns the writer of its outcome. */
  recordDelivery: () => (delivery: DeliverySummary) => void;
  /** The owner's stop. */
  ownerStop: AbortSignal;
  /** The task controller: aborted at teardown, and by the owner's stop too. */
  teardown: AbortSignal;
  /** Whether the process is tearing the run down (`ActiveTask.tearingDown`). */
  tearingDown: () => boolean;
  /** The run's scope. An unanswered question aborts it, so every step in flight ends. */
  abortScope: AbortScope;
  /** Tells the run entry which question is open, so a stop reports `wait`. */
  onPending: (promptId: string | undefined) => void;
}

/** The answer slot's marker for "nobody answered". It is an answer the model reads, not an end:
 *  where the run must stop, the scope abort or the step's own aborted signal ends it. */
const DISMISSED_ANSWER = '__dismissed__';

/** A promise that never settles: what a step gets when the process is tearing its run down. */
const neverSettles = (): Promise<string> => new Promise<string>(() => { /* the run stands until the process ends */ });

/**
 * The question channel of a scheduled workflow run (PRD 3b-2 §4.1–§4.7): the steps' `ask_user`
 * reaches the owner through here.
 *
 * Unlike the task path (`executeStandard`) the question carries no `trigger_id` and nothing is
 * parked: a run that waits survives only in this process (G1 (a)), so no re-arm or expiry sweep
 * may reach it.
 *
 * The run gets one thread, named by its run id, which is also the session id of its questions:
 * the owner opens it from the thread list, and the store's "one open question per session" index
 * becomes "one open question per run". Steps of a parallel phase take turns here, so the second
 * question waits for the first to settle instead of failing on that index.
 */
export class WorkflowQuestions implements WorkflowQuestionWait {
  readonly #deps: WorkflowQuestionDeps;
  #unanswered = false;
  #pausedMs = 0;
  #waitingSince: number | undefined;
  #threadReady = false;
  /** The turn the next question waits for. */
  #turn: Promise<void> = Promise.resolve();

  constructor(deps: WorkflowQuestionDeps) {
    this.#deps = deps;
  }

  get unanswered(): boolean { return this.#unanswered; }

  pausedMs(now: number = Date.now()): number {
    return this.#pausedMs + (this.#waitingSince !== undefined ? now - this.#waitingSince : 0);
  }

  /** The `parentAskUserPrompt` the run's steps get. */
  readonly ask: PromptUserFn = async (question, options, meta) => {
    const previous = this.#turn;
    let release!: () => void;
    this.#turn = new Promise<void>((resolve) => { release = resolve; });
    try {
      await previous;
      return await this.#askNow(question, options, meta);
    } finally {
      release();
    }
  };

  async #askNow(rawQuestion: string | PromptText, options: string[] | undefined, meta: PromptMeta | undefined): Promise<string> {
    const deps = this.#deps;
    // Before anything is written: a run that is already over must not leave a question behind,
    // or push one at its owner. A step that waited its turn behind a question that went
    // unanswered ends here too, with no row of its own (§4.5).
    const early = this.#causeOfEnd(meta?.signal);
    if (early === 'teardown') return neverSettles();
    if (early !== undefined) return DISMISSED_ANSWER;
    const store = deps.promptStore();
    if (!store) return DISMISSED_ANSWER;

    const question = flattenPrompt(rawQuestion);
    const segments = promptSegments(rawQuestion);
    const storedSegments = segments.some((s) => s.kind === 'value') ? segments : undefined;
    const offBoxText = flattenPrompt(offBoxPrompt(rawQuestion));
    // No `trigger_id`: neither the re-arm nor the expiry sweep may find this question (§4.4).
    let promptId: string;
    try {
      promptId = store.insertAskUser(deps.runId, question, options, undefined, storedSegments, promptOriginOf(meta), undefined, {
        createdBy: deps.createdBy,
        handRun: deps.handRun,
      });
    } catch (err: unknown) {
      // The question could not be put to the owner — e.g. a question of the owner's own chat
      // in the run's thread holds the session's one open slot. Not an answer: carrying on would
      // let the step act on a guess, so the run ends as one whose question went unanswered.
      process.stderr.write(`[lynox:worker] asking a workflow question failed: ${err instanceof Error ? err.message : String(err)}\n`);
      return this.#endUnanswered();
    }
    // Written only once the question exists, so the thread never shows one nobody can answer.
    this.#writeToThread(offBoxText);
    deps.onPending(promptId);
    this.#waitingSince = Date.now();
    this.#notify(deps.maskOffBox(offBoxText), options, promptId);

    const signals = [deps.ownerStop, deps.teardown, ...(meta?.signal !== undefined ? [meta.signal] : [])];
    try {
      const outcome = await store.waitForSettled(promptId, AbortSignal.any(signals));
      if (outcome.status === 'answered') return outcome.row.answer ?? DISMISSED_ANSWER;
      // The cause is read here, after the wait, and never in a settled listener: at shutdown
      // `expireUnparked` settles this wait as `expired` BEFORE `stop()` marks the teardown, and a
      // deploy read as a TTL would record the run failed and escalate it (§4.8). The row says
      // which it was, whatever the order — read only when the run itself says nothing, so a
      // teardown that already closed the database is not a query that throws.
      const cause = this.#causeOfEnd(meta?.signal) ?? this.#causeFromRow(store, promptId);
      if (cause === 'teardown') return neverSettles();
      if (cause === 'ttl') return this.#endUnanswered();
      // A stop or a withdrawal: the question goes, so an answer given later finds it closed.
      try { store.expirePrompt(promptId); } catch (err: unknown) {
        process.stderr.write(`[lynox:worker] withdrawing a workflow question failed: ${err instanceof Error ? err.message : String(err)}\n`);
      }
      return DISMISSED_ANSWER;
    } finally {
      if (this.#waitingSince !== undefined) this.#pausedMs += Date.now() - this.#waitingSince;
      this.#waitingSince = undefined;
      deps.onPending(undefined);
    }
  }

  /** The run goes on no further: no later step runs, and every step in flight ends (§4.5). */
  #endUnanswered(): string {
    this.#unanswered = true;
    for (const member of this.#deps.abortScope.members) {
      try { member.abort(); } catch { /* the next one still gets its abort */ }
    }
    return DISMISSED_ANSWER;
  }

  /**
   * Why an expired question expired, when nothing on the run says so: the shutdown's sweep
   * (`process_restarted`), or its TTL. A database the engine already closed is a teardown too.
   * Any other failed read ends the run unanswered — bounded and safe for the steps after it,
   * where a step left waiting would hold the run until the process ends.
   */
  #causeFromRow(store: PromptStore, promptId: string): 'teardown' | 'ttl' {
    try {
      return store.getById(promptId)?.closed_reason === 'process_restarted' ? 'teardown' : 'ttl';
    } catch {
      return store.isOpen() ? 'ttl' : 'teardown';
    }
  }

  /**
   * Why the wait ended, or would, read off the run rather than off the store (§4.5): the store
   * reports a TTL and a withdrawal alike. The owner's stop comes first, so a stop that meets a
   * teardown still ends the run as stopped. `undefined` = nothing has ended it.
   */
  #causeOfEnd(stepSignal: AbortSignal | undefined): 'stop' | 'teardown' | 'withdrawn' | 'ttl' | undefined {
    const deps = this.#deps;
    if (deps.ownerStop.aborted) return 'stop';
    if (deps.tearingDown() || deps.teardown.aborted) return 'teardown';
    if (stepSignal?.aborted === true) return 'withdrawn';
    if (this.#unanswered) return 'ttl';
    return undefined;
  }

  /**
   * The question as a message in the run's thread, which is created with the first one. Without
   * a message a thread does not appear in the list. A thread that cannot be written costs the
   * owner the list entry, not the question: the notification and the stored row still reach them.
   */
  #writeToThread(text: string): void {
    const threads = this.#deps.threadStore();
    if (!threads) return;
    const id = this.#deps.runId;
    try {
      if (!this.#threadReady) {
        threads.createThread(id, { title: this.#deps.title, created_by: this.#deps.createdBy });
        this.#threadReady = true;
      }
      // A resumable conversation starts with a user turn and alternates, as an escalation
      // thread does (`escalation.ts`).
      const last = threads.getMessages(id, { apiOnly: true }).at(-1)?.role ?? null;
      const seeds: BetaMessageParam[] = [];
      if (last === null || last === 'assistant') seeds.push({ role: 'user', content: [{ type: 'text', text: this.#deps.title }] });
      seeds.push({ role: 'assistant', content: [{ type: 'text', text }] });
      const count = threads.getThread(id)?.message_count ?? 0;
      threads.appendMessages(id, seeds, threads.getNextSeq(id), { message_count: count + seeds.length });
      threads.updateThread(id, { is_unread: true });
    } catch (err: unknown) {
      process.stderr.write(`[lynox:worker] writing a workflow question to its thread failed: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  /** The question to the owner, with whether it reached anyone written on the schedule (§4.7). */
  #notify(offBoxQuestion: string, options: string[] | undefined, promptId: string): void {
    const deps = this.#deps;
    const record = deps.recordDelivery();
    void deps.notify({
      title: `❓ ${deps.title}`,
      body: offBoxQuestion,
      taskId: deps.scheduleId,
      priority: 'high',
      data: { threadId: deps.runId, promptId },
      inquiry: { question: offBoxQuestion, options },
    }).then((report) => { record(summarizeDelivery(report)); }).catch((err: unknown) => {
      process.stderr.write(`[lynox:worker] recording a workflow question's delivery failed: ${err instanceof Error ? err.message : String(err)}\n`);
    });
  }
}
