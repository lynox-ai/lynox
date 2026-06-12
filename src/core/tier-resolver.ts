/**
 * The single chokepoint for "which model + which tier does this run get".
 *
 * Model selection used to be composed differently on every path: spawn applied
 * the account GATE but not the cost CEILING (so a Pro tenant under a low ceiling
 * reached the deep model past its cap); session step-hints + pipeline steps
 * applied the CEILING but not the GATE; cost estimation mapped tiers through an
 * Anthropic-only table. Because no site ran BOTH gate and clamp, the two could
 * disagree per path — the class of bug where managed_pro got the wrong model.
 *
 * `resolveRunModel` composes them in ONE fixed order so they can never diverge:
 *   1. normalize the requested tier (legacy `haiku|sonnet|opus` accepted),
 *   2. GATE by account tier — `deep` is a Pro-only capability (`applyTierGate`),
 *   3. CLAMP to the cost ceiling (`clampTier`),
 *   4. map to the concrete model id for the active provider (`getModelId`).
 *
 * Every model-resolution site delegates here.
 */

import { type ModelTier, type LLMProvider, normalizeTier, clampTier, getModelId } from '../types/index.js';
import { applyTierGate, type AccountTier } from './roles.js';

export interface RunModelRequest {
  /**
   * The caller's requested tier or model id (spawn `spec.model`, a step hint,
   * a pipeline step). A tier name (canonical or legacy) is gated + clamped; a
   * genuine model id (e.g. a pinned `claude-opus-4-7`) is passed through as the
   * model id since it carries no tier to gate/clamp. `undefined` → use `defaultTier`.
   */
  requested?: string | undefined;
  /** Tier used when `requested` is absent (the role default, then the config default). */
  defaultTier: ModelTier;
  /** Account plan tier — gates the `deep` capability (only `'pro'` may reach deep). */
  accountTier: AccountTier | undefined;
  /** Cost ceiling — the resolved tier is clamped down to it. */
  maxTier: ModelTier | undefined;
  /** Active LLM provider — selects the concrete model id for the resolved tier. */
  provider: LLMProvider;
}

export interface ResolvedRunModel {
  /** The provider-agnostic tier after gate + clamp (the cost band). */
  readonly tier: ModelTier;
  /** The concrete model id to send to the provider. */
  readonly modelId: string;
}

/**
 * Resolve the effective tier + concrete model id for a run. See the file header
 * for the gate→clamp→provider order. Pure + deterministic — table-testable.
 */
export function resolveRunModel(req: RunModelRequest): ResolvedRunModel {
  // Treat an empty string like an absent request: `model: ''` is type-legal but
  // means "no override" — every old call site coalesced '' to the default tier.
  const requested = req.requested ? req.requested : undefined;
  const normalized = requested !== undefined ? normalizeTier(requested) : undefined;

  // A genuine model id (not a tier name) carries no tier to gate/clamp — pass it
  // through verbatim as the model id, but still derive a (clamped) tier from the
  // default so callers that need a cost band (budget, estimation) get one.
  if (requested !== undefined && normalized === undefined) {
    return { tier: clampTier(req.defaultTier, req.maxTier), modelId: requested };
  }

  // The account GATE applies to an explicit tier OVERRIDE only — `deep` is a
  // Pro-only capability the caller asked for. A role/config DEFAULT is trusted
  // and NOT gated (matches applyTierGate's documented contract: no override →
  // fall through to the default untouched). The CLAMP (cost ceiling) then applies
  // to whatever tier results — that is the step the spawn path skipped, which let
  // a Pro tenant reach the deep model past a lower max_tier.
  const gatedOverride = normalized !== undefined ? applyTierGate(normalized, req.accountTier) : undefined;
  const tier = clampTier(gatedOverride ?? req.defaultTier, req.maxTier);
  return { tier, modelId: getModelId(tier, req.provider) };
}
