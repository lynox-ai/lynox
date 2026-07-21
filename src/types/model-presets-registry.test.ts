import { describe, it, expect } from 'vitest';
import { MODEL_CAPABILITIES } from './models.js';

/**
 * Wave 1 of model-presets: the four models the hybrid/standard presets route to
 * must be registered with VERIFIED facts (pricing sourced from provider price
 * pages 2026-07-19, not the harness estimates which were 2.5-4× off). This test
 * pins the verified numbers so a later edit can't silently regress them — an
 * unregistered id falls to FALLBACK_CAPABILITY (200k) + FALLBACK_PRICING (Opus
 * rate) = a ~9-100× mis-bill + a mis-trim, which is exactly what P1 exists to fix.
 */
describe('model-presets Wave 1 — new model registrations', () => {
  it('registers all preset models', () => {
    for (const id of [
      'claude-opus-4-8',
      'claude-fable-5',
      'mistral-medium-2604',
      'accounts/fireworks/models/glm-5p2',
      'accounts/fireworks/models/deepseek-v4-pro',
    ]) {
      expect(MODEL_CAPABILITIES[id], `${id} must be registered`).toBeDefined();
    }
  });

  it('Claude Opus 4.8 — verified $5/$25, 1M ctx, vision, US, deep', () => {
    const m = MODEL_CAPABILITIES['claude-opus-4-8']!;
    expect(m.provider).toBe('anthropic');
    expect(m.tier).toBe('deep');
    expect(m.contextWindow).toBe(1_000_000);
    expect(m.pricing).toEqual({ input: 5, output: 25, cacheWrite: 10, cacheRead: 0.5 });
    expect(m.features.vision).toBe(true);
    expect(m.provenance).toBe('US');
  });

  it('Claude Fable 5 — verified $10/$50, 1M ctx, vision, US, deep (max-quality deep slot)', () => {
    const m = MODEL_CAPABILITIES['claude-fable-5']!;
    expect(m.provider).toBe('anthropic');
    expect(m.tier).toBe('deep');
    expect(m.contextWindow).toBe(1_000_000);
    expect(m.pricing).toEqual({ input: 10, output: 50, cacheWrite: 20, cacheRead: 1.0 });
    expect(m.features.vision).toBe(true);
    expect(m.provenance).toBe('US');
  });

  it('Mistral Medium 3.5 — verified $1.50/$7.50, 262k ctx, vision:false, EU', () => {
    const m = MODEL_CAPABILITIES['mistral-medium-2604']!;
    expect(m.provider).toBe('openai');
    expect(m.contextWindow).toBe(262_144);
    expect(m.pricing.input).toBe(1.5);
    expect(m.pricing.output).toBe(7.5);
    // vision:false per the verify-live-or-false convention (advertised multimodal,
    // live image check owed before flipping to a vision feature-set).
    expect(m.features.vision).toBe(false);
    expect(m.provenance).toBe('EU');
  });

  it('GLM 5.2 (Fireworks) — verified $1.40/$4.40, ~1M ctx, text-only, CN', () => {
    const m = MODEL_CAPABILITIES['accounts/fireworks/models/glm-5p2']!;
    expect(m.provider).toBe('openai');
    expect(m.pricing).toEqual({ input: 1.4, output: 4.4, cacheWrite: 1.4, cacheRead: 0.14 });
    expect(m.contextWindow).toBeGreaterThanOrEqual(1_000_000);
    expect(m.features.vision).toBe(false);
    expect(m.provenance).toBe('CN');
  });

  it('DeepSeek v4 Pro (Fireworks) — verified $1.74/$3.48, Fireworks-hosted, text-only, CN', () => {
    const m = MODEL_CAPABILITIES['accounts/fireworks/models/deepseek-v4-pro']!;
    expect(m.provider).toBe('openai');
    // Fireworks-hosted price, NOT DeepSeek first-party ($0.43) — the PRD targets the host.
    expect(m.pricing).toEqual({ input: 1.74, output: 3.48, cacheWrite: 1.74, cacheRead: 0.14 });
    expect(m.contextWindow).toBeGreaterThanOrEqual(1_000_000);
    expect(m.features.vision).toBe(false);
    expect(m.provenance).toBe('CN');
  });
});
