// Pins the provider→slot map + resolveProviderApiKey priority order.
// Without these tests, a future engine refactor could silently revert to
// the pre-1.5.2 "always read ANTHROPIC_API_KEY" behaviour and re-introduce
// the Mistral-switch incident (rafael 2026-05-18: switched to Mistral,
// engine still talked to the Anthropic-keyed adapter).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  VAULT_SLOT_BY_PROVIDER,
  PROVIDER_KEY_SLOTS,
  vaultSlotForProvider,
  resolveProviderApiKey,
} from './provider-keys.js';

describe('VAULT_SLOT_BY_PROVIDER', () => {
  it('covers every known LLMProvider with a stable slot (or explicit null for vertex)', () => {
    expect(VAULT_SLOT_BY_PROVIDER.anthropic).toBe('ANTHROPIC_API_KEY');
    expect(VAULT_SLOT_BY_PROVIDER.openai).toBe('MISTRAL_API_KEY');
    expect(VAULT_SLOT_BY_PROVIDER.custom).toBe('CUSTOM_API_KEY');
    expect(VAULT_SLOT_BY_PROVIDER.vertex).toBe(null);
  });

  it('PROVIDER_KEY_SLOTS exposes the non-null slots as a Set for membership checks', () => {
    // Primary slots (one per provider that takes a key).
    expect(PROVIDER_KEY_SLOTS.has('ANTHROPIC_API_KEY')).toBe(true);
    expect(PROVIDER_KEY_SLOTS.has('MISTRAL_API_KEY')).toBe(true);
    expect(PROVIDER_KEY_SLOTS.has('CUSTOM_API_KEY')).toBe(true);
    // Secondary slot: OPENAI_API_KEY follows the OpenAI SDK env-var
    // convention so users who set that get picked up for openai-compat.
    expect(PROVIDER_KEY_SLOTS.has('OPENAI_API_KEY')).toBe(true);
    expect(PROVIDER_KEY_SLOTS.size).toBe(4);
  });
});

describe('vaultSlotForProvider', () => {
  it('returns the slot for each provider', () => {
    expect(vaultSlotForProvider('anthropic')).toBe('ANTHROPIC_API_KEY');
    expect(vaultSlotForProvider('openai')).toBe('MISTRAL_API_KEY');
    expect(vaultSlotForProvider('custom')).toBe('CUSTOM_API_KEY');
    expect(vaultSlotForProvider('vertex')).toBe(null);
  });

  it('returns null for undefined or null inputs', () => {
    expect(vaultSlotForProvider(undefined)).toBe(null);
    expect(vaultSlotForProvider(null)).toBe(null);
  });
});

describe('resolveProviderApiKey', () => {
  const ORIG_ENV = { ...process.env };

  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.MISTRAL_API_KEY;
    delete process.env.CUSTOM_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    process.env = { ...ORIG_ENV };
    vi.restoreAllMocks();
  });

  it('returns undefined when provider has no slot (vertex)', () => {
    const result = resolveProviderApiKey({
      provider: 'vertex',
      secretStore: { resolve: () => 'should-not-be-returned' },
      userConfig: { api_key: 'should-not-be-returned' },
    });
    expect(result).toBeUndefined();
  });

  it('env wins over vault for the matching slot (openai → MISTRAL_API_KEY)', () => {
    process.env.MISTRAL_API_KEY = 'from-env';
    const result = resolveProviderApiKey({
      provider: 'openai',
      secretStore: { resolve: () => 'from-vault' },
    });
    expect(result).toBe('from-env');
  });

  it('vault wins over userConfig.api_key (legacy field) for anthropic', () => {
    const result = resolveProviderApiKey({
      provider: 'anthropic',
      secretStore: { resolve: (n) => (n === 'ANTHROPIC_API_KEY' ? 'from-vault' : null) },
      userConfig: { api_key: 'from-userconfig' },
    });
    expect(result).toBe('from-vault');
  });

  it('falls back to userConfig.api_key ONLY for anthropic — openai never reads it', () => {
    const anthropicResult = resolveProviderApiKey({
      provider: 'anthropic',
      secretStore: { resolve: () => null },
      userConfig: { api_key: 'legacy-anthropic-key' },
    });
    expect(anthropicResult).toBe('legacy-anthropic-key');

    const openaiResult = resolveProviderApiKey({
      provider: 'openai',
      secretStore: { resolve: () => null },
      userConfig: { api_key: 'stale-anthropic-key-do-not-use' },
    });
    expect(openaiResult).toBeUndefined();
  });

  it('reads the openai provider key from MISTRAL_API_KEY env, not ANTHROPIC_API_KEY', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-stale';
    process.env.MISTRAL_API_KEY = 'sk-mistral-current';
    const result = resolveProviderApiKey({
      provider: 'openai',
      secretStore: null,
    });
    expect(result).toBe('sk-mistral-current');
  });

  it('reads the custom provider key from CUSTOM_API_KEY slot', () => {
    process.env.CUSTOM_API_KEY = 'sk-custom-key';
    const result = resolveProviderApiKey({
      provider: 'custom',
      secretStore: null,
    });
    expect(result).toBe('sk-custom-key');
  });

  it('returns undefined when nothing matches (no env, no vault, no userConfig)', () => {
    const result = resolveProviderApiKey({
      provider: 'openai',
      secretStore: { resolve: () => null },
      userConfig: { api_key: undefined },
    });
    expect(result).toBeUndefined();
  });

  it('handles missing secretStore + missing userConfig gracefully', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-env-only';
    const result = resolveProviderApiKey({
      provider: 'anthropic',
      secretStore: null,
    });
    expect(result).toBe('sk-ant-env-only');
  });
});
