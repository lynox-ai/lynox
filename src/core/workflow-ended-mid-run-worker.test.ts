import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkerLoop } from './worker-loop.js';
import { RunHistory } from './run-history.js';
import { EngineDb } from './engine-db.js';
import { TaskManager } from './task-manager.js';
import { PromptStore } from './prompt-store.js';
import { MandateEnds } from './mandate-ends.js';
import { AuditLog } from './audit-log.js';
import { setPlanPauseForTests } from './plan-pause.js';
import { WORKFLOW_ENDED_MID_RUN } from '../orchestrator/run-source.js';
import type { Engine } from './engine.js';
import type { NotificationRouter } from './notification-router.js';

/**
 * 1100: the runner ends a saved workflow's run before its next step once a mandate the workflow
 * depends on has ended (`WORKFLOW_ENDED_MID_RUN`). When that comes before the worker's sweep, the
 * worker records it as the sweep's stop: `stopped`, not a failure, and with the pause on the plan
 * pauses and keeps its schedule. A real TaskManager, RunHistory, engine.db, MandateEnds and
 * AuditLog; the runner is a double that ends the grant while it runs.
 */

const runner = vi.hoisted(() => ({ run: (..._args: unknown[]): unknown => undefined }));
vi.mock('./saved-workflow-runner.js', () => ({ runGuardedSavedWorkflow: (...args: unknown[]) => runner.run(...args) }));
vi.mock('../tools/builtin/pipeline.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getPipeline: (id: string) => ({ id, name: 'Report', mode: 'autonomous', steps: [], confirmedAt: '2026-01-01T00:00:00.000Z' }),
}));

const H = 3600;
const DUE = '2026-01-05T09:00:00.000Z';
const EMAIL = 'h@x.ch';
const GRANT = `g-${EMAIL}`;

const dirs: string[] = [];
const closers: Array<() => void> = [];
let restore: () => void = () => undefined;

beforeEach(() => { restore = setPlanPauseForTests(true); });
afterEach(async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
  restore();
  vi.restoreAllMocks();
  for (const c of closers.splice(0).reverse()) c();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const nowS = (): number => Math.floor(Date.now() / 1000);

function boot(): { loop: WorkerLoop; history: RunHistory; db: ReturnType<EngineDb['getDb']>; ends: MandateEnds } {
  const dir = mkdtempSync(join(tmpdir(), 'lynox-1100-w-'));
  dirs.push(dir);
  const history = new RunHistory(join(dir, 'history.db'));
  const engineDb = new EngineDb(join(dir, 'engine.db'));
  history.setVerbGraph(engineDb);
  closers.push(() => { try { history.close(); } catch { /* twice is fine */ } });
  closers.push(() => { try { engineDb.close(); } catch { /* twice is fine */ } });
  const manager = new TaskManager(history);
  const prompts = new PromptStore(history.getDb());
  const ends = new MandateEnds(engineDb.getDb());
  const audit = new AuditLog(engineDb.getDb());
  const engine = {
    getTaskManager: () => manager,
    getToolContext: () => ({ containment: null }),
    getPromptStore: () => prompts,
    getRunHistory: () => history,
    getSecretStore: () => null,
    getBulkLedger: () => null,
    getUserConfig: () => ({}),
    workerRunModelOverride: () => ({}),
    escalateToUser: () => null,
    getEngineDb: () => engineDb,
    getMandateEnds: () => ends,
    getAuditLog: () => audit,
    getApprovalStore: () => null,
  } as unknown as Engine;
  const router = { hasChannels: () => false, notify: vi.fn(async () => []) } as unknown as NotificationRouter;
  const loop = new WorkerLoop(engine, router, 60_000);
  closers.push(() => loop.stop());
  // The mandate made the workflow and its schedule: the runner's mid-run end reads the workflow's
  // authors, so this is the plan it can end that way.
  engineDb.getDb().prepare("INSERT INTO workflows (id, name, definition_json, created_by, created_mandate_id, created_at) VALUES ('wf', 'Report', ?, ?, ?, '2026-01-01 00:00:00')")
    .run(JSON.stringify({ id: 'wf', name: 'Report', steps: [] }), `mandate:${EMAIL}`, GRANT);
  history.insertTrigger({
    id: 'p', title: 'Weekly report', source: 'cron', effect: 'run_workflow', pipelineId: 'wf', scheduleCron: '0 9 * * 1', nextRunAt: DUE,
    confirmedAt: '2026-01-01T00:00:00.000Z', confirmedBy: 'owner', createdBy: `mandate:${EMAIL}`, createdMandateId: GRANT,
  });
  ends.record({ kind: 'mandate', email: EMAIL, mandateId: GRANT, mandateExp: nowS() + H }, nowS() - H);
  return { loop, history, db: engineDb.getDb(), ends };
}

function row(p: ReturnType<typeof boot>): { last_run_status: string | null; last_run_result: string | null; next_run_at: string | null; paused_at: number | null } {
  return p.db.prepare('SELECT last_run_status, last_run_result, next_run_at, paused_at FROM triggers WHERE id = ?').get('p') as never;
}

/** One tick, then until the run has recorded its end (a workflow run imports its runner first). */
async function tick(p: ReturnType<typeof boot>): Promise<void> {
  await p.loop.tick();
  await vi.waitFor(() => { expect(row(p).last_run_status).not.toBeNull(); }, { timeout: 5000 });
}

describe('a workflow run the runner ended because an access ended mid-run (1100)', () => {
  it('is recorded as the stop for that end: the plan pauses and keeps its schedule', async () => {
    const p = boot();
    let ran = 0;
    runner.run = () => {
      ran++;
      p.ends.revoke(GRANT);
      return Promise.resolve({ ok: true, status: 'failed', error: WORKFLOW_ENDED_MID_RUN, runId: 'r1' });
    };
    await tick(p);
    expect(ran, 'the run reached the runner').toBe(1);
    const r = row(p);
    expect(r.last_run_status).toBe('stopped');
    expect(r.last_run_result).toContain('access of someone who set up or changed this plan ended');
    expect(r.last_run_result).toContain('paused until the owner takes it over');
    expect(r.next_run_at).toBe(DUE);
    expect(r.paused_at).not.toBeNull();
  });

  it('a liveness read that throws is no end found: a failure, the plan not paused', async () => {
    const p = boot();
    let ran = 0;
    runner.run = () => {
      ran++;
      vi.spyOn(p.ends, 'isLive').mockImplementation(() => { throw new Error('engine.db busy'); });
      return Promise.resolve({ ok: true, status: 'failed', error: WORKFLOW_ENDED_MID_RUN, runId: 'r1' });
    };
    await tick(p);
    expect(ran, 'the run reached the runner').toBe(1);
    const r = row(p);
    expect(r.last_run_status).toBe('failed');
    expect(r.last_run_result ?? '').not.toContain('access of someone who set up or changed this plan ended');
    expect(r.paused_at).toBeNull();
  });

  it('control: the same error while every member is live is a failure, not that stop', async () => {
    const p = boot();
    let ran = 0;
    runner.run = () => { ran++; return Promise.resolve({ ok: true, status: 'failed', error: WORKFLOW_ENDED_MID_RUN, runId: 'r1' }); };
    await tick(p);
    expect(ran, 'the run reached the runner').toBe(1);
    const r = row(p);
    expect(r.last_run_status).toBe('failed');
    expect(r.paused_at).toBeNull();
  });
});
