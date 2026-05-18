import { describe, it, expect, vi } from 'vitest';
import { askSecretTool } from './ask-secret.js';
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
    const promptSecret = vi.fn().mockResolvedValue('managed_blocked');
    const agent = makeAgent({ promptSecret });

    const result = await askSecretTool.handler(
      { name: 'SHOPIFY_TOKEN', prompt: 'Enter Shopify token' },
      agent,
    );
    expect(result).toMatch(/refused/i);
    expect(result).toMatch(/managed hosting/i);
    // Hard guards: no retry, no plaintext.
    expect(result).toMatch(/DO NOT retry ask_secret/i);
    expect(result).toMatch(/DO NOT offer to receive the secret/i);
    // And critically: must NOT use the word "canceled" — that's the bug we
    // shipped this refactor to kill.
    expect(result.toLowerCase()).not.toContain('cancel');
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
