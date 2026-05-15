import { describe, it, expect } from 'vitest';
import type { LLMProvider } from '../../types/models.js';
import { LLM_CATALOG, getCatalogForProvider } from './catalog.js';

describe('LLM_CATALOG', () => {
  it('exposes all four providers (anthropic, vertex, openai, custom)', () => {
    const providers = LLM_CATALOG.map((e) => e.provider).sort();
    expect(providers).toEqual(['anthropic', 'custom', 'openai', 'vertex']);
  });

  // Per-provider requires_base_url + requires_region matrix. UI uses these
  // to render conditional form fields, so a regression here would break the
  // LLM page (e.g. showing a base-URL input for Anthropic).
  it.each([
    ['anthropic', { requires_base_url: false, requires_region: false }],
    ['vertex',    { requires_base_url: false, requires_region: true  }],
    ['openai',    { requires_base_url: true,  requires_region: false }],
    ['custom',    { requires_base_url: true,  requires_region: false }],
  ] as const)('%s has expected requires_base_url/requires_region flags', (provider, expected) => {
    const entry = getCatalogForProvider(provider as LLMProvider)!;
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

  it('openai (Mistral) has three Mistral models, EU-Paris residency, mistral-large pricing pinned', () => {
    const entry = getCatalogForProvider('openai')!;
    expect(entry.models.map((m) => m.id)).toEqual([
      'mistral-large-latest',
      'mistral-medium-latest',
      'mistral-small-latest',
    ]);
    expect(entry.default_residency).toContain('EU-Paris');
    const large = entry.models.find((m) => m.id === 'mistral-large-latest')!;
    expect(large.pricing).toEqual({ input: 2, output: 6 });
  });

  it('custom provider has zero preset models (user supplies free-text model ID)', () => {
    const entry = getCatalogForProvider('custom')!;
    expect(entry.models).toHaveLength(0);
    expect(entry.requires_base_url).toBe(true);
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
