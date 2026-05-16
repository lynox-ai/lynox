import { describe, it, expect, afterEach } from 'vitest';
import {
  clampTier,
  getModelId,
  getContextWindow,
  getDefaultMaxTokens,
  getMaxContinuations,
  getOpenAIModelMap,
  setOpenAIModelResolver,
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
  afterEach(() => {
    // Reset the process-global resolver so tests don't bleed into each other.
    setOpenAIModelResolver({ map: null, fallbackModelId: null });
  });

  it('exposes pinned snapshot IDs (not the auto-rolling -latest alias)', () => {
    // Reproducibility guarantee for managed-EU tenants — Mistral rolls
    // `*-latest` silently which would change behaviour mid-billing-period.
    expect(MISTRAL_MODEL_MAP.haiku).toBe('mistral-small-2603');
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

  it('Mistral context-windows + max-tokens + max-continuations registered', () => {
    expect(getContextWindow('mistral-small-2603')).toBe(32_000);
    expect(getContextWindow('mistral-large-2512')).toBe(131_072);
    expect(getContextWindow('magistral-medium-2509')).toBe(131_072);
    expect(getDefaultMaxTokens('mistral-small-2603')).toBe(8_192);
    expect(getDefaultMaxTokens('mistral-large-2512')).toBe(16_000);
    expect(getDefaultMaxTokens('magistral-medium-2509')).toBe(32_000);
    expect(getMaxContinuations('mistral-small-2603')).toBe(5);
    expect(getMaxContinuations('mistral-large-2512')).toBe(10);
    expect(getMaxContinuations('magistral-medium-2509')).toBe(20);
  });
});

describe('getModelId for openai provider', () => {
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
    expect(getModelId('haiku', 'openai')).toBe('mistral-small-2603');
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
