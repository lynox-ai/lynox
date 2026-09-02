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

import type { TierPresetName } from '../contract/vocab.js';

/** One tier's provider+model assignment (no api_key — keys live in the vault). */
export interface TierSlot { provider: string; model_id: string; api_key?: string; api_base_url?: string }
export type TierSet = Partial<Record<'fast' | 'balanced' | 'deep', TierSlot>>;

/**
 * Strategy cards: Standard · every hybrid preset · manual Custom.
 *
 * The preset names come from the VENDORED CONTRACT, never a hand-written list.
 * They used to be spelled out here and in LLMSettings' `PRESET_NAMES`, and that
 * drifted the moment core added `eu-sovereign` (2026-08-10): core's `TIER_PRESETS`
 * is keyed on `TierPresetName` and cannot compile without the name, but that
 * guarantee stops at the package boundary. web-ui copied the list by hand, so
 * `svelte-check` stayed green while the new preset had NO card, fell through to
 * 'custom' on load, and was then CLEARED to null on the next save (see
 * buildRoutingUpdate below) — silent data loss for a CP-pinned preset.
 * Importing the type makes the compiler that guards core guard this file too.
 */
export type Strategy = 'standard' | TierPresetName | 'custom';

export interface RoutingUpdate {
  routing_mode?: 'standard' | 'hybrid';
  tier_set?: TierSet;
  tier_preset?: string | null;
}

/** True for every named hybrid preset (not Standard, not the manual Custom). */
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
