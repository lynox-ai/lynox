/**
 * The GET /api/config `available_tier_presets` signal (model-presets W4).
 *
 * The settings "Modell-Strategie" cards + the composer/header picker render from
 * this — so the client needs NO `@lynox-ai/core` import (web-ui architecture bans
 * it) and the R2-gated disclosure stays server-authoritative. Per preset it
 * carries: the resolved per-tier model (id + catalog label + provenance), the
 * host disclosure (residency + transfer-basis + R2-gated posture), and whether
 * the preset is AVAILABLE on this instance (managed drops a preset whose slot the
 * CP can't back — same predicate as the loader, so the card's disabled-state
 * matches the write-gate's 403 and the loader's drop: no false advertising).
 */
import type { ModelTier } from '../types/index.js';
import { modelCapability } from '../types/index.js';
import { TIER_PRESETS, expandTierPreset } from './tier-presets.js';
import { applyManagedTierSetConstraints } from './config.js';
import { LLM_CATALOG } from './llm/catalog.js';
import { hostDisclosure, type HostResidency } from './llm/host-disclosure.js';

/** Per-tier resolved info for a preset card (all server-derived, client-safe). */
export interface TierPresetTierInfo {
  tier: ModelTier;
  model_id: string;
  /** Catalog label ("Ministral 14B"), or the raw id if the catalog has no entry. */
  label: string;
  /** Model weights-origin (US/EU/CN) for the provenance chip, when annotated. */
  provenance?: 'US' | 'EU' | 'CN';
  /** Where the data is processed (host residency), when the host is disclosed. */
  residency?: HostResidency;
  /** Chapter-V transfer basis for a non-EU host (e.g. 'SCC/DPF'), else null/absent. */
  transferBasis?: string | null;
  /** R2-gated posture string (never an unconfirmed claim). */
  posture?: string;
}

export interface TierPresetInfo {
  name: string;
  tiers: TierPresetTierInfo[];
  /** False on managed when a slot's host isn't backed here (e.g. ⚡ efficient's
   *  Fireworks slot without the operator opt-in) — the card renders DISABLED. */
  available: boolean;
}

/** Map a preset slot to the host key used by `host-disclosure` (host, not URL). */
function slotHost(slot: { provider: string; api_base_url?: string | undefined }): string {
  if (slot.api_base_url) {
    try { return new URL(slot.api_base_url).hostname; } catch { return ''; }
  }
  // Anthropic slots carry no api_base_url — the disclosure host is implied.
  return slot.provider === 'anthropic' ? 'api.anthropic.com' : '';
}

/**
 * Build the `available_tier_presets` signal. `isManagedTier` gates availability:
 * a managed preset is available iff `applyManagedTierSetConstraints` keeps every
 * slot (the SAME loader logic — so availability can't disagree with what routes).
 * Self-host: every preset is available (the loader hardening never runs).
 */
export function buildTierPresetSignal(opts: { isManagedTier: boolean }): Record<string, TierPresetInfo> {
  const out: Record<string, TierPresetInfo> = {};
  for (const name of Object.keys(TIER_PRESETS)) {
    const expanded = expandTierPreset(name);
    if (!expanded) continue;
    const slotCount = Object.keys(expanded.tier_set).length;
    // Availability: reuse the loader hardening so the card's disabled-state can
    // never diverge from what the loader would actually route (and the write-gate 403).
    const kept = opts.isManagedTier ? applyManagedTierSetConstraints(expanded.tier_set) : expanded.tier_set;
    const available = Object.keys(kept).length === slotCount;

    const tiers: TierPresetTierInfo[] = [];
    for (const tier of ['fast', 'balanced', 'deep'] as const) {
      const slot = expanded.tier_set[tier];
      if (!slot) continue;
      // Prefer the provider-picker catalog label; fall back to the registry
      // uiLabel (Fireworks preset-slot models like GLM/DeepSeek aren't in the
      // provider catalog, but carry a friendly uiLabel) before the raw id.
      const cap = modelCapability(slot.model_id);
      const label = LLM_CATALOG.flatMap((e) => e.models).find((m) => m.id === slot.model_id)?.label
        ?? cap?.uiLabel
        ?? slot.model_id;
      const provenance = cap?.provenance;
      const disc = hostDisclosure(slotHost(slot));
      tiers.push({
        tier,
        model_id: slot.model_id,
        label,
        ...(provenance ? { provenance } : {}),
        ...(disc ? { residency: disc.residency, transferBasis: disc.transferBasis, posture: disc.posture } : {}),
      });
    }
    out[name] = { name, tiers, available };
  }
  return out;
}
