import { describe, it, expect, afterEach, vi } from 'vitest';
import { bulkRunsOn, bulkRunsSource } from './bulk-switch.js';

/**
 * Who decides whether bulk runs are on: on a managed
 * pool tier the control plane per instance, with the owner able only to turn them off; on every
 * other tier the owner's config alone.
 */
describe('bulkRunsOn', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  const POOL = ['managed', 'managed_pro', 'managed_max'] as const;
  const OWNED = [undefined, '', 'hosted'] as const;

  it.each(POOL)('%s: the control plane opens it, and the config field left out keeps it open', (tier) => {
    vi.stubEnv('LYNOX_FEATURE_BULK_RUNS', '1');
    expect(bulkRunsOn({}, tier)).toBe(true);
    expect(bulkRunsOn({ bulk_runs_enabled: true }, tier)).toBe(true);
  });

  it.each(POOL)('%s: the owner turns it off in the config even with the control plane\'s flag on', (tier) => {
    vi.stubEnv('LYNOX_FEATURE_BULK_RUNS', '1');
    expect(bulkRunsOn({ bulk_runs_enabled: false }, tier)).toBe(false);
  });

  it.each(POOL)('%s: without the control plane\'s flag the owner\'s true opens nothing', (tier) => {
    vi.stubEnv('LYNOX_FEATURE_BULK_RUNS', '');
    expect(bulkRunsOn({ bulk_runs_enabled: true }, tier)).toBe(false);
    vi.stubEnv('LYNOX_FEATURE_BULK_RUNS', '0');
    expect(bulkRunsOn({ bulk_runs_enabled: true }, tier)).toBe(false);
  });

  it.each(OWNED)('tier %j: the flag has no effect, the config alone decides', (tier) => {
    vi.stubEnv('LYNOX_FEATURE_BULK_RUNS', '1');
    expect(bulkRunsOn({}, tier)).toBe(false);
    expect(bulkRunsOn({ bulk_runs_enabled: false }, tier)).toBe(false);
    expect(bulkRunsOn({ bulk_runs_enabled: true }, tier)).toBe(true);
    vi.stubEnv('LYNOX_FEATURE_BULK_RUNS', '');
    expect(bulkRunsOn({ bulk_runs_enabled: true }, tier)).toBe(true);
  });

  it('names who decides', () => {
    for (const tier of POOL) expect(bulkRunsSource(tier)).toBe('control-plane');
    for (const tier of OWNED) expect(bulkRunsSource(tier)).toBe('config');
  });
});
