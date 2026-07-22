import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  clampTier,
  modelIdExceedsMaxTier,
  getModelId,
  getContextWindow,
  getDefaultMaxTokens,
  getMaxContinuations,
  getOpenAIModelMap,
  setOpenAIModelResolver,
  effectiveContextWindow,
  resolveNativeContextWindow,
  normalizeTier,
  isModelProfile,
  MISTRAL_MODEL_MAP,
  MISTRAL_API_BASE,
  MODEL_CAPABILITIES,
  AGENT_CACHE_TTL,
  CACHE_TTL_WRITE_MULTIPLIER,
  CACHE_READ_MULTIPLIER,
  MODEL_MAP,
  CHARS_PER_TOKEN,
  getCharsPerToken,
  resolveBalancedModel,
  setBalancedModelResolver,
  getActiveBalancedModel,
  claudeModelRejectsManualThinking,
} from './models.js';

describe('pricing-vs-TTL contract (cache-write must match the TTL the agent sends)', () => {
  // The agent attaches `cache_control: { ttl: AGENT_CACHE_TTL }` to every
  // Anthropic/Vertex breakpoint. Anthropic bills cache WRITES by TTL, so the
  // registry `cacheWrite` MUST equal input × the multiplier for that TTL — else
  // managed billing drifts from the real Anthropic charge (it once under-billed
  // because cacheWrite sat at the 5m rate while the agent sent 1h). This test is
  // the structural pin: change the agent TTL or a price out of sync → CI fails.
  const cachedAnthropic = Object.entries(MODEL_CAPABILITIES).filter(
    ([, m]) => (m.provider === 'anthropic' || m.provider === 'vertex') && m.features.promptCaching,
  );

  it('knows the write multiplier for the TTL the agent actually sends', () => {
    expect(CACHE_TTL_WRITE_MULTIPLIER[AGENT_CACHE_TTL]).toBeDefined();
  });

  it('covers the cached Anthropic/Vertex roster (filter is not vacuously empty)', () => {
    // Guards against a refactor that renames provider/feature and silently makes
    // the contract match zero models (which would pass every assertion below).
    expect(cachedAnthropic.length).toBeGreaterThanOrEqual(8);
  });

  it.each(cachedAnthropic)(
    'cacheWrite for %s equals input × the AGENT_CACHE_TTL write multiplier',
    (_id, m) => {
      const expected = m.pricing.input * CACHE_TTL_WRITE_MULTIPLIER[AGENT_CACHE_TTL]!;
      expect(m.pricing.cacheWrite).toBeCloseTo(expected, 6);
    },
  );

  it.each(cachedAnthropic)(
    'cacheRead for %s equals input × the (TTL-independent) read multiplier',
    (_id, m) => {
      expect(m.pricing.cacheRead).toBeCloseTo(m.pricing.input * CACHE_READ_MULTIPLIER, 6);
    },
  );
});

describe('normalizeTier', () => {
  it('passes the canonical provider-agnostic names through unchanged', () => {
    expect(normalizeTier('fast')).toBe('fast');
    expect(normalizeTier('balanced')).toBe('balanced');
    expect(normalizeTier('deep')).toBe('deep');
  });

  it('maps legacy Anthropic-brand names to the canonical names (back-compat)', () => {
    // Persisted config.json + LYNOX_DEFAULT_TIER env vars written before the
    // 2026-05-29 rename must keep working.
    expect(normalizeTier('haiku')).toBe('fast');
    expect(normalizeTier('sonnet')).toBe('balanced');
    expect(normalizeTier('opus')).toBe('deep');
  });

  it('returns undefined for unknown values and undefined input', () => {
    expect(normalizeTier(undefined)).toBeUndefined();
    expect(normalizeTier('gpt-5')).toBeUndefined();
    expect(normalizeTier('')).toBeUndefined();
  });

  it('rejects inherited Object.prototype keys (hasOwn guard, not a bare lookup)', () => {
    expect(normalizeTier('toString')).toBeUndefined();
    expect(normalizeTier('constructor')).toBeUndefined();
    expect(normalizeTier('__proto__')).toBeUndefined();
  });
});

describe('isModelProfile', () => {
  const valid = {
    provider: 'openai',
    api_base_url: 'https://api.mistral.ai/v1',
    api_key: 'sk-x',
    model_id: 'mistral-large-2512',
  };

  it('accepts a well-formed profile (required fields present)', () => {
    expect(isModelProfile(valid)).toBe(true);
    // optional fields don't affect validity
    expect(isModelProfile({ ...valid, context_window: 262_000 })).toBe(true);
  });

  it('rejects entries missing or mistyping a required field', () => {
    const { api_key: _k, ...noKey } = valid;
    const { model_id: _m, ...noModel } = valid;
    const { api_base_url: _u, ...noUrl } = valid;
    expect(isModelProfile(noKey)).toBe(false);
    expect(isModelProfile(noModel)).toBe(false);
    expect(isModelProfile(noUrl)).toBe(false);
    expect(isModelProfile({ ...valid, api_base_url: 123 })).toBe(false);
    expect(isModelProfile({ ...valid, provider: 'anthropic' })).toBe(false);
  });

  it('rejects non-objects', () => {
    expect(isModelProfile(null)).toBe(false);
    expect(isModelProfile(undefined)).toBe(false);
    expect(isModelProfile('x')).toBe(false);
    expect(isModelProfile(['a'])).toBe(false);
  });
});

describe('clampTier', () => {
  it('returns requested tier when no cap is set', () => {
    expect(clampTier('deep', undefined)).toBe('deep');
    expect(clampTier('balanced', undefined)).toBe('balanced');
    expect(clampTier('fast', undefined)).toBe('fast');
  });

  it('clamps opus to sonnet when max_tier is sonnet', () => {
    expect(clampTier('deep', 'balanced')).toBe('balanced');
  });

  it('clamps opus to haiku when max_tier is haiku', () => {
    expect(clampTier('deep', 'fast')).toBe('fast');
  });

  it('clamps sonnet to haiku when max_tier is haiku', () => {
    expect(clampTier('balanced', 'fast')).toBe('fast');
  });

  it('allows sonnet when max_tier is sonnet', () => {
    expect(clampTier('balanced', 'balanced')).toBe('balanced');
  });

  it('allows haiku when max_tier is sonnet', () => {
    expect(clampTier('fast', 'balanced')).toBe('fast');
  });

  it('allows haiku when max_tier is haiku', () => {
    expect(clampTier('fast', 'fast')).toBe('fast');
  });

  it('allows any tier when max_tier is opus', () => {
    expect(clampTier('deep', 'deep')).toBe('deep');
    expect(clampTier('balanced', 'deep')).toBe('balanced');
    expect(clampTier('fast', 'deep')).toBe('fast');
  });
});

describe('modelIdExceedsMaxTier — the shared refuse predicate (DEF-0080)', () => {
  const DEEP = getModelId('deep', 'anthropic');
  const BALANCED = getModelId('balanced', 'anthropic');
  const FAST = getModelId('fast', 'anthropic');
  const UNKNOWN = 'some-unregistered-model-xyz';

  it('no ceiling → nothing exceeds (self-host default)', () => {
    expect(modelIdExceedsMaxTier(DEEP, undefined)).toBe(false);
    expect(modelIdExceedsMaxTier(UNKNOWN, undefined)).toBe(false);
  });

  it('a registered model above a restrictive ceiling exceeds', () => {
    expect(modelIdExceedsMaxTier(DEEP, 'fast')).toBe(true);
    expect(modelIdExceedsMaxTier(DEEP, 'balanced')).toBe(true);
    expect(modelIdExceedsMaxTier(BALANCED, 'fast')).toBe(true);
  });

  it('a registered model at or below the ceiling does not exceed', () => {
    expect(modelIdExceedsMaxTier(FAST, 'fast')).toBe(false);
    expect(modelIdExceedsMaxTier(BALANCED, 'balanced')).toBe(false);
    expect(modelIdExceedsMaxTier(FAST, 'balanced')).toBe(false);
  });

  it('a deep ceiling is not restrictive — even an unknown model passes', () => {
    expect(modelIdExceedsMaxTier(DEEP, 'deep')).toBe(false);
    expect(modelIdExceedsMaxTier(UNKNOWN, 'deep')).toBe(false);
  });

  it('an UNKNOWN model under a restrictive ceiling is refused (fail closed)', () => {
    expect(modelIdExceedsMaxTier(UNKNOWN, 'fast')).toBe(true);
    expect(modelIdExceedsMaxTier(UNKNOWN, 'balanced')).toBe(true);
  });
});

describe('Mistral tier-set', () => {
  // `beforeEach` defends against cross-file state leakage (vitest reuses
  // workers for sibling files — if another file forgets `afterEach`, this
  // describe would see stale state). Belt-and-braces with the `afterEach`.
  beforeEach(() => {
    setOpenAIModelResolver({ map: null, fallbackModelId: null });
  });
  afterEach(() => {
    setOpenAIModelResolver({ map: null, fallbackModelId: null });
  });

  it('exposes pinned snapshot IDs (not the auto-rolling -latest alias)', () => {
    // Reproducibility guarantee for managed-EU tenants — Mistral rolls
    // `*-latest` silently which would change behaviour mid-billing-period.
    expect(MISTRAL_MODEL_MAP.fast).toBe('ministral-8b-2512');
    expect(MISTRAL_MODEL_MAP.balanced).toBe('mistral-medium-2604');
    expect(MISTRAL_MODEL_MAP.deep).toBe('mistral-medium-2604');
    expect(MISTRAL_API_BASE).toBe('https://api.mistral.ai/v1');
  });

  it('getOpenAIModelMap detects the mistral base URL', () => {
    expect(getOpenAIModelMap('https://api.mistral.ai/v1')).toBe(MISTRAL_MODEL_MAP);
    // Substring match — managed instances may proxy via cloud-prefixed hosts.
    expect(getOpenAIModelMap('https://eu.mistral.ai/v1')).toBe(MISTRAL_MODEL_MAP);
  });

  it('getOpenAIModelMap returns null for unknown providers + undefined', () => {
    expect(getOpenAIModelMap(undefined)).toBeNull();
    expect(getOpenAIModelMap('https://api.openai.com/v1')).toBeNull();
    expect(getOpenAIModelMap('http://localhost:11434/v1')).toBeNull();
  });

  it('getOpenAIModelMap rejects hostile URLs that smuggle `mistral.ai` in the path or query', () => {
    // A naive `includes('mistral.ai')` would have matched these. URL-parsing
    // pinned the check to the hostname, so a misconfigured base URL can't
    // accidentally activate the Mistral tier-map against an attacker host.
    expect(getOpenAIModelMap('https://attacker.example.com/?proxy=mistral.ai')).toBeNull();
    expect(getOpenAIModelMap('https://api.mistral.ai.attacker.com/v1')).toBeNull();
    expect(getOpenAIModelMap('https://example.com/mistral.ai/v1')).toBeNull();
  });

  it('getOpenAIModelMap normalises hostname case', () => {
    // Operators sometimes write `https://API.MISTRAL.AI/v1` in env files.
    // Hostname-case in URLs is case-insensitive per RFC 3986; honour that
    // so case-typos don't silently disable tier routing.
    expect(getOpenAIModelMap('https://API.MISTRAL.AI/v1')).toBe(MISTRAL_MODEL_MAP);
  });

  it('getOpenAIModelMap returns null for malformed URLs', () => {
    expect(getOpenAIModelMap('not-a-url')).toBeNull();
    expect(getOpenAIModelMap('mistral.ai')).toBeNull(); // missing scheme
  });

  it('Mistral context-windows + max-tokens + max-continuations registered', () => {
    // mistral-small-2603 deprecated 2025-12; kept in registry for cost-guard legacy
    expect(getContextWindow('mistral-small-2603')).toBe(32_000);
    // Mistral Large 3 (Dec 2025) has 256k ctx (was 131k as Large 2)
    expect(getContextWindow('mistral-large-2512')).toBe(256_000);
    expect(getContextWindow('magistral-medium-2509')).toBe(131_072);
    // Gen-3 ministrals replace -2410: 256k context
    expect(getContextWindow('ministral-3b-2512')).toBe(262_144);
    expect(getContextWindow('ministral-8b-2512')).toBe(262_144);
    expect(getDefaultMaxTokens('mistral-small-2603')).toBe(8_192);
    expect(getDefaultMaxTokens('mistral-large-2512')).toBe(16_000);
    expect(getDefaultMaxTokens('magistral-medium-2509')).toBe(32_000);
    expect(getMaxContinuations('mistral-small-2603')).toBe(5);
    expect(getMaxContinuations('mistral-large-2512')).toBe(10);
    expect(getMaxContinuations('magistral-medium-2509')).toBe(20);
  });
});

describe('getModelId for openai provider', () => {
  beforeEach(() => {
    setOpenAIModelResolver({ map: null, fallbackModelId: null });
  });
  afterEach(() => {
    setOpenAIModelResolver({ map: null, fallbackModelId: null });
  });

  it('returns Anthropic IDs when no resolver is registered (legacy fallback)', () => {
    // Preserves test-environment behaviour for code paths that never
    // bootstrap Engine — vitest unit tests, scripts, etc.
    expect(getModelId('fast', 'openai')).toBe('claude-haiku-4-5-20251001');
    expect(getModelId('balanced', 'openai')).toBe('claude-sonnet-4-6');
    expect(getModelId('deep', 'openai')).toBe('claude-opus-4-6');
  });

  it('returns Mistral tier-set when the mistral map is registered', () => {
    setOpenAIModelResolver({ map: MISTRAL_MODEL_MAP });
    expect(getModelId('fast', 'openai')).toBe('ministral-8b-2512');
    expect(getModelId('balanced', 'openai')).toBe('mistral-medium-2604');
    expect(getModelId('deep', 'openai')).toBe('mistral-medium-2604');
  });

  it('falls back to fallbackModelId when no map but fallback is set', () => {
    setOpenAIModelResolver({ map: null, fallbackModelId: 'custom-model-v1' });
    // Single-model openai-compat setups (e.g. Ollama with one model) — every
    // tier resolves to the configured single id.
    expect(getModelId('fast', 'openai')).toBe('custom-model-v1');
    expect(getModelId('balanced', 'openai')).toBe('custom-model-v1');
    expect(getModelId('deep', 'openai')).toBe('custom-model-v1');
  });

  it('prefers map over fallback when both are set', () => {
    setOpenAIModelResolver({ map: MISTRAL_MODEL_MAP, fallbackModelId: 'should-be-ignored' });
    expect(getModelId('balanced', 'openai')).toBe('mistral-medium-2604');
  });

  it('still resolves Anthropic/Vertex providers correctly when openai resolver is set', () => {
    setOpenAIModelResolver({ map: MISTRAL_MODEL_MAP });
    expect(getModelId('balanced', 'anthropic')).toBe('claude-sonnet-4-6');
    expect(getModelId('balanced', 'vertex')).toBe('claude-sonnet-4-6');
    expect(getModelId('balanced', 'custom')).toBe('claude-sonnet-4-6');
  });
});

// Regression-pin: pre-2026-05-18 the `[1m]`-suffix variants Anthropic uses
// for the context-1m-2025-08-07 beta path were absent from CONTEXT_WINDOW /
// DEFAULT_MAX_TOKENS / MAX_CONTINUATIONS. The lookup fell through to the
// 200k default — engine treated a 1M-beta session as 200k for trim and
// percentage calc, producing the staging "Kontext: 423%" mismatch. Explicit
// variant entries now in place; this suite locks them down so silent
// removal during a future cleanup regresses loudly.
describe('1M-context variant lookups', () => {
  it('getContextWindow resolves Sonnet 1M variant to 1_000_000', () => {
    expect(getContextWindow('claude-sonnet-4-6[1m]')).toBe(1_000_000);
  });

  it('getContextWindow resolves Opus 1M variants to 1_000_000', () => {
    expect(getContextWindow('claude-opus-4-6[1m]')).toBe(1_000_000);
    expect(getContextWindow('claude-opus-4-7[1m]')).toBe(1_000_000);
    expect(getContextWindow('claude-opus-4-7')).toBe(1_000_000);
  });

  it('getDefaultMaxTokens for 1M variants mirrors base model', () => {
    expect(getDefaultMaxTokens('claude-sonnet-4-6[1m]')).toBe(getDefaultMaxTokens('claude-sonnet-4-6'));
    expect(getDefaultMaxTokens('claude-opus-4-6[1m]')).toBe(getDefaultMaxTokens('claude-opus-4-6'));
    expect(getDefaultMaxTokens('claude-opus-4-7[1m]')).toBe(getDefaultMaxTokens('claude-opus-4-7'));
  });

  it('getMaxContinuations for 1M variants mirrors base model', () => {
    expect(getMaxContinuations('claude-sonnet-4-6[1m]')).toBe(getMaxContinuations('claude-sonnet-4-6'));
    expect(getMaxContinuations('claude-opus-4-6[1m]')).toBe(getMaxContinuations('claude-opus-4-6'));
  });

  it('unknown bracket-suffix variants still fall through to 200k default', () => {
    // `normalizeModelId` strips @YYYYMMDD but NOT bracket suffixes; an
    // unknown bracketed id has no explicit entry → default. Guards against
    // silently treating an unrecognised variant as 1M.
    expect(getContextWindow('claude-future-9-9[whatever]')).toBe(200_000);
  });
});

describe('effectiveContextWindow', () => {
  it('returns the native window when no user cap is set', () => {
    expect(effectiveContextWindow('claude-sonnet-4-6', undefined)).toBe(200_000);
    expect(effectiveContextWindow('claude-opus-4-6', undefined)).toBe(1_000_000);
  });

  it('returns min(native, cap) when user cap is smaller', () => {
    expect(effectiveContextWindow('claude-opus-4-6', 500_000)).toBe(500_000);
    expect(effectiveContextWindow('claude-sonnet-4-6', 100_000)).toBe(100_000);
  });

  it('caps to native when user cap exceeds it (Sonnet base, not the 1M variant)', () => {
    // User picks 500k on plain Sonnet 4.6 — model only supports 200k native,
    // so effective is 200k. The mismatch is a UX problem (Settings v3 Item 6
    // will surface it); the engine bookkeeping must be correct regardless.
    expect(effectiveContextWindow('claude-sonnet-4-6', 500_000)).toBe(200_000);
  });

  it('respects user cap on the 1M-beta Sonnet variant', () => {
    // Same user cap, different model variant — picking the [1m] variant
    // unlocks 1M native, so a 500k cap actually applies.
    expect(effectiveContextWindow('claude-sonnet-4-6[1m]', 500_000)).toBe(500_000);
  });

  it('treats zero / negative cap as "no cap"', () => {
    expect(effectiveContextWindow('claude-sonnet-4-6', 0)).toBe(200_000);
    expect(effectiveContextWindow('claude-sonnet-4-6', -1)).toBe(200_000);
  });

  it('floors an absurdly small user cap so requests are not starved', () => {
    // A tiny max_context_window_tokens (e.g. 5k) leaves no room for the system
    // prompt + tool definitions and would brick every request — clamp up to
    // the floor (MIN_EFFECTIVE_CONTEXT_WINDOW_TOKENS = 32k).
    expect(effectiveContextWindow('claude-sonnet-4-6', 5_000)).toBe(32_000);
    expect(effectiveContextWindow('claude-sonnet-4-6', 20_000)).toBe(32_000);
    // A cap exactly at the floor stays; a cap comfortably above is untouched.
    expect(effectiveContextWindow('claude-sonnet-4-6', 32_000)).toBe(32_000);
    expect(effectiveContextWindow('claude-sonnet-4-6', 120_000)).toBe(120_000);
  });

  it('uses a declared native window over the id (custom/BYOK/self-host)', () => {
    // Unknown self-host id would otherwise fall back to 200k; the declared
    // window wins and the user cap still clamps on top.
    expect(effectiveContextWindow('my-self-host-ministral', undefined, { provider: 'openai', declaredWindow: 262_144 })).toBe(262_144);
    expect(effectiveContextWindow('my-self-host-ministral', 500_000, { provider: 'openai', declaredWindow: 262_144 })).toBe(262_144);
    expect(effectiveContextWindow('my-self-host-ministral', 100_000, { provider: 'openai', declaredWindow: 262_144 })).toBe(100_000);
  });
});

describe('resolveNativeContextWindow', () => {
  it('lets an explicitly declared window win over everything (self-host / BYOK)', () => {
    expect(resolveNativeContextWindow('whatever-id', 'openai', 131_072)).toBe(131_072);
    // Declared even overrides a known registry id (operator knows their pin).
    expect(resolveNativeContextWindow('claude-sonnet-4-6', 'custom', 131_072)).toBe(131_072);
  });

  it('returns the registry window for a known id (managed Mistral, direct Anthropic)', () => {
    // managed: getModelId(balanced, openai) → ministral-14b-2512 (provider openai), 262k.
    expect(resolveNativeContextWindow('ministral-14b-2512', 'openai', undefined)).toBe(262_144);
    expect(resolveNativeContextWindow('mistral-large-2512', 'openai', undefined)).toBe(256_000);
    expect(resolveNativeContextWindow('claude-opus-4-6', 'anthropic', undefined)).toBe(1_000_000);
  });

  it('does NOT trust an Anthropic id under a custom provider (the fallback trap)', () => {
    // Self-host with no openai_model_id → getModelId falls back to an Anthropic
    // id. Trusting it would surface a Claude window for a self-host model.
    // Resolver returns the honest 200k default instead of opus 1M.
    expect(resolveNativeContextWindow('claude-opus-4-6', 'openai', undefined)).toBe(200_000);
    expect(resolveNativeContextWindow('claude-opus-4-6', 'custom', undefined)).toBe(200_000);
  });

  it('returns the honest default for an unknown id, never an invented cap', () => {
    expect(resolveNativeContextWindow('some-runpod-model', 'openai', undefined)).toBe(200_000);
    expect(resolveNativeContextWindow('some-runpod-model', undefined, undefined)).toBe(200_000);
  });

  it('keeps trusting a known Anthropic id under the anthropic provider', () => {
    // The trap guard only fires for openai/custom — direct Anthropic is fine.
    expect(resolveNativeContextWindow('claude-opus-4-6', 'anthropic', undefined)).toBe(1_000_000);
  });
});

// ModelCapability registry — Settings v3 sprint substrate. The three legacy
// fact-maps (_CONTEXT_WINDOW / _DEFAULT_MAX_TOKENS / _MAX_CONTINUATIONS) +
// pricing.ts DEFAULT_PRICING collapsed into one registry. The legacy helpers
// (getContextWindow/getDefaultMaxTokens/getMaxContinuations) now delegate to
// the registry — this suite locks down the shape directly so a future
// helper-replacement refactor can't silently drop fields.
describe('ModelCapability registry', () => {
  it('exposes every routed Claude + Mistral model with full capability data', async () => {
    const { MODEL_CAPABILITIES, modelCapability } = await import('./models.js');
    const routedIds = [
      'claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-sonnet-5',
      'claude-haiku-4-5-20251001', 'claude-haiku-4-5',
      'claude-opus-4-7[1m]', 'claude-opus-4-6[1m]', 'claude-sonnet-4-6[1m]',
      // 2026-05-29 tier refresh: deep=mistral-large-2512, balanced=ministral-14b-2512,
      // fast=ministral-8b-2512 (magistral-medium-2509 dropped to bench-only/tier:null).
      'mistral-large-2512', 'ministral-14b-2512',
      // Gen-3 ministrals replaced mistral-small-2603 in the haiku slot 2026-05-24
      'ministral-3b-2512', 'ministral-8b-2512',
    ];
    for (const id of routedIds) {
      const cap = MODEL_CAPABILITIES[id];
      expect(cap, `missing registry entry for ${id}`).toBeDefined();
      expect(cap!.id).toBe(id);
      expect(cap!.contextWindow).toBeGreaterThan(0);
      expect(cap!.defaultMaxOutput).toBeGreaterThan(0);
      expect(cap!.maxContinuations).toBeGreaterThan(0);
      expect(cap!.pricing.input).toBeGreaterThanOrEqual(0);
      expect(cap!.uiLabel.length).toBeGreaterThan(0);
      // Routed entries always carry a tier — null is reserved for bench-only
      // models below. Settings v3 tier-detection relies on this invariant.
      expect(cap!.tier, `routed model ${id} must have a tier`).not.toBeNull();
    }
    // Accessor falls back via normalizeModelId for @-suffixed vertex ids.
    expect(modelCapability('claude-sonnet-4-6@20260101')?.id).toBe('claude-sonnet-4-6');
  });

  it('pins provider classification per family', async () => {
    // Settings v3 tier-detection + provider-switch logic reads `cap.provider`;
    // a silent flip of a mistral entry to provider:'anthropic' (or vice versa)
    // would mis-route LLM calls. Lock the families.
    const { MODEL_CAPABILITIES } = await import('./models.js');
    for (const id of ['claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-sonnet-5', 'claude-haiku-4-5-20251001',
                      'claude-opus-4-7[1m]', 'claude-opus-4-6[1m]', 'claude-sonnet-4-6[1m]']) {
      expect(MODEL_CAPABILITIES[id]!.provider, id).toBe('anthropic');
    }
    expect(MODEL_CAPABILITIES['claude-haiku-4-5']!.provider).toBe('vertex');
    for (const id of ['mistral-small-2603', 'mistral-large-2512', 'magistral-medium-2509',
                      'ministral-3b-2512', 'ministral-8b-2512', 'ministral-14b-2512',
                      'ministral-8b-2410', 'ministral-3b-2410', 'open-mistral-nemo',
                      'mistral-medium-2508', 'codestral-2508', 'magistral-small-2509']) {
      expect(MODEL_CAPABILITIES[id]!.provider, id).toBe('openai');
    }
  });

  it('anchors capability flags per model family', async () => {
    // Item 8 (show-all-grayed) reads `cap.features` to decide which settings
    // to disable per active model. Anchor one feature per family so silent
    // regression to vision/extendedThinking flags ships loud.
    const { MODEL_CAPABILITIES } = await import('./models.js');
    expect(MODEL_CAPABILITIES['claude-sonnet-4-6']!.features.extendedThinking).toBe(true);
    expect(MODEL_CAPABILITIES['claude-sonnet-4-6']!.features.vision).toBe(true);
    expect(MODEL_CAPABILITIES['mistral-small-2603']!.features.extendedThinking).toBe(false);
    expect(MODEL_CAPABILITIES['mistral-small-2603']!.features.vision).toBe(false);
    expect(MODEL_CAPABILITIES['mistral-large-2512']!.features.toolUse).toBe(true);

    // Gen-3 Mistral is multimodal (verified vs the live Mistral API: -2512 ids
    // 2026-07-18, mistral-medium-2604 2026-07-22): every id the product
    // tier-routes carries vision:true so an uploaded image reaches the model
    // instead of tripping the openai-adapter throw (#2). mistral-medium-2604 is
    // load-bearing — it is BOTH the balanced and deep Mistral tier, so a stale
    // vision:false here hard-errors every image message on the Mistral main.
    for (const id of ['ministral-3b-2512', 'ministral-8b-2512',
                      'ministral-14b-2512', 'mistral-large-2512',
                      'mistral-medium-2604']) {
      expect(MODEL_CAPABILITIES[id]!.features.vision, id).toBe(true);
    }
    // Legacy / opt-in Mistral stays vision:false by decision (rafael 2026-07-18) —
    // codestral + nemo genuinely reject images; magistral/older ids aren't routed.
    // A false-NO only yields the clear pre-flight error, never a silent unseen image.
    for (const id of ['codestral-2508', 'open-mistral-nemo', 'magistral-medium-2509',
                      'magistral-small-2509', 'ministral-8b-2410']) {
      expect(MODEL_CAPABILITIES[id]!.features.vision, id).toBe(false);
    }
  });

  it('exposes bench-only Mistral roster with tier:null + non-negative pricing', async () => {
    // These models aren't routed through MISTRAL_MODEL_MAP but appear in
    // cost-guard / set-bench. A future cleanup that drops them silently
    // would re-introduce the "Mistral-bench fall through to opus rate"
    // regression class. Lock them down.
    const { MODEL_CAPABILITIES } = await import('./models.js');
    const benchOnlyIds = [
      'ministral-8b-2410', 'ministral-3b-2410', 'open-mistral-nemo',
      'mistral-medium-2508', 'mistral-medium-latest',
      'codestral-2508', 'codestral-latest',
      'magistral-small-2509', 'magistral-small-latest',
      // Demoted from the `deep` slot 2026-05-29 (deprecated by Mistral, retires
      // 2026-07-31) — now tier:null, cost-guard / legacy-config only.
      'magistral-medium-2509',
    ];
    for (const id of benchOnlyIds) {
      const cap = MODEL_CAPABILITIES[id];
      expect(cap, `missing bench-only entry ${id}`).toBeDefined();
      expect(cap!.tier).toBeNull();
      expect(cap!.pricing.input).toBeGreaterThanOrEqual(0);
      expect(cap!.pricing.output).toBeGreaterThanOrEqual(0);
    }
  });

  it('tags 1M-beta variants with the context-1m-2025-08-07 header', async () => {
    const { MODEL_CAPABILITIES } = await import('./models.js');
    for (const id of ['claude-opus-4-7[1m]', 'claude-opus-4-6[1m]', 'claude-sonnet-4-6[1m]']) {
      expect(MODEL_CAPABILITIES[id]!.betaHeaders).toContain('context-1m-2025-08-07');
    }
    // Base (non-1M) variants stay header-free.
    expect(MODEL_CAPABILITIES['claude-sonnet-4-6']!.betaHeaders).toEqual([]);
  });

  it('registers claude-sonnet-5 as native-1M, sticker-priced, no beta header', async () => {
    const { MODEL_CAPABILITIES } = await import('./models.js');
    const cap = MODEL_CAPABILITIES['claude-sonnet-5'];
    expect(cap).toBeDefined();
    expect(cap!.provider).toBe('anthropic');
    expect(cap!.tier).toBe('balanced');
    // 1M NATIVELY — no context-1m beta header (unlike the 4.6[1m] variant).
    expect(cap!.contextWindow).toBe(1_000_000);
    expect(cap!.betaHeaders).toEqual([]);
    // Sticker $3/$15; cacheWrite=input×2 (1h TTL), cacheRead=input×0.1.
    expect(cap!.pricing).toEqual({ input: 3, output: 15, cacheWrite: 6, cacheRead: 0.30 });
    expect(cap!.defaultMaxOutput).toBe(16_000);
    // New-tokenizer baseline (~+30% tokens/text → lower chars-per-token).
    expect(cap!.charsPerToken).toBe(2.7);
    // effectiveContextWindow propagates the native 1M with no beta plumbing.
    expect(effectiveContextWindow('claude-sonnet-5', undefined)).toBe(1_000_000);
  });
});

describe('getCharsPerToken (model-aware tokenizer estimate)', () => {
  it('returns the per-model override when set (Sonnet 5 = 2.7)', () => {
    expect(getCharsPerToken('claude-sonnet-5')).toBe(2.7);
  });
  it('falls back to the global 3.5 for models without an override', () => {
    expect(getCharsPerToken('claude-sonnet-4-6')).toBe(CHARS_PER_TOKEN);
    expect(getCharsPerToken('claude-opus-4-6')).toBe(CHARS_PER_TOKEN);
  });
  it('falls back to the global 3.5 for unknown ids', () => {
    expect(getCharsPerToken('totally-unknown-model')).toBe(CHARS_PER_TOKEN);
  });
});

describe('resolveBalancedModel + balanced-tier Sonnet override', () => {
  afterEach(() => {
    // Reset the process-global so leakage can't affect other suites.
    setBalancedModelResolver(null);
  });

  it('defaults to claude-sonnet-4-6 when balanced_model is unset', () => {
    expect(resolveBalancedModel({})).toBe('claude-sonnet-4-6');
    expect(resolveBalancedModel({})).toBe(MODEL_MAP.balanced);
  });
  it('returns claude-sonnet-5 when balanced_model selects it', () => {
    expect(resolveBalancedModel({ balanced_model: 'claude-sonnet-5' })).toBe('claude-sonnet-5');
  });
  it('returns claude-sonnet-4-6 when balanced_model explicitly selects it', () => {
    expect(resolveBalancedModel({ balanced_model: 'claude-sonnet-4-6' })).toBe('claude-sonnet-4-6');
  });
  it('falls back to the default for an invalid / non-Sonnet value (never crashes)', () => {
    expect(resolveBalancedModel({ balanced_model: 'claude-opus-4-6' })).toBe('claude-sonnet-4-6');
    expect(resolveBalancedModel({ balanced_model: 'mistral-large-2512' })).toBe('claude-sonnet-4-6');
    expect(resolveBalancedModel({ balanced_model: 'garbage' })).toBe('claude-sonnet-4-6');
    expect(resolveBalancedModel({ balanced_model: '' })).toBe('claude-sonnet-4-6');
  });

  it('getModelId(balanced) honours a set override for anthropic + custom only', () => {
    // Default (no override): balanced = 4.6, deep/fast untouched.
    expect(getModelId('balanced', 'anthropic')).toBe('claude-sonnet-4-6');
    setBalancedModelResolver('claude-sonnet-5');
    expect(getModelId('balanced', 'anthropic')).toBe('claude-sonnet-5');
    expect(getModelId('balanced', 'custom')).toBe('claude-sonnet-5');
    // deep + fast are NOT affected by the balanced override.
    expect(getModelId('deep', 'anthropic')).toBe('claude-opus-4-6');
    expect(getModelId('fast', 'anthropic')).toBe('claude-haiku-4-5-20251001');
    // Vertex balanced stays on its own map (out of scope) = 4.6.
    expect(getModelId('balanced', 'vertex')).toBe('claude-sonnet-4-6');
    expect(getActiveBalancedModel()).toBe('claude-sonnet-5');
  });

  it('setBalancedModelResolver refuses a non-served id (no off-Sonnet routing)', () => {
    setBalancedModelResolver('claude-opus-4-6');
    // Refused → no override → default 4.6.
    expect(getModelId('balanced', 'anthropic')).toBe('claude-sonnet-4-6');
    expect(getActiveBalancedModel()).toBe('claude-sonnet-4-6');
  });
});

describe('claudeModelRejectsManualThinking (4.7/5-family predicate)', () => {
  it('flags Sonnet 5 + Opus 4.7+ (reject legacy enabled thinking)', () => {
    expect(claudeModelRejectsManualThinking('claude-sonnet-5')).toBe(true);
    expect(claudeModelRejectsManualThinking('claude-opus-4-7')).toBe(true);
    // Unknown/future Claude ids default to the safe (reject → coerce) path.
    expect(claudeModelRejectsManualThinking('claude-sonnet-6')).toBe(true);
    expect(claudeModelRejectsManualThinking('claude-opus-4-8')).toBe(true);
  });
  it('does NOT flag the 4.6-era models that still accept enabled', () => {
    expect(claudeModelRejectsManualThinking('claude-sonnet-4-6')).toBe(false);
    expect(claudeModelRejectsManualThinking('claude-sonnet-4-6[1m]')).toBe(false);
    expect(claudeModelRejectsManualThinking('claude-opus-4-6')).toBe(false);
    // @-suffixed vertex ids normalize before the allowlist check.
    expect(claudeModelRejectsManualThinking('claude-sonnet-4-6@20260101')).toBe(false);
  });
  it('does NOT flag non-Claude models (governed by their own provider guard)', () => {
    expect(claudeModelRejectsManualThinking('mistral-large-2512')).toBe(false);
    expect(claudeModelRejectsManualThinking('ministral-14b-2512')).toBe(false);
  });
});
