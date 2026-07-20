import type { AnthropicBeta } from '@anthropic-ai/sdk/resources/beta/beta.js';
import type { ProviderDescriptor, ProviderKey, CacheProfile } from './provider-registry.js';

// === 4.1 Model Tiers & Providers ===

/**
 * Provider-agnostic capability tiers. Renamed 2026-05-29 from the legacy
 * Anthropic-brand names (`opus`/`sonnet`/`haiku`) because lynox is now
 * provider-agnostic — the brand names leaked into tool schemas + config and
 * caused models on non-Anthropic providers to mislabel themselves (a Mistral
 * tenant reporting its `balanced` tier as "Sonnet"). The tier names describe
 * the cost/capability band; each provider resolves them to a concrete model
 * via the `*_MODEL_MAP`s below.
 *   fast     — cheapest/lowest-latency (status checks, formatting)
 *   balanced — default workhorse (data queries, content, tool use)
 *   deep     — reasoning-heavy (strategy, multi-source analysis)
 * Legacy names are still accepted at input boundaries via {@link normalizeTier}.
 */
export type ModelTier = 'deep' | 'balanced' | 'fast';

/** Legacy Anthropic-brand tier aliases → provider-agnostic names. Single
 *  source of truth; also reused by `ModelTierSchema` in types/schemas.ts. */
export const LEGACY_TIER_ALIASES: Record<string, ModelTier> = {
  opus: 'deep',
  sonnet: 'balanced',
  haiku: 'fast',
};

/**
 * Normalize a tier string to the canonical provider-agnostic name, accepting
 * both the current names (`fast`/`balanced`/`deep`) and the legacy
 * Anthropic-brand names (`haiku`/`sonnet`/`opus`). Returns `undefined` for
 * anything unrecognized so callers can fall back to their own default.
 * Applied at every input boundary (config load, env vars, tool inputs) so
 * persisted `config.json` files and `LYNOX_DEFAULT_TIER` env vars written
 * before the rename keep working.
 */
export function normalizeTier(value: string | undefined): ModelTier | undefined {
  if (value === undefined) return undefined;
  if (value === 'fast' || value === 'balanced' || value === 'deep') return value;
  return LEGACY_TIER_ALIASES[value];
}

/**
 * Provenance of a thread's persisted `model_tier` (arc:model-selector Wave P1,
 * DEF-0095). Records WHO chose the tier so a sticky per-thread pick (D18) is
 * distinguishable from a machine default:
 *  - `'user'`    — a deliberate pick (the composer picker was touched, or the
 *                  mid-thread re-pick endpoint ran). STICKY: resume honours it.
 *  - `'default'` — a new thread whose creator did NOT touch the picker.
 *  - `'unknown'` — origin not observed (the schema DEFAULT + the conservative
 *                  backfill value for pre-column rows).
 *
 * ADVISORY-ONLY: it is client-supplied (only the picker UI knows explicit-vs-
 * untouched), so a client CAN send `'user'` for a machine default. That is
 * harmless ONLY as long as `source` stays observational — it MUST NOT gate any
 * tier/cost/capability decision. The instant a policy keys off it, a client
 * could pin an expensive tier by lying. Kept a 3-value enum on purpose; because
 * the column is `TEXT`, a future value (e.g. `'inferred'`) is a zero-migration
 * string add (DEF-0127), so no speculative writers are named now.
 */
export type ThreadModelSource = 'user' | 'default' | 'unknown';

/**
 * Validate a client-supplied `source` at an input boundary. Returns `undefined`
 * for anything unrecognised so callers fall back to the schema default
 * (`'unknown'`). Mirrors {@link normalizeTier}'s boundary-validation shape.
 */
export function normalizeThreadModelSource(value: unknown): ThreadModelSource | undefined {
  return value === 'user' || value === 'default' || value === 'unknown' ? value : undefined;
}

export type LLMProvider = 'anthropic' | 'vertex' | 'custom' | 'openai';

/** Named model profile for non-Claude providers (Mistral, Gemini, Grok, etc.). */
export interface ModelProfile {
  /** Provider type — always 'openai' (OpenAI-compatible API). */
  provider: 'openai';
  /** API base URL (e.g. 'https://api.mistral.ai/v1'). */
  api_base_url: string;
  /** API key for this provider. Ignored if `auth: 'google-vertex'` (OAuth token generated from service account). */
  api_key: string;
  /** Authentication mode. 'static' (default) uses api_key as-is. 'google-vertex' generates OAuth tokens from GOOGLE_APPLICATION_CREDENTIALS. */
  auth?: 'static' | 'google-vertex' | undefined;
  /** Model ID to send in requests (e.g. 'mistral-large-2512'). */
  model_id: string;
  /** Context window size in tokens. Default: 200000. */
  context_window?: number | undefined;
  /** Max output tokens. Default: 16000. */
  max_tokens?: number | undefined;
  /** Max continuation attempts. Default: 5. */
  max_continuations?: number | undefined;
}

/**
 * Runtime guard for a {@link ModelProfile}. Checks only the REQUIRED fields the
 * downstream LLM client dereferences (`provider`, `api_base_url`, `api_key`,
 * `model_id`) — optional fields are left to their defaults. Used at every
 * untrusted boundary that ingests a profile (the `LYNOX_MODEL_PROFILES_JSON`
 * env blob, spawn `profile` inputs) so a malformed entry is dropped rather than
 * reaching the openai-adapter as `Bearer undefined` and crashing the run.
 */
export function isModelProfile(value: unknown): value is ModelProfile {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    v['provider'] === 'openai' &&
    typeof v['api_base_url'] === 'string' &&
    typeof v['api_key'] === 'string' &&
    typeof v['model_id'] === 'string'
  );
}

export const MODEL_MAP: Record<ModelTier, string> = {
  'deep':     'claude-opus-4-6',
  'balanced': 'claude-sonnet-4-6',
  'fast':     'claude-haiku-4-5-20251001',
};

/** Vertex AI Claude model identifiers (Google Cloud). */
export const VERTEX_MODEL_MAP: Record<ModelTier, string> = {
  'deep':     'claude-opus-4-6',
  'balanced': 'claude-sonnet-4-6',
  'fast':     'claude-haiku-4-5',
};

/** Canonical Mistral base URL (used for tier-map detection). */
export const MISTRAL_API_BASE = 'https://api.mistral.ai/v1';

/**
 * Mistral tier-set for openai-provider mode.
 * Pinned to specific snapshots so behaviour stays reproducible across model
 * refreshes. `mistral-large-latest` would auto-roll silently — bad for cost
 * and behaviour-drift in managed-EU tenants.
 *   fast     → ministral-8b-2512      (gen 3 edge model, replaces retired mistral-small-2603)
 *   balanced → ministral-14b-2512     (near-large quality at ~6× lower cost)
 *   deep     → mistral-large-2512     (Mistral quality leader, tool-use)
 * (Keep this block in sync with MISTRAL_MODEL_MAP below — the values are
 *  pinned by tests/doc-drift.test.ts.)
 *
 * Updated 2026-05-24: ministral-3b/8b-2410 retired 2025-12-31, mistral-small-2603 deprecated.
 * fast-tier moves to ministral-8b-2512 (gen 3 edge, ~$0.15/M, multimodal, 256k ctx).
 */
// Refreshed 2026-05-29 (Set-Bench v4, fair judge panel): Mistral deprecated
// the Magistral reasoning family (magistral-medium-2509 retires 2026-07-31),
// so `deep` moves to mistral-large-2512 — the Mistral quality leader, which
// medium-2604 (the nominal Magistral successor) never beats at 6× the cost.
// `balanced` adopts ministral-14b-2512 (100% pass, near-large quality at ~6×
// lower cost), giving a clean fast→balanced→deep capability ladder.
export const MISTRAL_MODEL_MAP: Record<ModelTier, string> = {
  'deep':     'mistral-large-2512',
  'balanced': 'ministral-14b-2512',
  'fast':     'ministral-8b-2512',
};

/**
 * True when `apiBaseURL`'s host is the Mistral API — `api.mistral.ai` or any
 * `*.mistral.ai` subdomain. Hostname-strict (parses the URL) so a crafted base
 * URL like `https://api.mistral.ai.evil.com` or `https://x/?proxy=mistral.ai`
 * cannot spoof Mistral identity; invalid or empty URLs return `false`. Single
 * source of truth for "is this the Mistral endpoint" — consumed by the openai
 * tier→model map below and by the managed key-promotion in `config.ts`.
 */
export function isMistralHost(apiBaseURL: string | undefined): boolean {
  if (!apiBaseURL) return false;
  try {
    const host = new URL(apiBaseURL).hostname.toLowerCase();
    return host === 'api.mistral.ai' || host.endsWith('.mistral.ai');
  } catch {
    return false;
  }
}

/**
 * Derive a tier→model map for the openai-compat provider, based on the
 * configured `api_base_url`. Returns `null` for non-Mistral / unknown / invalid
 * base URLs so callers can fall back to the single configured `openai_model_id`.
 *
 * Pure function — no side effects. Engine init wires the result via
 * `setOpenAIModelResolver()`.
 */
export function getOpenAIModelMap(apiBaseURL: string | undefined): Record<ModelTier, string> | null {
  return isMistralHost(apiBaseURL) ? MISTRAL_MODEL_MAP : null;
}

/**
 * Process-global tier→model resolver for openai-compat providers. Set once
 * at engine bootstrap by `setOpenAIModelResolver()` based on the active
 * config. Without this, `getModelId(tier, 'openai')` would return Anthropic
 * IDs which downstream Mistral/OpenAI endpoints reject.
 */
let _openaiModelMap: Record<ModelTier, string> | null = null;
let _openaiFallbackModelId: string | null = null;

/**
 * Configure the active openai-compat tier→model resolver. Called by engine
 * bootstrap once `userConfig` is loaded. Pass `null` (or omit fields) to
 * reset to legacy behaviour (returns Anthropic IDs — fine for tests).
 */
export function setOpenAIModelResolver(opts: {
  map?: Record<ModelTier, string> | null | undefined;
  fallbackModelId?: string | null | undefined;
}): void {
  if (opts.map !== undefined) _openaiModelMap = opts.map;
  if (opts.fallbackModelId !== undefined) _openaiFallbackModelId = opts.fallbackModelId;
}

/** Inspect the currently-registered openai tier map (mostly for tests + debug). */
export function getActiveOpenAIModelMap(): Record<ModelTier, string> | null {
  return _openaiModelMap;
}

// === Config-aware balanced-model resolver (Sonnet variant selection) ===
// The `balanced` tier resolves to `claude-sonnet-4-6` by default (MODEL_MAP),
// but a per-instance config field (`balanced_model`) can opt-in to a different
// served Sonnet — currently `claude-sonnet-5`. This mirrors the openai resolver
// pattern above: a pure `resolveBalancedModel(config)` computes the value, the
// engine pushes it to the process-global at bootstrap + reload, and the
// Anthropic/custom descriptors consult the global at CALL time. The raw
// MODEL_MAP stays the ultimate fallback, so an absent/invalid selection is a
// zero-behaviour no-op (default = Sonnet 4.6).

/** The only Sonnet ids `balanced_model` may select. Anything else falls back
 *  to `MODEL_MAP.balanced` — an invalid value can never route balanced to a
 *  non-Sonnet (or unknown) model. */
export const SERVED_BALANCED_SONNET_IDS: ReadonlySet<string> = new Set([
  'claude-sonnet-4-6',
  'claude-sonnet-5',
]);

/**
 * Resolve which concrete Sonnet the `balanced` tier should use for this
 * instance. Returns the configured `balanced_model` iff it is a served Sonnet
 * id; otherwise the raw `MODEL_MAP.balanced` default (Sonnet 4.6). Pure — the
 * default (4.6) is the fallback, so nothing changes unless a valid override is
 * set. Accepts a minimal config shape to avoid a types↔config import cycle.
 */
export function resolveBalancedModel(config: { balanced_model?: string | undefined }): string {
  const requested = config.balanced_model;
  if (requested !== undefined && SERVED_BALANCED_SONNET_IDS.has(requested)) return requested;
  return MODEL_MAP.balanced;
}

/**
 * Process-global override for the `balanced` tier on the Claude-wire providers
 * (anthropic + custom). `null` = no override (use MODEL_MAP.balanced). Set at
 * engine bootstrap + reload via {@link setBalancedModelResolver}. Read at call
 * time by {@link anthropicTierModel} so a config reload takes effect without a
 * restart — same lifecycle seam as `_openaiModelMap`.
 */
let _balancedModelOverride: string | null = null;

/**
 * Configure the active `balanced`-tier Sonnet override. Defensively refuses any
 * id that is not a served Sonnet (falls back to no-override) so a malformed
 * value can never leak onto the wire. Pass `null` to reset (tests / defaults).
 */
export function setBalancedModelResolver(modelId: string | null): void {
  if (modelId === null) {
    _balancedModelOverride = null;
    return;
  }
  _balancedModelOverride = SERVED_BALANCED_SONNET_IDS.has(modelId) ? modelId : null;
}

/** The `balanced` model the Claude-wire providers currently resolve to
 *  (override if set + valid, else MODEL_MAP.balanced). Tests + debug. */
export function getActiveBalancedModel(): string {
  return _balancedModelOverride ?? MODEL_MAP.balanced;
}

/**
 * Tier→model resolution for the Claude-wire providers (anthropic + custom).
 * Identical to `MODEL_MAP[tier]` EXCEPT `balanced`, which honours the active
 * per-instance Sonnet override. `deep`/`fast` are untouched. Read at call time.
 */
function anthropicTierModel(tier: ModelTier): string {
  if (tier === 'balanced' && _balancedModelOverride !== null) return _balancedModelOverride;
  return MODEL_MAP[tier];
}

// === Provider Registry (resolution) ===
// PR-1a: route tier→model resolution through a per-provider descriptor registry
// instead of the hardcoded `if (provider === …)` branches. Byte-parity — each
// descriptor's `resolveModelId` reproduces the exact pre-registry branch. Keyed
// by an OPEN `ProviderKey` so a new provider (incl. the now first-class
// `'mistral'` identity) registers without editing `LLMProvider` or the resolver.
// Co-located here because the openai descriptor reads the module-private resolver
// state (`_openaiModelMap`/`_openaiFallbackModelId`) at call time. The wire-client
// dispatch (createLLMClient) + Capability/CacheProfile re-projection follow in PR-1b.
const PROVIDER_REGISTRY = new Map<ProviderKey, ProviderDescriptor>();

/** Register (or replace) a provider descriptor. */
export function registerProvider(descriptor: ProviderDescriptor): void {
  PROVIDER_REGISTRY.set(descriptor.id, descriptor);
}

/** Inspect a registered descriptor (identity + metadata), or `undefined`. */
export function getProviderDescriptor(key: ProviderKey): ProviderDescriptor | undefined {
  return PROVIDER_REGISTRY.get(key);
}

/**
 * The cache mechanism for a provider — used by the cache wiring to choose
 * `cache_control` breakpoints (Anthropic) vs `prompt_cache_key` (OpenAI-compat).
 * Defaults to `'none'` for an unregistered key (make no caching assumption).
 */
export function getCacheProfile(provider: ProviderKey): CacheProfile {
  return PROVIDER_REGISTRY.get(provider)?.cache ?? { mechanism: 'none' };
}

/**
 * Resolve a tier to a model ID via the provider registry — the single
 * resolution path, no `if (provider === …)` branching. An unregistered key
 * degrades to the Anthropic map: no real caller passes an unknown key (the
 * typed {@link getModelId} only admits `LLMProvider`, all registered), so this
 * only guards a future/stub key gracefully instead of throwing.
 */
export function resolveModelIdViaRegistry(tier: ModelTier, provider: ProviderKey): string {
  return PROVIDER_REGISTRY.get(provider)?.resolveModelId(tier) ?? MODEL_MAP[tier];
}

// Built-in descriptors — each `resolveModelId` is the verbatim pre-registry branch.
// Cache mechanism — mirrors the runtime `isCustomProxy` split (agent.ts:352,
// 1128-1140): only Anthropic + Vertex honour block-level `cache_control`
// breakpoints (explicit-breakpoint). custom AND openai-compat proxies (incl.
// Mistral) STRIP cache_control and rely on the provider's own automatic prefix
// caching (automatic-prefix → a `prompt_cache_key`, PR-3 wiring). Note this is a
// distinct axis from `wireClient`: custom uses the Anthropic SDK client yet
// caches automatic-prefix.
registerProvider({
  id: 'anthropic', wireClient: 'anthropic', defaultTierModels: MODEL_MAP,
  // `balanced` honours the per-instance Sonnet override (anthropicTierModel);
  // deep/fast are the raw MODEL_MAP. Default (no override) = byte-identical.
  resolveModelId: (tier) => anthropicTierModel(tier),
  cache: { mechanism: 'explicit-breakpoint' },
});
registerProvider({
  id: 'vertex', wireClient: 'vertex', defaultTierModels: VERTEX_MODEL_MAP,
  resolveModelId: (tier) => VERTEX_MODEL_MAP[tier],
  cache: { mechanism: 'explicit-breakpoint' },
});
registerProvider({
  // 'custom' (LiteLLM etc.) uses the Anthropic SDK client + model IDs (the proxy
  // maps them) — hence wireClient:'anthropic'. But the engine treats it as a
  // custom proxy and STRIPS cache_control (agent.ts:1140), so cache-wise it is
  // automatic-prefix like openai, NOT explicit-breakpoint.
  // A custom (Anthropic-compatible) proxy resolves `balanced` through the same
  // per-instance Sonnet override — the proxy maps whichever Claude id it gets.
  id: 'custom', wireClient: 'anthropic', defaultTierModels: MODEL_MAP,
  resolveModelId: (tier) => anthropicTierModel(tier),
  cache: { mechanism: 'automatic-prefix' },
});
registerProvider({
  // OpenAI-compatible providers: prefer the active openai tier→map (bootstrapped
  // per config — e.g. MISTRAL_MODEL_MAP for managed), then the single configured
  // `openai_model_id` fallback, then Anthropic IDs (legacy/unbootstrapped). The
  // closure reads the resolver state at CALL time, so config bootstrap/reload
  // still applies. Verbatim 3-stage fallback.
  id: 'openai', wireClient: 'openai', defaultTierModels: MODEL_MAP,
  resolveModelId: (tier) => _openaiModelMap?.[tier] ?? _openaiFallbackModelId ?? MODEL_MAP[tier],
  cache: { mechanism: 'automatic-prefix' },
});
registerProvider({
  // Mistral as a FIRST-CLASS identity (`id:'mistral'`), wire path = openai.
  // Additive: no current caller resolves by the `'mistral'` key — Mistral flows
  // through the `'openai'` provider + the dynamic map — so this changes no
  // existing resolution. It gives Mistral a real registry identity for later PRs.
  id: 'mistral', wireClient: 'openai', defaultTierModels: MISTRAL_MODEL_MAP,
  resolveModelId: (tier) => MISTRAL_MODEL_MAP[tier],
  cache: { mechanism: 'automatic-prefix' },
});

/**
 * Resolve a tier name to a provider-specific model ID — dispatched through the
 * provider registry (descriptors above). Behaviour is byte-identical to the
 * pre-registry per-provider branches.
 */
export function getModelId(tier: ModelTier, provider: LLMProvider = 'anthropic'): string {
  return resolveModelIdViaRegistry(tier, provider);
}

/**
 * Normalize a provider-specific model ID to its base Anthropic model ID.
 * E.g. 'claude-sonnet-4-6@20260101' → 'claude-sonnet-4-6'
 * Returns the input unchanged if already a base model ID or tier alias.
 */
export function normalizeModelId(model: string): string {
  // Defense-in-depth: capability lookups route through here and are
  // contractually "safe on unknown ids" (modelCapabilityOrFallback returns a
  // fallback rather than throwing). A missed tier-normalization boundary can
  // hand us undefined (e.g. MODEL_MAP[<legacy-tier>] → undefined); guard so it
  // degrades to the fallback capability instead of a `.replace of undefined`
  // TypeError → 500.
  if (typeof model !== 'string') return '';
  // Strip Vertex AI version suffix: '@YYYYMMDD'
  return model.replace(/@\d{8}$/, '');
}

/** Approximate characters per token for context estimation. */
export const CHARS_PER_TOKEN = 3.5;

// === 4.2 Model Capability Registry ===

/** Pricing per million tokens. cacheWrite/cacheRead default to input rate
 *  for providers without separate cache tiers (e.g. Mistral). */
export interface ModelPricing {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

/** Capability flags surfaced to UI + agent (e.g. show-all-grayed pattern). */
export interface ModelFeatures {
  vision: boolean;
  extendedThinking: boolean;
  toolUse: boolean;
  promptCaching: boolean;
  pdfInput: boolean;
}

/** Where a model's WEIGHTS originate (supply-chain provenance) — axis (c) of the
 *  model-presets three-axis disclosure. Distinct from where the DATA is processed
 *  (the HOST — see `host-disclosure.ts`): a CN-weights model served from a Western
 *  host (e.g. GLM via Fireworks/US) is still CN by weights. `US`/`EU`/`CN` cover
 *  the current roster; extend as the fleet grows. */
export type WeightsOrigin = 'US' | 'EU' | 'CN';

/**
 * Single source of truth for per-model facts. Keyed by canonical provider
 * model id (no tier aliases). Replaces the pre-2026-05-18 scattered
 * _CONTEXT_WINDOW / _DEFAULT_MAX_TOKENS / _MAX_CONTINUATIONS / pricing maps
 * that drifted (staging "Kontext: 423%" bug came from three sites with the
 * same formula and two stale copies — see commit ed428cc8 follow-up).
 */
export interface ModelCapability {
  /** Provider's canonical id (e.g. 'claude-sonnet-4-6', 'mistral-large-2512'). */
  id: string;
  /** Provider this model belongs to. */
  provider: LLMProvider;
  /** Tier classification. `null` for utility / bench-only models without tier routing. */
  tier: ModelTier | null;
  /** Native context window in tokens. */
  contextWindow: number;
  /** Default max output tokens when caller doesn't specify. */
  defaultMaxOutput: number;
  /** Max continuation attempts the Agent will run for this model. */
  maxContinuations: number;
  /** Beta headers required to unlock this variant (e.g. ['context-1m-2025-08-07']). */
  betaHeaders: AnthropicBeta[];
  /** Capability flags. */
  features: ModelFeatures;
  /** Pricing per million tokens. */
  pricing: ModelPricing;
  /** Human-readable label for UI dropdowns / pills. */
  uiLabel: string;
  /**
   * Per-model chars-per-token override for context estimation. When absent,
   * consumers fall back to the global {@link CHARS_PER_TOKEN} (3.5). Set only
   * for models whose tokenizer diverges materially from the 3.5 baseline —
   * e.g. Sonnet 5's new tokenizer emits ~30% more tokens for the same text, so
   * a LOWER chars-per-token (more tokens per char) keeps the occupancy meter +
   * truncation math conservative. Leaving existing Claude 4.6 entries unset
   * preserves byte-identical estimation for today's default fleet.
   */
  charsPerToken?: number | undefined;
  /** Model weights-origin for the presets supply-chain disclosure (axis c).
   *  Set on the models a preset SURFACES, so the disclosure carries a per-model
   *  weights-origin for each (incl. US/EU, not only CN — the picker renders all
   *  three axes per model). Absent on models the presets don't surface, where the
   *  host implies it. */
  provenance?: WeightsOrigin | undefined;
}

const CLAUDE_FEATURES: ModelFeatures = {
  vision: true,
  extendedThinking: true,
  toolUse: true,
  promptCaching: true,
  pdfInput: true,
};

const MISTRAL_FEATURES_LARGE: ModelFeatures = {
  vision: false,
  extendedThinking: false,
  toolUse: true,
  promptCaching: true,
  pdfInput: false,
};

const MISTRAL_FEATURES_SMALL: ModelFeatures = {
  vision: false,
  extendedThinking: false,
  toolUse: true,
  promptCaching: true,
  pdfInput: false,
};

// Gen-3 Mistral (ministral-{3,8,14}b-2512, mistral-large-2512) are multimodal:
// they accept an OpenAI `image_url` part and describe it. VERIFIED against the
// live Mistral API 2026-07-18 (red/blue split PNG → correctly named both halves
// on all four). This is the ONLY axis that separates them from MISTRAL_FEATURES_*
// today, so it earns its own object rather than flipping the shared ones — the
// legacy/opt-in roster (codestral, magistral, nemo, *-2410/2508/2603) stays
// vision:false: codestral + nemo genuinely reject images ("Image input is not
// enabled for this model"), and the reasoning/deprecated ids the product doesn't
// tier-route are left unsupported by decision (rafael 2026-07-18) — a false-NO
// only yields the clear pre-flight throw, never a silent answer to an unseen image.
const MISTRAL_FEATURES_GEN3: ModelFeatures = {
  vision: true,
  extendedThinking: false,
  toolUse: true,
  promptCaching: true,
  pdfInput: false,
};

// Fireworks-hosted openai-compat text models (GLM 5.2, DeepSeek v4 Pro). Text +
// tool-use + prompt-cache; NO vision (Fireworks model pages state "image input:
// not supported" for both — so vision:false yields a clean pre-flight throw on an
// image-attach, never a silent drop). extendedThinking is the Anthropic-specific
// mechanism → false on the openai wire.
const FIREWORKS_TEXT_FEATURES: ModelFeatures = {
  vision: false,
  extendedThinking: false,
  toolUse: true,
  promptCaching: true,
  pdfInput: false,
};

const ONE_M_BETA: AnthropicBeta[] = ['context-1m-2025-08-07'];

/**
 * The cache TTL the agent attaches to every Anthropic/Vertex cache breakpoint
 * (see `Agent._buildSystemPrompt` / `_applyOutboundCaching`, which send
 * `cache_control: { type: 'ephemeral', ttl: AGENT_CACHE_TTL }`). Anthropic bills
 * cache WRITES by TTL — 5-minute = 1.25× input, 1-hour = 2× input — while cache
 * READS are 0.1× input regardless of TTL. The `cacheWrite` prices in
 * MODEL_CAPABILITIES MUST equal `input × CACHE_TTL_WRITE_MULTIPLIER[AGENT_CACHE_TTL]`
 * or managed billing silently drifts from what Anthropic charges. It DID drift:
 * cacheWrite was priced at the 5m rate (1.25×) while the agent sent 1h (2×), so
 * every cached prefix write under-billed. The pricing-vs-TTL contract test in
 * models.test.ts pins this invariant. Custom/OpenAI proxies (Mistral) get no
 * `cache_control` (`isCustomProxy`), so their `cacheWrite` is not governed here.
 */
export const AGENT_CACHE_TTL = '1h' as const;

/** Anthropic cache-WRITE price as a multiple of base input price, keyed by TTL. */
export const CACHE_TTL_WRITE_MULTIPLIER: Record<string, number> = { '5m': 1.25, '1h': 2 };

/** Anthropic cache-READ price as a multiple of base input price (TTL-independent). */
export const CACHE_READ_MULTIPLIER = 0.1;

export const MODEL_CAPABILITIES: Record<string, ModelCapability> = {
  // === Anthropic Claude (direct + custom proxy) ===
  // Claude Opus 4.8 — the max-quality preset's deep model (model-presets P1).
  // Additive: MODEL_MAP.deep stays opus-4-6 (re-pointing it is a deliberate
  // behavior change, not this wave). Pricing verified against Anthropic's catalog
  // (2026-06-24): $5/$25, 1M native ctx, vision. Shares the 4.7 tokenizer (no
  // charsPerToken override). TTL contract: cacheWrite=input×2, cacheRead=input×0.1.
  'claude-opus-4-8': {
    id: 'claude-opus-4-8',
    provider: 'anthropic',
    tier: 'deep',
    contextWindow: 1_000_000,
    defaultMaxOutput: 32_000,
    maxContinuations: 20,
    betaHeaders: [],
    features: CLAUDE_FEATURES,
    pricing: { input: 5, output: 25, cacheWrite: 10, cacheRead: 0.50 },
    uiLabel: 'Claude Opus 4.8',
    provenance: 'US',
  },
  'claude-opus-4-7': {
    id: 'claude-opus-4-7',
    provider: 'anthropic',
    tier: 'deep',
    contextWindow: 1_000_000,
    defaultMaxOutput: 32_000,
    maxContinuations: 20,
    betaHeaders: [],
    features: CLAUDE_FEATURES,
    pricing: { input: 5, output: 25, cacheWrite: 10, cacheRead: 0.50 },
    uiLabel: 'Claude Opus 4.7',
  },
  'claude-opus-4-6': {
    id: 'claude-opus-4-6',
    provider: 'anthropic',
    tier: 'deep',
    contextWindow: 1_000_000,
    defaultMaxOutput: 32_000,
    maxContinuations: 20,
    betaHeaders: [],
    features: CLAUDE_FEATURES,
    pricing: { input: 5, output: 25, cacheWrite: 10, cacheRead: 0.50 },
    uiLabel: 'Claude Opus 4.6',
  },
  'claude-sonnet-4-6': {
    id: 'claude-sonnet-4-6',
    provider: 'anthropic',
    tier: 'balanced',
    contextWindow: 200_000,
    defaultMaxOutput: 16_000,
    maxContinuations: 10,
    betaHeaders: [],
    features: CLAUDE_FEATURES,
    pricing: { input: 3, output: 15, cacheWrite: 6, cacheRead: 0.30 },
    uiLabel: 'Claude Sonnet 4.6',
  },
  // Claude Sonnet 5 — additive opt-in (4.6 stays the balanced default). 1M
  // context NATIVELY (no `context-1m` beta header, unlike the 4.6[1m] variant),
  // mirroring the Opus base entries' shape. Pricing is $3/$15 STICKER: Anthropic
  // lists an intro $2/$10 through 2026-08-31, then reverts to $3/$15 on Sep 1 —
  // we bill sticker so the customer-facing rate is stable across that cutover
  // (no 2026-09 re-deploy; the intro window is temporary extra margin). The
  // pricing-vs-TTL contract (models.test.ts) requires cacheWrite = input×2 (1h
  // TTL) and cacheRead = input×0.1, so 6 and 0.30 are the only valid values.
  // charsPerToken 2.7 (≈ 3.5 / 1.3): Sonnet 5's new tokenizer emits ~30% more
  // tokens/text (documented Anthropic fact) — a conservative baseline pending
  // live count_tokens measurement (measure-first). Same per-token RATE as 4.6;
  // the real cost delta is the tokenizer, which the metered debit counts directly.
  'claude-sonnet-5': {
    id: 'claude-sonnet-5',
    provider: 'anthropic',
    tier: 'balanced',
    contextWindow: 1_000_000,
    defaultMaxOutput: 16_000,
    maxContinuations: 10,
    betaHeaders: [],
    features: CLAUDE_FEATURES,
    pricing: { input: 3, output: 15, cacheWrite: 6, cacheRead: 0.30 },
    uiLabel: 'Claude Sonnet 5',
    charsPerToken: 2.7,
    provenance: 'US',
  },
  'claude-haiku-4-5-20251001': {
    id: 'claude-haiku-4-5-20251001',
    provider: 'anthropic',
    tier: 'fast',
    contextWindow: 200_000,
    defaultMaxOutput: 8_192,
    maxContinuations: 5,
    betaHeaders: [],
    features: CLAUDE_FEATURES,
    pricing: { input: 1, output: 5, cacheWrite: 2, cacheRead: 0.10 },
    uiLabel: 'Claude Haiku 4.5',
    provenance: 'US',
  },
  // Vertex AI variant — same model, different id surface (no date suffix).
  'claude-haiku-4-5': {
    id: 'claude-haiku-4-5',
    provider: 'vertex',
    tier: 'fast',
    contextWindow: 200_000,
    defaultMaxOutput: 8_192,
    maxContinuations: 5,
    betaHeaders: [],
    features: CLAUDE_FEATURES,
    pricing: { input: 1, output: 5, cacheWrite: 2, cacheRead: 0.10 },
    uiLabel: 'Claude Haiku 4.5',
  },
  // 1M-context beta variants — Anthropic's identifier for the 1M-context
  // beta when `anthropic-beta: context-1m-2025-08-07` is on. Without these
  // explicit entries the lookup falls through to the 200k default (only
  // @YYYYMMDD gets stripped, not bracket suffixes), which historically caused
  // the staging "Kontext: 423%" UI mismatch when an extended-Sonnet session
  // was treated as 200k for trim/percentage calc. Pricing mirrors the base
  // model for now — Anthropic may levy a 1M-tier premium later; revisit when
  // that lands.
  'claude-opus-4-7[1m]': {
    id: 'claude-opus-4-7[1m]',
    provider: 'anthropic',
    tier: 'deep',
    contextWindow: 1_000_000,
    defaultMaxOutput: 32_000,
    maxContinuations: 20,
    betaHeaders: ONE_M_BETA,
    features: CLAUDE_FEATURES,
    pricing: { input: 5, output: 25, cacheWrite: 10, cacheRead: 0.50 },
    uiLabel: 'Claude Opus 4.7 (1M)',
  },
  'claude-opus-4-6[1m]': {
    id: 'claude-opus-4-6[1m]',
    provider: 'anthropic',
    tier: 'deep',
    contextWindow: 1_000_000,
    defaultMaxOutput: 32_000,
    maxContinuations: 20,
    betaHeaders: ONE_M_BETA,
    features: CLAUDE_FEATURES,
    pricing: { input: 5, output: 25, cacheWrite: 10, cacheRead: 0.50 },
    uiLabel: 'Claude Opus 4.6 (1M)',
  },
  'claude-sonnet-4-6[1m]': {
    id: 'claude-sonnet-4-6[1m]',
    provider: 'anthropic',
    tier: 'balanced',
    contextWindow: 1_000_000,
    defaultMaxOutput: 16_000,
    maxContinuations: 10,
    betaHeaders: ONE_M_BETA,
    features: CLAUDE_FEATURES,
    pricing: { input: 3, output: 15, cacheWrite: 6, cacheRead: 0.30 },
    uiLabel: 'Claude Sonnet 4.6 (1M)',
  },
  // === Mistral tier-set (eu-sovereign managed via openai-compat) ===
  // cacheRead = 10% of input per Mistral pricing docs (2026-05-24).
  // Mistral exposes `prompt_cache_key` opt-in; cached input billed at 10%.
  // Cache-write is implicit (no separate billing field per Mistral terms).
  'ministral-3b-2512': {
    id: 'ministral-3b-2512',
    provider: 'openai',
    tier: 'fast',
    contextWindow: 262_144,
    defaultMaxOutput: 8_192,
    maxContinuations: 5,
    betaHeaders: [],
    features: MISTRAL_FEATURES_GEN3,
    pricing: { input: 0.10, output: 0.10, cacheWrite: 0.10, cacheRead: 0.010 },
    uiLabel: 'Ministral 3B',
  },
  'ministral-8b-2512': {
    id: 'ministral-8b-2512',
    provider: 'openai',
    tier: 'fast',
    contextWindow: 262_144,
    defaultMaxOutput: 8_192,
    maxContinuations: 5,
    betaHeaders: [],
    features: MISTRAL_FEATURES_GEN3,
    pricing: { input: 0.15, output: 0.15, cacheWrite: 0.15, cacheRead: 0.015 },
    uiLabel: 'Ministral 8B',
    provenance: 'EU',
  },
  // Ministral 3 14B (Dec 2025): gen-3 mid model, text+vision, 262k context.
  // The `balanced` tier as of 2026-05-29 — Set-Bench v4 showed 100% pass and
  // near-Large quality at ~6× lower cost than mistral-large-2512.
  'ministral-14b-2512': {
    id: 'ministral-14b-2512',
    provider: 'openai',
    tier: 'balanced',
    contextWindow: 262_144,
    defaultMaxOutput: 8_192,
    maxContinuations: 5,
    betaHeaders: [],
    features: MISTRAL_FEATURES_GEN3,
    pricing: { input: 0.20, output: 0.20, cacheWrite: 0.20, cacheRead: 0.02 },
    uiLabel: 'Ministral 14B',
    provenance: 'EU',
  },
  // Mistral Large 3 (Dec 2025): 256k context, $0.50/$1.50 (75% price cut vs Large 2),
  // multimodal input (text+image), structured-outputs, function-calling, prefix-cache.
  // The `deep` tier as of 2026-05-29 (replaced the deprecated magistral-medium-2509);
  // the Mistral quality leader on Set-Bench v4.
  'mistral-large-2512': {
    id: 'mistral-large-2512',
    provider: 'openai',
    tier: 'deep',
    contextWindow: 256_000,
    defaultMaxOutput: 16_000,
    maxContinuations: 10,
    betaHeaders: [],
    features: MISTRAL_FEATURES_GEN3,
    pricing: { input: 0.50, output: 1.50, cacheWrite: 0.50, cacheRead: 0.05 },
    uiLabel: 'Mistral Large 3',
  },
  // DEPRECATED by Mistral — magistral-medium-2509 retires 2026-07-31. No longer
  // tier-routed (tier:null); kept for cost-guard + back-compat of legacy configs
  // that pinned it via openai_model_id. Set-Bench v4: never beat mistral-large-2512.
  'magistral-medium-2509': {
    id: 'magistral-medium-2509',
    provider: 'openai',
    tier: null,
    contextWindow: 131_072,
    defaultMaxOutput: 32_000,
    maxContinuations: 20,
    betaHeaders: [],
    features: MISTRAL_FEATURES_LARGE,
    pricing: { input: 2, output: 5, cacheWrite: 2, cacheRead: 0.20 },
    uiLabel: 'Magistral Medium 1.2',
  },
  // === Mistral bench-only / legacy roster (cost tracking; no tier routing) ===
  // contextWindow values from Mistral docs (2026-05). These models aren't
  // wired into MISTRAL_MODEL_MAP — they're only referenced by set-bench and
  // cost-guard so the user can opt-in via openai_model_id.
  //
  // Note: ministral-3b/8b-2410 + mistral-small-2603 retired by Mistral 2025-12.
  // Kept here for backwards-compat of legacy configs + cost-guard. New code
  // should use the gen-3 ministral-3b/8b-2512 entries above (tier:'fast').
  'mistral-small-2603': {
    id: 'mistral-small-2603',
    provider: 'openai',
    tier: null,
    contextWindow: 32_000,
    defaultMaxOutput: 8_192,
    maxContinuations: 5,
    betaHeaders: [],
    features: MISTRAL_FEATURES_SMALL,
    pricing: { input: 0.20, output: 0.60, cacheWrite: 0.20, cacheRead: 0.20 },
    uiLabel: 'Mistral Small (deprecated)',
  },
  'ministral-8b-2410': {
    id: 'ministral-8b-2410',
    provider: 'openai',
    tier: null,
    contextWindow: 32_000,
    defaultMaxOutput: 8_192,
    maxContinuations: 5,
    betaHeaders: [],
    features: MISTRAL_FEATURES_SMALL,
    pricing: { input: 0.10, output: 0.10, cacheWrite: 0.10, cacheRead: 0.10 },
    uiLabel: 'Ministral 8B',
  },
  'ministral-3b-2410': {
    id: 'ministral-3b-2410',
    provider: 'openai',
    tier: null,
    contextWindow: 32_000,
    defaultMaxOutput: 8_192,
    maxContinuations: 5,
    betaHeaders: [],
    features: MISTRAL_FEATURES_SMALL,
    pricing: { input: 0.04, output: 0.04, cacheWrite: 0.04, cacheRead: 0.04 },
    uiLabel: 'Ministral 3B',
  },
  'open-mistral-nemo': {
    id: 'open-mistral-nemo',
    provider: 'openai',
    tier: null,
    contextWindow: 128_000,
    defaultMaxOutput: 8_192,
    maxContinuations: 5,
    betaHeaders: [],
    features: MISTRAL_FEATURES_SMALL,
    pricing: { input: 0.15, output: 0.15, cacheWrite: 0.15, cacheRead: 0.15 },
    uiLabel: 'Mistral Nemo',
  },
  'mistral-medium-2508': {
    id: 'mistral-medium-2508',
    provider: 'openai',
    tier: null,
    contextWindow: 128_000,
    defaultMaxOutput: 16_000,
    maxContinuations: 10,
    betaHeaders: [],
    features: MISTRAL_FEATURES_LARGE,
    pricing: { input: 0.40, output: 2, cacheWrite: 0.40, cacheRead: 0.40 },
    uiLabel: 'Mistral Medium 3.1',
  },
  // Mistral Medium 3.5 (2604) — model-presets candidate (Mistral standard-deep /
  // balanced). 262k ctx (clears the 200k fitness floor, unlike 2508's 128k).
  // Pricing VERIFIED against the Mistral model card: $1.50/$7.50 (the 2508 entry's
  // $0.40/$2 was ~3.75× too low for this newer model). cacheRead is NOT published
  // for Medium 3.5 → apply the gen-3 convention (cacheWrite=input, cacheRead=input
  // ×0.1, as mistral-large-2512 does); verify against La Plateforme when available.
  // vision:false per the verify-live-or-false convention (Mistral advertises Medium
  // 3.5 as multimodal, but a live image check is owed before flipping to GEN3 —
  // a false-NO is a clean pre-flight throw; a false-YES is a silent wrong answer).
  'mistral-medium-2604': {
    id: 'mistral-medium-2604',
    provider: 'openai',
    tier: null,
    contextWindow: 262_144,
    defaultMaxOutput: 16_000,
    maxContinuations: 10,
    betaHeaders: [],
    features: MISTRAL_FEATURES_LARGE,
    pricing: { input: 1.50, output: 7.50, cacheWrite: 1.50, cacheRead: 0.15 },
    uiLabel: 'Mistral Medium 3.5',
    provenance: 'EU',
  },
  'mistral-medium-latest': {
    id: 'mistral-medium-latest',
    provider: 'openai',
    tier: null,
    contextWindow: 128_000,
    defaultMaxOutput: 16_000,
    maxContinuations: 10,
    betaHeaders: [],
    features: MISTRAL_FEATURES_LARGE,
    pricing: { input: 0.40, output: 2, cacheWrite: 0.40, cacheRead: 0.40 },
    uiLabel: 'Mistral Medium (latest)',
  },
  'codestral-2508': {
    id: 'codestral-2508',
    provider: 'openai',
    tier: null,
    contextWindow: 256_000,
    defaultMaxOutput: 16_000,
    maxContinuations: 10,
    betaHeaders: [],
    features: MISTRAL_FEATURES_LARGE,
    pricing: { input: 0.30, output: 0.90, cacheWrite: 0.30, cacheRead: 0.30 },
    uiLabel: 'Codestral',
  },
  'codestral-latest': {
    id: 'codestral-latest',
    provider: 'openai',
    tier: null,
    contextWindow: 256_000,
    defaultMaxOutput: 16_000,
    maxContinuations: 10,
    betaHeaders: [],
    features: MISTRAL_FEATURES_LARGE,
    pricing: { input: 0.30, output: 0.90, cacheWrite: 0.30, cacheRead: 0.30 },
    uiLabel: 'Codestral (latest)',
  },
  'magistral-small-2509': {
    id: 'magistral-small-2509',
    provider: 'openai',
    tier: null,
    contextWindow: 40_000,
    defaultMaxOutput: 8_192,
    maxContinuations: 5,
    betaHeaders: [],
    features: MISTRAL_FEATURES_SMALL,
    pricing: { input: 0.50, output: 1.50, cacheWrite: 0.50, cacheRead: 0.50 },
    uiLabel: 'Magistral Small',
  },
  'magistral-small-latest': {
    id: 'magistral-small-latest',
    provider: 'openai',
    tier: null,
    contextWindow: 40_000,
    defaultMaxOutput: 8_192,
    maxContinuations: 5,
    betaHeaders: [],
    features: MISTRAL_FEATURES_SMALL,
    pricing: { input: 0.50, output: 1.50, cacheWrite: 0.50, cacheRead: 0.50 },
    uiLabel: 'Magistral Small (latest)',
  },
  // === Fireworks-hosted (openai-compat) — model-presets hybrid deep/big-context ===
  // CN-provenance weights served from a WESTERN fixed host (Fireworks/US), never a
  // direct CN API — the affirmative sourcing rule (host residency US, weights CN).
  // Pricing VERIFIED against the Fireworks model pages (2026-07-19): the harness
  // estimates were ~2.5-4× low. cacheRead = $0.14 is the PUBLISHED Fireworks
  // cached-input rate for BOTH models (a flat rate, NOT input×0.1) — so DeepSeek's
  // 0.14 (≠ 1.74×0.1 = 0.174) is correct as read from its page, not a copy of GLM's.
  // Both are text-only (Fireworks: "image input: not supported"). Reached via
  // provider:'openai' + api_base_url=api.fireworks.ai + the full
  // `accounts/fireworks/models/*` id; no Fireworks tier map yet (they are preset
  // -slot models, tier:null — a preset's tier_set pins them explicitly).
  'accounts/fireworks/models/glm-5p2': {
    id: 'accounts/fireworks/models/glm-5p2',
    provider: 'openai',
    tier: null,
    contextWindow: 1_000_000,
    defaultMaxOutput: 16_000,
    maxContinuations: 10,
    betaHeaders: [],
    features: FIREWORKS_TEXT_FEATURES,
    pricing: { input: 1.40, output: 4.40, cacheWrite: 1.40, cacheRead: 0.14 },
    uiLabel: 'GLM 5.2',
    provenance: 'CN',
  },
  'accounts/fireworks/models/deepseek-v4-pro': {
    id: 'accounts/fireworks/models/deepseek-v4-pro',
    provider: 'openai',
    tier: null,
    contextWindow: 1_000_000,
    defaultMaxOutput: 16_000,
    maxContinuations: 10,
    betaHeaders: [],
    features: FIREWORKS_TEXT_FEATURES,
    pricing: { input: 1.74, output: 3.48, cacheWrite: 1.74, cacheRead: 0.14 },
    uiLabel: 'DeepSeek v4 Pro',
    provenance: 'CN',
  },
};

/** Resolve a model id (canonical or @-suffixed Vertex variant) to its
 *  capability entry. Returns `undefined` for unknown models — callers must
 *  decide whether that's a hard error or a soft fallback. */
export function modelCapability(model: string): ModelCapability | undefined {
  return MODEL_CAPABILITIES[model] ?? MODEL_CAPABILITIES[normalizeModelId(model)];
}

/** Backstop for unknown model ids. Matches the pre-registry hard-coded
 *  fallbacks in getContextWindow / getDefaultMaxTokens / getMaxContinuations.
 *  Exported so server-side synthetic-model shapes (e.g. /api/config
 *  active_model for a declared self-host window) reference one source. */
export const FALLBACK_CAPABILITY = {
  contextWindow: 200_000,
  defaultMaxOutput: 16_000,
  maxContinuations: 10,
} as const;

/** Resolve a model id to its capability entry, falling back to a sensible
 *  default capability if the id is unknown. Used by helpers like
 *  `getContextWindow` that historically returned safe defaults rather than
 *  throwing on unknown ids. */
function modelCapabilityOrFallback(model: string): {
  contextWindow: number;
  defaultMaxOutput: number;
  maxContinuations: number;
} {
  return modelCapability(model) ?? FALLBACK_CAPABILITY;
}

/** Look up context window size. Normalizes provider-prefixed model IDs automatically. */
export function getContextWindow(model: string): number {
  return modelCapabilityOrFallback(model).contextWindow;
}

/** Floor for a user-supplied context-window cap. Stops an absurdly small
 *  `max_context_window_tokens` setting from starving the system prompt + tool
 *  definitions and bricking every request. */
export const MIN_EFFECTIVE_CONTEXT_WINDOW_TOKENS = 32_000;

/** Resolve a model's NATIVE context window across all tiers (self-host / BYOK /
 *  managed), with a clear precedence that the bare id-based `getContextWindow`
 *  cannot express:
 *
 *    1. An explicitly DECLARED window always wins — `ModelProfile.context_window`
 *       (BYOK named profile) or `openai_context_window` (self-host global
 *       openai-compat switch). The operator knows their model's real window
 *       better than any id lookup can.
 *    2. A KNOWN registry id → its registered window (managed Mistral resolves
 *       via MISTRAL_MODEL_MAP to e.g. `ministral-14b-2512`, provider `openai`,
 *       262k; direct Anthropic ids likewise).
 *       BUT: under an openai/custom provider, `getModelId` falls back to an
 *       Anthropic id when no tier map and no `openai_model_id` are configured
 *       (see getModelId above). Trusting that id would surface a misleading
 *       Claude window for a self-host model — so an Anthropic-provider id under
 *       a custom provider is treated as "unknown" and gets the honest default.
 *    3. Unknown id → honest 200k default, never an invented cap.
 *
 *  Pure + side-effect-free; the single place tier-specific window logic lives. */
export function resolveNativeContextWindow(
  model: string,
  provider?: LLMProvider | undefined,
  declaredWindow?: number | undefined,
): number {
  if (declaredWindow !== undefined && declaredWindow > 0) return declaredWindow;
  const known = modelCapability(model);
  if (known) {
    const isCustomProvider = provider === 'openai' || provider === 'custom';
    // Anthropic-fallback trap: a Claude id reaching here under a custom
    // provider means the tier resolver fell back — don't trust its window.
    if (isCustomProvider && known.provider === 'anthropic') return FALLBACK_CAPABILITY.contextWindow;
    return known.contextWindow;
  }
  return FALLBACK_CAPABILITY.contextWindow;
}

/** Effective context window after applying the user's optional cap. Mirrors
 *  Agent._effectiveContextWindow so server-side endpoints + session bookkeeping
 *  can compute the same value the agent actually uses internally — staging
 *  2026-05-18 shipped this with three separate copies of the formula that
 *  drifted (UI showed 423% because /sessions returned the native window
 *  while the agent had applied a smaller user cap). Single source of truth.
 *
 *  `opts` carries the provider + any declared window so custom/BYOK/self-host
 *  models resolve their real native window via `resolveNativeContextWindow`
 *  instead of the bare-id 200k fallback. Omitting `opts` preserves the legacy
 *  id-only behaviour (all pre-existing 2-arg callers unchanged).
 *  Never returns more than the model's native window. */
export function effectiveContextWindow(
  model: string,
  userCap: number | undefined,
  opts?: { provider?: LLMProvider | undefined; declaredWindow?: number | undefined } | undefined,
): number {
  const native = resolveNativeContextWindow(model, opts?.provider, opts?.declaredWindow);
  if (userCap !== undefined && userCap > 0) {
    return Math.min(native, Math.max(userCap, MIN_EFFECTIVE_CONTEXT_WINDOW_TOKENS));
  }
  return native;
}

/** Look up default max output tokens. Normalizes provider-prefixed model IDs automatically. */
export function getDefaultMaxTokens(model: string): number {
  return modelCapabilityOrFallback(model).defaultMaxOutput;
}

/** Look up max continuation attempts. Normalizes provider-prefixed model IDs automatically. */
export function getMaxContinuations(model: string): number {
  return modelCapabilityOrFallback(model).maxContinuations;
}

/**
 * Model-aware chars-per-token for context estimation. Returns the model's
 * per-entry `charsPerToken` when set, else the global {@link CHARS_PER_TOKEN}
 * (3.5). Unknown ids + every model without an override → 3.5, so existing
 * default-fleet estimation is byte-identical; only models with a materially
 * different tokenizer (e.g. Sonnet 5 at 2.7) shift. Normalizes @-suffixed ids.
 */
export function getCharsPerToken(model: string): number {
  return modelCapability(model)?.charsPerToken ?? CHARS_PER_TOKEN;
}

// === Thinking & Effort ===

export type ThinkingMode =
  | { type: 'enabled'; budget_tokens: number }
  | { type: 'adaptive' }
  | { type: 'disabled' };

export type ThinkingHint = ThinkingMode['type'];

/**
 * Claude model families that still accept the LEGACY manual extended-thinking
 * shape `{ type: 'enabled', budget_tokens }`. Anthropic REMOVED manual thinking
 * in the 4.7/5 generation (Sonnet 5, Opus 4.7+): those hard-400 on an `enabled`
 * block and require `adaptive` instead. This is a POSITIVE allowlist of the
 * legacy-accepting ids so any NEW/unknown Claude id defaults to the SAFE path
 * (treated as rejecting → coerced to adaptive, which every Claude model
 * accepts). Over-coercing is harmless (adaptive works on 4.6 too); UNDER-
 * coercing 400s — so the safe bias is "unknown Claude ⇒ reject".
 */
const CLAUDE_MODELS_ACCEPTING_MANUAL_THINKING: ReadonlySet<string> = new Set([
  'claude-sonnet-4-6', 'claude-sonnet-4-6[1m]',
  'claude-opus-4-6', 'claude-opus-4-6[1m]',
  // Haiku 4.5 has no extended thinking at all (force-disabled upstream), so it
  // never carries an `enabled` block to coerce — omitting it is inconsequential.
]);

/**
 * True when a model is a Claude model that REJECTS the legacy manual
 * `{ type: 'enabled', budget_tokens }` thinking shape (i.e. the 4.7/5 family and
 * anything newer). Non-Claude models return false — their thinking support is
 * governed by their own provider guard. Used as a defense-in-depth normalizer
 * so a free-form `thinking` object handed in via the spawn tool schema can never
 * 400 a Sonnet-5/Opus-4.7+ run. Normalizes @-suffixed ids.
 */
export function claudeModelRejectsManualThinking(model: string): boolean {
  const id = normalizeModelId(model);
  if (!id.startsWith('claude-')) return false;
  return !CLAUDE_MODELS_ACCEPTING_MANUAL_THINKING.has(id);
}

/**
 * Structured warning produced by the engine that the HTTP-API surfaces as a
 * `warning` SSE event so the web-UI can render a user-facing toast. Used
 * when the engine has to silently degrade behaviour to avoid a customer-
 * facing API error (e.g. `thinking=enabled` requested on a non-reasoning
 * Mistral model — the call still works but reasoning is disabled).
 *
 * `modelId` is an internal enum (no user-supplied content), `code` is a
 * stable identifier the UI uses to pick the right i18n string + icon,
 * `hint` is a short fallback English message for clients without i18n.
 */
export interface AgentWarning {
  readonly code: 'thinking_not_supported_on_model';
  readonly modelId: string;
  readonly hint: string;
}

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

// === Step Hints (LLM-driven per-step configuration) ===

/**
 * Hints the LLM attaches to `ask_user` options to tune the NEXT step's
 * thinking/effort. It deliberately carries NO model tier: the agent never
 * drives the main-session tier — only the user (composer picker / thread
 * re-pick) does. See model-execution-policy D23.
 */
export interface StepHint {
  thinking?: ThinkingHint | undefined;
  effort?: EffortLevel | undefined;
}

/** Tier ordering for clamping — lower index = cheaper/faster. */
const TIER_ORDER: Record<ModelTier, number> = { fast: 0, balanced: 1, deep: 2 };

/** Clamp a requested tier to the maximum allowed tier. Returns requested if no cap set. */
export function clampTier(requested: ModelTier, maxTier: ModelTier | undefined): ModelTier {
  if (!maxTier) return requested;
  return TIER_ORDER[requested] > TIER_ORDER[maxTier] ? maxTier : requested;
}

/**
 * Does an explicit model id resolve to a cost band ABOVE the ceiling? A raw model
 * id carries no tier to clamp — it names a specific model/endpoint that cannot be
 * substituted — so an over-ceiling id must be REFUSED, not clamped (DEF-0080). An
 * id unknown to the registry has no tier and is treated as `deep` (fail closed),
 * matching FALLBACK_PRICING's conservative Opus default. Shared by the tier
 * chokepoint (`resolveRunModel`) and the spawn profile guard (`profileExceedsMaxTier`).
 */
export function modelIdExceedsMaxTier(modelId: string, maxTier: ModelTier | undefined): boolean {
  if (!maxTier) return false;
  const tier = modelCapability(modelId)?.tier ?? null;
  if (tier === null) return maxTier !== 'deep';
  return clampTier(tier, maxTier) !== tier;
}
