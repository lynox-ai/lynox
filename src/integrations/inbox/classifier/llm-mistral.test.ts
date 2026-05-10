import { describe, expect, it, vi } from 'vitest';
import {
  createMistralEuLLMCaller,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MISTRAL_BASE_URL,
  DEFAULT_MISTRAL_MODEL,
} from './llm-mistral.js';

function fakeFetch(reply: { ok: boolean; status?: number; statusText?: string; body?: unknown; text?: string }): typeof fetch {
  return vi.fn(async () => ({
    ok: reply.ok,
    status: reply.status ?? (reply.ok ? 200 : 500),
    statusText: reply.statusText ?? '',
    json: async () => reply.body ?? {},
    text: async () => reply.text ?? '',
  })) as unknown as typeof fetch;
}

describe('createMistralEuLLMCaller', () => {
  it('throws when apiKey is missing', () => {
    expect(() => createMistralEuLLMCaller({ apiKey: '' })).toThrow(/apiKey is required/);
  });

  it('POSTs to api.mistral.ai/v1/chat/completions with bearer auth and JSON body', async () => {
    const fetchImpl = fakeFetch({
      ok: true,
      body: {
        choices: [{ message: { content: '{"bucket":"auto_handled","confidence":0.9,"one_line_why_de":"k"}' } }],
        usage: { prompt_tokens: 312, completion_tokens: 41 },
      },
    });
    const caller = createMistralEuLLMCaller({ apiKey: 'test-key', fetchImpl });
    const out = await caller({ system: 'sys', user: 'usr' });
    expect(out).toContain('"bucket":"auto_handled"');
    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[0]).toBe(`${DEFAULT_MISTRAL_BASE_URL}/chat/completions`);
    const init = call[1] as RequestInit;
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer test-key');
    expect(headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body['model']).toBe(DEFAULT_MISTRAL_MODEL);
    expect(body['max_tokens']).toBe(DEFAULT_MAX_TOKENS);
    expect(body['response_format']).toEqual({ type: 'json_object' });
    expect(body['messages']).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'usr' },
    ]);
  });

  it('forwards onUsage with Mistral-shaped usage fields', async () => {
    const onUsage = vi.fn();
    const fetchImpl = fakeFetch({
      ok: true,
      body: { choices: [{ message: { content: '{}' } }], usage: { prompt_tokens: 99, completion_tokens: 7 } },
    });
    await createMistralEuLLMCaller({ apiKey: 'k', onUsage, fetchImpl })({ system: 's', user: 'u' });
    expect(onUsage).toHaveBeenCalledWith({ inputTokens: 99, outputTokens: 7 });
  });

  it('throws a sanitized error on non-2xx responses', async () => {
    const fetchImpl = fakeFetch({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
      text: 'rate limit exceeded',
    });
    await expect(
      createMistralEuLLMCaller({ apiKey: 'k', fetchImpl })({ system: 's', user: 'u' }),
    ).rejects.toThrow(/Mistral 429: rate limit exceeded/);
  });

  it('forwards an abort signal as the request signal', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.signal).toBeDefined();
      return {
        ok: true,
        status: 200,
        statusText: '',
        json: async () => ({ choices: [{ message: { content: '{}' } }] }),
        text: async () => '',
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const controller = new AbortController();
    await createMistralEuLLMCaller({ apiKey: 'k', fetchImpl })({ system: 's', user: 'u', signal: controller.signal });
    expect(fetchImpl).toHaveBeenCalled();
  });

  it('honors modelId, baseURL, and maxTokens overrides', async () => {
    const fetchImpl = fakeFetch({
      ok: true,
      body: { choices: [{ message: { content: '{}' } }] },
    });
    await createMistralEuLLMCaller({
      apiKey: 'k',
      modelId: 'mistral-medium-latest',
      baseURL: 'https://eu-private.example.com/v1/',
      maxTokens: 64,
      fetchImpl,
    })({ system: 's', user: 'u' });
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe('https://eu-private.example.com/v1/chat/completions');
    const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
    expect(body['model']).toBe('mistral-medium-latest');
    expect(body['max_tokens']).toBe(64);
  });
});
