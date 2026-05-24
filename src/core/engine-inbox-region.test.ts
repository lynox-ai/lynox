import { describe, it, expect } from 'vitest';
import { resolveInboxLlmRegion } from './engine.js';

describe('resolveInboxLlmRegion — EU residency from user provider choice', () => {
  it('honors LYNOX_INBOX_LLM_REGION=eu override regardless of provider', () => {
    expect(resolveInboxLlmRegion({
      envOverride: 'eu',
      provider: 'anthropic',
      apiBaseURL: undefined,
    })).toBe('eu');
  });

  it('honors LYNOX_INBOX_LLM_REGION=us override regardless of provider', () => {
    expect(resolveInboxLlmRegion({
      envOverride: 'us',
      provider: 'openai',
      apiBaseURL: 'https://api.mistral.ai/v1',
    })).toBe('us');
  });

  it('defaults Mistral users to EU (no env override needed) — fixes leak', () => {
    expect(resolveInboxLlmRegion({
      envOverride: undefined,
      provider: 'openai',
      apiBaseURL: 'https://api.mistral.ai/v1',
    })).toBe('eu');
  });

  it('defaults Anthropic users to US', () => {
    expect(resolveInboxLlmRegion({
      envOverride: undefined,
      provider: 'anthropic',
      apiBaseURL: undefined,
    })).toBe('us');
  });

  it('does NOT imply EU for non-Mistral openai-compat baseURLs', () => {
    expect(resolveInboxLlmRegion({
      envOverride: undefined,
      provider: 'openai',
      apiBaseURL: 'https://api.openai.com/v1',
    })).toBe('us');
    expect(resolveInboxLlmRegion({
      envOverride: undefined,
      provider: 'openai',
      apiBaseURL: 'https://localhost:11434/v1',
    })).toBe('us');
  });

  it('treats missing provider as US', () => {
    expect(resolveInboxLlmRegion({
      envOverride: undefined,
      provider: undefined,
      apiBaseURL: undefined,
    })).toBe('us');
  });

  it('honors invalid env values as no-override (falls back to provider inference)', () => {
    expect(resolveInboxLlmRegion({
      envOverride: 'EU', // uppercase: not 'eu' exactly → treated as no-override
      provider: 'openai',
      apiBaseURL: 'https://api.mistral.ai/v1',
    })).toBe('eu'); // falls through to provider inference, which is EU
  });
});
