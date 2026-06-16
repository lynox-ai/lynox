/**
 * Provider Registry — descriptor types for provider-agnostic model routing.
 *
 * The closed `LLMProvider` enum + the `openai` + `isMistralHost` URL-sniff
 * (models.ts) make Mistral a second-class citizen and force every resolution
 * site to branch on a hardcoded provider list. The registry replaces that with
 * uniform, data-driven provider descriptors.
 *
 * PR-1a (this slice): the RESOLUTION half only — `getModelId` dispatches through
 * a per-provider descriptor's `resolveModelId`, byte-identical to the previous
 * hardcoded branches, with Mistral promoted to a first-class `id:'mistral'`
 * identity. The wire-client dispatch (replacing `createLLMClient`'s if-branch)
 * and the `CapabilityProfile` / `CacheProfile` re-projection follow in PR-1b.
 * The registry itself lives in `models.ts` (co-located with the tier maps + the
 * openai resolver state it reads); this module owns only the shared types.
 */
import type { ModelTier, LLMProvider } from './models.js';

/**
 * Open provider identity key — supersedes the closed `LLMProvider` enum for
 * registry purposes, so a new provider (e.g. the now first-class `'mistral'`,
 * or a future `'gemini'`) can register WITHOUT editing the enum or the resolver.
 * The known `LLMProvider` values stay assignable; `(string & {})` keeps literal
 * autocomplete while admitting any string.
 */
export type ProviderKey = LLMProvider | (string & {});

/**
 * How a provider's prompt cache works — the load-bearing fact for the cache
 * wiring (PR-3): `explicit-breakpoint` providers (Anthropic/Vertex) need
 * `cache_control` breakpoints in the request; `automatic-prefix` providers
 * (Mistral and other OpenAI-compatible endpoints, see `isMistralHost` /
 * models.ts:432) cache transparently and take a `prompt_cache_key` instead;
 * `none` makes no caching assumption (an unknown custom proxy).
 *
 * `readMult`/`writeMult` are intentionally OPTIONAL and omitted today: the
 * per-model cache economics already live in `MODEL_CAPABILITIES.pricing`
 * (`cacheRead`/`cacheWrite`) and are read by `calculateCost` (pricing.ts).
 * Hardcoding provider-level multipliers here would duplicate that and drift;
 * a later consumer derives aggregates from pricing if it needs them.
 */
export interface CacheProfile {
  mechanism: 'explicit-breakpoint' | 'automatic-prefix' | 'context-cache' | 'none';
  readMult?: number;
  writeMult?: number;
}

/**
 * A provider as a uniformly-resolved, first-class citizen of the registry.
 *
 * `resolveModelId` is byte-parity with the pre-registry `getModelId` branch for
 * this provider — for a dynamically-configured provider (openai-compat) it reads
 * live resolver state at call time, so config bootstrap/reload still applies.
 */
export interface ProviderDescriptor {
  /** Provider identity (open key). */
  id: ProviderKey;
  /**
   * Which wire client constructs this provider's requests, mirroring today's
   * `createLLMClient` branch. Mistral and other OpenAI-compatible providers use
   * the `'openai'` path. (Consumed by the PR-1b client-dispatch slice.)
   */
  wireClient: 'anthropic' | 'vertex' | 'openai';
  /**
   * The provider's default tier→model map — for inspection and as the static
   * resolution source. A dynamically-configured provider's live resolver may
   * read runtime state instead (see `resolveModelId`).
   */
  defaultTierModels: Record<ModelTier, string>;
  /**
   * Resolve a tier to a concrete model id for THIS provider. Byte-parity with
   * the pre-registry `getModelId` per-provider branch.
   */
  resolveModelId: (tier: ModelTier) => string;
  /** How this provider's prompt cache behaves (consumed by the PR-3 wiring). */
  cache: CacheProfile;
}
