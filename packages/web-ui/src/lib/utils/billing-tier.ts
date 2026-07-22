/**
 * Billing/hosting tier — re-export shim over the vendored wire-contract copy
 * (`$lib/contract/vocab.ts`, byte-identical to core `src/contract/vocab.ts`,
 * guarded by `tests/contract-drift.test.ts`). The web-ui is a standalone
 * package and cannot import from the engine, so it consumes the vendored copy
 * (K-W1, PRD-CORE-PRO-CONTRACT / DEF-0030).
 *
 * The tier string reaches the web-ui via `/api/config`'s `managed` field
 * (= the engine's `LYNOX_MANAGED_MODE`).
 *
 * BILLING tier (hosting plan) — NOT the model tier (deep/balanced/fast).
 */

export type { BillingTier } from '../contract/vocab.js';
export { normalizeBillingTier, isHostedInstance, cpSuppliesLLMKey } from '../contract/vocab.js';

/**
 * A nav/settings item that opts into per-tier visibility. A flagless item shows
 * on every tier. The two flags are mutually exclusive in practice (one route
 * per tier); setting both would hide the item on every concrete tier.
 */
export interface TierGatedItem {
	selfHostOnly?: boolean;
	managedOnly?: boolean;
}

/**
 * Shared tier-visibility predicate for the Settings nav (`SettingsIndex`) and
 * the Command Palette — the single source of truth both used to reimplement
 * identically. `managed`: `true` = managed instance, `false` = self-host,
 * `null` = tier not yet probed. While `null`, BOTH self-host-only and
 * managed-only items are hidden, so the user never sees a tier-inappropriate
 * flash during the ~300 ms before `/api/config` replies (the default-null
 * pattern). Non-tier dimensions (e.g. `hideOnMobile`) stay with each caller.
 */
export function keepSettingsItem(item: TierGatedItem, managed: boolean | null): boolean {
	if (item.selfHostOnly && managed !== false) return false;
	if (item.managedOnly && managed !== true) return false;
	return true;
}
