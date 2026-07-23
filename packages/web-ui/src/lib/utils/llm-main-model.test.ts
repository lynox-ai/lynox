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
  selectMainModelKey,
  mainModelOptionKey,
  findMainModelOptionByKey,
  availableComposerTiers,
  type ProviderLike,
  type MainModelOption,
} from './llm-main-model.js';

describe('availableComposerTiers', () => {
  it('offers all three cost-ascending (deep LAST, not suggested as best) when there is no ceiling', () => {
    expect(availableComposerTiers(undefined)).toEqual(['fast', 'balanced', 'deep']);
  });
  it('caps at a balanced ceiling (no deep)', () => {
    expect(availableComposerTiers('balanced')).toEqual(['fast', 'balanced']);
  });
  it('caps at a fast ceiling (demo tenant → single option, picker hides)', () => {
    expect(availableComposerTiers('fast')).toEqual(['fast']);
  });
  it('accepts legacy tier aliases as the ceiling', () => {
    // 'sonnet' → balanced via normalizeTier
    expect(availableComposerTiers('sonnet')).toEqual(['fast', 'balanced']);
  });
  it('treats an unrecognised ceiling as no ceiling (fail-open UX; server still clamps)', () => {
    expect(availableComposerTiers('nonsense')).toEqual(['fast', 'balanced', 'deep']);
  });
});

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

// Regression: a provider whose balanced AND deep bands resolve to the SAME model
// id — the live Mistral case (balanced == deep == Mistral Medium 3.5 since the
// 14B main fell below the orchestration floor). `main_chat_models` is NOT deduped
// by design, so the picker receives two options sharing an id. Keying the
// `<select>`/each by the bare id then (1) crashes Svelte with `each_key_duplicate`,
// (2) makes the deep `<option>` unselectable (two share a value), and (3) collapses
// a deep pick onto the first-matching (balanced) option. Tier-qualified identity
// fixes all three.
describe('tier-qualified identity (balanced == deep collision, Mistral Medium 3.5)', () => {
  const mistralCollide: ProviderLike = {
    main_chat_models: [
      { id: 'ministral-8b-2512', tier: 'fast' },
      { id: 'mistral-medium-2604', tier: 'balanced' },
      { id: 'mistral-medium-2604', tier: 'deep' },
    ],
    models: [
      { id: 'ministral-8b-2512', label: 'Ministral 8B', pricing: { input: 0.15, output: 0.15 } },
      { id: 'mistral-medium-2604', label: 'Mistral Medium 3.5', pricing: { input: 1.5, output: 7.5 } },
    ],
  };
  const opts = buildMainModelOptions(mistralCollide, 'deep');

  it('sanity: the fixture reproduces the duplicate-id list buildMainChatModels emits', () => {
    // Two distinct options carry the SAME model id — the exact shape catalog.ts
    // ships (no-dedupe by design). If this ever stops holding, the bug is moot.
    const ids = opts.map((o) => o.id);
    expect(ids.filter((id) => id === 'mistral-medium-2604')).toHaveLength(2);
  });

  it('(a) tier-qualified keys AND <option> values are unique despite the shared id', () => {
    const keys = opts.map(mainModelOptionKey);
    expect(keys).toEqual(['fast:ministral-8b-2512', 'balanced:mistral-medium-2604', 'deep:mistral-medium-2604']);
    expect(new Set(keys).size).toBe(keys.length); // no duplicate → no each_key_duplicate crash
  });

  it('(b) tier-aware selection returns the DEEP option for default_tier=deep, BALANCED for balanced', () => {
    // The select value is the composite key, so it lands on the right <option>
    // even though both share the model id.
    expect(selectMainModelKey(opts, 'deep', undefined)).toBe('deep:mistral-medium-2604');
    expect(selectMainModelKey(opts, 'balanced', undefined)).toBe('balanced:mistral-medium-2604');
    // legacy aliases resolve the same
    expect(selectMainModelKey(opts, 'opus', undefined)).toBe('deep:mistral-medium-2604');
  });

  it('(c) the set-path maps a DEEP selection to the deep tier (no first-match collapse to balanced)', () => {
    // The component does `config.default_tier = findMainModelOptionByKey(opts, key).tier`.
    // Choosing the deep <option> must yield tier 'deep', not the balanced option
    // that shares the id and renders first.
    const deepKey = mainModelOptionKey({ tier: 'deep', id: 'mistral-medium-2604' });
    const picked = findMainModelOptionByKey(opts, deepKey);
    expect(picked?.tier).toBe('deep');

    const balancedKey = mainModelOptionKey({ tier: 'balanced', id: 'mistral-medium-2604' });
    expect(findMainModelOptionByKey(opts, balancedKey)?.tier).toBe('balanced');
  });

  it('round-trips: a deep config → deep key → back to the deep option', () => {
    const key = selectMainModelKey(opts, 'deep', undefined);
    expect(findMainModelOptionByKey(opts, key)?.tier).toBe('deep');
  });

  it('an unknown key resolves to undefined — the set-path must no-op, not fall back', () => {
    // setMainModel early-returns on undefined; a `?? options[0]` fallback here
    // would silently rewrite the config to the first (fast) option.
    expect(findMainModelOptionByKey(opts, 'deep:no-such-model')).toBeUndefined();
    expect(findMainModelOptionByKey(opts, 'not-a-composite')).toBeUndefined();
  });

  it('an empty option list selects the empty key (no throw, select stays unmatched)', () => {
    expect(selectMainModelKey([], 'balanced', undefined)).toBe('');
  });

  it('balanced rung 2: an unknown balanced_model falls back to the NO-VARIANT balanced option, not the first balanced', () => {
    // Fixture ordering puts a variant-carrying balanced option FIRST so that
    // deleting the middle `balanced_model === undefined` rung is observable:
    // without it, an unknown variant would land on the variant option instead.
    const variants: ProviderLike = {
      main_chat_models: [
        { id: 'a-variant', tier: 'balanced', balanced_model: 'a-variant' },
        { id: 'a-plain', tier: 'balanced' },
      ],
      models: [
        { id: 'a-variant', label: 'A (variant)' },
        { id: 'a-plain', label: 'A' },
      ],
    };
    const vOpts = buildMainModelOptions(variants, 'deep');
    expect(selectMainModelKey(vOpts, 'balanced', 'no-such-variant')).toBe('balanced:a-plain');
  });
});

describe('tier_models providers through the selection helpers (per-tier picker fix)', () => {
  // A tier_models entry (Fireworks) ships `models: []` + NO `main_chat_models`
  // — its per-tier options must NOT leak into the standard-mode main picker,
  // and the helpers must degrade cleanly (no crash, no fake options) when the
  // active provider is such an entry. Both tier_models models are `tier: null`
  // in the registry, so any option the helpers invented would fake a band.
  const fireworksLike: ProviderLike = {
    models: [],
    // main_chat_models deliberately absent — mirrors the real catalog entry.
  };

  it('buildMainModelOptions yields NO options (picker hides, free-text stays)', () => {
    expect(buildMainModelOptions(fireworksLike, undefined)).toEqual([]);
  });

  it('selectMainModelKey / selectMainModelId return empty for the empty option list', () => {
    const opts = buildMainModelOptions(fireworksLike, undefined);
    expect(selectMainModelKey(opts, 'deep', undefined)).toBe('');
    expect(selectMainModelId(opts, 'deep', undefined)).toBe('');
  });

  it('findMainModelOptionByKey resolves nothing for a tier-qualified tier_models id', () => {
    const opts = buildMainModelOptions(fireworksLike, undefined);
    expect(findMainModelOptionByKey(opts, 'deep:accounts/fireworks/models/glm-5p2')).toBeUndefined();
  });
});
