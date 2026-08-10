/**
 * Cross-repo wire-contract vocabulary — SINGLE SOURCE OF TRUTH.
 *
 * VENDORED DOWNSTREAM — edit ONLY here (`core/src/contract/`). Two consumers
 * carry byte-identical copies kept honest by CI:
 *   - the private control plane (lynox-pro `packages/managed/src/vendor/contract/`,
 *     synced via its `sync-contract.sh`, guarded by a tree-hash lock check)
 *   - the web-ui package (`packages/web-ui/src/lib/contract/`, guarded by an
 *     in-repo file-equality test)
 * Changes here are WIRE-CONTRACT changes: every value below is parsed off the
 * wire (env vars set by the control plane) by the engine or the web-ui.
 * See `src/contract/README.md` for the full contract rules.
 *
 * This file must stay DEPENDENCY-FREE (pure literals, types, and functions) —
 * consumers compile it standalone.
 */

// === Billing tier (hosting plan) — NOT the model tier ===

export type BillingTier = 'hosted' | 'managed' | 'managed_pro';

/** Legacy tier aliases still accepted at input boundaries (pre-rename envs). */
export const LEGACY_BILLING_TIER_ALIASES: Record<string, BillingTier> = {
  starter: 'hosted',
  eu: 'managed',
};

export const CANONICAL_BILLING_TIERS: ReadonlySet<string> = new Set<BillingTier>([
  'hosted',
  'managed',
  'managed_pro',
]);

/** Canonical tier for any tier string (canonical or legacy); undefined if unknown/self-host. */
export function normalizeBillingTier(value: string | undefined | null): BillingTier | undefined {
  if (!value) return undefined;
  if (CANONICAL_BILLING_TIERS.has(value)) return value as BillingTier;
  // hasOwn guard: a bare index would return inherited Object.prototype members
  // (truthy!) for hostile keys like 'toString' / '__proto__'.
  return Object.hasOwn(LEGACY_BILLING_TIER_ALIASES, value)
    ? LEGACY_BILLING_TIER_ALIASES[value]
    : undefined;
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

// === Tier presets (which MODEL sits behind each band) ===

/**
 * The named routing strategies the control plane may pin via `LYNOX_TIER_PRESET`.
 *
 * Only the NAMES are contract. The slots — which provider and model each band
 * resolves to — stay in core's `TIER_PRESETS` table, because they are a curation
 * decision with their own guards (provenance, registered-model checks) and the CP
 * has no business carrying them.
 *
 * They are here so the CP can REFUSE an unknown name before storing it. Without
 * that, a typo is written, `sync-env` force-recreates the tenant container, and
 * the engine then throws at load on the unknown preset — the instance does not
 * come back up. Validating against a copied list would only move the typo; this
 * is the same list core expands from.
 *
 * ADDING A PRESET: add the name here first. `TIER_PRESETS` is a `Record` keyed on
 * this type, so the compiler names the missing half at the moment you write it —
 * a preset without a contract name will not build, and a contract name without a
 * preset will not either.
 */
export const TIER_PRESET_NAMES = ['efficient', 'balanced', 'eu-sovereign', 'max-quality'] as const;

export type TierPresetName = (typeof TIER_PRESET_NAMES)[number];

/** Narrow an untrusted string to a known preset name. */
export function isTierPresetName(value: string | undefined | null): value is TierPresetName {
  return typeof value === 'string' && (TIER_PRESET_NAMES as readonly string[]).includes(value);
}

// === Model tier (deep/balanced/fast) — orthogonal to the billing tier ===

export type ModelTier = 'deep' | 'balanced' | 'fast';

/** Legacy Anthropic-brand tier aliases → provider-agnostic names. */
export const LEGACY_TIER_ALIASES: Record<string, ModelTier> = {
  opus: 'deep',
  sonnet: 'balanced',
  haiku: 'fast',
};

/**
 * Normalize a tier string to the canonical provider-agnostic name, accepting
 * both current (`fast`/`balanced`/`deep`) and legacy (`haiku`/`sonnet`/`opus`)
 * names. Returns `undefined` for anything unrecognized.
 */
export function normalizeTier(value: string | undefined): ModelTier | undefined {
  if (value === undefined) return undefined;
  if (value === 'fast' || value === 'balanced' || value === 'deep') return value;
  // hasOwn guard: see normalizeBillingTier.
  return Object.hasOwn(LEGACY_TIER_ALIASES, value) ? LEGACY_TIER_ALIASES[value] : undefined;
}

// === Account tier (managed entitlement axis) ===

export type AccountTier = 'standard' | 'pro';

// === LLM provider ===

export type LLMProvider = 'anthropic' | 'vertex' | 'custom' | 'openai';

// === Outbound network policy ===

export type NetworkPolicy = 'allow-all' | 'allow-list' | 'deny-all' | 'guarded';
