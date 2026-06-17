import { describe, it, expect } from 'vitest';
import { buildPromptCacheKey, shouldSendPromptCacheKey } from './prompt-cache-key.js';

describe('buildPromptCacheKey (PR-3c)', () => {
  it('combines thread id + agent name for a per-thread key', () => {
    expect(buildPromptCacheKey('thread-123', 'main')).toBe('thread-123:main');
  });

  it('falls back to the agent name when there is no thread', () => {
    expect(buildPromptCacheKey(undefined, 'researcher')).toBe('researcher');
  });

  it('distinguishes sub-agents within the same thread', () => {
    expect(buildPromptCacheKey('t1', 'main')).not.toBe(buildPromptCacheKey('t1', 'spawn-a'));
  });

  it('is stable for the same thread + agent (cache reuse across turns)', () => {
    expect(buildPromptCacheKey('t1', 'main')).toBe(buildPromptCacheKey('t1', 'main'));
  });
});

describe('shouldSendPromptCacheKey (PR-3c gate)', () => {
  it('sends for openai-wire providers (their client is the OpenAIAdapter)', () => {
    expect(shouldSendPromptCacheKey('openai')).toBe(true);
    expect(shouldSendPromptCacheKey('mistral')).toBe(true);
  });

  it('does NOT send for custom — it is Anthropic-wire (real Anthropic SDK), not the adapter', () => {
    expect(shouldSendPromptCacheKey('custom')).toBe(false);
  });

  it('does NOT send for anthropic or vertex (explicit cache_control instead)', () => {
    expect(shouldSendPromptCacheKey('anthropic')).toBe(false);
    expect(shouldSendPromptCacheKey('vertex')).toBe(false);
  });

  it('does NOT send for an unregistered provider', () => {
    expect(shouldSendPromptCacheKey('unknown-x')).toBe(false);
  });
});
