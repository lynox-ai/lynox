import { describe, it, expect } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { createLLMClient } from './llm-client.js';
import { OpenAIAdapter } from './openai-adapter.js';

// PR-1b: createLLMClient dispatches on the registry descriptor's wireClient.
// These assert byte-parity with the previous per-provider branches — the same
// client kind is constructed for each provider.
describe('createLLMClient — wire-client dispatch (PR-1b)', () => {
  it('anthropic → real Anthropic client', () => {
    const c = createLLMClient({ provider: 'anthropic', apiKey: 'sk-test' });
    expect(c instanceof Anthropic).toBe(true);
    expect(c instanceof OpenAIAdapter).toBe(false);
  });

  it('custom (Anthropic-compatible proxy) → Anthropic client, not the openai adapter', () => {
    const c = createLLMClient({ provider: 'custom', apiKey: 'sk-test', apiBaseURL: 'https://proxy.example/v1' });
    expect(c instanceof Anthropic).toBe(true);
    expect(c instanceof OpenAIAdapter).toBe(false);
  });

  it('openai → OpenAIAdapter (cast to Anthropic)', () => {
    const c = createLLMClient({
      provider: 'openai',
      apiKey: 'k',
      apiBaseURL: 'https://api.mistral.ai/v1',
      openaiModelId: 'ministral-8b-2512',
    });
    expect(c instanceof OpenAIAdapter).toBe(true);
  });

  it('openai tolerates empty creds at boot (no throw — BYOK signup path)', () => {
    expect(() => createLLMClient({ provider: 'openai' })).not.toThrow();
  });

  it('vertex without init → throws (parity with the old branch)', () => {
    expect(() => createLLMClient({ provider: 'vertex' })).toThrow(/Vertex provider not initialized/);
  });

  it('an unregistered provider key → Anthropic fallback (matches the old else branch)', () => {
    // @ts-expect-error — exercising the unregistered-key fallback at runtime
    const c = createLLMClient({ provider: 'totally-unknown', apiKey: 'sk-test' });
    expect(c instanceof Anthropic).toBe(true);
  });
});
