/**
 * `getApiKey()` — which config field the online tests fall back to.
 *
 * Offline: no API call. Each case writes a throwaway `~/.lynox/config.json` under its own
 * HOME, so the developer's real config is never read.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { getApiKey, hasApiKey } from './setup.js';

describe('getApiKey reads the config fallback', () => {
  let home = '';

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'lynox-online-setup-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    // The guard on this file's purpose: if HOME did not take, the real config would be read.
    expect(homedir()).toBe(home);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  function config(fields: Record<string, unknown>): void {
    mkdirSync(join(home, '.lynox'));
    writeFileSync(join(home, '.lynox', 'config.json'), JSON.stringify(fields));
  }

  it('reads anthropic_api_key, the name the eval and bench scripts read', () => {
    config({ anthropic_api_key: 'from-anthropic-field' });
    expect(getApiKey()).toBe('from-anthropic-field');
  });

  it('still reads the legacy api_key', () => {
    config({ api_key: 'from-legacy-field' });
    expect(getApiKey()).toBe('from-legacy-field');
  });

  it('prefers anthropic_api_key when both are set', () => {
    config({ api_key: 'from-legacy-field', anthropic_api_key: 'from-anthropic-field' });
    expect(getApiKey()).toBe('from-anthropic-field');
  });

  it('skips an empty anthropic_api_key and falls back to api_key', () => {
    config({ anthropic_api_key: '', api_key: 'from-legacy-field' });
    expect(getApiKey()).toBe('from-legacy-field');
  });

  it('skips a non-string value', () => {
    config({ anthropic_api_key: 42, api_key: 'from-legacy-field' });
    expect(getApiKey()).toBe('from-legacy-field');
  });

  it('throws, and hasApiKey is false, when neither field holds a key', () => {
    config({ anthropic_api_key: '', mistral_api_key: 'not-anthropic' });
    expect(() => getApiKey()).toThrow(/No API key found/);
    expect(hasApiKey()).toBe(false);
  });

  it('lets the environment variable win over the config', () => {
    config({ anthropic_api_key: 'from-anthropic-field' });
    vi.stubEnv('ANTHROPIC_API_KEY', 'from-env');
    expect(getApiKey()).toBe('from-env');
  });
});
