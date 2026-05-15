import { describe, it, expect } from 'vitest';
import { LLM_CATALOG, getCatalogForProvider } from './catalog.js';

describe('LLM_CATALOG', () => {
  it('exposes all four providers (anthropic, vertex, openai, custom)', () => {
    const providers = LLM_CATALOG.map((e) => e.provider).sort();
    expect(providers).toEqual(['anthropic', 'custom', 'openai', 'vertex']);
  });

  it('anthropic entry has three tier-keyed models (opus, sonnet, haiku)', () => {
    const entry = getCatalogForProvider('anthropic');
    expect(entry).toBeDefined();
    expect(entry!.requires_base_url).toBe(false);
    expect(entry!.requires_region).toBe(false);
    const tiers = entry!.models.map((m) => m.tier).sort();
    expect(tiers).toEqual(['haiku', 'opus', 'sonnet']);
    const sonnet = entry!.models.find((m) => m.tier === 'sonnet')!;
    expect(sonnet.id).toBe('claude-sonnet-4-6');
    expect(sonnet.context_window).toBe(200_000);
    expect(sonnet.pricing).toEqual({ input: 3, output: 15 });
    expect(sonnet.notes).toContain('Recommended');
  });

  it('vertex requires region but not base_url', () => {
    const entry = getCatalogForProvider('vertex');
    expect(entry!.requires_region).toBe(true);
    expect(entry!.requires_base_url).toBe(false);
  });

  it('openai (Mistral) requires base_url and has three Mistral models', () => {
    const entry = getCatalogForProvider('openai');
    expect(entry!.requires_base_url).toBe(true);
    expect(entry!.requires_region).toBe(false);
    expect(entry!.models.map((m) => m.id)).toEqual([
      'mistral-large-latest',
      'mistral-medium-latest',
      'mistral-small-latest',
    ]);
    expect(entry!.default_residency).toContain('EU-Paris');
  });

  it('custom provider has zero preset models (user supplies free-text model ID)', () => {
    const entry = getCatalogForProvider('custom');
    expect(entry!.models).toHaveLength(0);
    expect(entry!.requires_base_url).toBe(true);
  });

  it('returns undefined for an unknown provider', () => {
    // @ts-expect-error — testing unknown provider
    expect(getCatalogForProvider('bogus')).toBeUndefined();
  });
});
