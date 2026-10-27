/**
 * The writer of an external bulk run, as the worker builds it for an apply or an undo. Apart from
 * the worker so that which client a run is handed — and under which grant — can be tested
 * without a worker.
 */
import type { TargetWriter } from './bulk-apply.js';
import { externalWriter, parseBulkContract, writeMethodOf, type ExternalClient } from './bulk-external.js';
import { externalHostOf, type BulkLedger, type BulkRunForApply } from './bulk-ledger.js';
import { shopifyTargetIo } from './bulk-shopify.js';
import { shopifyGraphqlEndpoint } from './shopify-graphql.js';
import { withListQuery, withShopifyApply, withShopifyRead, type ListQueryConstraints, type ShopifyApplyPhase, type ShopifyReadPhase } from '../tools/permission-guard.js';
import type { CapabilityContract } from '../types/capability-contract.js';

/** The worker's client for a run: its stored contract, or — handed an apply phase — a copy granted that phase's bodies. */
export type BulkApplyClientFor = (
  run: BulkRunForApply, listQuery?: undefined, shopifyRead?: undefined, shopifyApply?: ShopifyApplyPhase,
) => ExternalClient | null;

/**
 * A Shopify run writes through its form, not a verb: its contract grants none, and the apply's
 * reads and writes are granted body by body from this run's rows (`shopifyApplyOf`). Any other
 * external run writes with its contract's one verb. Null where neither holds.
 */
export function externalRunWriter(run: BulkRunForApply, ledger: Pick<BulkLedger, 'shopifyApplyOf'>, clientFor: BulkApplyClientFor): TargetWriter | null {
  const shopifyApply = ledger.shopifyApplyOf(run.id);
  if (shopifyApply !== null) {
    const host = externalHostOf(run.targetSystem);
    const endpoint = host === null ? null : shopifyGraphqlEndpoint(host);
    const client = endpoint === null ? null : clientFor(run, undefined, undefined, shopifyApply);
    return client && endpoint ? externalWriter(client, { io: shopifyTargetIo(client, endpoint) }) : null;
  }
  const client = clientFor(run);
  const contract = parseBulkContract(run.contractJson);
  const method = contract ? writeMethodOf(contract) : null;
  return client && method ? externalWriter(client, { method }) : null;
}

/**
 * The contract a run's client is built with: the stored one, or a copy granted one of a list
 * page's query, a Shopify run's reads, or its apply — made here, in memory, so the stored contract
 * never carries such a grant. The copies are never combined: each drops the others' grants. Null
 * when the phase cannot be granted (a run without a host, a phase its minting refuses).
 */
export function bulkRunContract(stored: CapabilityContract, targetSystem: string, phase: {
  listQuery?: ListQueryConstraints | undefined; shopifyRead?: ShopifyReadPhase | undefined; shopifyApply?: ShopifyApplyPhase | undefined;
}): CapabilityContract | null {
  try {
    if (phase.shopifyApply !== undefined) {
      const host = externalHostOf(targetSystem);
      return host === null ? null : withShopifyApply(stored, host, phase.shopifyApply);
    }
    if (phase.shopifyRead !== undefined) {
      const host = externalHostOf(targetSystem);
      return host === null ? null : withShopifyRead(stored, host, phase.shopifyRead);
    }
    return phase.listQuery !== undefined ? withListQuery(stored, phase.listQuery) : stored;
  } catch {
    return null;
  }
}
