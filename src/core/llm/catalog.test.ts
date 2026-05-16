import { describe, it, expect } from 'vitest';
import type { LLMProvider } from '../../types/models.js';
import { LLM_CATALOG, getCatalogForProvider, getCatalogEntryByKey, catalogEntryKey } from './catalog.js';

describe('LLM_CATALOG', () => {
  it('exposes the five UI entries (anthropic, mistral, openai-compat, vertex, custom)', () => {
    // Mistral is split out from the generic OpenAI-compatible entry so the
    // EU-sovereign option is a first-class button in the provider picker
    // rather than hidden behind "OpenAI-compatible endpoint". Both UI
    // entries serialise to `provider: 'openai'` at the wire — disambiguated
    // by `preset_id` for the UI.
    const keys = LLM_CATALOG.map(catalogEntryKey).sort();
    expect(keys).toEqual(['anthropic', 'custom', 'mistral', 'openai-compat', 'vertex']);
  });

  // Per-entry requires_base_url + requires_region matrix. UI uses these
  // to render conditional form fields, so a regression here would break the
  // LLM page (e.g. showing a base-URL input for Anthropic, or hiding it
  // for the generic OpenAI-compatible preset).
  it.each([
    ['anthropic',     { requires_base_url: false, requires_region: false }],
    ['vertex',        { requires_base_url: false, requires_region: true  }],
    ['mistral',       { requires_base_url: false, requires_region: false }],
    ['openai-compat', { requires_base_url: true,  requires_region: false }],
    ['custom',        { requires_base_url: true,  requires_region: false }],
  ] as const)('%s has expected requires_base_url/requires_region flags', (key, expected) => {
    const entry = getCatalogEntryByKey(key)!;
    expect(entry.requires_base_url).toBe(expected.requires_base_url);
    expect(entry.requires_region).toBe(expected.requires_region);
  });

  it('anthropic models pin Sonnet/Opus/Haiku with provider-specific IDs', () => {
    const entry = getCatalogForProvider('anthropic')!;
    const tiers = entry.models.map((m) => m.tier).sort();
    expect(tiers).toEqual(['haiku', 'opus', 'sonnet']);
    const byTier = Object.fromEntries(entry.models.map((m) => [m.tier, m]));
    expect(byTier['sonnet']?.id).toBe('claude-sonnet-4-6');
    expect(byTier['opus']?.id).toBe('claude-opus-4-6');
    // Haiku ID has date suffix on Anthropic Direct, NOT on Vertex — pin both.
    expect(byTier['haiku']?.id).toBe('claude-haiku-4-5-20251001');
    expect(byTier['sonnet']?.pricing).toEqual({ input: 3, output: 15 });
    expect(byTier['opus']?.pricing).toEqual({ input: 15, output: 75 });
    expect(byTier['haiku']?.pricing).toEqual({ input: 0.80, output: 4 });
    expect(byTier['sonnet']?.notes).toContain('Recommended');
  });

  it('vertex models use Vertex-specific IDs (haiku drops date suffix)', () => {
    const entry = getCatalogForProvider('vertex')!;
    const byTier = Object.fromEntries(entry.models.map((m) => [m.tier, m]));
    expect(byTier['sonnet']?.id).toBe('claude-sonnet-4-6');
    expect(byTier['opus']?.id).toBe('claude-opus-4-6');
    // CRITICAL: vertex haiku is 'claude-haiku-4-5', NOT 'claude-haiku-4-5-20251001'
    // (matches VERTEX_MODEL_MAP in src/types/models.ts).
    expect(byTier['haiku']?.id).toBe('claude-haiku-4-5');
  });

  it('mistral preset pins dated snapshots and EU-Paris residency', () => {
    const entry = getCatalogEntryByKey('mistral')!;
    // Pinned to dated snapshots — mirrors MISTRAL_MODEL_MAP. The previous
    // catalog shipped `*-latest` aliases which auto-roll at Mistral's
    // discretion, silently shifting cost + behaviour mid-billing-period.
    expect(entry.models.map((m) => m.id)).toEqual([
      'mistral-large-2512',
      'magistral-medium-2509',
      'mistral-small-2603',
    ]);
    expect(entry.default_residency).toContain('EU-Paris');
    expect(entry.base_url_default).toBe('https://api.mistral.ai/v1');
    expect(entry.preset_id).toBe('mistral');
    expect(entry.provider).toBe('openai');
    // Tier mapping (small ↔ haiku, large ↔ sonnet, magistral ↔ opus) — kept
    // in sync with MISTRAL_MODEL_MAP so the engine's tier router and the UI
    // model dropdown stay coherent.
    const byTier = Object.fromEntries(entry.models.map((m) => [m.tier, m]));
    expect(byTier['haiku']?.id).toBe('mistral-small-2603');
    expect(byTier['sonnet']?.id).toBe('mistral-large-2512');
    expect(byTier['opus']?.id).toBe('magistral-medium-2509');
    expect(byTier['sonnet']?.pricing).toEqual({ input: 2, output: 6 });
  });

  it('generic OpenAI-compatible preset accepts free-text model + base URL', () => {
    const entry = getCatalogEntryByKey('openai-compat')!;
    expect(entry.models).toHaveLength(0);
    expect(entry.requires_base_url).toBe(true);
    expect(entry.preset_id).toBe('openai-compat');
    expect(entry.provider).toBe('openai');
    expect(entry.base_url_default).toBeUndefined();
  });

  it('mistral preset is ordered before the generic openai-compat preset', () => {
    // Visual priority guarantee for the EU-sovereign button — surfaced
    // above the catch-all OpenAI-compatible option in the picker.
    const order = LLM_CATALOG.map(catalogEntryKey);
    expect(order.indexOf('mistral')).toBeLessThan(order.indexOf('openai-compat'));
    expect(order.indexOf('anthropic')).toBeLessThan(order.indexOf('mistral'));
  });

  it('custom provider has zero preset models (user supplies free-text model ID)', () => {
    const entry = getCatalogForProvider('custom')!;
    expect(entry.models).toHaveLength(0);
    expect(entry.requires_base_url).toBe(true);
  });

  it('getCatalogForProvider returns the first openai entry (mistral) — preset disambig is UI-side', () => {
    // Backward-compat: callers reading by `provider` get the first match.
    // The UI uses `getCatalogEntryByKey` with the preset_id when it needs
    // to distinguish mistral vs openai-compat.
    const entry = getCatalogForProvider('openai' as LLMProvider)!;
    expect(entry.preset_id).toBe('mistral');
  });

  it('returns undefined for an unknown provider', () => {
    // @ts-expect-error — testing unknown provider
    expect(getCatalogForProvider('bogus')).toBeUndefined();
  });

  it('LLM_CATALOG is runtime-frozen against accidental mutation', () => {
    expect(Object.isFrozen(LLM_CATALOG)).toBe(true);
    const anthropic = getCatalogForProvider('anthropic')!;
    expect(Object.isFrozen(anthropic)).toBe(true);
    expect(Object.isFrozen(anthropic.models)).toBe(true);
    expect(Object.isFrozen(anthropic.models[0])).toBe(true);
  });
});
