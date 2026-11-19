/**
 * The Mistral thinking warning is gated on Mistral's host. The preset moved to the EU regional
 * endpoint, and a config written before the move still names the global one: both are Mistral,
 * another OpenAI-compatible host is not.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic { beta = { messages: { stream: vi.fn() } }; }
  class APIError extends Error {}
  return { default: MockAnthropic, APIError };
});
vi.mock('./stream.js', () => ({ StreamProcessor: vi.fn() }));
vi.mock('./observability.js', () => ({
  channels: { cacheHealth: { publish: vi.fn() }, contentTruncation: { hasSubscribers: false, publish: vi.fn() } },
  measureTool: vi.fn().mockReturnValue({ end: () => 0 }),
}));

import { Agent } from './agent.js';

const codes = (apiBaseURL: string): string[] =>
  new Agent({
    name: 'test',
    model: 'mistral-large-2512',
    provider: 'openai',
    apiBaseURL,
    apiKey: 'test-key',
    thinking: { type: 'enabled', budget_tokens: 1024 },
  }).getWarnings().map((w) => w.code);

describe('Mistral thinking warning', () => {
  it.each(['https://api.eu.mistral.ai/v1', 'https://api.mistral.ai/v1'])('warns on %s', (url) => {
    expect(codes(url)).toContain('thinking_not_supported_on_model');
  });

  it('twin: another OpenAI-compatible host gets no Mistral warning', () => {
    expect(codes('https://api.groq.com/openai/v1')).not.toContain('thinking_not_supported_on_model');
  });
});
