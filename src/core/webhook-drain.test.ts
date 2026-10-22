import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RunHistory } from './run-history.js';
import { EngineDb } from './engine-db.js';
import { TaskManager } from './task-manager.js';
import { WorkflowStore } from './workflow-store.js';
import { ConnectionStore } from './connection-store.js';
import { InboundEventStore } from './inbound-events.js';
import { EVENT_OUTCOME_UNKNOWN, EVENT_SHOP_MOVED, EVENT_TRIGGER_NOT_LIVE, WEBHOOK_ASKS_RESULT, WorkerLoop, outcomeOfRun } from './worker-loop.js';
import { MANDATE_TAG_PREFIX } from './request-principal.js';
import type { Engine } from './engine.js';
import type { NotificationRouter } from './notification-router.js';

// The workflow runner and the stored workflow are stand-ins: what the drain hands the runner is
// the subject here, not what a workflow does. Everything else — the ledger, the trigger row, its
// lease and the run frame — is the real thing on a real engine database.
const runner = vi.hoisted(() => ({
  run: vi.fn<(...args: unknown[]) => Promise<{ ok: boolean; status?: string; runId?: string; error?: string }>>(),
  mode: { value: 'autonomous' as string },
  steps: { value: [] as unknown[] },
}));
vi.mock('./saved-workflow-runner.js', () => ({ runGuardedSavedWorkflow: (...args: unknown[]) => runner.run(...args) }));
vi.mock('../tools/builtin/pipeline.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getPipeline: (id: string) => ({ id, name: 'Orders', mode: runner.mode.value, steps: runner.steps.value, confirmedAt: '2026-10-01T00:00:00.000Z' }),
}));

const SHOP = 'demo-store.myshopify.com';

describe('the webhook drain', () => {
  let dir: string;
  let history: RunHistory;
  let engineDb: EngineDb;
  let tm: TaskManager;
  let ledger: InboundEventStore;
  let loop: WorkerLoop;
  let notify: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.stubEnv('LYNOX_FEATURE_INBOUND_WEBHOOKS', 'true');
    runner.run.mockReset();
    runner.run.mockResolvedValue({ ok: true, status: 'completed', runId: 'run-1' });
    runner.mode.value = 'autonomous';
    runner.steps.value = [];
    dir = mkdtempSync(join(tmpdir(), 'lynox-webhook-drain-'));
    history = new RunHistory(join(dir, 'history.db'));
    engineDb = new EngineDb(join(dir, 'engine.db'));
    history.setVerbGraph(engineDb);
    tm = new TaskManager(history);
    ledger = new InboundEventStore(engineDb);
    new WorkflowStore(engineDb).upsert({ id: 'wf-orders', name: 'Orders', definitionJson: '{}', isTemplate: false }, null);
    connectShop('shop-a', 'demo-store');
    notify = vi.fn().mockResolvedValue(undefined);
    const router = { hasChannels: () => true, notify } as unknown as NotificationRouter;
    const engine = {
      getTaskManager: () => tm,
      getRunHistory: () => history,
      getEngineDb: () => engineDb,
      getApprovalStore: () => null,
      getAuditLog: () => null,
      getPromptStore: () => null,
      getMandateEnds: () => null,
      getSecretStore: () => null,
      getBulkLedger: () => null,
      getUserConfig: () => ({}),
      getToolContext: () => ({ containment: null }),
      escalateToUser: vi.fn(),
    } as unknown as Engine;
    loop = new WorkerLoop(engine, router, 60_000, undefined, { heartbeatMs: 20, ttlMs: 60_000 });
  });

  afterEach(() => {
    loop.stop();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    try { engineDb.close(); } catch { /* closed */ }
    history.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function connectShop(id: string, shop: string): void {
    new ConnectionStore(engineDb).upsert({
      id, kind: 'api', name: 'Shop', subjectId: null, direction: 'outbound',
      configJson: JSON.stringify({ base_url: `https://${shop}.myshopify.com/admin/api/2025-10`, auth: { type: 'oauth2', oauth: { preset_id: 'shopify', preset_params: { shop } } } }),
      vaultKeys: [], status: 'active',
    });
  }

  function sharedTrigger(): string {
    return tm.createWebhookTrigger({ title: 'Tickets', pipelineId: 'wf-orders', verifier: 'shared-token', confirmedAt: '2026-10-01T00:00:00.000Z' }).trigger.id;
  }
  function shopifyTrigger(): string {
    return tm.createWebhookTrigger({ title: 'Orders', pipelineId: 'wf-orders', verifier: 'shopify-hmac', connectionId: 'shop-a', confirmedAt: '2026-10-01T00:00:00.000Z' }).trigger.id;
  }
  let seq = 0;
  function deliver(triggerId: string, values: Record<string, string | number | boolean> = { email: 'kim@example.com' }, headers: Record<string, string> = {}): string {
    seq++;
    ledger.record({ triggerId, dedupKey: `k-${String(seq)}`, headers, state: 'received', values: { values, unread: {} }, now: `2026-10-22T12:00:${String(seq).padStart(2, '0')}.000Z` });
    return ledger.listByTrigger(triggerId).at(-1)!.id;
  }
  const eventOf = (triggerId: string, id: string) => ledger.listByTrigger(triggerId).find((e) => e.id === id)!;
  const lease = (triggerId: string): unknown => (engineDb.getDb().prepare('SELECT lease_holder FROM triggers WHERE id = ?').get(triggerId) as { lease_holder: unknown }).lease_holder;
  // The first run of the file imports the workflow modules on its way, which under load takes
  // longer than waitFor's default second.
  const settled = async (triggerId: string, id: string, state: string): Promise<void> => {
    await vi.waitFor(() => expect(eventOf(triggerId, id).state).toBe(state), { timeout: 5_000 });
    await vi.waitFor(() => expect(lease(triggerId)).toBeNull(), { timeout: 5_000 });
  };

  it('runs an event with its values as a third party\'s, under its own origin, and records it done', async () => {
    const t = sharedTrigger();
    const before = tm.getTrigger(t)!;
    const id = deliver(t, { email: 'kim@example.com', total: 12.5 });
    await loop.tick();
    await settled(t, id, 'done');
    expect(runner.run).toHaveBeenCalledTimes(1);
    const [, workflowId, params, opts] = runner.run.mock.calls[0]! as [unknown, string, unknown, { seed: string; origin: unknown }];
    expect(workflowId).toBe('wf-orders');
    expect(params).toEqual({ email: 'kim@example.com', total: 12.5 });
    expect(opts.seed).toBe('external-tool');
    expect(opts.origin).toEqual({ kind: 'webhook', triggerId: t, eventId: id });
    // Done: the values are not kept, and the trigger is as it was but for its last run.
    expect(eventOf(t, id).valuesJson).toBeNull();
    const after = tm.getTrigger(t)!;
    expect([after.status, after.next_run_at, after.enabled]).toEqual([before.status, before.next_run_at, before.enabled]);
    expect(after.last_run_status).toBe('success');
  });

  it('CONTROL: with the switch off it reads nothing and runs nothing', async () => {
    vi.stubEnv('LYNOX_FEATURE_INBOUND_WEBHOOKS', '');
    const t = sharedTrigger();
    const id = deliver(t);
    const spy = vi.spyOn(InboundEventStore.prototype, 'triggersWithWork');
    await loop.tick();
    expect(spy).not.toHaveBeenCalled();
    expect(runner.run).not.toHaveBeenCalled();
    expect(eventOf(t, id).state).toBe('received');
  });

  it('runs one event per trigger per tick, oldest first', async () => {
    const t = sharedTrigger();
    const first = deliver(t, { n: 1 });
    const second = deliver(t, { n: 2 });
    await loop.tick();
    await settled(t, first, 'done');
    expect(eventOf(t, second).state).toBe('received');
    await loop.tick();
    await settled(t, second, 'done');
    expect(runner.run.mock.calls.map((c) => c[2])).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it('records a failed run failed, with its reason, and keeps the values for a run again', async () => {
    runner.run.mockResolvedValue({ ok: false, error: 'the shop said no' });
    const t = sharedTrigger();
    const id = deliver(t);
    await loop.tick();
    await settled(t, id, 'failed');
    const ev = eventOf(t, id);
    expect(ev.reason).toContain('the shop said no');
    expect(JSON.parse(ev.valuesJson!)).toEqual({ values: { email: 'kim@example.com' }, unread: {} });
    // The trigger keeps accepting: a one-shot reading would have set it failed.
    expect(tm.getTrigger(t)!.status).toBe('open');
  });

  // G2: a question in a webhook run would carry a third party's text to the owner for consent.
  it('does not run a workflow that asks its owner, and says why on the event', async () => {
    runner.mode.value = 'interactive';
    runner.steps.value = [{ id: 's1', task: 'ask', tools: ['ask_user'] }];
    const t = sharedTrigger();
    const id = deliver(t);
    await loop.tick();
    await settled(t, id, 'failed');
    expect(runner.run).not.toHaveBeenCalled();
    expect(eventOf(t, id).reason).toContain(WEBHOOK_ASKS_RESULT);
    expect(eventOf(t, id).valuesJson).not.toBeNull();
  });

  it('gives the lease up when writing the outcome fails, and leaves the event running', async () => {
    vi.spyOn(InboundEventStore.prototype, 'finish').mockImplementation(() => { throw new Error('disk full'); });
    const written = vi.spyOn(process.stderr, 'write');
    const t = sharedTrigger();
    const id = deliver(t);
    await loop.tick();
    await vi.waitFor(() => expect(runner.run).toHaveBeenCalledTimes(1), { timeout: 5_000 });
    await vi.waitFor(() => expect(lease(t)).toBeNull());
    expect(eventOf(t, id).state).toBe('running');
    // Caught and said, not thrown out of the run's frame.
    expect(written.mock.calls.some((c) => String(c[0]).includes(`could not record the outcome of event ${id}`))).toBe(true);
  });

  // [L1]: the outcome is on the row before another process can take the trigger up.
  it('writes the outcome while the lease still holds', async () => {
    const t = sharedTrigger();
    const id = deliver(t);
    const seen: unknown[] = [];
    const real = InboundEventStore.prototype.finish;
    vi.spyOn(InboundEventStore.prototype, 'finish').mockImplementation(function (this: InboundEventStore, ...args) {
      seen.push(lease(t));
      return real.apply(this, args);
    });
    await loop.tick();
    await settled(t, id, 'done');
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toBeNull();
  });

  it('drops the oldest event of a trigger that no longer accepts one, and reports it once', async () => {
    const t = sharedTrigger();
    const id = deliver(t);
    tm.setEnabled(t, false);
    await loop.tick();
    expect(runner.run).not.toHaveBeenCalled();
    expect(eventOf(t, id)).toMatchObject({ state: 'dropped', reason: EVENT_TRIGGER_NOT_LIVE, valuesJson: null });
    await loop.tick();
    await loop.tick();
    const told = notify.mock.calls.filter((c) => String((c[0] as { body: string }).body).includes(EVENT_TRIGGER_NOT_LIVE));
    expect(told).toHaveLength(1);
  });

  it('CONTROL: a mandate\'s trigger the owner has not confirmed runs no event', async () => {
    const t = tm.createWebhookTrigger({ title: 'Theirs', pipelineId: 'wf-orders', verifier: 'shared-token', createdBy: `${MANDATE_TAG_PREFIX}eva@kanzlei.example` }).trigger.id;
    const id = deliver(t);
    await loop.tick();
    expect(runner.run).not.toHaveBeenCalled();
    expect(eventOf(t, id).state).toBe('dropped');
  });

  // sec-core (b): the connection can serve another shop by the time the event runs.
  it('drops a Shopify event whose shop the trigger\'s connection no longer serves', async () => {
    const t = shopifyTrigger();
    const id = deliver(t, { email: 'kim@example.com' }, { 'x-shopify-shop-domain': SHOP });
    connectShop('shop-a', 'other-store');
    await loop.tick();
    expect(runner.run).not.toHaveBeenCalled();
    expect(eventOf(t, id)).toMatchObject({ state: 'dropped', reason: EVENT_SHOP_MOVED, valuesJson: null });
  });

  it('CONTROL: a Shopify event of the connection\'s shop runs', async () => {
    const t = shopifyTrigger();
    const id = deliver(t, { email: 'kim@example.com' }, { 'x-shopify-shop-domain': SHOP });
    await loop.tick();
    await settled(t, id, 'done');
    expect(runner.run).toHaveBeenCalledTimes(1);
  });

  // sec-core (a): what the receiver dropped is never run, whatever it holds.
  it('never runs a dropped event, even one that holds values', async () => {
    const t = sharedTrigger();
    ledger.record({ triggerId: t, dedupKey: 'k-dropped', headers: {}, state: 'dropped', reason: 'misdelivered' });
    engineDb.getDb().prepare(`UPDATE inbound_events SET values_json = '{"values":{"a":1},"unread":{}}' WHERE dedup_key = 'k-dropped'`).run();
    await loop.tick();
    await loop.tick();
    expect(runner.run).not.toHaveBeenCalled();
    expect(notify.mock.calls.filter((c) => String((c[0] as { body: string }).body).includes('misdelivered'))).toHaveLength(1);
  });

  it('reports an event a lost process left running once, as of unknown outcome, and does not run it again', async () => {
    const t = sharedTrigger();
    const id = deliver(t);
    expect(ledger.begin(id, 'attempt-of-a-lost-process')).toBe(true);
    await loop.tick();
    await loop.tick();
    expect(runner.run).not.toHaveBeenCalled();
    expect(eventOf(t, id).state).toBe('running');
    expect(notify.mock.calls.filter((c) => (c[0] as { body: string }).body === EVENT_OUTCOME_UNKNOWN)).toHaveLength(1);
    expect(lease(t)).toBeNull();
  });

  it('starts no second event of a trigger whose run is still going', async () => {
    let finish: (v: { ok: boolean; status: string }) => void = () => undefined;
    runner.run.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const t = sharedTrigger();
    const first = deliver(t);
    const second = deliver(t);
    await loop.tick();
    await vi.waitFor(() => expect(runner.run).toHaveBeenCalledTimes(1), { timeout: 5_000 });
    await loop.tick();
    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(eventOf(t, second).state).toBe('received');
    finish({ ok: true, status: 'completed' });
    await settled(t, first, 'done');
  });

  // The frame is shared: what holds a due trigger's run holds a webhook run.
  it('renews the lease while a webhook run goes on', async () => {
    let finish: (v: { ok: boolean; status: string }) => void = () => undefined;
    runner.run.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const t = sharedTrigger();
    const id = deliver(t);
    await loop.tick();
    await vi.waitFor(() => expect(runner.run).toHaveBeenCalledTimes(1), { timeout: 5_000 });
    const until = (): string => (engineDb.getDb().prepare('SELECT lease_until FROM triggers WHERE id = ?').get(t) as { lease_until: string }).lease_until;
    const first = until();
    await vi.waitFor(() => expect(until() > first).toBe(true));
    finish({ ok: true, status: 'completed' });
    await settled(t, id, 'done');
  });

  it('ends a webhook run on the owner\'s stop, through the run\'s stop signal and its step agents', async () => {
    const stepAbort = vi.fn();
    runner.run.mockImplementationOnce((...args: unknown[]) => {
      const opts = args[3] as { stopSignal: AbortSignal; abortScope: { members: Set<{ abort: () => void }> } };
      opts.abortScope.members.add({ abort: stepAbort });
      return new Promise((resolve) => {
        opts.stopSignal.addEventListener('abort', () => resolve({ ok: true, status: 'failed', error: 'stopped' }), { once: true });
      });
    });
    const t = sharedTrigger();
    const id = deliver(t);
    await loop.tick();
    await vi.waitFor(() => expect(runner.run).toHaveBeenCalledTimes(1), { timeout: 5_000 });
    expect(loop.stopTask(t)).toEqual({ kind: 'requested', via: 'signal' });
    await settled(t, id, 'failed');
    expect(stepAbort).toHaveBeenCalledTimes(1);
  });

  it('clears, on its pass, the values of an event that failed longer ago than the window', async () => {
    const t = sharedTrigger();
    ledger.record({ triggerId: t, dedupKey: 'k-old', headers: {}, state: 'received', values: { values: { a: 1 }, unread: {} }, now: '2020-01-01T00:00:00.000Z' });
    const old = ledger.listByTrigger(t)[0]!.id;
    expect(ledger.begin(old, 'a-old')).toBe(true);
    expect(ledger.finish(old, 'a-old', { state: 'failed', reason: 'x' })).toBe(true);
    const recent = deliver(t);
    expect(ledger.begin(recent, 'a-new')).toBe(true);
    expect(ledger.finish(recent, 'a-new', { state: 'failed', reason: 'x' })).toBe(true);
    await loop.tick();
    expect(eventOf(t, old).valuesJson).toBeNull();
    expect(eventOf(t, recent).valuesJson).not.toBeNull();
  });

  it('clears the values an event kept once the window to run it again has passed', () => {
    const t = sharedTrigger();
    const id = deliver(t);
    expect(ledger.begin(id, 'a1')).toBe(true);
    expect(ledger.finish(id, 'a1', { state: 'failed', reason: 'x' })).toBe(true);
    expect(ledger.sweepValues('2026-10-22T12:00:00.000Z')).toBe(0);
    expect(ledger.sweepValues('2026-11-30T00:00:00.000Z')).toBe(1);
    expect(eventOf(t, id).valuesJson).toBeNull();
  });
});

describe('the ledger\'s moves', () => {
  let dir: string;
  let engineDb: EngineDb;
  let ledger: InboundEventStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-ledger-moves-'));
    engineDb = new EngineDb(join(dir, 'engine.db'));
    ledger = new InboundEventStore(engineDb);
  });
  afterEach(() => {
    engineDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // [R2-2]: a late writer whose attempt was superseded changes nothing.
  it('writes an outcome only for the attempt that holds the event', () => {
    ledger.record({ triggerId: 't1', dedupKey: 'k1', headers: {}, state: 'received', values: { values: { a: 1 }, unread: {} } });
    const id = ledger.listByTrigger('t1')[0]!.id;
    expect(ledger.begin(id, 'a1')).toBe(true);
    expect(ledger.begin(id, 'a2')).toBe(false);
    expect(ledger.finish(id, 'a2', { state: 'done' })).toBe(false);
    expect(ledger.listByTrigger('t1')[0]!.state).toBe('running');
    expect(ledger.finish(id, 'a1', { state: 'done' })).toBe(true);
    expect(ledger.finish(id, 'a1', { state: 'failed', reason: 'late' })).toBe(false);
    expect(ledger.listByTrigger('t1')[0]).toMatchObject({ state: 'done', valuesJson: null });
  });

  it('reports each dropped and each lost event once', () => {
    ledger.record({ triggerId: 't1', dedupKey: 'k1', headers: {}, state: 'dropped', reason: 'r' });
    const id = ledger.listByTrigger('t1')[0]!.id;
    expect(ledger.triggersWithWork()).toEqual(['t1']);
    expect(ledger.markReported(id)).toBe(true);
    expect(ledger.markReported(id)).toBe(false);
    expect(ledger.triggersWithWork()).toEqual([]);
  });
});

describe('an event\'s outcome from its run', () => {
  it('is done only for a success; any other end, or none, fails with the run\'s result', () => {
    expect(outcomeOfRun({ ended: 'success' }, 'Pipeline completed')).toEqual({ state: 'done' });
    expect(outcomeOfRun({ ended: 'failed' }, 'boom')).toEqual({ state: 'failed', reason: 'The run ended failed. boom' });
    expect(outcomeOfRun({ ended: 'stopped' }, null)).toEqual({ state: 'failed', reason: 'The run ended stopped.' });
    expect(outcomeOfRun({ ended: undefined }, 'x')).toEqual({ state: 'failed', reason: 'The run ended without a recorded result. x' });
  });
});
