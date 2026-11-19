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

  it('defaults Mistral users on the EU regional endpoint to EU (no env override needed) — fixes leak', () => {
    expect(resolveInboxLlmRegion({
      envOverride: undefined,
      provider: 'openai',
      apiBaseURL: 'https://api.eu.mistral.ai/v1',
    })).toBe('eu');
  });

  // Mistral commits to no inference location for its global endpoint, so it must not switch off
  // the warning and the production gate that 'us' carries.
  it('treats Mistral\'s global endpoint as US: no location is committed there', () => {
    expect(resolveInboxLlmRegion({
      envOverride: undefined,
      provider: 'openai',
      apiBaseURL: 'https://api.mistral.ai/v1',
    })).toBe('us');
  });

  it('treats another mistral.ai subdomain as US', () => {
    expect(resolveInboxLlmRegion({
      envOverride: undefined,
      provider: 'openai',
      apiBaseURL: 'https://api.us.mistral.ai/v1',
    })).toBe('us');
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

  it('treats empty-string envOverride as no-override', () => {
    expect(resolveInboxLlmRegion({
      envOverride: '',
      provider: 'anthropic',
      apiBaseURL: undefined,
    })).toBe('us');
  });

  it('treats uppercase EU as no-override (strict-match contract)', () => {
    expect(resolveInboxLlmRegion({
      envOverride: 'EU',
      provider: 'anthropic',
      apiBaseURL: undefined,
    })).toBe('us');
  });

  it('rejects attacker-controlled subdomain that substring-matches mistral hostname', () => {
    expect(resolveInboxLlmRegion({
      envOverride: undefined,
      provider: 'openai',
      apiBaseURL: 'https://api.mistral.ai.attacker.com/v1',
    })).toBe('us');
    expect(resolveInboxLlmRegion({
      envOverride: undefined,
      provider: 'openai',
      apiBaseURL: 'https://api.eu.mistral.ai.attacker.com/v1',
    })).toBe('us');
  });

  it('falls back to US on malformed baseURL string', () => {
    expect(resolveInboxLlmRegion({
      envOverride: undefined,
      provider: 'openai',
      apiBaseURL: 'not-a-url',
    })).toBe('us');
  });
});
