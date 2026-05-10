import { describe, expect, it, vi } from 'vitest';
import { type AnthropicLike, DEFAULT_MAX_TOKENS, wrapAnthropicAsLLMCaller } from './llm.js';

interface FakeReply {
  content: ReadonlyArray<{ type: string; text?: string }>;
}

function makeClient(reply: FakeReply): { client: AnthropicLike; create: ReturnType<typeof vi.fn> } {
  const create = vi.fn(async () => reply);
  return {
    client: { messages: { create } } as unknown as AnthropicLike,
    create,
  };
}

describe('wrapAnthropicAsLLMCaller', () => {
  it('forwards model + system + user + max_tokens to the SDK', async () => {
    const { client, create } = makeClient({
      content: [{ type: 'text', text: '{"bucket":"auto_handled","confidence":0.9,"one_line_why_de":"k"}' }],
    });
    const caller = wrapAnthropicAsLLMCaller(client, 'claude-haiku-x', { maxTokens: 64 });
    const out = await caller({ system: 'sys', user: 'usr' });
    expect(out).toBe('{"bucket":"auto_handled","confidence":0.9,"one_line_why_de":"k"}');
    expect(create).toHaveBeenCalledTimes(1);
    const [params] = create.mock.calls[0]!;
    expect(params).toEqual({
      model: 'claude-haiku-x',
      max_tokens: 64,
      system: 'sys',
      messages: [{ role: 'user', content: 'usr' }],
    });
  });

  it('uses DEFAULT_MAX_TOKENS when none provided', async () => {
    const { client, create } = makeClient({
      content: [{ type: 'text', text: '{}' }],
    });
    await wrapAnthropicAsLLMCaller(client, 'm')({ system: 's', user: 'u' });
    expect(create.mock.calls[0]![0].max_tokens).toBe(DEFAULT_MAX_TOKENS);
  });

  it('forwards the abort signal as a request option', async () => {
    const { client, create } = makeClient({ content: [{ type: 'text', text: '{}' }] });
    const controller = new AbortController();
    await wrapAnthropicAsLLMCaller(client, 'm')({ system: 's', user: 'u', signal: controller.signal });
    expect(create.mock.calls[0]![1]).toEqual({ signal: controller.signal });
  });

  it('joins multiple text blocks and skips non-text blocks', async () => {
    const { client } = makeClient({
      content: [
        { type: 'text', text: '{"bucket":' },
        { type: 'tool_use' },
        { type: 'text', text: '"requires_user","confidence":0.8,"one_line_why_de":"x"}' },
      ],
    });
    const out = await wrapAnthropicAsLLMCaller(client, 'm')({ system: 's', user: 'u' });
    expect(out).toBe('{"bucket":"requires_user","confidence":0.8,"one_line_why_de":"x"}');
  });

  it('returns an empty string when there are no text blocks', async () => {
    const { client } = makeClient({ content: [{ type: 'tool_use' }] });
    const out = await wrapAnthropicAsLLMCaller(client, 'm')({ system: 's', user: 'u' });
    expect(out).toBe('');
  });

  it('lets SDK errors propagate to the caller', async () => {
    const create = vi.fn(async () => {
      throw new Error('rate_limited');
    });
    const client = { messages: { create } } as unknown as AnthropicLike;
    await expect(
      wrapAnthropicAsLLMCaller(client, 'm')({ system: 's', user: 'u' }),
    ).rejects.toThrow('rate_limited');
  });
});
