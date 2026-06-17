import { describe, it, expect } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { createLLMClient, clientForTierSnapshot } from './llm-client.js';
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

// PR-3b: the per-slot client for a resolved tier snapshot — the end-to-end half
// of hybrid. Reuses the ambient client when the slot changes nothing; builds a
// dedicated client when the slot changes the provider or carries its own creds.
describe('clientForTierSnapshot — per-slot hybrid client (PR-3b)', () => {
  const ambient = new Anthropic({ apiKey: 'ambient-key' });

  it('a standard/base snapshot (same provider, no creds) reuses the ambient client', () => {
    const snap = { provider: 'anthropic', modelId: 'claude-haiku-4-5-20251001' };
    expect(clientForTierSnapshot(snap, ambient, 'anthropic')).toBe(ambient);
  });

  it('a credless same-provider slot reuses ambient (no default-env-key fallback)', () => {
    const snap = { provider: 'anthropic', modelId: 'claude-opus-4-6' };
    expect(clientForTierSnapshot(snap, ambient, 'anthropic')).toBe(ambient);
  });

  it('a slot that changes the provider builds a dedicated client', () => {
    const snap = {
      provider: 'mistral',
      modelId: 'ministral-8b-2512',
      apiKey: 'slot-key',
      apiBaseURL: 'https://api.mistral.ai/v1',
    };
    const c = clientForTierSnapshot(snap, ambient, 'anthropic');
    expect(c).not.toBe(ambient);
    expect(c instanceof OpenAIAdapter).toBe(true);
  });

  it('a same-provider slot WITH its own key builds a dedicated client', () => {
    const snap = { provider: 'anthropic', modelId: 'claude-opus-4-6', apiKey: 'slot-key' };
    const c = clientForTierSnapshot(snap, ambient, 'anthropic');
    expect(c).not.toBe(ambient);
    expect(c instanceof Anthropic).toBe(true);
  });
});
