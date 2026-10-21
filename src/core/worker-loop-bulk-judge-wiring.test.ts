import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WorkerLoop } from './worker-loop.js';
import { createManagedHook } from './managed-hook.js';
import type { Engine, LynoxHooks } from './engine.js';
import type { NotificationRouter } from './notification-router.js';
import type { TriggerRecord } from '../types/index.js';
import type { BulkJudgeDeps } from './bulk-judge.js';

// The judge itself is tested against the real managed hook in bulk-judge.test.ts, with
// `gate` and `report` handed in by the test. What that cannot see is the worker's own
// wiring: whether the worker hands the judge a gate that reaches the
// engine's hooks at all, and whether each report carries its own gate's run id. So the
// judge is stubbed here to keep the deps the worker built, and those are driven against
// the real hook. Which execution a report belongs to (its run group) is not visible here,
// because the deps run after the worker returned: bulk-judge-worker.test.ts covers that.
const captured: { deps?: BulkJudgeDeps } = {};
vi.mock('./bulk-judge.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./bulk-judge.js')>();
  return {
    ...actual,
    runBulkJudge: vi.fn(async (_runId: string, deps: BulkJudgeDeps) => {
      captured.deps = deps;
      return { status: 'done', summary: 'judged' };
    }),
  };
});

describe('the worker wires the judge to the engine\'s managed hook', () => {
  const bodies: { runs: { run_id: string; model: string; cost_cents: number }[] }[] = [];
  let hook: LynoxHooks | undefined;
  let allowed = true;
  beforeEach(() => {
    bodies.length = 0;
    allowed = true;
    captured.deps = undefined;
    vi.stubEnv('LYNOX_MANAGED_CONTROL_PLANE_URL', 'https://cp.test');
    vi.stubEnv('LYNOX_MANAGED_INSTANCE_ID', 'inst-1');
    vi.stubEnv('LYNOX_HTTP_SECRET', 'secret');
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { body?: string }) => {
      if (!String(url).endsWith('/status') && init?.body) bodies.push(JSON.parse(init.body) as typeof bodies[number]);
      return { ok: true, json: async () => ({ allowed, spend_gate: 'balance' }) };
    }));
  });
  // Shut down here too, so a failed assertion does not leave the hook's timers running.
  afterEach(async () => { await hook?.onShutdown?.(); hook = undefined; vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  async function depsFromWorker(): Promise<{ deps: BulkJudgeDeps; hook: LynoxHooks }> {
    hook = createManagedHook();
    await hook.onInit?.();
    const engine = {
      getBulkLedger: vi.fn(() => ({ getRunForPreview: vi.fn(() => null), haltPreview: vi.fn(), getStatus: vi.fn(() => null) })),
      getApiStore: vi.fn(() => null),
      getSecretStore: vi.fn(() => null),
      getDataStore: vi.fn(() => null),
      getRunHistory: vi.fn(() => null),
      getUserConfig: vi.fn(() => ({})),
      getToolContext: vi.fn(() => ({ containment: null })),
      getAuditLog: vi.fn(() => ({ record: vi.fn() })),
      getTaskManager: vi.fn(() => ({ recordTaskRun: vi.fn() })),
      getHooks: vi.fn(() => [hook!]),
      getContext: vi.fn(() => null),
      client: {},
    } as unknown as Engine;
    const router = { hasChannels: vi.fn(() => false), notify: vi.fn(async () => {}) } as unknown as NotificationRouter;
    const loop = new WorkerLoop(engine, router, 60_000);
    const task = { id: 't-1', title: 'judge', bulk_run_id: 'run-1' } as unknown as TriggerRecord;
    await (loop as unknown as { executeBulkJudge: (t: TriggerRecord, s: AbortSignal, o: () => boolean) => Promise<void> })
      .executeBulkJudge(task, new AbortController().signal, () => false);
    expect(captured.deps).toBeDefined();
    return { deps: captured.deps!, hook: hook! };
  }

  it('each report reaches the control plane under the run id and tier of its own gate', async () => {
    const { deps, hook } = await depsFromWorker();
    // Not 'fast', so a worker that labels every report 'fast' is caught.
    const first = await deps.gate('deep');
    const second = await deps.gate('balanced');
    expect(first.blockedReason).toBeNull();
    expect(first.runId).not.toBe(second.runId);
    deps.report(first.runId, 0.02, 'deep');
    deps.report(second.runId, 0.03, 'balanced');
    await hook.onShutdown?.();
    const sent = bodies.flatMap((b) => b.runs);
    expect(sent.map((r) => `${r.run_id} ${r.model}`).sort()).toEqual([`${first.runId} deep`, `${second.runId} balanced`].sort());
    expect(sent.reduce((n, r) => n + r.cost_cents, 0)).toBe(5);
  });

  // That the gate reaches the hook at all is this test's: the hook reads its cached state,
  // so a gate that skipped it would pass the run-id test above.
  it('a refused credit comes back from the worker\'s gate as blocked', async () => {
    allowed = false;
    const { deps, hook } = await depsFromWorker();
    const gate = await deps.gate('fast');
    await hook.onShutdown?.();
    expect(gate.blockedReason).not.toBeNull();
  });
});
