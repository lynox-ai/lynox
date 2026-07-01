import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  SECRET_CONFIG_KEYS,
  redactConfigForResponse,
  stripSecretsForPlugin,
} from './secret-fields.js';
import type { LynoxUserConfig } from '../types/config.js';

// A config carrying a secret at every known surface: top-level keys + the two
// nested collections' per-slot api_key + a non-secret the consumer must keep.
function secretRichConfig(): LynoxUserConfig {
  return {
    api_key: 'sk-ant-TOPLEVEL',
    api_base_url: 'https://api.anthropic.com',
    search_api_key: 'srch-SECRET',
    google_client_id: 'goog-CLIENTID',
    google_client_secret: 'goog-SECRET',
    bugsink_dsn: 'https://key@bugsink.example/1',
    display_name: 'Ada',
    tier_set: {
      fast: { provider: 'openai', model_id: 'x', api_key: 'sk-NESTED-FAST', api_base_url: 'https://api.mistral.ai/v1' },
    },
    model_profiles: {
      custom: { provider: 'anthropic', model: 'y', api_key: 'sk-NESTED-PROFILE' },
    },
  } as unknown as LynoxUserConfig;
}

// Every secret string value we plant, so a test can assert none survive.
const PLANTED_SECRETS = [
  'sk-ant-TOPLEVEL', 'srch-SECRET', 'goog-SECRET',
  'https://key@bugsink.example/1', 'sk-NESTED-FAST', 'sk-NESTED-PROFILE',
];

describe('redactConfigForResponse (GET /api/config + export)', () => {
  it('strips every top-level secret and leaves a *_configured marker', () => {
    const out = redactConfigForResponse(secretRichConfig());
    for (const key of SECRET_CONFIG_KEYS) {
      expect(out[key], `${key} must be removed`).toBeUndefined();
      expect(out[`${key}_configured`], `${key}_configured marker`).toBe(true);
    }
  });

  it('scrubs nested tier_set / model_profiles api_key', () => {
    const out = redactConfigForResponse(secretRichConfig());
    const tier = (out['tier_set'] as Record<string, Record<string, unknown>>)['fast'];
    const prof = (out['model_profiles'] as Record<string, Record<string, unknown>>)['custom'];
    expect(tier?.['api_key']).toBeUndefined();
    expect(prof?.['api_key']).toBeUndefined();
  });

  it('preserves api_base_url (the user sees their own endpoint) and non-secret fields', () => {
    const out = redactConfigForResponse(secretRichConfig());
    expect(out['api_base_url']).toBe('https://api.anthropic.com');
    expect(out['display_name']).toBe('Ada');
    // nested api_base_url stays too (not a secret in this consumer)
    const tier = (out['tier_set'] as Record<string, Record<string, unknown>>)['fast'];
    expect(tier?.['api_base_url']).toBe('https://api.mistral.ai/v1');
  });

  it('leaks NONE of the planted secret values in the serialized response', () => {
    const json = JSON.stringify(redactConfigForResponse(secretRichConfig()));
    for (const s of PLANTED_SECRETS) expect(json).not.toContain(s);
  });

  it('never mutates the input config', () => {
    const input = secretRichConfig();
    redactConfigForResponse(input);
    expect(input.api_key).toBe('sk-ant-TOPLEVEL');
    expect((input.tier_set!.fast)!.api_key).toBe('sk-NESTED-FAST');
  });
});

describe('stripSecretsForPlugin (3rd-party plugin ctx)', () => {
  it('removes every secret AND every endpoint url (top + nested)', () => {
    const out = stripSecretsForPlugin(secretRichConfig()) as Record<string, unknown>;
    for (const key of SECRET_CONFIG_KEYS) expect(out[key]).toBeUndefined();
    expect(out['api_base_url']).toBeUndefined();
    const tier = (out['tier_set'] as Record<string, Record<string, unknown>>)['fast'];
    expect(tier?.['api_key']).toBeUndefined();
    expect(tier?.['api_base_url']).toBeUndefined();
  });

  it('leaves non-secret fields intact', () => {
    const out = stripSecretsForPlugin(secretRichConfig()) as Record<string, unknown>;
    expect(out['display_name']).toBe('Ada');
    const tier = (out['tier_set'] as Record<string, Record<string, unknown>>)['fast'];
    expect(tier?.['provider']).toBe('openai');
    expect(tier?.['model_id']).toBe('x');
  });

  it('leaks NONE of the planted secret values', () => {
    const json = JSON.stringify(stripSecretsForPlugin(secretRichConfig()));
    for (const s of PLANTED_SECRETS) expect(json).not.toContain(s);
  });

  it('never mutates the input config', () => {
    const input = secretRichConfig();
    stripSecretsForPlugin(input);
    expect(input.api_key).toBe('sk-ant-TOPLEVEL');
    expect(input.api_base_url).toBe('https://api.anthropic.com');
  });
});

describe('registration guard — SECRET_CONFIG_KEYS must cover every secret-suffixed top-level field', () => {
  it('fails closed if a new secret-looking field is added to LynoxUserConfig without registering it', () => {
    const src = readFileSync(fileURLToPath(new URL('../types/config.ts', import.meta.url)), 'utf8');
    // Slice out the LynoxUserConfig interface body only (top-level fields are
    // 2-space indented) so nested type interfaces (TierSlot/ModelProfile) —
    // whose api_key is handled by SECRET_NESTED_COLLECTIONS — don't trip this.
    const start = src.indexOf('export interface LynoxUserConfig {');
    expect(start, 'LynoxUserConfig interface not found').toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('\n}', start));
    // Field names that look like a secret (api_key / *_secret / *_dsn / *_token / *password).
    const secretLike = new Set<string>();
    const re = /^  (\w+)\??:/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) {
      const name = m[1]!;
      // Broad secret-suffix tripwire: any *_key / *_secret / *_dsn / *_token /
      // *password top-level field must be registered in SECRET_CONFIG_KEYS.
      if (/(_key$|_secret$|_dsn$|_token$|password)/.test(name)) secretLike.add(name);
    }
    // Sanity: the scan actually found the known ones (guards against a regex that silently matches nothing).
    expect(secretLike.has('api_key')).toBe(true);
    expect(secretLike.has('bugsink_dsn')).toBe(true);
    const registered = new Set<string>(SECRET_CONFIG_KEYS);
    const unregistered = [...secretLike].filter((n) => !registered.has(n));
    expect(unregistered, `secret-looking config fields not in SECRET_CONFIG_KEYS: ${unregistered.join(', ')}`).toEqual([]);
  });
});
