import { cpSuppliesLLMKey } from '../contract/vocab.js';
import { isFeatureEnabled } from './features.js';

/**
 * Whether bulk runs are on for this instance: the one answer `engine.ts` registers the
 * bulk tools and the ledger by, at boot and on every config reload.
 *
 * On a managed pool tier (the control plane supplies the LLM key, so the owner does not own
 * the budget) the control plane decides, per instance, through `LYNOX_FEATURE_BULK_RUNS`;
 * the owner's config can only turn bulk runs OFF there (`bulk_runs_enabled: false`), never on.
 * On every other tier — self-hosted, hosted BYOK — the owner's config alone decides, as
 * before, and the flag has no effect: a self-hosted instance with the flag set and no
 * `bulk_runs_enabled: true` stays off.
 */
export function bulkRunsOn(config: { bulk_runs_enabled?: boolean | undefined }, billingTier: string | undefined): boolean {
  if (cpSuppliesLLMKey(billingTier)) {
    // The owner's explicit false closes it; otherwise the flag decides, and its default is off,
    // so an instance that sets nothing stays off (scripts/default-on-inventory.sh).
    if (config.bulk_runs_enabled === false) return false;
    return isFeatureEnabled('bulk-runs');
  }
  return config.bulk_runs_enabled === true;
}

/** Where the answer of {@link bulkRunsOn} comes from, for the owner's settings page. */
export type BulkRunsSource = 'config' | 'control-plane';

export function bulkRunsSource(billingTier: string | undefined): BulkRunsSource {
  return cpSuppliesLLMKey(billingTier) ? 'control-plane' : 'config';
}

/**
 * Who can turn bulk runs on here, for a text that names the way: the owner through the config on
 * every tier but a pool tier, and on a pool tier the control plane has opened them on and whose
 * engine database opened; the control plane on any other pool tier. The same reading as
 * `GET /api/config` `bulk_runs`: `source` is `'config'`, or `allowed` is true. Without the engine
 * database the owner's config does not take effect on any tier; off a pool tier the answer stays
 * the owner's, because nobody else turns them on there.
 */
export function bulkRunsTurnedOnBy(billingTier: string | undefined, engineDb: boolean): BulkRunsSource {
  return bulkRunsSource(billingTier) === 'config' || (engineDb && isFeatureEnabled('bulk-runs')) ? 'config' : 'control-plane';
}
