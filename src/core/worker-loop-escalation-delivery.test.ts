import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * A failed scheduled workflow escalates (a thread plus a wakeup). Whether that wakeup reached
 * anyone is written onto the trigger, so the case reads "gemeldet / nicht gemeldet". Driven
 * through a REAL TaskManager + RunHistory + engine.db, the real escalation primitive and a
 * real router; only the workflow runner and the channels are doubles.
 */

vi.mock('./saved-workflow-runner.js', () => ({
  runGuardedSavedWorkflow: vi.fn(async () => ({ ok: true, status: 'failed', runId: 'run-1', stepErrors: [{ stepId: 's1', error: 'boom' }] })),
}));
vi.mock('../tools/builtin/pipeline.js', async (orig) => ({
  ...(await orig<typeof import('../tools/builtin/pipeline.js')>()),
  getPipeline: vi.fn(() => ({ id: 'wf-1', mode: 'autonomous', confirmedAt: '2026-01-01T00:00:00.000Z' })),
}));

const { WorkerLoop } = await import('./worker-loop.js');
const { RunHistory } = await import('./run-history.js');
const { EngineDb } = await import('./engine-db.js');
const { TaskManager } = await import('./task-manager.js');
const { NotificationRouter } = await import('./notification-router.js');
const { escalateToUser } = await import('./escalation.js');
import type { Engine } from './engine.js';
import type { ChannelOutcome } from './notification-router.js';
import type { EscalateOpts } from './escalation.js';

const T0 = Date.parse('2026-01-01T09:00:30.000Z');
const DUE = '2026-01-01T09:00:00.000Z';

const dirs: string[] = [];
const closers: Array<() => void> = [];

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const c of closers.splice(0).reverse()) c();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Escalation { at: string | null; outcome: string | null }

type Channel = ChannelOutcome | ((row: () => Escalation) => Promise<ChannelOutcome>);

/**
 * One engine on a fresh dir, its channels answering as given (an outcome, or a function that
 * sees the trigger's record at send time); ticks the trigger once. `awaitAnswer: false` for a
 * channel that never answers.
 */
async function failOnce(channels: Channel[], awaitAnswer = true): Promise<{ escalation: () => Escalation; escalated: number }> {
  const dir = mkdtempSync(join(tmpdir(), 'lynox-escal-'));
  dirs.push(dir);
  const history = new RunHistory(join(dir, 'history.db'));
  const engineDb = new EngineDb(join(dir, 'engine.db'));
  history.setVerbGraph(engineDb);
  closers.push(() => { try { history.close(); } catch { /* twice is fine */ } });
  closers.push(() => { try { engineDb.close(); } catch { /* twice is fine */ } });
  const manager = new TaskManager(history);
  const router = new NotificationRouter();
  const escalation = (): Escalation =>
    engineDb.getDb().prepare('SELECT last_escalation_at AS at, last_escalation_outcome AS outcome FROM triggers WHERE id = ?').get('trg-1') as Escalation;
  channels.forEach((c, i) => router.register({ name: `ch${String(i)}`, send: async () => (typeof c === 'function' ? c(escalation) : c) }));

  let escalated = 0;
  let settled!: () => void;
  const done = new Promise<void>((r) => { settled = r; });
  const engine = {
    getTaskManager: () => manager,
    getPromptStore: () => null,
    getRunHistory: () => history,
    getSecretStore: () => null,
    getBulkLedger: () => null,
    getUserConfig: () => ({}),
    workerRunModelOverride: () => ({}),
    escalateToUser: (opts: EscalateOpts) => {
      escalated++;
      return escalateToUser(null, router, {
        ...opts,
        onReported: (d) => { try { opts.onReported?.(d); } finally { settled(); } },
      });
    },
  } as unknown as Engine;
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);

  // The trigger's target is a real foreign key; without the row it reads as deleted.
  engineDb.getDb().prepare("INSERT INTO workflows (id, name, definition_json) VALUES ('wf-1', 'W', '{}')").run();
  history.insertTrigger({
    id: 'trg-1', title: 'Nightly export', source: 'cron', effect: 'run_workflow',
    scheduleCron: '0 9 * * *', nextRunAt: DUE, pipelineId: 'wf-1',
  });
  const loop = new WorkerLoop(engine, router, 60_000);
  closers.push(() => loop.stop());
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  await loop.tick();
  await vi.waitFor(() => { expect(escalated).toBe(1); });
  if (awaitAnswer) await done;
  return { escalation, escalated };
}

describe('a failed scheduled workflow records whether its escalation reached anyone', () => {
  it('gemeldet: a channel delivered the wakeup', async () => {
    const { escalation } = await failOnce(['delivered']);
    expect(escalation().outcome).toBe('delivered');
    expect(escalation().at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('nicht gemeldet: the only channel merely handled it', async () => {
    const { escalation } = await failOnce(['skipped']);
    expect(escalation().outcome).toBe('not_delivered');
  });

  it('nicht gemeldet: the channel failed', async () => {
    const { escalation } = await failOnce(['failed']);
    expect(escalation().outcome).toBe('not_delivered');
  });

  it('nicht gemeldet (kein Kanal): nothing registered', async () => {
    const { escalation } = await failOnce([]);
    expect(escalation().outcome).toBe('no_channel');
  });

  it('the start is on the trigger before the wakeup leaves', async () => {
    let seenAtSend: Escalation | undefined;
    const { escalation } = await failOnce([async (row) => { seenAtSend = row(); return 'delivered'; }]);
    expect(seenAtSend?.outcome).toBe('unconfirmed');
    expect(seenAtSend?.at).toBe(escalation().at);
    expect(escalation().outcome).toBe('delivered');
  });

  it('a channel that never answers leaves the escalation unconfirmed, not the previous outcome', async () => {
    const { escalation } = await failOnce([() => new Promise<ChannelOutcome>(() => { /* stalled endpoint */ })], false);
    expect(escalation().outcome).toBe('unconfirmed');
    expect(escalation().at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('the record reaches the trigger as the surface reads it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-escal-read-'));
    dirs.push(dir);
    const history = new RunHistory(join(dir, 'history.db'));
    const engineDb = new EngineDb(join(dir, 'engine.db'));
    history.setVerbGraph(engineDb);
    closers.push(() => { try { history.close(); } catch { /* twice is fine */ } });
    closers.push(() => { try { engineDb.close(); } catch { /* twice is fine */ } });
    const manager = new TaskManager(history);
    engineDb.getDb().prepare("INSERT INTO workflows (id, name, definition_json) VALUES ('wf-1', 'W', '{}')").run();
    history.insertTrigger({ id: 'trg-2', title: 'x', source: 'cron', effect: 'run_workflow', scheduleCron: '0 9 * * *', nextRunAt: DUE, pipelineId: 'wf-1' });
    const first = '2026-01-01T09:00:00.000Z';
    const second = '2026-01-01T09:05:00.000Z';
    expect(manager.startEscalation('trg-2', first)).toBe(true);
    expect(history.getTrigger('trg-2')?.last_escalation_outcome).toBe('unconfirmed');
    expect(manager.recordEscalationOutcome('trg-2', 'not_delivered', first)).toBe(true);
    const rec = history.getTrigger('trg-2');
    expect(rec?.last_escalation_outcome).toBe('not_delivered');
    expect(rec?.last_escalation_at).toBe(first);
    // A newer escalation starts; the older one's late answer must not overwrite it.
    expect(manager.startEscalation('trg-2', second)).toBe(true);
    expect(manager.recordEscalationOutcome('trg-2', 'delivered', first)).toBe(false);
    expect(history.getTrigger('trg-2')?.last_escalation_outcome).toBe('unconfirmed');
    expect(manager.recordEscalationOutcome('trg-2', 'delivered', second)).toBe(true);
    expect(history.getTrigger('trg-2')?.last_escalation_outcome).toBe('delivered');
    // An older start retried after the newer one began (its first write failed) does not
    // take the record back, so neither it nor its answer can displace the newer escalation.
    expect(manager.startEscalation('trg-2', first, true)).toBe(false);
    expect(history.getTrigger('trg-2')?.last_escalation_at).toBe(second);
    expect(manager.recordEscalationOutcome('trg-2', 'not_delivered', first)).toBe(false);
    expect(history.getTrigger('trg-2')?.last_escalation_outcome).toBe('delivered');
    // A fresh start always lands, even behind a stored instant from a clock that was ahead.
    expect(manager.startEscalation('trg-2', '2026-01-01T10:00:00.000Z')).toBe(true);
    expect(manager.startEscalation('trg-2', first)).toBe(true);
    expect(history.getTrigger('trg-2')?.last_escalation_at).toBe(first);
    // A value no writer produces reads as no record rather than a guess.
    engineDb.getDb().prepare("UPDATE triggers SET last_escalation_outcome = 'maybe' WHERE id = 'trg-2'").run();
    expect(history.getTrigger('trg-2')?.last_escalation_outcome).toBeUndefined();
    expect(history.getTrigger('trg-2')?.last_escalation_at).toBeUndefined();
    // A retried start on a trigger that never escalated (the first write failed) lands, and
    // it marks the escalation unconfirmed until the answer is written.
    history.insertTrigger({ id: 'trg-3', title: 'y', source: 'cron', effect: 'run_workflow', scheduleCron: '0 9 * * *', nextRunAt: DUE, pipelineId: 'wf-1' });
    expect(manager.startEscalation('trg-3', first, true)).toBe(true);
    expect(history.getTrigger('trg-3')).toMatchObject({ last_escalation_at: first, last_escalation_outcome: 'unconfirmed' });
    expect(manager.recordEscalationOutcome('trg-3', 'delivered', first)).toBe(true);
    // An equal start is not later: a retry never re-opens the escalation it belongs to.
    expect(manager.startEscalation('trg-3', first, true)).toBe(false);
    expect(history.getTrigger('trg-3')?.last_escalation_outcome).toBe('delivered');
    // A gone trigger is not an error.
    expect(manager.startEscalation('nope', first)).toBe(false);
    expect(manager.recordEscalationOutcome('nope', 'delivered', first)).toBe(false);
  });
});
