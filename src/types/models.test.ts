import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  clampTier,
  getModelId,
  getContextWindow,
  getDefaultMaxTokens,
  getMaxContinuations,
  getOpenAIModelMap,
  setOpenAIModelResolver,
  effectiveContextWindow,
  MISTRAL_MODEL_MAP,
  MISTRAL_API_BASE,
} from './models.js';

describe('clampTier', () => {
  it('returns requested tier when no cap is set', () => {
    expect(clampTier('opus', undefined)).toBe('opus');
    expect(clampTier('sonnet', undefined)).toBe('sonnet');
    expect(clampTier('haiku', undefined)).toBe('haiku');
  });

  it('clamps opus to sonnet when max_tier is sonnet', () => {
    expect(clampTier('opus', 'sonnet')).toBe('sonnet');
  });

  it('clamps opus to haiku when max_tier is haiku', () => {
    expect(clampTier('opus', 'haiku')).toBe('haiku');
  });

  it('clamps sonnet to haiku when max_tier is haiku', () => {
    expect(clampTier('sonnet', 'haiku')).toBe('haiku');
  });

  it('allows sonnet when max_tier is sonnet', () => {
    expect(clampTier('sonnet', 'sonnet')).toBe('sonnet');
  });

  it('allows haiku when max_tier is sonnet', () => {
    expect(clampTier('haiku', 'sonnet')).toBe('haiku');
  });

  it('allows haiku when max_tier is haiku', () => {
    expect(clampTier('haiku', 'haiku')).toBe('haiku');
  });

  it('allows any tier when max_tier is opus', () => {
    expect(clampTier('opus', 'opus')).toBe('opus');
    expect(clampTier('sonnet', 'opus')).toBe('sonnet');
    expect(clampTier('haiku', 'opus')).toBe('haiku');
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
    expect(MISTRAL_MODEL_MAP.haiku).toBe('ministral-8b-2512');
    expect(MISTRAL_MODEL_MAP.sonnet).toBe('mistral-large-2512');
    expect(MISTRAL_MODEL_MAP.opus).toBe('magistral-medium-2509');
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
    expect(getModelId('haiku', 'openai')).toBe('claude-haiku-4-5-20251001');
    expect(getModelId('sonnet', 'openai')).toBe('claude-sonnet-4-6');
    expect(getModelId('opus', 'openai')).toBe('claude-opus-4-6');
  });

  it('returns Mistral tier-set when the mistral map is registered', () => {
    setOpenAIModelResolver({ map: MISTRAL_MODEL_MAP });
    expect(getModelId('haiku', 'openai')).toBe('ministral-8b-2512');
    expect(getModelId('sonnet', 'openai')).toBe('mistral-large-2512');
    expect(getModelId('opus', 'openai')).toBe('magistral-medium-2509');
  });

  it('falls back to fallbackModelId when no map but fallback is set', () => {
    setOpenAIModelResolver({ map: null, fallbackModelId: 'custom-model-v1' });
    // Single-model openai-compat setups (e.g. Ollama with one model) — every
    // tier resolves to the configured single id.
    expect(getModelId('haiku', 'openai')).toBe('custom-model-v1');
    expect(getModelId('sonnet', 'openai')).toBe('custom-model-v1');
    expect(getModelId('opus', 'openai')).toBe('custom-model-v1');
  });

  it('prefers map over fallback when both are set', () => {
    setOpenAIModelResolver({ map: MISTRAL_MODEL_MAP, fallbackModelId: 'should-be-ignored' });
    expect(getModelId('sonnet', 'openai')).toBe('mistral-large-2512');
  });

  it('still resolves Anthropic/Vertex providers correctly when openai resolver is set', () => {
    setOpenAIModelResolver({ map: MISTRAL_MODEL_MAP });
    expect(getModelId('sonnet', 'anthropic')).toBe('claude-sonnet-4-6');
    expect(getModelId('sonnet', 'vertex')).toBe('claude-sonnet-4-6');
    expect(getModelId('sonnet', 'custom')).toBe('claude-sonnet-4-6');
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
      'claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-4-6',
      'claude-haiku-4-5-20251001', 'claude-haiku-4-5',
      'claude-opus-4-7[1m]', 'claude-opus-4-6[1m]', 'claude-sonnet-4-6[1m]',
      'mistral-large-2512', 'magistral-medium-2509',
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
    for (const id of ['claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001',
                      'claude-opus-4-7[1m]', 'claude-opus-4-6[1m]', 'claude-sonnet-4-6[1m]']) {
      expect(MODEL_CAPABILITIES[id]!.provider, id).toBe('anthropic');
    }
    expect(MODEL_CAPABILITIES['claude-haiku-4-5']!.provider).toBe('vertex');
    for (const id of ['mistral-small-2603', 'mistral-large-2512', 'magistral-medium-2509',
                      'ministral-3b-2512', 'ministral-8b-2512',
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
});
