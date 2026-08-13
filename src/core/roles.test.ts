import { describe, it, expect } from 'vitest';
import { BUILTIN_ROLES, getRole, applyTierGate } from './roles.js';

describe('BUILTIN_ROLES', () => {
  it('researcher defaults to balanced — deep is an opt-in override', () => {
    // The 2026-04-21 rebalance moved researcher off Opus-by-default.
    // Bench (see project_bench_phase_1_verdict) showed Sonnet with
    // adaptive-thinking matches Opus on deep-research at a fraction of
    // the cost. Any tenant can still pass `model: 'deep'` — the capability
    // gate was retired (D8); the budget controls cost, not a tier lock.
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

  it('collector can fetch + read — the engine recommends it to work large payloads in isolation (DEF-0112)', () => {
    // The truncation hints in fs.ts (large files), http.ts (large API responses)
    // and the web-fetch path actively tell the model to spawn role='collector' to
    // work a payload too big for the main context in isolation. allowTools is
    // hard-enforced as a whitelist (resolve-tools.ts), so a missing entry is a
    // silent hole — a collector without the tool a hint recommends cannot do the
    // job it was spawned for.
    const allow = BUILTIN_ROLES['collector']!.allowTools!;
    expect(allow).toContain('read_file');
    expect(allow).toContain('http_request');
    expect(allow).toContain('web_research');
    // Stays read-only — none of the destructive or system tools.
    expect(allow).not.toContain('write_file');
    expect(allow).not.toContain('edit_file');
    expect(allow).not.toContain('bash');
  });

  it('getRole returns the named role, undefined on miss', () => {
    expect(getRole('researcher')?.model).toBe('balanced');
    expect(getRole('nonexistent')).toBeUndefined();
  });
});

describe('applyTierGate (retired to a pass-through — D8 2026-06-17)', () => {
  // The deep-tier capability gate is RETIRED: no tier-band gating, the included
  // budget + per-model cost transparency control spend. Every account now gets
  // its requested tier unchanged; only an absent override falls through.
  it('passes deep through for a pro account', () => {
    expect(applyTierGate('deep', 'pro')).toBe('deep');
  });

  it('passes deep through for a standard account (gate retired — no downgrade)', () => {
    expect(applyTierGate('deep', 'standard')).toBe('deep');
  });

  it('passes deep through when account_tier is unset (self-host / BYOK)', () => {
    expect(applyTierGate('deep', undefined)).toBe('deep');
  });

  it('passes balanced and fast through untouched for any tier', () => {
    expect(applyTierGate('balanced', 'standard')).toBe('balanced');
    expect(applyTierGate('balanced', 'pro')).toBe('balanced');
    expect(applyTierGate('fast', 'standard')).toBe('fast');
    expect(applyTierGate('fast', 'pro')).toBe('fast');
  });

  it('returns undefined when no override was requested (use the role default)', () => {
    expect(applyTierGate(undefined, 'standard')).toBeUndefined();
    expect(applyTierGate(undefined, 'pro')).toBeUndefined();
  });
});
