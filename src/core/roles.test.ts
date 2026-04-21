import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BUILTIN_ROLES, getRole, applyTierGate } from './roles.js';

describe('BUILTIN_ROLES', () => {
  it('researcher defaults to sonnet — opus is an opt-in, tier-gated override', () => {
    // The 2026-04-21 rebalance moved researcher off Opus-by-default.
    // Bench (see project_bench_phase_1_verdict) showed Sonnet with
    // adaptive-thinking matches Opus on deep-research at a fraction of
    // the cost. Managed-Pro tenants can still pass `model: 'opus'`;
    // non-Pro tenants get downgraded.
    expect(BUILTIN_ROLES['researcher']!.model).toBe('sonnet');
    expect(BUILTIN_ROLES['researcher']!.effort).toBe('max');
    expect(BUILTIN_ROLES['researcher']!.denyTools).toContain('write_file');
    expect(BUILTIN_ROLES['researcher']!.denyTools).toContain('bash');
  });

  it('creator/operator/collector defaults unchanged', () => {
    expect(BUILTIN_ROLES['creator']!.model).toBe('sonnet');
    expect(BUILTIN_ROLES['operator']!.model).toBe('haiku');
    expect(BUILTIN_ROLES['collector']!.model).toBe('haiku');
  });

  it('getRole returns the named role, undefined on miss', () => {
    expect(getRole('researcher')?.model).toBe('sonnet');
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

  it('passes opus through when account_tier is pro', () => {
    expect(applyTierGate('opus', 'pro')).toBe('opus');
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('downgrades opus to sonnet for standard tier', () => {
    expect(applyTierGate('opus', 'standard')).toBe('sonnet');
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('opus override requires account_tier=pro'));
  });

  it('downgrades opus to sonnet when account_tier is unset (defaults to non-pro)', () => {
    expect(applyTierGate('opus', undefined)).toBe('sonnet');
    expect(stderrSpy).toHaveBeenCalled();
  });

  it('passes sonnet and haiku through untouched for any tier', () => {
    expect(applyTierGate('sonnet', 'standard')).toBe('sonnet');
    expect(applyTierGate('sonnet', 'pro')).toBe('sonnet');
    expect(applyTierGate('haiku', 'standard')).toBe('haiku');
    expect(applyTierGate('haiku', 'pro')).toBe('haiku');
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
