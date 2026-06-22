import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { Engine, LynoxHooks } from './engine.js';

const { mockCheckPersistentBudget, mockRunSavedWorkflow } = vi.hoisted(() => ({
  mockCheckPersistentBudget: vi.fn(),
  mockRunSavedWorkflow: vi.fn(),
}));

vi.mock('./session-budget.js', () => ({ checkPersistentBudget: mockCheckPersistentBudget }));
vi.mock('../tools/builtin/pipeline.js', () => ({ runSavedWorkflow: mockRunSavedWorkflow }));

const { runGuardedSavedWorkflow } = await import('./saved-workflow-runner.js');

function makeEngine(hooks: LynoxHooks[]): Engine {
  return {
    getHooks: () => hooks,
    getContext: () => null,
    getUserConfig: () => ({ default_tier: 'balanced' }),
    getRunHistory: () => ({} as unknown),
    getToolContext: () => ({ tools: [] }),
    getMemory: () => null,
  } as unknown as Engine;
}

describe('runGuardedSavedWorkflow — budget + managed-credit lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckPersistentBudget.mockReturnValue({ allowed: true });
    mockRunSavedWorkflow.mockResolvedValue({ ok: true, runId: 'run-9', status: 'completed', costUsd: 0.42 });
  });

  it('blocks when the persistent daily/monthly cap is exceeded — no run, no hooks', async () => {
    mockCheckPersistentBudget.mockReturnValue({ allowed: false, reason: 'Daily budget exceeded.' });
    const onBeforeRun = vi.fn();
    const result = await runGuardedSavedWorkflow(makeEngine([{ onBeforeRun }]), 'wf-1');
    expect(result).toEqual({ ok: false, error: 'Daily budget exceeded.' });
    expect(onBeforeRun).not.toHaveBeenCalled();
    expect(mockRunSavedWorkflow).not.toHaveBeenCalled();
  });

  it('blocks when an onBeforeRun credit gate throws — workflow never runs', async () => {
    const onBeforeRun = vi.fn().mockRejectedValue(new Error('Managed AI budget exhausted'));
    const onAfterRun = vi.fn();
    const result = await runGuardedSavedWorkflow(makeEngine([{ onBeforeRun, onAfterRun }]), 'wf-1');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Run blocked');
    expect(result.error).toContain('Managed AI budget exhausted');
    expect(mockRunSavedWorkflow).not.toHaveBeenCalled();
    expect(onAfterRun).not.toHaveBeenCalled();
  });

  it('runs and reports the cost via onAfterRun on the happy path', async () => {
    const onBeforeRun = vi.fn();
    const onAfterRun = vi.fn();
    const result = await runGuardedSavedWorkflow(makeEngine([{ onBeforeRun, onAfterRun }]), 'wf-1');
    expect(result).toMatchObject({ ok: true, runId: 'run-9', status: 'completed' });
    expect(onBeforeRun).toHaveBeenCalledOnce();
    expect(mockRunSavedWorkflow).toHaveBeenCalledTimes(1);
    expect(mockRunSavedWorkflow.mock.calls[0]?.[0]).toBe('wf-1');
    // onAfterRun(runId, costUsd, context) — reports the run's actual cost.
    expect(onAfterRun).toHaveBeenCalledOnce();
    const [runIdArg, costArg, ctxArg] = onAfterRun.mock.calls[0]!;
    expect(runIdArg).toBe('run-9');
    expect(costArg).toBe(0.42);
    expect((ctxArg as { modelTier: string }).modelTier).toBe('balanced');
  });

  it('skips the cost report for a zero-cost run', async () => {
    mockRunSavedWorkflow.mockResolvedValue({ ok: true, runId: 'run-0', status: 'completed', costUsd: 0 });
    const onAfterRun = vi.fn();
    const result = await runGuardedSavedWorkflow(makeEngine([{ onAfterRun }]), 'wf-1');
    expect(result.ok).toBe(true);
    expect(onAfterRun).not.toHaveBeenCalled();
  });

  it('passes the underlying failure through (and still does not report a cost when none was incurred)', async () => {
    mockRunSavedWorkflow.mockResolvedValue({ ok: false, error: 'Workflow "wf-x" not found.' });
    const onAfterRun = vi.fn();
    const result = await runGuardedSavedWorkflow(makeEngine([{ onAfterRun }]), 'wf-x');
    expect(result).toEqual({ ok: false, error: 'Workflow "wf-x" not found.' });
    expect(onAfterRun).not.toHaveBeenCalled();
  });

  it('fans the cost report out to every onAfterRun hook', async () => {
    const a = vi.fn();
    const b = vi.fn();
    const result = await runGuardedSavedWorkflow(
      makeEngine([{ onBeforeRun: vi.fn() }, { onAfterRun: a }, { onAfterRun: b }]),
      'wf-1',
    );
    expect(result.ok).toBe(true);
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
    expect(a.mock.calls[0]?.[1]).toBe(0.42);
    expect(b.mock.calls[0]?.[1]).toBe(0.42);
  });

  it('treats an onAfterRun that throws as non-fatal and still fires the remaining hooks', async () => {
    const throwing = vi.fn(() => { throw new Error('billing flush failed'); });
    const after = vi.fn();
    const result = await runGuardedSavedWorkflow(makeEngine([{ onAfterRun: throwing }, { onAfterRun: after }]), 'wf-1');
    expect(result).toMatchObject({ ok: true, runId: 'run-9' });
    expect(throwing).toHaveBeenCalledOnce();
    expect(after).toHaveBeenCalledOnce();
  });

  it('falls back to the generated runId when the run returns no runId', async () => {
    mockRunSavedWorkflow.mockResolvedValue({ ok: true, status: 'completed', costUsd: 0.1 });
    const onAfterRun = vi.fn();
    await runGuardedSavedWorkflow(makeEngine([{ onAfterRun }]), 'wf-1');
    const runIdArg = onAfterRun.mock.calls[0]?.[0] as string;
    expect(typeof runIdArg).toBe('string');
    expect(runIdArg.length).toBeGreaterThan(0);
  });
});
