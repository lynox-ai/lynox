// === Main-chat picker helper tests ===
//
// The picker sets default_tier (+ the Anthropic balanced_model variant) from the
// server-computed `main_chat_models`. These pin the branchy bits the .svelte
// can't unit-test: legacy-tier normalisation, the balanced-variant disambiguation
// fallback chain, the ceiling flag, and the "no matching band → first option, not
// ''" forward-compat guard.

import { describe, it, expect } from 'vitest';
import {
  normalizeTier,
  isExpensiveModel,
  buildMainModelOptions,
  selectMainModelId,
  type ProviderLike,
  type MainModelOption,
} from './llm-main-model.js';

const anthropic: ProviderLike = {
  main_chat_models: [
    { id: 'claude-haiku-4-5-20251001', tier: 'fast' },
    { id: 'claude-sonnet-4-6', tier: 'balanced', balanced_model: 'claude-sonnet-4-6' },
    { id: 'claude-sonnet-5', tier: 'balanced', balanced_model: 'claude-sonnet-5' },
    { id: 'claude-opus-4-6', tier: 'deep' },
  ],
  models: [
    { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', pricing: { input: 1, output: 5 } },
    { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', pricing: { input: 3, output: 15 } },
    { id: 'claude-sonnet-5', label: 'Sonnet 5', pricing: { input: 3, output: 15 } },
    { id: 'claude-opus-4-6', label: 'Opus 4.6', pricing: { input: 5, output: 25 } },
  ],
};

const mistral: ProviderLike = {
  main_chat_models: [
    { id: 'ministral-8b-2512', tier: 'fast' },
    { id: 'ministral-14b-2512', tier: 'balanced' },
    { id: 'mistral-large-2512', tier: 'deep' },
  ],
  models: [
    { id: 'ministral-8b-2512', label: 'Ministral 8B', pricing: { input: 0.15, output: 0.15 } },
    { id: 'ministral-14b-2512', label: 'Ministral 14B', pricing: { input: 0.2, output: 0.2 } },
    { id: 'mistral-large-2512', label: 'Mistral Large 3', pricing: { input: 0.5, output: 1.5 } },
  ],
};

const freeText: ProviderLike = { models: [] }; // openai-compat / custom — no main_chat_models

describe('normalizeTier', () => {
  it('passes canonical bands through', () => {
    expect(normalizeTier('fast')).toBe('fast');
    expect(normalizeTier('balanced')).toBe('balanced');
    expect(normalizeTier('deep')).toBe('deep');
  });
  it('maps legacy Anthropic-brand names (the ones config-update still stores)', () => {
    expect(normalizeTier('haiku')).toBe('fast');
    expect(normalizeTier('sonnet')).toBe('balanced');
    expect(normalizeTier('opus')).toBe('deep');
  });
  it('returns undefined for unset / unknown', () => {
    expect(normalizeTier(undefined)).toBeUndefined();
    expect(normalizeTier('bogus')).toBeUndefined();
    expect(normalizeTier('')).toBeUndefined();
  });
});

describe('isExpensiveModel', () => {
  it('trips only in Opus territory ($20+/M out)', () => {
    expect(isExpensiveModel({ output: 25 })).toBe(true);
    expect(isExpensiveModel({ output: 20 })).toBe(true);
    expect(isExpensiveModel({ output: 15 })).toBe(false);
    expect(isExpensiveModel({ output: 1.5 })).toBe(false);
    expect(isExpensiveModel(undefined)).toBe(false);
  });
});

describe('buildMainModelOptions', () => {
  it('joins label + pricing, flags fast as not-recommended, Opus as expensive', () => {
    const opts = buildMainModelOptions(anthropic, 'deep');
    expect(opts.map((o) => o.id)).toEqual([
      'claude-haiku-4-5-20251001', 'claude-sonnet-4-6', 'claude-sonnet-5', 'claude-opus-4-6',
    ]);
    const byId = Object.fromEntries(opts.map((o) => [o.id, o]));
    expect(byId['claude-haiku-4-5-20251001']!.label).toBe('Haiku 4.5');
    expect(byId['claude-haiku-4-5-20251001']!.notRecommended).toBe(true);
    expect(byId['claude-sonnet-4-6']!.notRecommended).toBe(false);
    expect(byId['claude-opus-4-6']!.expensive).toBe(true);
    expect(byId['claude-sonnet-4-6']!.expensive).toBe(false);
    // balanced options carry their variant; non-balanced carry none (omitted key).
    expect(byId['claude-sonnet-5']!.balanced_model).toBe('claude-sonnet-5');
    expect('balanced_model' in byId['claude-opus-4-6']!).toBe(false);
  });

  it('greys options above the max_tier ceiling (overCeiling), keeps the rest', () => {
    const opts = buildMainModelOptions(mistral, 'balanced'); // ceiling = balanced
    const byTier = Object.fromEntries(opts.map((o) => [o.tier, o]));
    expect(byTier['fast']!.overCeiling).toBe(false);
    expect(byTier['balanced']!.overCeiling).toBe(false);
    expect(byTier['deep']!.overCeiling).toBe(true); // deep > balanced
  });

  it('no ceiling (unset / unknown max_tier) → nothing over-ceiling', () => {
    for (const opt of buildMainModelOptions(anthropic, undefined)) expect(opt.overCeiling).toBe(false);
    for (const opt of buildMainModelOptions(anthropic, 'garbage')) expect(opt.overCeiling).toBe(false);
  });

  it('accepts legacy ceiling names (opus → deep rank)', () => {
    const opts = buildMainModelOptions(mistral, 'sonnet'); // legacy balanced
    expect(Object.fromEntries(opts.map((o) => [o.tier, o.overCeiling]))).toEqual({
      fast: false, balanced: false, deep: true,
    });
  });

  it('returns [] for a free-text provider (no main_chat_models)', () => {
    expect(buildMainModelOptions(freeText, 'deep')).toEqual([]);
    expect(buildMainModelOptions(undefined, 'deep')).toEqual([]);
  });

  it('falls back to the id as label when the models list lacks the option', () => {
    const orphan: ProviderLike = { main_chat_models: [{ id: 'x-1', tier: 'deep' }], models: [] };
    const [opt] = buildMainModelOptions(orphan, 'deep');
    expect(opt!.label).toBe('x-1');
    expect(opt!.expensive).toBe(false);
  });
});

describe('selectMainModelId', () => {
  const aOpts = buildMainModelOptions(anthropic, 'deep');
  const mOpts = buildMainModelOptions(mistral, 'deep');

  it('unset default_tier → the balanced default variant (Sonnet 4.6, not 5)', () => {
    // The disambiguation feature: no balanced_model must land on 4.6, never 5.
    expect(selectMainModelId(aOpts, undefined, 'claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
  });

  it('balanced + balanced_model picks the matching Sonnet variant', () => {
    expect(selectMainModelId(aOpts, 'balanced', 'claude-sonnet-5')).toBe('claude-sonnet-5');
    expect(selectMainModelId(aOpts, 'balanced', 'claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
  });

  it('balanced + unset/stale balanced_model → the no-variant fallback (first balanced)', () => {
    // Fallback chain: no exact match, no undefined-variant option (Anthropic has
    // none) → first balanced option = Sonnet 4.6.
    expect(selectMainModelId(aOpts, 'balanced', undefined)).toBe('claude-sonnet-4-6');
    expect(selectMainModelId(aOpts, 'balanced', 'claude-sonnet-99-stale')).toBe('claude-sonnet-4-6');
  });

  it('non-Anthropic balanced (single option, no variant) matches via the undefined-variant rung', () => {
    // Mistral's balanced carries no balanced_model; a stored Sonnet balanced_model
    // (the resolved default even on Mistral) must NOT prevent the match.
    expect(selectMainModelId(mOpts, 'balanced', 'claude-sonnet-4-6')).toBe('ministral-14b-2512');
  });

  it('fast / deep select by tier (incl. legacy aliases)', () => {
    expect(selectMainModelId(mOpts, 'deep', undefined)).toBe('mistral-large-2512');
    expect(selectMainModelId(mOpts, 'fast', undefined)).toBe('ministral-8b-2512');
    expect(selectMainModelId(aOpts, 'opus', undefined)).toBe('claude-opus-4-6'); // legacy deep
    expect(selectMainModelId(aOpts, 'haiku', undefined)).toBe('claude-haiku-4-5-20251001'); // legacy fast
  });

  it('empty options → empty selection', () => {
    expect(selectMainModelId([], 'balanced', undefined)).toBe('');
  });

  it('no option for the resolved tier → first option, NOT "" (forward-compat guard)', () => {
    // A hypothetical future provider with only fast+deep (no balanced band): an
    // unset default_tier resolves to balanced, finds no balanced option, and must
    // fall back to the first option instead of '' (which would show fast selected
    // while the engine routed to its own default).
    const noBalanced: MainModelOption[] = [
      { id: 'q-fast', tier: 'fast', label: 'Q Fast', expensive: false, overCeiling: false, notRecommended: true },
      { id: 'q-deep', tier: 'deep', label: 'Q Deep', expensive: false, overCeiling: false, notRecommended: false },
    ];
    expect(selectMainModelId(noBalanced, undefined, undefined)).toBe('q-fast');
    // and a deep default with no deep... actually deep exists here → picks it:
    expect(selectMainModelId(noBalanced, 'deep', undefined)).toBe('q-deep');
    // a tier with no representative (balanced) also falls back to first, not '':
    expect(selectMainModelId(noBalanced, 'balanced', undefined)).toBe('q-fast');
  });
});
