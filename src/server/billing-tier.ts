/**
 * Billing/hosting tier — core-side mirror of the control-plane's canonical
 * `billing-tier` module (`@lynox-ai/lynox-pro` packages/managed/.../domain/billing-tier.ts).
 *
 * Core cannot import from pro, so the normalization + predicates are mirrored
 * here (the same pattern as the model-tier `normalizeTier` in types/models.ts).
 * The tier string arrives via the `LYNOX_MANAGED_MODE` env var, set by the CP at
 * provision/sync time. Legacy values (`starter`, `eu`) are still accepted so an
 * instance running a pre-rename env keeps working until it is re-synced.
 *
 * NOTE: this is the BILLING tier (hosting plan), NOT the model tier
 * (`deep`/`balanced`/`fast`) — a different axis.
 */

export type BillingTier = 'hosted' | 'managed' | 'managed_pro';

const LEGACY_BILLING_TIER_ALIASES: Record<string, BillingTier> = {
  starter: 'hosted',
  eu: 'managed',
};

const CANONICAL_TIERS: ReadonlySet<string> = new Set<BillingTier>([
  'hosted',
  'managed',
  'managed_pro',
]);

/** Canonical tier for any tier string (canonical or legacy); undefined if unknown/self-host. */
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
