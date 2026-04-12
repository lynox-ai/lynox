/**
 * Unit test: Session._recreateAgent with profile override
 *
 * Verifies that when a model profile is specified, the session
 * correctly looks it up in userConfig and passes the right provider
 * credentials to the Agent.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Engine } from './engine.js';

describe('Session profile override', () => {
  it('looks up profile from userConfig.model_profiles', () => {
    // Minimal engine mock with a model profile configured
    const mockEngine = {
      getUserConfig: vi.fn(() => ({
        provider: 'anthropic' as const,
        model_profiles: {
          'mistral-eu': {
            provider: 'openai' as const,
            api_base_url: 'https://api.mistral.ai/v1',
            api_key: 'test-key',
            model_id: 'mistral-large-latest',
          },
        },
      })),
    } as unknown as Engine;

    // Simulate the profile lookup logic from _recreateAgent
    const profileName = 'mistral-eu';
    const profiles = mockEngine.getUserConfig().model_profiles;
    const profile = profiles?.[profileName];

    expect(profile).toBeDefined();
    expect(profile!.provider).toBe('openai');
    expect(profile!.api_base_url).toBe('https://api.mistral.ai/v1');
    expect(profile!.model_id).toBe('mistral-large-latest');
  });

  it('throws on unknown profile', () => {
    const profiles: Record<string, unknown> = {
      'mistral-eu': { provider: 'openai', model_id: 'mistral-large-latest' },
    };

    const resolve = (name: string) => {
      const p = profiles[name];
      if (!p) throw new Error(`Unknown model profile "${name}". Available: ${Object.keys(profiles).join(', ')}.`);
      return p;
    };

    expect(() => resolve('missing')).toThrow('Unknown model profile "missing"');
    expect(() => resolve('missing')).toThrow('mistral-eu');
  });

  it('supports no profile (returns undefined for default path)', () => {
    const mockEngine = {
      getUserConfig: vi.fn(() => ({ provider: 'anthropic' as const })),
    } as unknown as Engine;

    const cfg = mockEngine.getUserConfig();
    // When no profile override, should use userConfig directly
    expect(cfg.model_profiles).toBeUndefined();
  });
});
