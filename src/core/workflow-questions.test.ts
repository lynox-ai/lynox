import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunHistory } from './run-history.js';
import { PromptStore } from './prompt-store.js';
import { ThreadStore } from './thread-store.js';
import type { NotificationMessage, NotifyReport, DeliverySummary } from './notification-router.js';
import { WorkflowQuestions, type WorkflowQuestionDeps } from './workflow-questions.js';

/**
 * The question channel of a scheduled workflow run (PRD 3b-2 §4.1–§4.8), over a real prompt
 * store and a real thread store on one history database, as the engine wires them.
 */
const RUN_ID = '11111111-2222-4333-8444-555555555555';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
  vi.useRealTimers();
});

interface Harness {
  q: WorkflowQuestions;
  prompts: PromptStore;
  threads: ThreadStore;
  history: RunHistory;
  ownerStop: AbortController;
  controller: AbortController;
  scopeMember: { abort: ReturnType<typeof vi.fn> };
  notified: NotificationMessage[];
  deliveries: DeliverySummary[];
  pending: Array<string | undefined>;
  tearingDown: { value: boolean };
}

function makeHarness(overrides?: Partial<WorkflowQuestionDeps>): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'lynox-wfq-'));
  const history = new RunHistory(join(dir, 'history.db'));
  cleanups.push(() => { try { history.close(); } catch { /* closed */ } rmSync(dir, { recursive: true, force: true }); });
  const prompts = new PromptStore(history.getDb());
  const threads = new ThreadStore(history.getDb());
  const ownerStop = new AbortController();
  const controller = new AbortController();
  const scopeMember = { abort: vi.fn() };
  const notified: NotificationMessage[] = [];
  const deliveries: DeliverySummary[] = [];
  const pending: Array<string | undefined> = [];
  const tearingDown = { value: false };
  const q = new WorkflowQuestions({
    runId: RUN_ID,
    scheduleId: 'trg-wf',
    title: 'Weekly offer',
    createdBy: 'owner',
    handRun: false,
    promptStore: () => prompts,
    threadStore: () => threads,
    maskOffBox: (text) => text.replace('sk-secret-123', '***123'),
    notify: async (msg): Promise<NotifyReport> => { notified.push(msg); return [{ channel: 'push', outcome: 'delivered' }]; },
    recordDelivery: () => (d) => { deliveries.push(d); },
    ownerStop: ownerStop.signal,
    teardown: controller.signal,
    tearingDown: () => tearingDown.value,
    abortScope: { members: new Set([scopeMember]) },
    onPending: (id) => { pending.push(id); },
    ...overrides,
  });
  return { q, prompts, threads, history, ownerStop, controller, scopeMember, notified, deliveries, pending, tearingDown };
}

/** The open question of the run, once it is written. */
async function openQuestion(h: Harness): Promise<string> {
  await vi.waitFor(() => { expect(h.prompts.getPending(RUN_ID)).toBeDefined(); });
  return h.prompts.getPending(RUN_ID)!.id;
}

/** Whether `p` is still unsettled after the store has had every chance to settle it. */
async function stillPending(p: Promise<unknown>): Promise<boolean> {
  const marker = Symbol('pending');
  const winner = await Promise.race([p, new Promise((r) => { setTimeout(() => r(marker), 50); })]);
  return winner === marker;
}

describe('a question of a scheduled workflow run', () => {
  it('lands in the run\'s thread, carries no trigger, reaches the owner and records the delivery', async () => {
    const h = makeHarness();
    const answer = h.q.ask('Which list, A or B?', ['A', 'B'], { stepId: 'pick', stepTask: 'pick a list', workflowName: 'Weekly offer' });
    const id = await openQuestion(h);
    const row = h.prompts.getById(id)!;
    expect(row.session_id).toBe(RUN_ID);
    expect(row.trigger_id).toBeNull();
    expect(row.created_by).toBe('owner');
    expect(JSON.parse(row.origin_json ?? '{}')).toMatchObject({ stepId: 'pick', workflowName: 'Weekly offer' });

    const thread = h.threads.getThread(RUN_ID)!;
    expect(thread).toMatchObject({ title: 'Weekly offer', created_by: 'owner', is_unread: 1 });
    expect(h.threads.listThreads().map((t) => t.id)).toContain(RUN_ID);
    const msgs = h.threads.getMessages(RUN_ID, { apiOnly: true });
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(msgs[1]!.content_json).toContain('Which list, A or B?');

    expect(h.notified).toHaveLength(1);
    expect(h.notified[0]).toMatchObject({
      taskId: 'trg-wf', priority: 'high', data: { threadId: RUN_ID, promptId: id },
      inquiry: { question: 'Which list, A or B?', options: ['A', 'B'] },
    });
    await vi.waitFor(() => { expect(h.deliveries).toEqual(['delivered']); });
    expect(h.pending).toEqual([id]);

    h.prompts.answerUser(id, 'B');
    await expect(answer).resolves.toBe('B');
    expect(h.pending).toEqual([id, undefined]);
    expect(h.q.unanswered).toBe(false);
  });

  it('masks a known secret in the copy that leaves the box, not in the stored row', async () => {
    const h = makeHarness();
    void h.q.ask('Use key sk-secret-123?');
    const id = await openQuestion(h);
    expect(h.notified[0]!.body).toBe('Use key ***123?');
    expect(h.prompts.getById(id)!.question).toBe('Use key sk-secret-123?');
  });

  it('two questions of one run take turns: the second is written once the first is answered', async () => {
    const h = makeHarness();
    const first = h.q.ask('First?');
    const second = h.q.ask('Second?');
    const firstId = await openQuestion(h);
    expect(h.prompts.getById(firstId)!.question).toBe('First?');
    h.prompts.answerUser(firstId, 'one');
    await expect(first).resolves.toBe('one');
    await vi.waitFor(() => { expect(h.prompts.getPending(RUN_ID)?.question).toBe('Second?'); });
    h.prompts.answerUser(h.prompts.getPending(RUN_ID)!.id, 'two');
    await expect(second).resolves.toBe('two');
    expect(h.threads.getMessages(RUN_ID, { apiOnly: true }).filter((m) => m.role === 'assistant')).toHaveLength(2);
  });

  it('counts the time spent waiting, so the wall clock can leave it out', async () => {
    const h = makeHarness();
    const answer = h.q.ask('Wait for me?');
    const id = await openQuestion(h);
    const since = Date.now();
    await new Promise((r) => { setTimeout(r, 30); });
    expect(h.q.pausedMs()).toBeGreaterThanOrEqual(25);
    h.prompts.answerUser(id, 'yes');
    await answer;
    const total = h.q.pausedMs();
    expect(total).toBeGreaterThanOrEqual(Date.now() - since - 5);
    await new Promise((r) => { setTimeout(r, 20); });
    // Not waiting any more: the count stands.
    expect(h.q.pausedMs()).toBe(total);
  });
});

describe('how the wait ends (§4.5)', () => {
  it('the owner\'s stop withdraws the question and marks nothing', async () => {
    const h = makeHarness();
    const answer = h.q.ask('Stop me?');
    const id = await openQuestion(h);
    h.ownerStop.abort();
    h.controller.abort();
    await expect(answer).resolves.toBe('__dismissed__');
    expect(h.prompts.getById(id)!.status).toBe('expired');
    expect(h.q.unanswered).toBe(false);
    expect(h.scopeMember.abort).not.toHaveBeenCalled();
  });

  it('the TTL marks the run unanswered and aborts its scope', async () => {
    const h = makeHarness();
    const answer = h.q.ask('Nobody answers?');
    const id = await openQuestion(h);
    h.history.getDb().prepare('UPDATE pending_prompts SET expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), id);
    h.prompts.expireOld();
    await expect(answer).resolves.toBe('__dismissed__');
    expect(h.q.unanswered).toBe(true);
    expect(h.scopeMember.abort).toHaveBeenCalledTimes(1);
  });

  it('a step waiting its turn behind a question that expires ends without a question of its own', async () => {
    const h = makeHarness();
    const first = h.q.ask('First?');
    const second = h.q.ask('Second?');
    const id = await openQuestion(h);
    h.history.getDb().prepare('UPDATE pending_prompts SET expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), id);
    h.prompts.expireOld();
    await expect(first).resolves.toBe('__dismissed__');
    await expect(second).resolves.toBe('__dismissed__');
    const rows = h.history.getDb().prepare('SELECT question FROM pending_prompts WHERE session_id = ?').all(RUN_ID) as Array<{ question: string }>;
    expect(rows.map((r) => r.question)).toEqual(['First?']);
    expect(h.notified).toHaveLength(1);
  });

  it('a shutdown that closes the question before the teardown is marked: no answer, nothing marked', async () => {
    // The shutdown's `expireUnparked` runs BEFORE `stop()` sets the teardown flag (§4.8), so the
    // wait settles as `expired` while nothing on the run says teardown yet. The row's reason does.
    const h = makeHarness();
    const answer = h.q.ask('Across a deploy?');
    const id = await openQuestion(h);
    h.prompts.expireUnparked();
    expect(await stillPending(answer)).toBe(true);
    expect(h.q.unanswered).toBe(false);
    expect(h.scopeMember.abort).not.toHaveBeenCalled();
    expect(h.prompts.getById(id)!.closed_reason).toBe('process_restarted');
  });

  it('a shutdown that closes the database before the wait continues still answers nothing', async () => {
    // `LynoxHTTPApi.shutdown()` closes the rows, `stop()` aborts the controller, and the engine
    // can reach `runHistory.close()` with no await in between; the wait continues afterwards.
    // Reading the row then throws. The step must get no rejection — a rejection is a tool error
    // its agent reads and carries on from.
    const h = makeHarness();
    const answer = h.q.ask('Across a fast shutdown?');
    await openQuestion(h);
    h.prompts.expireUnparked();
    h.history.close();
    expect(await stillPending(answer.catch((err: unknown) => `REJECTED ${String(err)}`))).toBe(true);
    expect(h.q.unanswered).toBe(false);
    expect(h.scopeMember.abort).not.toHaveBeenCalled();
  });

  it('a question the store refuses ends the run unanswered, and leaves no message in the thread', async () => {
    // The owner's own chat in the run's thread holds the session's one open slot.
    const h = makeHarness();
    h.prompts.insertAskUser(RUN_ID, 'A question of the owner\'s own chat');
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await expect(h.q.ask('Which list?')).resolves.toBe('__dismissed__');
    } finally { write.mockRestore(); }
    expect(h.q.unanswered).toBe(true);
    expect(h.scopeMember.abort).toHaveBeenCalledTimes(1);
    expect(h.threads.getMessages(RUN_ID)).toEqual([]);
    expect(h.notified).toHaveLength(0);
  });

  it('a teardown through the controller leaves the question open for the next process to close', async () => {
    const h = makeHarness();
    const answer = h.q.ask('Across a crash-free stop?');
    const id = await openQuestion(h);
    h.tearingDown.value = true;
    h.controller.abort();
    expect(await stillPending(answer)).toBe(true);
    expect(h.prompts.getById(id)!.status).toBe('pending');
    expect(h.q.unanswered).toBe(false);
  });

  it('a withdrawal through the step\'s signal fails the step without marking the run', async () => {
    const h = makeHarness();
    const step = new AbortController();
    const answer = h.q.ask('Withdrawn?', undefined, { signal: step.signal });
    const id = await openQuestion(h);
    step.abort();
    await expect(answer).resolves.toBe('__dismissed__');
    expect(h.prompts.getById(id)!.status).toBe('expired');
    expect(h.q.unanswered).toBe(false);
    expect(h.scopeMember.abort).not.toHaveBeenCalled();
  });

  it('a run already stopped asks nothing: no row, no notification', async () => {
    const h = makeHarness();
    h.ownerStop.abort();
    await expect(h.q.ask('Too late?')).resolves.toBe('__dismissed__');
    expect(h.prompts.getPending(RUN_ID)).toBeUndefined();
    expect(h.notified).toHaveLength(0);
  });

  it('a run already being torn down asks nothing and gets no answer', async () => {
    const h = makeHarness();
    h.tearingDown.value = true;
    h.controller.abort();
    expect(await stillPending(h.q.ask('During shutdown?'))).toBe(true);
    expect(h.prompts.getPending(RUN_ID)).toBeUndefined();
    expect(h.notified).toHaveLength(0);
  });

  it('the stop wins over a teardown that reaches the same wait', async () => {
    const h = makeHarness();
    const answer = h.q.ask('Both?');
    await openQuestion(h);
    h.tearingDown.value = true;
    h.ownerStop.abort();
    h.controller.abort();
    await expect(answer).resolves.toBe('__dismissed__');
  });
});
