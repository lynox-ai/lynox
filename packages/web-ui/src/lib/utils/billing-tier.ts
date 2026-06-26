/**
 * Billing/hosting tier — web-ui mirror of the control-plane's canonical
 * billing-tier predicates. The web-ui is a standalone package and cannot import
 * from the engine or the control plane, so the normalization is mirrored here
 * (same pattern as the core-side mirror in `src/server/billing-tier.ts`).
 *
 * The tier string reaches the web-ui via `/api/config`'s `managed` field
 * (= the engine's `LYNOX_MANAGED_MODE`). Legacy values (`starter`, `eu`) are
 * still accepted so a pre-rename instance keeps rendering correctly.
 *
 * BILLING tier (hosting plan) — NOT the model tier (deep/balanced/fast).
 */

export type BillingTier = 'hosted' | 'managed' | 'managed_pro';

const LEGACY_BILLING_TIER_ALIASES: Record<string, BillingTier> = {
	starter: 'hosted',
	eu: 'managed',
};

const CANONICAL_TIERS = new Set<string>(['hosted', 'managed', 'managed_pro']);

/** Canonical tier for any tier string; undefined when unknown / self-host / empty. */
export function normalizeBillingTier(value: string | undefined | null): BillingTier | undefined {
	if (!value) return undefined;
	if (CANONICAL_TIERS.has(value)) return value as BillingTier;
	return LEGACY_BILLING_TIER_ALIASES[value];
}

/** True for every CP-provisioned instance (BYOK `hosted` included). */
export function isHostedInstance(value: string | undefined | null): boolean {
	return normalizeBillingTier(value) !== undefined;
}

/** True only when the control plane supplies the LLM key (managed / managed_pro). */
export function cpSuppliesLLMKey(value: string | undefined | null): boolean {
	const t = normalizeBillingTier(value);
	return t === 'managed' || t === 'managed_pro';
}

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
