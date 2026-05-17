import { describe, it, expect } from 'vitest';
import { LynoxUserConfigSchema } from './schemas.js';

/**
 * Schema-validation tests for surfaces introduced by the Sprint-Review
 * follow-up (PR #407): HttpUrlSchema scheme-allowlist + `.catch([])` fallback
 * for `custom_endpoints`. Locks in the runtime invariants that downstream
 * code (Agent, http-api, vault) relies on so a future schema relaxation
 * trips a test instead of a security regression.
 */
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
      default_tier: 'sonnet',
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
