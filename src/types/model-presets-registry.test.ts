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

  it('Mistral Medium 3.5 — verified $1.50/$7.50, 262k ctx, vision, EU', () => {
    const m = MODEL_CAPABILITIES['mistral-medium-2604']!;
    expect(m.provider).toBe('openai');
    expect(m.contextWindow).toBe(262_144);
    expect(m.pricing.input).toBe(1.5);
    expect(m.pricing.output).toBe(7.5);
    // vision verified live 2026-07-22 (two image probes described correctly),
    // completing the check the verify-live-or-false convention owed here.
    expect(m.features.vision).toBe(true);
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

  it('Kimi K3 (Fireworks) — verified $3/$15 + $0.30 cached, text-only pending vision validation, CN', () => {
    const m = MODEL_CAPABILITIES['accounts/fireworks/models/kimi-k3']!;
    expect(m.provider).toBe('openai');
    // Read from the Fireworks model page 2026-08-09. cacheRead $0.30 is Kimi's
    // published cached-input rate (here it DOES equal input×0.1 — unlike the flat
    // $0.14 of GLM/DeepSeek; each page is its own source).
    expect(m.pricing).toEqual({ input: 3.0, output: 15.0, cacheWrite: 3.0, cacheRead: 0.30 });
    expect(m.contextWindow).toBeGreaterThanOrEqual(1_000_000);
    // Fireworks serves Kimi K3 WITH image input; vision stays false here until
    // the openai-wire image path is validated — flipping it is a separate change.
    expect(m.features.vision).toBe(false);
    expect(m.provenance).toBe('CN');
  });

  it('DeepSeek v4 Flash (Fireworks) — verified $0.14/$0.28 + $0.028 cached, text-only, CN', () => {
    const m = MODEL_CAPABILITIES['accounts/fireworks/models/deepseek-v4-flash']!;
    expect(m.provider).toBe('openai');
    // Read from the Fireworks model page 2026-08-09.
    expect(m.pricing).toEqual({ input: 0.14, output: 0.28, cacheWrite: 0.14, cacheRead: 0.028 });
    expect(m.contextWindow).toBeGreaterThanOrEqual(1_000_000);
    expect(m.features.vision).toBe(false);
    expect(m.provenance).toBe('CN');
  });

  it('Qwen3.7 Plus (Fireworks) — verified $0.40/$1.60 + $0.08 cached, 262k ctx, text-only pending vision validation, CN', () => {
    const m = MODEL_CAPABILITIES['accounts/fireworks/models/qwen3p7-plus']!;
    expect(m.provider).toBe('openai');
    // Read from the Fireworks model page 2026-08-09. Vision stays false pending
    // openai-wire image validation (Fireworks lists image input as supported).
    expect(m.pricing).toEqual({ input: 0.40, output: 1.60, cacheWrite: 0.40, cacheRead: 0.08 });
    expect(m.contextWindow).toBe(262_144);
    expect(m.features.vision).toBe(false);
    expect(m.provenance).toBe('CN');
  });
});
