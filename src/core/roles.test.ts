import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BUILTIN_ROLES, getRole, applyTierGate } from './roles.js';

describe('BUILTIN_ROLES', () => {
  it('researcher defaults to sonnet — opus is an opt-in, tier-gated override', () => {
    // The 2026-04-21 rebalance moved researcher off Opus-by-default.
    // Bench (see project_bench_phase_1_verdict) showed Sonnet with
    // adaptive-thinking matches Opus on deep-research at a fraction of
    // the cost. Managed-Pro tenants can still pass `model: 'deep'`;
    // non-Pro tenants get downgraded.
    expect(BUILTIN_ROLES['researcher']!.model).toBe('balanced');
    expect(BUILTIN_ROLES['researcher']!.effort).toBe('max');
    expect(BUILTIN_ROLES['researcher']!.denyTools).toContain('write_file');
    expect(BUILTIN_ROLES['researcher']!.denyTools).toContain('bash');
  });

  it('creator/operator/collector defaults unchanged', () => {
    expect(BUILTIN_ROLES['creator']!.model).toBe('balanced');
    expect(BUILTIN_ROLES['operator']!.model).toBe('fast');
    expect(BUILTIN_ROLES['collector']!.model).toBe('fast');
  });

  it('getRole returns the named role, undefined on miss', () => {
    expect(getRole('researcher')?.model).toBe('balanced');
    expect(getRole('nonexistent')).toBeUndefined();
  });
});

describe('applyTierGate', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('passes the deep tier through when account_tier is pro', () => {
    expect(applyTierGate('deep', 'pro')).toBe('deep');
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('downgrades deep to balanced for standard tier', () => {
    expect(applyTierGate('deep', 'standard')).toBe('balanced');
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('deep-tier override requires account_tier=pro'));
  });

  it('passes deep through when account_tier is unset (self-host / BYOK is not gated)', () => {
    // Self-host pays its own LLM bill — the deep gate is a managed billing
    // entitlement and must not apply when account_tier is unset.
    expect(applyTierGate('deep', undefined)).toBe('deep');
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('passes balanced and fast through untouched for any tier', () => {
    expect(applyTierGate('balanced', 'standard')).toBe('balanced');
    expect(applyTierGate('balanced', 'pro')).toBe('balanced');
    expect(applyTierGate('fast', 'standard')).toBe('fast');
    expect(applyTierGate('fast', 'pro')).toBe('fast');
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('returns undefined when no override was requested, regardless of tier', () => {
    // This is the "use role default" path — applyTierGate must not
    // hallucinate a model when the caller didn't ask for one.
    expect(applyTierGate(undefined, 'standard')).toBeUndefined();
    expect(applyTierGate(undefined, 'pro')).toBeUndefined();
    expect(stderrSpy).not.toHaveBeenCalled();
  });
});
