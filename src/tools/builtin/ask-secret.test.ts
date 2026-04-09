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
    const promptSecret = vi.fn().mockResolvedValue(true);
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
    const promptSecret = vi.fn().mockResolvedValue(true);
    const agent = makeAgent({ promptSecret });

    await askSecretTool.handler(
      { name: 'OPENAI_KEY', prompt: 'Enter key', key_type: 'openai' },
      agent,
    );
    expect(promptSecret).toHaveBeenCalledWith('OPENAI_KEY', 'Enter key', 'openai');
  });

  it('returns cancel message when user cancels', async () => {
    const promptSecret = vi.fn().mockResolvedValue(false);
    const agent = makeAgent({ promptSecret });

    const result = await askSecretTool.handler(
      { name: 'MY_KEY', prompt: 'Enter key' },
      agent,
    );
    expect(result).toContain('canceled');
  });

  it('returns fallback when promptSecret is undefined', async () => {
    const agent = makeAgent();
    const result = await askSecretTool.handler(
      { name: 'MY_KEY', prompt: 'Enter key' },
      agent,
    );
    expect(result).toContain('not available');
    expect(result).toContain('Settings');
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
    const promptSecret = vi.fn().mockResolvedValue(true);
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
    const promptSecret = vi.fn().mockResolvedValue(true);
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
