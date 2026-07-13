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
    // Per-endpoint slots contributed by catalog presets. Derived from the
    // catalog, so a new preset's slot is recognised by the callers that gate on
    // this set (the settings API's key-write path) without a second edit here.
    expect(PROVIDER_KEY_SLOTS.has('GROQ_API_KEY')).toBe(true);
    expect(PROVIDER_KEY_SLOTS.has('TOGETHER_API_KEY')).toBe(true);
    expect(PROVIDER_KEY_SLOTS.has('FIREWORKS_API_KEY')).toBe(true);
    expect(PROVIDER_KEY_SLOTS.size).toBe(7);
  });
});

// The bug these pin: EVERY OpenAI-compatible vendor — Mistral, Groq, Together,
// Fireworks, a local Ollama — serialises to `provider: 'openai'`. Resolving the
// vault slot on the provider alone therefore hands whichever key sits in the
// shared openai slot to whatever endpoint happens to be configured. A user with
// a Mistral key who picks the Groq tile would bearer-token their Mistral key
// straight to Groq. Same class as the Anthropic legacy-fallback hazard this
// module already guards (see the comment on the `config.api_key` branch) — it
// just had no way to see the endpoint.
describe('resolveProviderApiKey — endpoint-bound slots (cross-provider leak)', () => {
  const GROQ = 'https://api.groq.com/openai/v1';
  const OLLAMA = 'http://localhost:11434/v1';
  const MISTRAL = 'https://api.mistral.ai/v1';

  beforeEach(() => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('MISTRAL_API_KEY', '');
    vi.stubEnv('CUSTOM_API_KEY', '');
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('GROQ_API_KEY', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('does NOT hand the Mistral key to a Groq endpoint', () => {
    vi.stubEnv('MISTRAL_API_KEY', 'mistral-secret');
    const key = resolveProviderApiKey({
      provider: 'openai',
      apiBaseURL: GROQ,
      secretStore: null,
    });
    expect(key).toBeUndefined();
  });

  it('does NOT fall back to the OPENAI_API_KEY alias for a Groq endpoint either', () => {
    // The same leak by another door: the SDK-alias fallback is scoped to the
    // provider-default slot and must not apply to an endpoint with its own.
    vi.stubEnv('OPENAI_API_KEY', 'openai-secret');
    const key = resolveProviderApiKey({
      provider: 'openai',
      apiBaseURL: GROQ,
      secretStore: null,
    });
    expect(key).toBeUndefined();
  });

  it('uses the Groq endpoint’s own slot when it is set', () => {
    vi.stubEnv('MISTRAL_API_KEY', 'mistral-secret');
    vi.stubEnv('GROQ_API_KEY', 'groq-secret');
    const key = resolveProviderApiKey({
      provider: 'openai',
      apiBaseURL: GROQ,
      secretStore: null,
    });
    expect(key).toBe('groq-secret');
  });

  it('lends NO key at all to a loopback runtime', () => {
    // Ollama serves unauthenticated on the user's own machine. Sending it a
    // stored vendor key would put a live credential on the wire — in plaintext,
    // over http, to whatever process happens to hold that port.
    vi.stubEnv('MISTRAL_API_KEY', 'mistral-secret');
    const key = resolveProviderApiKey({
      provider: 'openai',
      apiBaseURL: OLLAMA,
      secretStore: null,
    });
    expect(key).toBeUndefined();
  });

  it('still resolves the Mistral preset from the historic slot (back-compat)', () => {
    vi.stubEnv('MISTRAL_API_KEY', 'mistral-secret');
    expect(resolveProviderApiKey({ provider: 'openai', apiBaseURL: MISTRAL, secretStore: null }))
      .toBe('mistral-secret');
  });

  it('still resolves an unrecognised OpenAI-compatible host from the historic slot', () => {
    // The generic tile is where existing installs live — their key is in
    // MISTRAL_API_KEY and moving it would silently log them out.
    vi.stubEnv('MISTRAL_API_KEY', 'mistral-secret');
    expect(resolveProviderApiKey({
      provider: 'openai',
      apiBaseURL: 'https://some-proxy.example.com/v1',
      secretStore: null,
    })).toBe('mistral-secret');
  });

  it('is unchanged when no endpoint is supplied (legacy callers)', () => {
    vi.stubEnv('MISTRAL_API_KEY', 'mistral-secret');
    expect(resolveProviderApiKey({ provider: 'openai', secretStore: null }))
      .toBe('mistral-secret');
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

describe('resolveProviderApiKey — legacy config.api_key is base-provider gated', () => {
  // The legacy `config.api_key` field has no schema guarantee that it holds an
  // Anthropic key. On a non-Anthropic-base tenant it may hold that provider's
  // key. A keyless cross-Anthropic hybrid slot asking for the anthropic key
  // must NEVER be handed that value — it would go to the Anthropic wire =
  // cross-provider credential leak. The fallback only fires when the tenant's
  // BASE provider is anthropic (undefined = legacy anthropic default).
  beforeEach(() => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('MISTRAL_API_KEY', '');
    vi.stubEnv('CUSTOM_API_KEY', '');
    vi.stubEnv('OPENAI_API_KEY', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('does NOT lend config.api_key to an anthropic slot when the base is openai (leak closed)', () => {
    const result = resolveProviderApiKey({
      provider: 'anthropic',
      secretStore: undefined,
      userConfig: { provider: 'openai', api_key: 'mistral-base-key' },
    });
    // Must be undefined — NOT the Mistral base key. Sending it to the Anthropic
    // endpoint would leak a non-Anthropic credential cross-provider.
    expect(result).toBeUndefined();
    expect(result).not.toBe('mistral-base-key');
  });

  it('does NOT lend config.api_key to an anthropic slot when the base is custom (leak closed)', () => {
    const result = resolveProviderApiKey({
      provider: 'anthropic',
      secretStore: undefined,
      userConfig: { provider: 'custom', api_key: 'custom-proxy-key' },
    });
    expect(result).toBeUndefined();
    expect(result).not.toBe('custom-proxy-key');
  });

  it('DOES lend config.api_key when the base provider is explicitly anthropic (legacy preserved)', () => {
    const result = resolveProviderApiKey({
      provider: 'anthropic',
      secretStore: null,
      userConfig: { provider: 'anthropic', api_key: 'sk-ant' },
    });
    expect(result).toBe('sk-ant');
  });

  it('DOES lend config.api_key when userConfig.provider is undefined (legacy anthropic default preserved)', () => {
    // Historically config.json omitted `provider` for the Anthropic default,
    // so undefined must keep the legacy back-compat behaviour.
    const result = resolveProviderApiKey({
      provider: 'anthropic',
      secretStore: null,
      userConfig: { api_key: 'sk-ant' },
    });
    expect(result).toBe('sk-ant');
  });

  it('env/vault still win over the legacy fallback on an anthropic-base tenant', () => {
    const savedEnv = process.env.ANTHROPIC_API_KEY;
    try {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-from-env-wins';
      const result = resolveProviderApiKey({
        provider: 'anthropic',
        secretStore: { resolve: (n) => (n === 'ANTHROPIC_API_KEY' ? 'sk-ant-from-vault' : null) },
        userConfig: { provider: 'anthropic', api_key: 'sk-ant-legacy-should-lose' },
      });
      expect(result).toBe('sk-ant-from-env-wins');
    } finally {
      if (savedEnv === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = savedEnv;
    }
  });

  it('vault wins over the legacy fallback even with a non-anthropic base (no leak into vault path)', () => {
    // Vault ANTHROPIC_API_KEY is a genuine anthropic key regardless of base, so
    // it is correctly returned; the base-gate only guards the config.api_key leg.
    const result = resolveProviderApiKey({
      provider: 'anthropic',
      secretStore: { resolve: (n) => (n === 'ANTHROPIC_API_KEY' ? 'sk-ant-vault' : null) },
      userConfig: { provider: 'openai', api_key: 'mistral-base-key' },
    });
    expect(result).toBe('sk-ant-vault');
  });

  it('non-anthropic providers never read config.api_key regardless of base (unchanged)', () => {
    // A base-openai tenant asking for its openai key: config.api_key is not a
    // fallback for openai at all — must resolve to undefined when no vault/env.
    const result = resolveProviderApiKey({
      provider: 'openai',
      secretStore: { resolve: () => null },
      userConfig: { provider: 'openai', api_key: 'some-key' },
    });
    expect(result).toBeUndefined();
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
