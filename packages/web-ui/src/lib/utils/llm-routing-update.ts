// The PUT /api/config routing body for a chosen "Modell-Strategie" card
// (model-presets W4). Extracted from LLMSettings.svelte so the persistence
// mapping — which card produces which body, including the load-bearing
// `tier_preset: null` CLEAR — is unit-testable without a Svelte runtime.
//
// Contract (mirrors the engine's config-load expander + the grounded PUT rules):
//  · a PRESET persists by NAME (tier_preset) and empties any explicit tier_set,
//    so the loader's explicit-over-preset spread can't shadow the preset per-tier.
//  · CUSTOM (Eigene) persists the manual tier_set and clears tier_preset.
//  · STANDARD clears tier_preset (null → the server's merge-loop deletes the key;
//    its mere presence force-sets routing_mode='hybrid' at every load) and empties
//    any prior tier_set so no stale slots survive.
// `tier_preset: null` is why the schema is `.nullable()` — both `''` and omission
// fail to clear it (the former 400s, the latter preserves the stale value).

/** One tier's provider+model assignment (no api_key — keys live in the vault). */
export interface TierSlot { provider: string; model_id: string; api_key?: string; api_base_url?: string }
export type TierSet = Partial<Record<'fast' | 'balanced' | 'deep', TierSlot>>;

/** The five strategy cards: Standard · three hybrid presets · manual Custom. */
export type Strategy = 'standard' | 'efficient' | 'balanced' | 'max-quality' | 'custom';

export interface RoutingUpdate {
  routing_mode?: 'standard' | 'hybrid';
  tier_set?: TierSet;
  tier_preset?: string | null;
}

/** True for the three named hybrid presets (not Standard, not the manual Custom). */
export function isPresetStrategy(strategy: Strategy): boolean {
  return strategy !== 'standard' && strategy !== 'custom';
}

export function buildRoutingUpdate(
  strategy: Strategy,
  opts: { existingTierSet?: TierSet | undefined; customTierSet: TierSet },
): RoutingUpdate {
  if (isPresetStrategy(strategy)) {
    return { tier_preset: strategy, tier_set: {} };
  }
  if (strategy === 'custom') {
    return { routing_mode: 'hybrid', tier_preset: null, tier_set: opts.customTierSet };
  }
  // standard
  const update: RoutingUpdate = { routing_mode: 'standard', tier_preset: null };
  if (opts.existingTierSet && Object.keys(opts.existingTierSet).length > 0) update.tier_set = {};
  return update;
}
