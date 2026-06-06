import { describe, it, expect, vi } from 'vitest';
import { RunExecutor, DEFAULT_MAX_CONCURRENT_RUNS } from './run-executor.js';

describe('RunExecutor', () => {
  it('defaults the cap to DEFAULT_MAX_CONCURRENT_RUNS and floors invalid caps to 1', () => {
    expect(new RunExecutor().capacity).toBe(DEFAULT_MAX_CONCURRENT_RUNS);
    expect(new RunExecutor(3).capacity).toBe(3);
    expect(new RunExecutor(0).capacity).toBe(1); // floored
    expect(new RunExecutor(-5).capacity).toBe(1);
    expect(new RunExecutor(2.9).capacity).toBe(2); // floored to int
  });

  it('reports atCapacity only once the cap is reached', () => {
    const ex = new RunExecutor(2);
    expect(ex.atCapacity()).toBe(false);
    ex.acquire('r1', 't1', () => {});
    expect(ex.atCapacity()).toBe(false);
    expect(ex.activeCount).toBe(1);
    ex.acquire('r2', 't2', () => {});
    expect(ex.atCapacity()).toBe(true);
    expect(ex.activeCount).toBe(2);
  });

  it('release frees a slot so a new run can be acquired', () => {
    const ex = new RunExecutor(1);
    ex.acquire('r1', 't1', () => {});
    expect(ex.atCapacity()).toBe(true);
    ex.release('r1');
    expect(ex.atCapacity()).toBe(false);
    expect(ex.activeCount).toBe(0);
  });

  it('re-acquiring the same runId replaces the handle without tripping the cap', () => {
    const ex = new RunExecutor(1);
    const first = vi.fn();
    const second = vi.fn();
    ex.acquire('r1', 't1', first);
    ex.acquire('r1', 't1', second); // takeover rewiring abort — must not count as a 2nd run
    expect(ex.activeCount).toBe(1);
    expect(ex.abort('r1')).toBe(true);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });

  it('abort invokes the stored handle and returns true; unknown runId returns false', () => {
    const ex = new RunExecutor();
    const abortFn = vi.fn();
    ex.acquire('r1', 't1', abortFn);
    expect(ex.abort('r1')).toBe(true);
    expect(abortFn).toHaveBeenCalledOnce();
    expect(ex.abort('does-not-exist')).toBe(false);
  });

  it('abort swallows a throwing handle (best-effort) and still returns true', () => {
    const ex = new RunExecutor();
    ex.acquire('r1', 't1', () => { throw new Error('boom'); });
    expect(() => ex.abort('r1')).not.toThrow();
    expect(ex.abort('r1')).toBe(true); // still active until released
  });

  it('isActive + activeRunIds reflect the live set', () => {
    const ex = new RunExecutor();
    ex.acquire('r1', 't1', () => {});
    ex.acquire('r2', 't2', () => {});
    expect(ex.isActive('r1')).toBe(true);
    expect(ex.isActive('rX')).toBe(false);
    expect(ex.activeRunIds().sort()).toEqual(['r1', 'r2']);
    ex.release('r1');
    expect(ex.isActive('r1')).toBe(false);
    expect(ex.activeRunIds()).toEqual(['r2']);
  });

  it('release is idempotent', () => {
    const ex = new RunExecutor();
    ex.acquire('r1', 't1', () => {});
    ex.release('r1');
    expect(() => ex.release('r1')).not.toThrow();
    expect(ex.activeCount).toBe(0);
  });
});
