import { describe, it, expect } from 'vitest';
import { LynoxUserConfigSchema } from './schemas.js';

/**
 * Schema-validation tests for surfaces introduced by the Sprint-Review
 * follow-up (PR #407): HttpUrlSchema scheme-allowlist + `.catch([])` fallback
 * for `custom_endpoints`. Locks in the runtime invariants that downstream
 * code (Agent, http-api, vault) relies on so a future schema relaxation
 * trips a test instead of a security regression.
 */
describe('LynoxUserConfigSchema — default_tier back-compat (2026-05-29 rename)', () => {
  it('normalizes legacy Anthropic-brand tier names to provider-agnostic names', () => {
    // Persisted config.json files written before the rename store opus/sonnet/haiku.
    for (const [legacy, canonical] of [['opus', 'deep'], ['sonnet', 'balanced'], ['haiku', 'fast']] as const) {
      const result = LynoxUserConfigSchema.safeParse({ default_tier: legacy });
      expect(result.success).toBe(true);
      expect(result.success && result.data.default_tier).toBe(canonical);
    }
  });

  it('passes canonical names through unchanged', () => {
    for (const tier of ['fast', 'balanced', 'deep'] as const) {
      const result = LynoxUserConfigSchema.safeParse({ default_tier: tier });
      expect(result.success && result.data.default_tier).toBe(tier);
    }
  });

  it('rejects an unknown tier value', () => {
    const result = LynoxUserConfigSchema.safeParse({ default_tier: 'gpt-5' });
    expect(result.success).toBe(false);
  });
});

describe('LynoxUserConfigSchema — balanced_model (Sonnet variant selection)', () => {
  it('preserves a persisted balanced_model through the .strict() schema (not stripped)', () => {
    // Config-field 3-place contract: a value absent from the schema is dropped
    // by .strict(), nulling the whole config on write. Lock that it survives.
    for (const id of ['claude-sonnet-4-6', 'claude-sonnet-5']) {
      const result = LynoxUserConfigSchema.safeParse({ balanced_model: id });
      expect(result.success).toBe(true);
      expect(result.success && result.data.balanced_model).toBe(id);
    }
  });

  it('accepts an arbitrary string (resolveBalancedModel validates + safely defaults)', () => {
    // NOT a z.enum: an unrecognised value must parse (the whole config would
    // otherwise be nulled) and be defaulted downstream, never route off-Sonnet.
    const result = LynoxUserConfigSchema.safeParse({ balanced_model: 'some-future-sonnet' });
    expect(result.success).toBe(true);
  });

  it('rejects an over-long value', () => {
    const result = LynoxUserConfigSchema.safeParse({ balanced_model: 'x'.repeat(65) });
    expect(result.success).toBe(false);
  });
});

describe('LynoxUserConfigSchema — openai_context_window (self-host native window)', () => {
  it('round-trips a positive integer window (self-host openai-compat)', () => {
    const result = LynoxUserConfigSchema.safeParse({ openai_context_window: 262_144 });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.openai_context_window).toBe(262_144);
  });

  it('rejects zero / negative / non-integer / over-cap', () => {
    expect(LynoxUserConfigSchema.safeParse({ openai_context_window: 0 }).success).toBe(false);
    expect(LynoxUserConfigSchema.safeParse({ openai_context_window: -1 }).success).toBe(false);
    expect(LynoxUserConfigSchema.safeParse({ openai_context_window: 1.5 }).success).toBe(false);
    expect(LynoxUserConfigSchema.safeParse({ openai_context_window: 2_000_000 }).success).toBe(false);
  });
});

describe('LynoxUserConfigSchema — http(s) scheme allowlist', () => {
  it('accepts https api_base_url', () => {
    const result = LynoxUserConfigSchema.safeParse({ api_base_url: 'https://api.example.com/v1' });
    expect(result.success).toBe(true);
  });

  it('accepts http api_base_url (self-host LAN endpoints)', () => {
    const result = LynoxUserConfigSchema.safeParse({ api_base_url: 'http://localhost:11434/v1' });
    expect(result.success).toBe(true);
  });

  it('accepts empty string api_base_url (UI clear gesture)', () => {
    const result = LynoxUserConfigSchema.safeParse({ api_base_url: '' });
    expect(result.success).toBe(true);
  });

  it('rejects javascript: api_base_url (XSS / exfil vector)', () => {
    const result = LynoxUserConfigSchema.safeParse({ api_base_url: 'javascript:alert(1)' });
    expect(result.success).toBe(false);
  });

  it('rejects file: api_base_url (local file read)', () => {
    const result = LynoxUserConfigSchema.safeParse({ api_base_url: 'file:///etc/passwd' });
    expect(result.success).toBe(false);
  });

  it('rejects ftp: api_base_url', () => {
    const result = LynoxUserConfigSchema.safeParse({ api_base_url: 'ftp://example.com' });
    expect(result.success).toBe(false);
  });

  it('rejects data: api_base_url', () => {
    const result = LynoxUserConfigSchema.safeParse({ api_base_url: 'data:text/plain,attacker' });
    expect(result.success).toBe(false);
  });

  it('rejects api_base_url over 2KB cap', () => {
    const big = 'https://example.com/' + 'a'.repeat(2050);
    const result = LynoxUserConfigSchema.safeParse({ api_base_url: big });
    expect(result.success).toBe(false);
  });
});

describe('LynoxUserConfigSchema — custom_endpoints', () => {
  it('accepts a well-formed bookmark', () => {
    const result = LynoxUserConfigSchema.safeParse({
      custom_endpoints: [{ id: 'a', name: 'Mistral', base_url: 'https://api.mistral.ai/v1' }],
    });
    expect(result.success).toBe(true);
  });

  it('drops the whole list to [] when a single bookmark is malformed (.catch fallback)', () => {
    // A non-http base_url on one bookmark would otherwise fail the entire
    // PUT — the `.catch([])` keeps the user out of a locked-config state
    // (Settings page wouldn't load) and surfaces the corruption as
    // "no bookmarks visible" instead.
    const result = LynoxUserConfigSchema.safeParse({
      custom_endpoints: [
        { id: 'good', name: 'Valid', base_url: 'https://example.com' },
        { id: 'evil', name: 'XSS', base_url: 'javascript:alert(1)' },
      ],
    });
    expect(result.success).toBe(true);
    expect(result.data?.custom_endpoints).toEqual([]);
  });

  it('rejects bookmark with javascript: scheme in isolation (no .catch nest)', () => {
    // The .catch defends against unparseable data — but the inner refinement
    // still fires. We verify it via the schema's array element schema below.
    const result = LynoxUserConfigSchema.safeParse({
      custom_endpoints: [{ id: 'x', name: 'Y', base_url: 'javascript:1' }],
    });
    // Top-level still succeeds because the array's `.catch([])` swallows it,
    // but the data is now empty — verifies the failure path.
    expect(result.success).toBe(true);
    expect(result.data?.custom_endpoints).toEqual([]);
  });

  it('rejects bookmark id over 128 char cap', () => {
    const result = LynoxUserConfigSchema.safeParse({
      custom_endpoints: [{ id: 'a'.repeat(129), name: 'Y', base_url: 'https://example.com' }],
    });
    expect(result.success).toBe(true);  // .catch([]) swallows; verify drop
    expect(result.data?.custom_endpoints).toEqual([]);
  });

  it('rejects bookmark name over 64 char cap', () => {
    const result = LynoxUserConfigSchema.safeParse({
      custom_endpoints: [{ id: 'x', name: 'a'.repeat(65), base_url: 'https://example.com' }],
    });
    expect(result.success).toBe(true);
    expect(result.data?.custom_endpoints).toEqual([]);
  });
});

describe('LynoxUserConfigSchema — disabled_tools caps (Tool-Toggles)', () => {
  it('accepts a normal disabled-tools list', () => {
    const result = LynoxUserConfigSchema.safeParse({
      disabled_tools: ['web_search', 'http_request'],
    });
    expect(result.success).toBe(true);
  });

  it('accepts an empty list', () => {
    const result = LynoxUserConfigSchema.safeParse({ disabled_tools: [] });
    expect(result.success).toBe(true);
  });

  it('rejects disabled_tools with > 200 entries (DoS / config-bloat cap)', () => {
    const tools = Array.from({ length: 201 }, (_, i) => `tool_${i}`);
    const result = LynoxUserConfigSchema.safeParse({ disabled_tools: tools });
    expect(result.success).toBe(false);
  });

  it('rejects disabled_tools entry over 128 chars', () => {
    const result = LynoxUserConfigSchema.safeParse({
      disabled_tools: ['a'.repeat(129)],
    });
    expect(result.success).toBe(false);
  });

  it('rejects disabled_tools empty string entries', () => {
    const result = LynoxUserConfigSchema.safeParse({
      disabled_tools: [''],
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-array disabled_tools — guards against the session.ts spread crashing on non-iterable', () => {
    const result = LynoxUserConfigSchema.safeParse({
      disabled_tools: 'web_search' as unknown as string[],
    });
    expect(result.success).toBe(false);
  });
});

describe('LynoxUserConfigSchema — bugsink_enabled', () => {
  it('accepts true', () => {
    const result = LynoxUserConfigSchema.safeParse({ bugsink_enabled: true });
    expect(result.success).toBe(true);
  });

  it('accepts false (GDPR opt-out path)', () => {
    const result = LynoxUserConfigSchema.safeParse({ bugsink_enabled: false });
    expect(result.success).toBe(true);
  });

  it('rejects non-boolean (catches type drift between LynoxUserConfig + schema)', () => {
    const result = LynoxUserConfigSchema.safeParse({ bugsink_enabled: 'yes' as unknown as boolean });
    expect(result.success).toBe(false);
  });
});

describe('LynoxUserConfigSchema — update_check', () => {
  it('accepts true (SystemSettings update toggle)', () => {
    const result = LynoxUserConfigSchema.safeParse({ update_check: true });
    expect(result.success).toBe(true);
  });

  it('accepts false', () => {
    const result = LynoxUserConfigSchema.safeParse({ update_check: false });
    expect(result.success).toBe(true);
  });

  it('rejects non-boolean', () => {
    const result = LynoxUserConfigSchema.safeParse({ update_check: 'true' as unknown as boolean });
    expect(result.success).toBe(false);
  });
});

describe('LynoxUserConfigSchema — strict mode (PRD-IA-V2 P1-PR-A2)', () => {
  it('rejects GET-response-only field `capabilities` — prevents BackupsView-style ghost-writes', () => {
    const result = LynoxUserConfigSchema.safeParse({ capabilities: { mistral_available: true } });
    expect(result.success).toBe(false);
  });

  it('rejects GET-response-only field `locks`', () => {
    const result = LynoxUserConfigSchema.safeParse({ locks: { provider: { reason: 'managed-tier' } } });
    expect(result.success).toBe(false);
  });

  it('rejects GET-response-only field `managed` (tier indicator)', () => {
    const result = LynoxUserConfigSchema.safeParse({ managed: 'managed' });
    expect(result.success).toBe(false);
  });

  it('rejects GET-response-only field `bugsink_dsn_configured`', () => {
    const result = LynoxUserConfigSchema.safeParse({ bugsink_dsn_configured: true });
    expect(result.success).toBe(false);
  });

  it('rejects `${key}_configured` redaction-mirror fields', () => {
    expect(LynoxUserConfigSchema.safeParse({ api_key_configured: true }).success).toBe(false);
    expect(LynoxUserConfigSchema.safeParse({ search_api_key_configured: true }).success).toBe(false);
    expect(LynoxUserConfigSchema.safeParse({ google_client_id_configured: true }).success).toBe(false);
  });

  it('rejects arbitrary unknown fields (forward-compat ghost-write surface closed)', () => {
    const result = LynoxUserConfigSchema.safeParse({ totally_made_up_field: 42 });
    expect(result.success).toBe(false);
  });

  it('still accepts a real settings payload (no false-positive on the happy path)', () => {
    const result = LynoxUserConfigSchema.safeParse({
      provider: 'anthropic',
      default_tier: 'balanced',
      effort_level: 'high',
      thinking_mode: 'adaptive',
      experience: 'business',
      memory_extraction: true,
      update_check: true,
      max_session_cost_usd: 50,
      bugsink_enabled: false,
    });
    expect(result.success).toBe(true);
  });
});

describe('LynoxUserConfigSchema — max_context_window_tokens', () => {
  it('accepts the three UI radio values (200k / 500k / 1M)', () => {
    for (const v of [200_000, 500_000, 1_000_000]) {
      const result = LynoxUserConfigSchema.safeParse({ max_context_window_tokens: v });
      expect(result.success).toBe(true);
    }
  });

  it('rejects zero / negative — agent treats undefined as "no cap", not 0 as "infinite trim"', () => {
    expect(LynoxUserConfigSchema.safeParse({ max_context_window_tokens: 0 }).success).toBe(false);
    expect(LynoxUserConfigSchema.safeParse({ max_context_window_tokens: -1 }).success).toBe(false);
  });

  it('rejects non-integer', () => {
    expect(LynoxUserConfigSchema.safeParse({ max_context_window_tokens: 200_000.5 }).success).toBe(false);
  });

  it('accepts the 1M upper-bound exactly (PRD-IA-V2 P3-PR-C Security S3)', () => {
    const result = LynoxUserConfigSchema.safeParse({ max_context_window_tokens: 1_000_000 });
    expect(result.success).toBe(true);
  });

  it('rejects values above 1M — blocks unbounded-window DoS on Managed (Security S3)', () => {
    // An attacker on a managed instance with the field in MANAGED_USER_WRITABLE_CONFIG
    // could otherwise force multi-million-token reads per turn (memory + cost DoS).
    const result = LynoxUserConfigSchema.safeParse({ max_context_window_tokens: 1_000_001 });
    expect(result.success).toBe(false);
  });
});

describe('LynoxUserConfigSchema — settable tier/profile fields survive .strict()', () => {
  // These 4 fields live on the LynoxUserConfig interface AND are set via env
  // (LYNOX_MAX_TIER / LYNOX_ACCOUNT_TIER / LYNOX_WORKER_PROFILE /
  // LYNOX_MODEL_PROFILES_JSON). If they are absent from the `.strict()` schema
  // they are unknown keys — `.strict()` rejects the whole object, so persisting
  // any one of them nulls the ENTIRE config (every other setting dropped).
  it('preserves account_tier / max_tier / worker_profile / model_profiles through a parse', () => {
    const input = {
      account_tier: 'pro' as const,
      max_tier: 'deep' as const,
      worker_profile: 'mistral-fast',
      model_profiles: {
        'mistral-fast': {
          provider: 'openai' as const,
          api_base_url: 'https://api.mistral.ai/v1',
          api_key: 'sk-test',
          model_id: 'ministral-8b-2512',
        },
      },
    };
    const result = LynoxUserConfigSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.account_tier).toBe('pro');
      expect(result.data.max_tier).toBe('deep');
      expect(result.data.worker_profile).toBe('mistral-fast');
      expect(result.data.model_profiles?.['mistral-fast']?.model_id).toBe('ministral-8b-2512');
    }
  });

  it('does NOT strip sibling fields when one of the 4 is present (the corruption path)', () => {
    // The regression: writing `worker_profile` used to make `.strict()` reject
    // the payload, so the config write nulled provider/default_tier/etc.
    const result = LynoxUserConfigSchema.safeParse({
      provider: 'anthropic' as const,
      default_tier: 'balanced' as const,
      max_session_cost_usd: 50,
      worker_profile: 'mistral-fast',
      account_tier: 'standard' as const,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.provider).toBe('anthropic');
      expect(result.data.default_tier).toBe('balanced');
      expect(result.data.max_session_cost_usd).toBe(50);
      expect(result.data.worker_profile).toBe('mistral-fast');
    }
  });

  it('normalizes a legacy Anthropic-brand max_tier (opus → deep)', () => {
    const result = LynoxUserConfigSchema.safeParse({ max_tier: 'opus' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.max_tier).toBe('deep');
  });

  it('rejects an invalid account_tier value', () => {
    expect(LynoxUserConfigSchema.safeParse({ account_tier: 'enterprise' }).success).toBe(false);
  });

  it('rejects a model_profiles entry with a non-openai provider', () => {
    const result = LynoxUserConfigSchema.safeParse({
      model_profiles: { bad: { provider: 'anthropic', api_base_url: 'x', api_key: 'y', model_id: 'z' } },
    });
    expect(result.success).toBe(false);
  });
});

describe('LynoxUserConfigSchema — accepted_custom_endpoints (W3 server-persisted disclosure)', () => {
  it('accepts an array of {host, accepted_at} records', () => {
    const result = LynoxUserConfigSchema.safeParse({
      accepted_custom_endpoints: [{ host: 'my-litellm.example.com', accepted_at: '2026-06-07T12:00:00.000Z' }],
    });
    expect(result.success).toBe(true);
  });

  it('gently degrades a malformed record to [] instead of bricking config-load', () => {
    // Same `.catch([])` contract as custom_endpoints — a hand-edited config
    // with a bad acceptance row must not lock the user out of Settings.
    const result = LynoxUserConfigSchema.safeParse({
      accepted_custom_endpoints: [{ host: 123, accepted_at: null }],
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.accepted_custom_endpoints).toEqual([]);
  });
});
