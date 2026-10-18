import { afterEach, describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { JUDGE_MODELS, judgeAxisOf, judgeModelId, judgeOutputBudget, resolveJudgeModel } from './bulk-judge.js';
import { judgeMaxOutputTokens } from './bulk-judge-rule.js';
import type { ExtractSchema } from './llm-helper.js';
import { setTierSetResolver } from './tier-resolver.js';
import { FIREWORKS_API_BASE, TIER_PRESETS } from './tier-presets.js';
import { MISTRAL_MODEL_MAP, MODEL_MAP, modelCapability, type TierSet } from '../types/index.js';

// The judge's model is set per provider, not taken from the provider's tier model: these tests pin
// that for every way a call can be served — standard per provider, and each hybrid preset.

const MISTRAL_BASE = 'https://api.mistral.ai/v1';
const ambient = { marker: 'ambient' } as unknown as Anthropic;
const uc = (over: Partial<{ max_tier: 'fast' | 'balanced' | 'deep'; blocked_model_ids: string[]; api_base_url: string }> = {}) => ({
  account_tier: undefined, max_tier: over.max_tier, blocked_model_ids: over.blocked_model_ids, api_base_url: over.api_base_url,
});
const hybrid = (preset: 'efficient' | 'balanced' | 'max-quality'): void => {
  // The preset's slots, with a key as the managed constraint would add one.
  const set = TIER_PRESETS[preset].tier_set;
  const withKeys = Object.fromEntries(Object.entries(set).map(([t, s]) => [t, { ...s, api_key: 'k' }])) as TierSet;
  setTierSetResolver({ routingMode: 'hybrid', tierSet: withKeys });
};

afterEach(() => { setTierSetResolver({ routingMode: 'standard', tierSet: null }); });

describe('the judge model per provider', () => {
  it('names models the catalog knows', () => {
    for (const id of Object.values(JUDGE_MODELS)) expect(modelCapability(id), id).toBeDefined();
  });

  it('judges on Haiku on Anthropic and Vertex, with the ambient client', () => {
    expect(judgeModelId(uc(), 'fast', 'anthropic')).toBe(JUDGE_MODELS.anthropic);
    expect(judgeModelId(uc(), 'balanced', 'anthropic')).toBe(JUDGE_MODELS.anthropic);
    expect(judgeModelId(uc(), 'fast', 'vertex')).toBe(JUDGE_MODELS.vertex);
    const m = resolveJudgeModel(uc(), 'fast', ambient, 'anthropic')!;
    expect(m.modelId).toBe(JUDGE_MODELS.anthropic);
    expect(m.client).toBe(ambient);
  });

  it('judges on mistral-medium on a Mistral tenant, not on its fast model', () => {
    expect(MISTRAL_MODEL_MAP.fast).not.toBe(JUDGE_MODELS.mistral);
    expect(judgeModelId(uc({ api_base_url: MISTRAL_BASE }), 'fast', 'openai')).toBe(JUDGE_MODELS.mistral);
    // Served by the tenant's own client: the adapter sends the request's model id.
    const m = resolveJudgeModel(uc({ api_base_url: MISTRAL_BASE }), 'fast', ambient, 'openai')!;
    expect(m.modelId).toBe(JUDGE_MODELS.mistral);
    expect(m.client).toBe(ambient);
  });

  it.each(['efficient', 'balanced'] as const)('judges on gpt-oss-120b under the %s preset, never on its fast slot', (preset) => {
    expect(TIER_PRESETS[preset].tier_set.fast!.model_id).not.toBe(JUDGE_MODELS.fireworks);
    hybrid(preset);
    for (const tier of ['fast', 'balanced', 'deep'] as const) {
      expect(judgeModelId(uc(), tier, 'anthropic'), tier).toBe(JUDGE_MODELS.fireworks);
    }
    expect(resolveJudgeModel(uc(), 'fast', ambient, 'anthropic')!.modelId).toBe(JUDGE_MODELS.fireworks);
  });

  it('judges on Haiku under the max-quality preset', () => {
    hybrid('max-quality');
    expect(judgeModelId(uc(), 'deep', 'anthropic')).toBe(JUDGE_MODELS.anthropic);
    expect(MODEL_MAP.fast).toBe(JUDGE_MODELS.anthropic);
  });

  it('gives no judge to a provider it has no decided model for', () => {
    expect(judgeModelId(uc({ api_base_url: 'https://llm.example.invalid/v1' }), 'fast', 'openai')).toBeNull();
    expect(judgeModelId(uc(), 'fast', 'openai')).toBeNull();
    expect(judgeModelId(uc({ api_base_url: 'https://proxy.example.invalid' }), 'fast', 'custom')).toBeNull();
    expect(resolveJudgeModel(uc(), 'fast', ambient, 'custom')).toBeNull();
  });

  it('refuses a blocked judge model instead of falling back', () => {
    expect(judgeModelId(uc({ blocked_model_ids: [JUDGE_MODELS.anthropic] }), 'balanced', 'anthropic')).toBeNull();
    expect(judgeModelId(uc({ blocked_model_ids: [JUDGE_MODELS.mistral], api_base_url: MISTRAL_BASE }), 'fast', 'openai')).toBeNull();
    // A blocked chat model on the tier is not the judge's: the judge still judges.
    expect(judgeModelId(uc({ blocked_model_ids: [MODEL_MAP.balanced] }), 'balanced', 'anthropic')).toBe(JUDGE_MODELS.anthropic);
  });

  it('refuses a judge model above max_tier', () => {
    // mistral-medium is in the deep band; gpt-oss-120b has no band and counts as deep.
    expect(modelCapability(JUDGE_MODELS.mistral)?.tier).toBe('deep');
    for (const max of ['fast', 'balanced'] as const) {
      expect(judgeModelId(uc({ max_tier: max, api_base_url: MISTRAL_BASE }), 'fast', 'openai'), max).toBeNull();
    }
    expect(judgeModelId(uc({ max_tier: 'deep', api_base_url: MISTRAL_BASE }), 'fast', 'openai')).toBe(JUDGE_MODELS.mistral);
    hybrid('efficient');
    expect(judgeModelId(uc({ max_tier: 'balanced' }), 'fast', 'anthropic')).toBeNull();
    expect(judgeModelId(uc({ max_tier: 'deep' }), 'fast', 'anthropic')).toBe(JUDGE_MODELS.fireworks);
    setTierSetResolver({ routingMode: 'standard', tierSet: null });
    expect(judgeModelId(uc({ max_tier: 'fast' }), 'deep', 'anthropic')).toBe(JUDGE_MODELS.anthropic);
  });
});

describe('judgeAxisOf', () => {
  it('reads the endpoint on the OpenAI wire, the slot before the base', () => {
    expect(judgeAxisOf({ provider: 'openai', apiBaseURL: FIREWORKS_API_BASE }, MISTRAL_BASE)).toBe('fireworks');
    expect(judgeAxisOf({ provider: 'openai', apiBaseURL: undefined }, MISTRAL_BASE)).toBe('mistral');
    expect(judgeAxisOf({ provider: 'mistral', apiBaseURL: undefined }, undefined)).toBe('mistral');
    expect(judgeAxisOf({ provider: 'openai', apiBaseURL: 'https://api.fireworks.ai.example.invalid/v1' }, undefined)).toBeNull();
    expect(judgeAxisOf({ provider: 'openai', apiBaseURL: 'not a url' }, undefined)).toBeNull();
  });

  it('gives no judge to a plain-text endpoint', () => {
    expect(judgeAxisOf({ provider: 'openai', apiBaseURL: 'https://api.fireworks.ai/inference/v1' }, undefined)).toBe('fireworks');
    expect(judgeAxisOf({ provider: 'openai', apiBaseURL: 'http://api.fireworks.ai/inference/v1' }, undefined)).toBeNull();
    expect(judgeAxisOf({ provider: 'openai', apiBaseURL: undefined }, 'http://api.mistral.ai/v1')).toBeNull();
  });

  it('gives a Mistral slot the Mistral judge only on Mistral\'s own endpoint', () => {
    expect(judgeAxisOf({ provider: 'mistral', apiBaseURL: MISTRAL_BASE }, undefined)).toBe('mistral');
    expect(judgeAxisOf({ provider: 'mistral', apiBaseURL: 'http://api.mistral.ai/v1' }, undefined)).toBeNull();
    expect(judgeAxisOf({ provider: 'mistral', apiBaseURL: 'https://proxy.example.invalid/v1' }, undefined)).toBeNull();
  });
});

describe('judgeOutputBudget', () => {
  const small: ExtractSchema = { type: 'object', properties: { label: { type: 'string', enum: ['a', 'b'] } } };

  it('lifts a thinking-only judge above the budget it comes back empty at', () => {
    const silent = modelCapability(JUDGE_MODELS.fireworks)!.thinkingOnly!.emptyAtOrBelow;
    expect(judgeMaxOutputTokens(small)).toBeLessThanOrEqual(silent);
    expect(judgeOutputBudget(JUDGE_MODELS.fireworks, small)).toBe(judgeMaxOutputTokens(small) + 1024);
  });

  it('leaves every other judge on the schema bound', () => {
    for (const id of [JUDGE_MODELS.anthropic, JUDGE_MODELS.vertex, JUDGE_MODELS.mistral]) {
      expect(modelCapability(id)?.thinkingOnly, id).toBeUndefined();
      expect(judgeOutputBudget(id, small), id).toBe(judgeMaxOutputTokens(small));
    }
  });

  it('adds the room to think on top of a large schema bound too', () => {
    // Its thinking counts against the same budget: a large verdict still needs the room.
    const large: ExtractSchema = { type: 'object', properties: { body: { type: 'string', maxLength: 4000 } } };
    expect(judgeMaxOutputTokens(large)).toBeGreaterThan(1024);
    expect(judgeOutputBudget(JUDGE_MODELS.fireworks, large)).toBe(judgeMaxOutputTokens(large) + 1024);
  });
});
