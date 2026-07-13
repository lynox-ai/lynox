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
 *   2. apply the override gate (`applyTierGate`) — RETIRED to a pass-through
 *      (D8, 2026-06-17): no tier-band capability gate; the included budget +
 *      per-model cost transparency control spend. The call stays as the seam.
 *   3. CLAMP to the cost ceiling (`clampTier`),
 *   4. map to the concrete model id for the active provider (`getModelId`).
 *
 * Every model-resolution site delegates here.
 */

import { type ModelTier, type LLMProvider, type ProviderKey, type TierSet, normalizeTier, clampTier, getModelId, getBetasForProvider, getProviderDescriptor } from '../types/index.js';
import { applyTierGate, type AccountTier } from './roles.js';
import { channels } from './observability.js';
import type { AnthropicBeta } from '@anthropic-ai/sdk/resources/beta/beta.js';

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

  // `applyTierGate` is now a pass-through (D8 — no tier-band capability gate;
  // budget + cost-transparency control spend), but the call stays as the single
  // override seam. The CLAMP (cost ceiling, `max_tier`) still applies to whatever
  // tier results — that is the real cap, and the step the spawn path historically
  // skipped (which let a run reach a model past a lower max_tier).
  const gatedOverride = normalized !== undefined ? applyTierGate(normalized, req.accountTier) : undefined;
  const tier = clampTier(gatedOverride ?? req.defaultTier, req.maxTier);
  return { tier, modelId: getModelId(tier, req.provider) };
}

/**
 * The provider snapshot for an ALREADY-RESOLVED tier — the single seam that
 * every direct LLM-call site resolves its provider + model id + beta headers
 * through. It exists so hybrid routing (PR-3) can make resolution per-tier by
 * swapping the provider HERE, instead of editing each call site.
 *
 * Unlike {@link resolveRunModel}, this does NOT gate/clamp: callers pass a tier
 * that is already resolved (a session's `this._model`, a literal `'fast'`), so
 * re-running the gate/clamp would double-apply it. Standard mode passes the
 * single active provider, so the result is byte-identical to the previous inline
 * `getModelId(tier, provider)` + `isCustomProvider() ? {} : { betas }`.
 */
export interface TierProviderSnapshot {
  readonly provider: ProviderKey;
  readonly modelId: string;
  /**
   * Anthropic beta headers to send, or `undefined` for OpenAI-compatible
   * providers (custom/openai/mistral) that reject them. Call sites spread
   * `...(snap.betas ? { betas: snap.betas } : {})`, reproducing the old
   * `isCustomProvider() ? {} : { betas }` omission exactly.
   */
  readonly betas: AnthropicBeta[] | undefined;
  /** Per-slot API key for a hybrid tier (undefined in standard mode / base). */
  readonly apiKey?: string | undefined;
  /** Per-slot API base URL for a hybrid tier (undefined in standard mode / base). */
  readonly apiBaseURL?: string | undefined;
}

// Process-global hybrid Tier-Set state, set at config-load + reload (engine
// `_configureOpenAIResolver`), mirroring the openai tier-map resolver pattern.
let _tierSet: TierSet | null = null;
let _routingMode: 'standard' | 'hybrid' = 'standard';

/**
 * Configure the active hybrid Tier-Set from user config. Called at bootstrap +
 * on every reloadUserConfig so a UI toggle takes effect without a restart. Pass
 * `routingMode: 'standard'` (or `tierSet: null`) to disable hybrid resolution.
 */
export function setTierSetResolver(opts: {
  routingMode?: 'standard' | 'hybrid' | undefined;
  tierSet?: TierSet | null | undefined;
}): void {
  if (opts.routingMode !== undefined) _routingMode = opts.routingMode;
  if (opts.tierSet !== undefined) _tierSet = opts.tierSet;
}

/** Inspect the active routing mode (tests + debug). */
export function getActiveRoutingMode(): 'standard' | 'hybrid' {
  return _routingMode;
}

export function resolveTierModel(tier: ModelTier, baseProvider: LLMProvider): TierProviderSnapshot {
  // Hybrid: a configured tier_set slot overrides the base provider/model/creds
  // for this tier. Standard (default): the slot is ignored, so the snapshot is
  // byte-identical to the previous inline resolution against the base provider.
  const slot = _routingMode === 'hybrid' ? _tierSet?.[tier] : undefined;
  const provider: ProviderKey = slot?.provider ?? baseProvider;
  // Anthropic beta headers apply ONLY to the Claude-wire providers (anthropic,
  // vertex), never to custom (an Anthropic-compatible proxy that strips them,
  // agent.ts) nor the OpenAI-compatible wire (openai/mistral). Derived from the
  // RESOLVED provider via a POSITIVE check, so an unknown/typo'd hybrid slot
  // provider safely gets NO betas rather than the wrong ones. Byte-parity with
  // isCustomProvider() (custom||openai → no betas) for the 4 standard providers.
  const wire = getProviderDescriptor(provider)?.wireClient;
  const usesBetas = provider !== 'custom' && (wire === 'anthropic' || wire === 'vertex');
  // A hybrid slot names its own model; otherwise resolve the tier for the base
  // provider exactly as before.
  const modelId = slot?.model_id ?? getModelId(tier, baseProvider);
  // Live routing attribution (lynox:llm:call) — fires per RESOLUTION (not 1:1
  // with an API call: this runs at run start, agent (re)build, background task,
  // and model/effort toggles). It's a routing-observability signal — which
  // provider a tier resolved to (e.g. a hybrid `fast` slot → Mistral live) — NOT
  // a billing counter (use runs.provider for spend). A diagnostics_channel
  // publish is a no-op with no subscriber → free on the hot path.
  channels.llmCall.publish({ tier, provider, model_id: modelId });
  return {
    provider,
    modelId,
    // Cast is safe: usesBetas is true only for anthropic/vertex ⊂ LLMProvider.
    betas: usesBetas ? getBetasForProvider(provider as LLMProvider) : undefined,
    apiKey: slot?.api_key,
    apiBaseURL: slot?.api_base_url,
  };
}

/**
 * Wire-level Agent client config for a resolved per-tier snapshot under hybrid
 * routing. A CROSS-provider slot — one whose provider differs from the base, or
 * that carries enriched `api_key`/`api_base_url` (injected by enrichTierSetCreds
 * / applyManagedTierSetConstraints) — drives the Agent's wire + creds from the
 * slot, mapping the registry ProviderKey to the wire-level LLMProvider the Agent
 * client + beta/cache logic understand (mirrors `clientForTierSnapshot`:
 * mistral→openai). So a hybrid Mistral slot becomes the SAME Agent shape as a
 * standard managed-Mistral session (provider 'openai' + Mistral host), reusing
 * that well-tested path end-to-end. A same-provider/standard snapshot returns
 * `{crossProviderSlot:false}` and the caller keeps its base values (byte-parity).
 *
 * Pure + table-testable — this is the seam the hybrid hot-path regression is
 * pinned to: before this, `session.ts` dispatched a cross-provider tier through
 * the AMBIENT client with only the model id swapped, so a chat-tier→Mistral slot
 * sent a Mistral model id to the Anthropic endpoint → 404. Consumed by the
 * session (main-chat wire) AND spawn (Slice 2 — a subagent's tier follows its
 * hybrid slot, so a `deep` spawn from a Mistral main lands on the deep slot).
 */
export function hybridSlotClientConfig(
  snap: TierProviderSnapshot,
  baseProvider: LLMProvider | undefined,
):
  | { crossProviderSlot: true; provider: LLMProvider; apiKey: string | undefined; apiBaseURL: string | undefined; openaiModelId: string }
  | { crossProviderSlot: false } {
  const isCross = snap.provider !== baseProvider
    || snap.apiKey !== undefined
    || snap.apiBaseURL !== undefined;
  if (!isCross) return { crossProviderSlot: false };
  const wire = getProviderDescriptor(snap.provider)?.wireClient ?? 'anthropic';
  const provider: LLMProvider = wire === 'openai' ? 'openai' : wire === 'vertex' ? 'vertex' : 'anthropic';
  return { crossProviderSlot: true, provider, apiKey: snap.apiKey, apiBaseURL: snap.apiBaseURL, openaiModelId: snap.modelId };
}

/**
 * The full wire client config for a resolved tier under the active routing mode —
 * the single seam every FRESH-Agent site (spawn sub-agents, orchestrator pipeline
 * steps) shares so a hybrid tier_set slot steers a step the same way it steers the
 * main session. It composes {@link resolveTierModel} + {@link hybridSlotClientConfig}
 * into the union of what those sites each need: provider, model, and the per-slot
 * creds (apiKey/apiBaseURL/openaiModelId).
 *
 * Two shapes, distinguished by `crossProviderSlot`:
 *  - **cross** — a hybrid slot whose provider differs from base, or that carries
 *    enriched creds (see `hybridSlotClientConfig`). The Agent's wire + creds come
 *    from the slot; a same-provider slot that `enrichTierSetCreds` deliberately
 *    left key-LESS gets `resolveKey(provider)` filled in so a fresh Agent (which
 *    has no ambient client to borrow a key from) doesn't 401 with an empty key.
 *  - **non-cross** (standard mode / same-provider) — returns the BASE provider +
 *    the tier's base model id + undefined creds. A caller that keeps its base
 *    values when `!crossProviderSlot` is byte-identical to pre-hybrid behavior.
 *    (The genuine-model-id passthrough — a caller that resolved a pinned model id
 *    via resolveRunModel — must keep its OWN model id in the non-cross branch,
 *    since `snap.modelId` here is the tier→provider mapping, not the pin.)
 *
 * Pure + table-testable: `resolveKey` is passed in (bound to `resolveProviderApiKey`
 * over the caller's secret store / env), so no SecretStore is needed in tests.
 * Mirrors the already-correct + tested spawn.ts consumption exactly.
 */
export interface CrossProviderSlotCreds {
  /** Wire-level provider the Agent client uses (mistral→openai already mapped). */
  readonly provider: LLMProvider;
  /** Concrete model id for a cross slot; the tier's base model id otherwise. */
  readonly model: string;
  /** Slot API key (or resolveKey fallback) for a cross slot; undefined otherwise. */
  readonly apiKey: string | undefined;
  /** Slot API base URL for a cross slot; undefined otherwise. */
  readonly apiBaseURL: string | undefined;
  /** OpenAI-compatible model id for a cross slot; undefined otherwise. */
  readonly openaiModelId: string | undefined;
  /** True when the resolved tier maps to a cross-provider hybrid slot. */
  readonly crossProviderSlot: boolean;
}

export function resolveCrossProviderSlotCreds(
  tier: ModelTier,
  baseProvider: LLMProvider,
  resolveKey: (provider: LLMProvider, apiBaseURL?: string) => string | undefined,
): CrossProviderSlotCreds {
  const snap = resolveTierModel(tier, baseProvider);
  const hybrid = hybridSlotClientConfig(snap, baseProvider);
  if (hybrid.crossProviderSlot) {
    return {
      provider: hybrid.provider,
      model: hybrid.openaiModelId,
      apiKey: hybrid.apiKey ?? resolveKey(hybrid.provider, hybrid.apiBaseURL),
      apiBaseURL: hybrid.apiBaseURL,
      openaiModelId: hybrid.openaiModelId,
      crossProviderSlot: true,
    };
  }
  return {
    provider: baseProvider,
    model: snap.modelId,
    apiKey: undefined,
    apiBaseURL: undefined,
    openaiModelId: undefined,
    crossProviderSlot: false,
  };
}
