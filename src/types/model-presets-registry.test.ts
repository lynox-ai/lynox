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
      'accounts/fireworks/models/kimi-k3',
      'accounts/fireworks/models/deepseek-v4-flash-0731',
      'accounts/fireworks/models/qwen3p7-plus',
      'accounts/fireworks/models/gpt-oss-120b',
      'accounts/fireworks/models/kimi-k2p6',
      'accounts/fireworks/models/kimi-k2p7-code',
      'accounts/fireworks/models/minimax-m3',
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

  it('Claude Fable 5 — verified $10/$50, 1M ctx, vision, US, deep (catalog-only, in no preset)', () => {
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

  it('Kimi K3 (Fireworks) — verified $3/$15 + $0.30 cached, vision validated live, CN', () => {
    const m = MODEL_CAPABILITIES['accounts/fireworks/models/kimi-k3']!;
    expect(m.provider).toBe('openai');
    // Read from the Fireworks model page 2026-08-09. cacheRead $0.30 is Kimi's
    // published cached-input rate (here it DOES equal input×0.1 — unlike the flat
    // $0.14 of GLM/DeepSeek; each page is its own source).
    expect(m.pricing).toEqual({ input: 3.0, output: 15.0, cacheWrite: 3.0, cacheRead: 0.30 });
    expect(m.contextWindow).toBeGreaterThanOrEqual(1_000_000);
    // Vision validated live 2026-08-14 (tests/online/fireworks-vision.test.ts:
    // red/blue probe named both halves through the real adapter + endpoint).
    expect(m.features.vision).toBe(true);
    expect(m.provenance).toBe('CN');
  });

  it('DeepSeek v4 Flash (Fireworks) — verified $0.14/$0.28 + $0.028 cached, text-only, CN', () => {
    const m = MODEL_CAPABILITIES['accounts/fireworks/models/deepseek-v4-flash-0731']!;
    expect(m.provider).toBe('openai');
    // Read from the Fireworks model page 2026-08-09.
    expect(m.pricing).toEqual({ input: 0.14, output: 0.28, cacheWrite: 0.14, cacheRead: 0.028 });
    expect(m.contextWindow).toBeGreaterThanOrEqual(1_000_000);
    expect(m.features.vision).toBe(false);
    expect(m.provenance).toBe('CN');
  });

  it('Qwen3.7 Plus (Fireworks) — verified $0.40/$1.60 + $0.08 cached, 262k ctx, vision validated live, CN', () => {
    const m = MODEL_CAPABILITIES['accounts/fireworks/models/qwen3p7-plus']!;
    expect(m.provider).toBe('openai');
    // Read from the Fireworks model page 2026-08-09. Vision validated live
    // 2026-08-14 (tests/online/fireworks-vision.test.ts, red/blue probe).
    expect(m.pricing).toEqual({ input: 0.40, output: 1.60, cacheWrite: 0.40, cacheRead: 0.08 });
    expect(m.contextWindow).toBe(262_144);
    expect(m.features.vision).toBe(true);
    expect(m.provenance).toBe('CN');
  });

  // The 2026-08-09 second candidate wave — all read from their Fireworks pages.
  it('GPT-OSS 120B (Fireworks) — verified $0.15/$0.60 + $0.014 cached, 131k ctx, text-only, US provenance', () => {
    const m = MODEL_CAPABILITIES['accounts/fireworks/models/gpt-oss-120b']!;
    expect(m.provider).toBe('openai');
    expect(m.pricing).toEqual({ input: 0.15, output: 0.60, cacheWrite: 0.15, cacheRead: 0.014 });
    expect(m.contextWindow).toBe(131_072);
    expect(m.features.vision).toBe(false);
    // Non-CN (OpenAI open weights).
    expect(m.provenance).toBe('US');
  });

  it('Kimi K2.6 (Fireworks) — verified $0.95/$4.00 + $0.16 cached, 262k ctx, text-only pending vision validation, CN', () => {
    const m = MODEL_CAPABILITIES['accounts/fireworks/models/kimi-k2p6']!;
    expect(m.provider).toBe('openai');
    expect(m.pricing).toEqual({ input: 0.95, output: 4.00, cacheWrite: 0.95, cacheRead: 0.16 });
    expect(m.contextWindow).toBe(262_144);
    expect(m.features.vision).toBe(false);
    expect(m.provenance).toBe('CN');
  });

  it('Kimi K2.7 Code (Fireworks) — verified $0.95/$4.00 + $0.19 cached, 262k ctx, text-only pending vision validation, CN', () => {
    const m = MODEL_CAPABILITIES['accounts/fireworks/models/kimi-k2p7-code']!;
    expect(m.provider).toBe('openai');
    // Cached rate $0.19 ≠ K2.6's $0.16 — sibling models, separate pages.
    expect(m.pricing).toEqual({ input: 0.95, output: 4.00, cacheWrite: 0.95, cacheRead: 0.19 });
    expect(m.contextWindow).toBe(262_144);
    expect(m.features.vision).toBe(false);
    expect(m.provenance).toBe('CN');
  });

  it('MiniMax M3 (Fireworks) — verified $0.30/$1.20 + $0.059 cached, 512k ctx, vision validated live, CN', () => {
    const m = MODEL_CAPABILITIES['accounts/fireworks/models/minimax-m3']!;
    expect(m.provider).toBe('openai');
    expect(m.pricing).toEqual({ input: 0.30, output: 1.20, cacheWrite: 0.30, cacheRead: 0.059 });
    expect(m.contextWindow).toBe(524_288);
    // Vision validated live 2026-08-14 (tests/online/fireworks-vision.test.ts).
    expect(m.features.vision).toBe(true);
    expect(m.provenance).toBe('CN');
  });
});
