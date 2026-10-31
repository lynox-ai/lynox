/**
 * The writer of an external bulk run, as the worker builds it for an apply or an undo. Apart from
 * the worker so that which client a run is handed — and under which grant — can be tested
 * without a worker.
 */
import type { TargetWriter } from './bulk-apply.js';
import { externalWriter, parseBulkContract, writeMethodOf, type ExternalClient, type ExternalImage } from './bulk-external.js';
import { htmlFieldsOfListForm, markupAddedByHost } from './bulk-html.js';
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
export function externalRunWriter(
  run: BulkRunForApply, ledger: Pick<BulkLedger, 'shopifyApplyOf' | 'startDomainsOf'>, clientFor: BulkApplyClientFor,
): TargetWriter | null {
  const shopifyApply = ledger.shopifyApplyOf(run.id);
  if (shopifyApply !== null) {
    const host = externalHostOf(run.targetSystem);
    const endpoint = host === null ? null : shopifyGraphqlEndpoint(host);
    const client = endpoint === null ? null : clientFor(run, undefined, undefined, shopifyApply);
    if (!client || !endpoint || host === null) return null;
    const io = shopifyTargetIo(client, endpoint, shopifyApply.form);
    // A product's description is read back for markup the write never sent (PRD shopify-preset
    // §21.2 item 6), on this form only (N5): an image's `alt` is plain text.
    return shopifyApply.form === 'shopify_product'
      ? externalWriter(client, { io, readBack: productReadBack(host, ledger.startDomainsOf(run.id)) })
      : externalWriter(client, { io });
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

/** What a product's read-back holds in its HTML fields against the value sent: markup the write did
 *  not send in any field, else a field stored otherwise than sent, else the bytes sent. A field the
 *  write did not send, or that is not text on either side, is not read here. */
function productReadBack(storeHost: string, startDomains: readonly string[]): (sent: ExternalImage, back: ExternalImage) => 'added' | 'rewritten' | 'kept' {
  return (sent, back) => {
    const pairs = htmlFieldsOfListForm('shopify').flatMap((f) => {
      const s = sent[f];
      const b = back[f];
      return typeof s === 'string' && typeof b === 'string' ? [[s, b] as const] : [];
    });
    if (pairs.some(([s, b]) => !markupAddedByHost({ sent: s, back: b, storeHost, startDomains }).ok)) return 'added';
    return pairs.some(([s, b]) => s !== b) ? 'rewritten' : 'kept';
  };
}
