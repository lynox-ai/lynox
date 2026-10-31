/**
 * The writer of an external bulk run, as the worker builds it for an apply or an undo. Apart from
 * the worker so that which client a run is handed — and under which grant — can be tested
 * without a worker.
 */
import type { TargetWriter } from './bulk-apply.js';
import { externalWriter, parseBulkContract, writeMethodOf, type ExternalClient, type ExternalImage } from './bulk-external.js';
import { droppedTagsOf, htmlFieldsOfListForm, markupAddedByHost } from './bulk-html.js';
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

/** Whether `back` holds a string more often than `sent` does. */
function moreDropped(sent: readonly string[], back: readonly string[]): boolean {
  const held = new Map<string, number>();
  for (const v of sent) held.set(v, (held.get(v) ?? 0) + 1);
  for (const v of back) {
    const n = held.get(v) ?? 0;
    if (n === 0) return true;
    held.set(v, n - 1);
  }
  return false;
}

/** What a product's read-back holds in its HTML fields against the value sent: markup the write did
 *  not send in any field, else a field stored otherwise than sent — a sent text held as no text
 *  included — else the bytes sent. A field the write did not send as text is not read here. */
function productReadBack(storeHost: string, startDomains: readonly string[]): (sent: ExternalImage, back: ExternalImage) => 'added' | 'rewritten' | 'kept' {
  return (sent, back) => {
    const fields = htmlFieldsOfListForm('shopify').filter((f) => typeof sent[f] === 'string');
    const pairs = fields.flatMap((f) => {
      const b = back[f];
      return typeof b === 'string' ? [[sent[f] as string, b] as const] : [];
    });
    // A stretch the parser drops (`<body onload>`, a stray end tag) is in no tree the check reads:
    // one the store's read-back holds beyond the value sent is markup it added, live on the page.
    if (pairs.some(([s, b]) => !markupAddedByHost({ sent: s, back: b, storeHost, startDomains }).ok
      || (s !== b && moreDropped(droppedTagsOf(s), droppedTagsOf(b))))) return 'added';
    // A sent text the store holds as no text (cleared) is a removal: counted like any other.
    return pairs.length < fields.length || pairs.some(([s, b]) => s !== b) ? 'rewritten' : 'kept';
  };
}
