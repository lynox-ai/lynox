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
  enrichTierSetCreds,
} from './provider-keys.js';
import type { TierSet } from '../../types/config.js';

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
  beforeEach(() => {
    // vi.stubEnv parity with the rest of the suite — also auto-restores on
    // unstubAllEnvs. Empty string clears the var.
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('MISTRAL_API_KEY', '');
    vi.stubEnv('CUSTOM_API_KEY', '');
    vi.stubEnv('OPENAI_API_KEY', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
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
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-stale');
    vi.stubEnv('MISTRAL_API_KEY', 'sk-mistral-current');
    const result = resolveProviderApiKey({
      provider: 'openai',
      secretStore: null,
    });
    expect(result).toBe('sk-mistral-current');
  });

  it('falls back to OPENAI_API_KEY (secondary slot) when primary MISTRAL_API_KEY is empty', () => {
    // OpenAI SDK convention — users who set the standard env name expect it
    // to work for the openai provider without learning about the Mistral alias.
    vi.stubEnv('OPENAI_API_KEY', 'sk-openai-secondary');
    const result = resolveProviderApiKey({
      provider: 'openai',
      secretStore: null,
    });
    expect(result).toBe('sk-openai-secondary');
  });

  it('primary MISTRAL_API_KEY wins over secondary OPENAI_API_KEY when both are set', () => {
    vi.stubEnv('MISTRAL_API_KEY', 'sk-mistral-primary');
    vi.stubEnv('OPENAI_API_KEY', 'sk-openai-secondary');
    const result = resolveProviderApiKey({
      provider: 'openai',
      secretStore: null,
    });
    expect(result).toBe('sk-mistral-primary');
  });

  it('reads the custom provider key from CUSTOM_API_KEY slot', () => {
    vi.stubEnv('CUSTOM_API_KEY', 'sk-custom-key');
    const result = resolveProviderApiKey({
      provider: 'custom',
      secretStore: null,
    });
    expect(result).toBe('sk-custom-key');
  });

  it('returns undefined for openai when secretStore is null AND every env slot is empty', () => {
    // Explicit null-secretStore branch — the optional-chain in
    // resolveProviderApiKey should short-circuit, never throw.
    const result = resolveProviderApiKey({
      provider: 'openai',
      secretStore: null,
    });
    expect(result).toBeUndefined();
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
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-env-only');
    const result = resolveProviderApiKey({
      provider: 'anthropic',
      secretStore: null,
    });
    expect(result).toBe('sk-ant-env-only');
  });
});

describe('enrichTierSetCreds (hybrid per-slot vault-key injection)', () => {
  // resolveKey stub: a fixed provider→key table so the helper stays pure +
  // table-testable without a real SecretStore.
  const keyFor: Record<string, string | undefined> = {
    anthropic: 'sk-ant-xxx',
    openai: 'sk-mistral-xxx',
  };
  const resolveKey = (p: string): string | undefined => keyFor[p];

  it('injects the target provider key into a CROSS-provider slot (no key in config.json)', () => {
    const tierSet: TierSet = {
      fast: { provider: 'openai', model_id: 'ministral-8b-2512', api_base_url: 'https://api.mistral.ai/v1' },
    };
    const out = enrichTierSetCreds(tierSet, 'anthropic', resolveKey);
    // base=anthropic, slot=openai → cross-provider → key injected in-memory.
    expect(out.fast).toEqual({
      provider: 'openai',
      model_id: 'ministral-8b-2512',
      api_base_url: 'https://api.mistral.ai/v1',
      api_key: 'sk-mistral-xxx',
    });
    // The INPUT slot is never mutated (config-on-disk stays key-less).
    expect(tierSet.fast).not.toHaveProperty('api_key');
  });

  it('leaves a SAME-provider slot untouched so the ambient client (+ its key) is reused', () => {
    const tierSet: TierSet = {
      balanced: { provider: 'anthropic', model_id: 'claude-sonnet-4-6' },
    };
    const out = enrichTierSetCreds(tierSet, 'anthropic', resolveKey);
    expect(out.balanced).toEqual({ provider: 'anthropic', model_id: 'claude-sonnet-4-6' });
    expect(out.balanced).not.toHaveProperty('api_key');
  });

  it('keeps an explicit api_key as-is (power-user / managed transform)', () => {
    const tierSet: TierSet = {
      deep: { provider: 'openai', model_id: 'mistral-large-2512', api_key: 'sk-explicit' },
    };
    const out = enrichTierSetCreds(tierSet, 'anthropic', resolveKey);
    expect(out.deep?.api_key).toBe('sk-explicit');
  });

  it('leaves a cross-provider slot key-less when nothing resolves (adapter surfaces 401 at request time)', () => {
    const tierSet: TierSet = {
      fast: { provider: 'custom', model_id: 'whatever', api_base_url: 'https://proxy.example' },
    };
    const out = enrichTierSetCreds(tierSet, 'anthropic', resolveKey); // no 'custom' in keyFor
    expect(out.fast).not.toHaveProperty('api_key');
    expect(out.fast?.model_id).toBe('whatever');
  });

  it('handles a full mixed tier_set + skips unset tiers', () => {
    const tierSet: TierSet = {
      fast: { provider: 'openai', model_id: 'ministral-3b-2512', api_base_url: 'https://api.mistral.ai/v1' },
      deep: { provider: 'anthropic', model_id: 'claude-opus-4-6' },
    };
    const out = enrichTierSetCreds(tierSet, 'anthropic', resolveKey);
    expect(out.fast?.api_key).toBe('sk-mistral-xxx');   // cross → injected
    expect(out.deep).not.toHaveProperty('api_key');     // same → untouched
    expect(out.balanced).toBeUndefined();               // unset → skipped
  });
});
