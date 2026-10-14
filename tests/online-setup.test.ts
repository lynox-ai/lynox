/**
 * `getApiKey()` — which config field the online tests fall back to.
 *
 * Offline: no API call. Each case writes a throwaway `~/.lynox/config.json` under its own
 * home, so the developer's real config is never read. The key is read from the home the run
 * started with (`operatorHome()`, `scripts/test-run-home.ts`), so that is the one stubbed here.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getApiKey, hasApiKey } from './online/setup.js';
import { REAL_HOME_ENV, operatorHome } from '../scripts/test-run-home.js';

describe('getApiKey reads the config fallback', () => {
  let home = '';

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'lynox-online-setup-'));
    vi.stubEnv(REAL_HOME_ENV, home);
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    // The guard on this file's purpose: if the stub did not take, the real config would be read.
    expect(operatorHome()).toBe(home);
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
    const said = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(hasApiKey()).toBe(false);
      // Not a silent skip: it says where it looked, the variable and the config file by path.
      const text = said.mock.calls.map((c) => String(c[0])).join('');
      expect(text).toContain('online tests: SKIPPED, no API key');
      expect(text).toContain('ANTHROPIC_API_KEY: unset');
      expect(text).toContain(`${join(home, '.lynox', 'config.json')} has none of anthropic_api_key, api_key`);
    } finally {
      said.mockRestore();
    }
  });

  it('lets the environment variable win over the config', () => {
    config({ anthropic_api_key: 'from-anthropic-field' });
    vi.stubEnv('ANTHROPIC_API_KEY', 'from-env');
    expect(getApiKey()).toBe('from-env');
  });
});
