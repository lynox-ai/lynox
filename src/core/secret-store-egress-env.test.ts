import { describe, it, expect, afterEach, vi } from 'vitest';
import { maskSecretPatterns } from './secret-store.js';

/**
 * The pattern masker also masks the engine's own env secrets by value: every sink that scrubs by
 * pattern alone (debug bundle, error reports, client errors, run errors) goes through it. The
 * values are made up and have no credential shape, so only the value set can mask them.
 */
describe('maskSecretPatterns and the engine\'s env secrets', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('masks an env secret that has no credential shape', () => {
    const canary = 'zQ7patterncanaryPq9Lm2Xv4';
    const text = `run failed: ${canary}`;
    expect(maskSecretPatterns(text), 'control: not set, not masked').toContain(canary);
    vi.stubEnv('LYNOX_VAULT_KEY', canary);
    const out = maskSecretPatterns(text);
    expect(out).toContain('run failed');
    expect(out).not.toContain(canary);
  });

  it('still masks a shaped credential next to it, with or without includeGeneric', () => {
    const canary = 'zQ7patterncanaryPq9Lm2Xv4';
    vi.stubEnv('LYNOX_VAULT_KEY', canary);
    const shaped = `sk-ant-api03-${'a'.repeat(40)}`;
    for (const opts of [undefined, { includeGeneric: true }]) {
      const out = maskSecretPatterns(`${canary} and ${shaped}`, opts);
      expect(out).not.toContain(canary);
      expect(out).not.toContain(shaped);
    }
  });

  it('leaves text without either untouched', () => {
    vi.stubEnv('LYNOX_VAULT_KEY', 'zQ7patterncanaryPq9Lm2Xv4');
    expect(maskSecretPatterns('nothing to see here')).toBe('nothing to see here');
  });
});
