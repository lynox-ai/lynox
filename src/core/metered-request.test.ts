import { describe, it, expect, vi } from 'vitest';

import type { Engine, LynoxHooks } from './engine.js';
import { fireBeforeRunGate, reportMeteredCost } from './metered-request.js';

/** Minimal Engine stub exposing only what the metered helpers read. */
function makeEngine(hooks: LynoxHooks[]): Engine {
  return {
    getHooks: () => hooks,
    getContext: () => null,
  } as unknown as Engine;
}

describe('fireBeforeRunGate — pre-run credit gate', () => {
  it('returns blockedReason=null with a run id when no hooks are registered (self-host)', async () => {
    const result = await fireBeforeRunGate(makeEngine([]), 'fast');
    expect(result.blockedReason).toBeNull();
    expect(result.runId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('passes the gate when onBeforeRun does not throw', async () => {
    const onBeforeRun = vi.fn();
    const result = await fireBeforeRunGate(makeEngine([{ onBeforeRun }]), 'fast');
    expect(result.blockedReason).toBeNull();
    expect(onBeforeRun).toHaveBeenCalledOnce();
    // The run id passed to the hook is the same one returned to the caller, so
    // the later debit can be deduped against it on the control plane.
    const [runIdArg, ctxArg] = onBeforeRun.mock.calls[0]!;
    expect(runIdArg).toBe(result.runId);
    expect((ctxArg as { modelTier: string }).modelTier).toBe('fast');
  });

  it('blocks (returns the reason) when an onBeforeRun hook throws — credit exhausted', async () => {
    const onBeforeRun = vi.fn().mockRejectedValue(new Error('AI budget for this period reached.'));
    const result = await fireBeforeRunGate(makeEngine([{ onBeforeRun }]), 'fast');
    expect(result.blockedReason).toBe('AI budget for this period reached.');
    expect(result.runId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('blocks on a stale-control-plane throw (fail-closed)', async () => {
    const onBeforeRun = vi.fn(() => { throw new Error('Managed control plane temporarily unreachable'); });
    const result = await fireBeforeRunGate(makeEngine([{ onBeforeRun }]), 'fast');
    expect(result.blockedReason).toContain('control plane temporarily unreachable');
  });

  it('coerces a non-Error throw to a string reason', async () => {
    const onBeforeRun = vi.fn().mockRejectedValue('plain string boom');
    const result = await fireBeforeRunGate(makeEngine([{ onBeforeRun }]), 'fast');
    expect(result.blockedReason).toBe('plain string boom');
  });
});

describe('reportMeteredCost — post-run debit', () => {
  it('fires onAfterRun with the run id, cost, and tier label on a billable run', () => {
    const onAfterRun = vi.fn();
    reportMeteredCost(makeEngine([{ onAfterRun }]), 'run-42', 0.1234, 'fast');
    expect(onAfterRun).toHaveBeenCalledOnce();
    const [runIdArg, costArg, ctxArg] = onAfterRun.mock.calls[0]!;
    expect(runIdArg).toBe('run-42');
    expect(costArg).toBe(0.1234);
    expect((ctxArg as { modelTier: string }).modelTier).toBe('fast');
  });

  it('skips the debit for a zero-cost run (no hook call)', () => {
    const onAfterRun = vi.fn();
    reportMeteredCost(makeEngine([{ onAfterRun }]), 'run-0', 0, 'fast');
    expect(onAfterRun).not.toHaveBeenCalled();
  });

  it('skips the debit for a negative cost', () => {
    const onAfterRun = vi.fn();
    reportMeteredCost(makeEngine([{ onAfterRun }]), 'run-neg', -1, 'fast');
    expect(onAfterRun).not.toHaveBeenCalled();
  });

  it('is a no-op on self-host (no hooks registered)', () => {
    // No throw, nothing to assert beyond "does not blow up".
    expect(() => reportMeteredCost(makeEngine([]), 'run-x', 5, 'fast')).not.toThrow();
  });

  it('swallows a throwing onAfterRun so a billing hiccup never breaks the response', () => {
    const onAfterRun = vi.fn(() => { throw new Error('flush failed'); });
    const onAfterRun2 = vi.fn();
    // A throwing hook must NOT prevent the remaining hooks from firing, and must
    // not propagate to the caller.
    expect(() => reportMeteredCost(makeEngine([{ onAfterRun }, { onAfterRun: onAfterRun2 }]), 'run-9', 1, 'fast')).not.toThrow();
    expect(onAfterRun2).toHaveBeenCalledOnce();
  });
});
