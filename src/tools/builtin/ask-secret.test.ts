import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { askSecretTool } from './ask-secret.js';
import { SecretStore } from '../../core/secret-store.js';
import type { IAgent } from '../../types/index.js';

function makeAgent(overrides: Partial<IAgent> = {}): IAgent {
  return {
    name: 'test',
    model: 'test-model',
    memory: null,
    tools: [],
    onStream: null,
    ...overrides,
  } as IAgent;
}

describe('askSecretTool', () => {
  it('calls promptSecret and returns success message', async () => {
    const promptSecret = vi.fn().mockResolvedValue('saved');
    const agent = makeAgent({ promptSecret });

    const result = await askSecretTool.handler(
      { name: 'STRIPE_API_KEY', prompt: 'Enter your Stripe key' },
      agent,
    );
    expect(result).toContain('saved securely');
    expect(result).toContain('secret:STRIPE_API_KEY');
    expect(promptSecret).toHaveBeenCalledWith('STRIPE_API_KEY', 'Enter your Stripe key', undefined);
  });

  it('passes key_type to promptSecret', async () => {
    const promptSecret = vi.fn().mockResolvedValue('saved');
    const agent = makeAgent({ promptSecret });

    await askSecretTool.handler(
      { name: 'OPENAI_KEY', prompt: 'Enter key', key_type: 'openai' },
      agent,
    );
    expect(promptSecret).toHaveBeenCalledWith('OPENAI_KEY', 'Enter key', 'openai');
  });

  it('returns cancel message AND a hard guard against plaintext fallback', async () => {
    const promptSecret = vi.fn().mockResolvedValue('canceled');
    const agent = makeAgent({ promptSecret });

    const result = await askSecretTool.handler(
      { name: 'MY_KEY', prompt: 'Enter key' },
      agent,
    );
    expect(result).toContain('canceled');
    // The whole point of the v29 refactor — these guards must appear in the
    // tool result so the model is told, not just hoped, not to fall back.
    expect(result).toMatch(/DO NOT offer a plaintext fallback/i);
    expect(result).toMatch(/vault flow is the only way/i);
  });

  it('returns a distinct message for managed_blocked (NOT a cancel)', async () => {
    // 2026-05-18 inversion: managed_blocked now only fires for admin-only
    // infrastructure names (LYNOX_*, MAIL_ACCOUNT_*, etc.) — Shopify/Stripe/
    // etc. pass freely. The tool result text now reflects that boundary:
    // "this is infrastructure / channel-managed, not a tier restriction".
    const promptSecret = vi.fn().mockResolvedValue('managed_blocked');
    const agent = makeAgent({ promptSecret });

    const result = await askSecretTool.handler(
      { name: 'LYNOX_HTTP_SECRET', prompt: 'Enter engine HTTP secret' },
      agent,
    );
    expect(result).toMatch(/rejected/i);
    expect(result).toMatch(/infrastructure|engine|channel/i);
    // Hard guards: no retry-with-same-name, no plaintext.
    expect(result).toMatch(/do ?not retry|don't retry/i);
    expect(result).toMatch(/plaintext fallback/i);
    // Must NOT include "User canceled" — different outcome path.
    expect(result).not.toMatch(/user canceled/i);
    // The previous leak-bug: tool result must NOT name the (now-retired)
    // allowlist or the specific LLM providers, in case the agent paraphrases.
    expect(result).not.toMatch(/Anthropic\s*\/\s*OpenAI\s*\/\s*Mistral/);
    expect(result).not.toMatch(/BYOK/i);
    expect(result).not.toMatch(/user-writable/i);
    expect(result).not.toMatch(/writable secrets/i);
    // Don't lecture about tier or managed-vs-self-host (the gating axis is
    // now name-shape, not tier). Guard against accidental re-introduction.
    expect(result).not.toMatch(/your managed plan|on your tier/i);
    // Should clue the agent that if the user wanted an integration, the
    // name was probably misaligned — propose a corrected one and retry.
    expect(result).toMatch(/(integration|corrected name|propose)/i);
  });

  it('returns a distinct message for vault_error (NOT a cancel)', async () => {
    const promptSecret = vi.fn().mockResolvedValue('vault_error');
    const agent = makeAgent({ promptSecret });

    const result = await askSecretTool.handler(
      { name: 'MY_KEY', prompt: 'Enter key' },
      agent,
    );
    expect(result).toMatch(/server-side error/i);
    expect(result).toMatch(/NOT a user cancel/i);
    expect(result).toMatch(/DO NOT offer a plaintext fallback/i);
  });

  it('returns fallback when promptSecret is undefined — and warns against chat', async () => {
    const agent = makeAgent();
    const result = await askSecretTool.handler(
      { name: 'MY_KEY', prompt: 'Enter key' },
      agent,
    );
    expect(result).toContain('not available');
    expect(result).toContain('Settings');
    // Even when the secure path is unavailable, the model must not ask for
    // the secret in chat.
    expect(result).toMatch(/Do NOT ask the user to paste the secret into chat/i);
  });

  it('rejects invalid secret names', async () => {
    const promptSecret = vi.fn();
    const agent = makeAgent({ promptSecret });

    const result = await askSecretTool.handler(
      { name: 'invalid-name', prompt: 'Enter key' },
      agent,
    );
    expect(result).toContain('Error');
    expect(result).toContain('UPPER_SNAKE_CASE');
    expect(promptSecret).not.toHaveBeenCalled();
  });

  it('rejects names starting with a digit', async () => {
    const promptSecret = vi.fn();
    const agent = makeAgent({ promptSecret });

    const result = await askSecretTool.handler(
      { name: '1BAD_NAME', prompt: 'Enter key' },
      agent,
    );
    expect(result).toContain('Error');
    expect(promptSecret).not.toHaveBeenCalled();
  });

  it('accepts valid UPPER_SNAKE_CASE names', async () => {
    const promptSecret = vi.fn().mockResolvedValue('saved');
    const agent = makeAgent({ promptSecret });

    for (const name of ['API_KEY', 'STRIPE_API_KEY', 'X', 'MY_TOKEN_123']) {
      const result = await askSecretTool.handler(
        { name, prompt: 'Enter key' },
        agent,
      );
      expect(result).toContain('saved securely');
    }
  });

  it('never returns the secret value itself', async () => {
    const secret = 'sk-ant-super-secret-key-12345';
    const promptSecret = vi.fn().mockResolvedValue('saved');
    const agent = makeAgent({ promptSecret });

    const result = await askSecretTool.handler(
      { name: 'TEST_KEY', prompt: 'Enter key' },
      agent,
    );
    // The result should never contain the actual secret value
    expect(result).not.toContain(secret);
    expect(result).toContain('saved securely');
  });
});

describe('askSecretTool — discovery + reconciliation (DEF-vault-name-discovery)', () => {
  const cleanSecretEnv = (): void => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('LYNOX_SECRET_')) delete process.env[key];
    }
  };
  beforeEach(cleanSecretEnv);
  afterEach(cleanSecretEnv);

  it('reconciles a near-identical requested name instead of collecting a duplicate (ZAI/Z_AI)', async () => {
    process.env['LYNOX_SECRET_ZAI_API_KEY'] = 'sk-zai-secretvalue';
    const promptSecret = vi.fn().mockResolvedValue('saved');
    const agent = makeAgent({ promptSecret, secretStore: new SecretStore() });

    const result = await askSecretTool.handler(
      { name: 'Z_AI_API_KEY', prompt: 'Enter your z.ai key' },
      agent,
    );
    // The loop is dead: the agent is pointed at the existing name, not re-prompted.
    expect(result).toContain('ZAI_API_KEY');
    expect(result).toContain('secret:ZAI_API_KEY');
    expect(promptSecret).not.toHaveBeenCalled();
    expect(result).not.toContain('sk-zai-secretvalue'); // value never surfaces
  });

  it('collects a same-VENDOR-namespace second key (hint, NOT hard-block) — DATAFORSEO class', async () => {
    // DATAFORSEO_API_LOGIN is potentially a DISTINCT credential from a stored
    // DATAFORSEO_B64 (same vendor, no normalize-collision). The vendor namespace
    // legitimately holds more than one key, so we surface the sibling as a non-blocking
    // hint on the prompt and STILL collect — a hard block here would dead-end a genuine
    // second key. (If it IS the same credential, the hint tells the user to cancel and
    // reference the existing one.)
    process.env['LYNOX_SECRET_DATAFORSEO_B64'] = 'base64-creds-value';
    const promptSecret = vi.fn().mockResolvedValue('saved');
    const agent = makeAgent({ promptSecret, secretStore: new SecretStore() });

    const result = await askSecretTool.handler(
      { name: 'DATAFORSEO_API_LOGIN', prompt: 'Enter DataForSEO login' },
      agent,
    );
    expect(promptSecret).toHaveBeenCalledTimes(1); // collected, not dead-ended
    // the sibling is surfaced as a non-blocking hint appended to the prompt
    expect(promptSecret.mock.calls[0]?.[1]).toContain('DATAFORSEO_B64');
    expect(result).toContain('saved securely');
    expect(result).not.toContain('base64-creds-value'); // value never surfaces
  });

  it('collects a legitimate second same-vendor key (AWS id → secret) instead of dead-ending', async () => {
    // Regression (release-review v2.8.0): the vendor-namespace reconcile used to
    // HARD-BLOCK ANY second key sharing the leading token, so AWS_SECRET_ACCESS_KEY after
    // a stored AWS_ACCESS_KEY_ID (the canonical AWS pair) could never be stored by the
    // agent — and it was tempted to reference the WRONG existing key. It must collect the
    // NEW key while hinting at the sibling.
    process.env['LYNOX_SECRET_AWS_ACCESS_KEY_ID'] = 'AKIAEXAMPLE';
    const promptSecret = vi.fn().mockResolvedValue('saved');
    const agent = makeAgent({ promptSecret, secretStore: new SecretStore() });

    const result = await askSecretTool.handler(
      { name: 'AWS_SECRET_ACCESS_KEY', prompt: 'Enter your AWS secret access key' },
      agent,
    );
    expect(promptSecret).toHaveBeenCalledTimes(1);
    expect(promptSecret.mock.calls[0]?.[0]).toBe('AWS_SECRET_ACCESS_KEY'); // the NEW key
    expect(promptSecret.mock.calls[0]?.[1]).toContain('AWS_ACCESS_KEY_ID'); // sibling hinted
    expect(result).toContain('saved securely');
  });

  it('still HARD-BLOCKS an exact-normalized duplicate under a different spelling (ZAI/Z_AI)', async () => {
    // The exact-match dedup path must survive the vendor-second-key relaxation:
    // Z_AI_API_KEY normalizes to the stored ZAI_API_KEY → collecting would duplicate it.
    process.env['LYNOX_SECRET_ZAI_API_KEY'] = 'sk-zai-secretvalue';
    const promptSecret = vi.fn().mockResolvedValue('saved');
    const agent = makeAgent({ promptSecret, secretStore: new SecretStore() });

    const result = await askSecretTool.handler(
      { name: 'Z_AI_API_KEY', prompt: 'Enter your z.ai key' },
      agent,
    );
    expect(promptSecret).not.toHaveBeenCalled(); // hard-blocked (duplicate)
    expect(result).toContain('secret:ZAI_API_KEY');
  });

  it('still collects when the requested name matches an existing one exactly (overwrite path)', async () => {
    process.env['LYNOX_SECRET_STRIPE_API_KEY'] = 'sk-old';
    const promptSecret = vi.fn().mockResolvedValue('saved');
    const agent = makeAgent({ promptSecret, secretStore: new SecretStore() });

    await askSecretTool.handler({ name: 'STRIPE_API_KEY', prompt: 'Re-enter' }, agent);
    expect(promptSecret).toHaveBeenCalledWith('STRIPE_API_KEY', 'Re-enter', undefined);
  });

  it('action:"list" surfaces stored names + masked values, never plaintext or infra names', async () => {
    process.env['LYNOX_SECRET_ZAI_API_KEY'] = 'sk-zai-secretvalue';
    process.env['LYNOX_SECRET_MAIL_ACCOUNT_SHOP'] = 'infra-cred'; // infra → must not appear
    const agent = makeAgent({ secretStore: new SecretStore() });

    const result = await askSecretTool.handler({ action: 'list' }, agent);
    expect(result).toContain('ZAI_API_KEY');
    expect(result).not.toContain('sk-zai-secretvalue'); // no plaintext value
    expect(result).not.toContain('MAIL_ACCOUNT_SHOP'); // infra excluded
  });

  it('action:"list" reports an empty vault cleanly', async () => {
    const agent = makeAgent({ secretStore: new SecretStore() });
    const result = await askSecretTool.handler({ action: 'list' }, agent);
    expect(result).toContain('No secrets');
  });

  it('collect still errors clearly when name/prompt are missing', async () => {
    const agent = makeAgent({ secretStore: new SecretStore() });
    const result = await askSecretTool.handler({ action: 'collect' }, agent);
    expect(result).toContain('needs both');
  });
});
