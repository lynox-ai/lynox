import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initSecrets } from './engine-init.js';
import { SecretVault } from './secret-vault.js';
import type { LynoxUserConfig } from '../types/index.js';

/**
 * What the boot does with an LLM key the user stored in the vault, per billing tier.
 *
 * On a pool tier the control plane supplies the LLM key in the environment. The boot
 * used to copy a vault `MISTRAL_API_KEY` into the environment and mirror a vault
 * `ANTHROPIC_API_KEY` into `api_key` whenever the environment had none; from there
 * the user's own key passed for the pool's, and ran in its place without a word.
 * The resolver half of this lives in `llm/provider-keys.test.ts`.
 */
describe('initSecrets — vault LLM keys on a pool tier stay in the vault', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-pool-keys-'));
    vi.stubEnv('LYNOX_DATA_DIR', dir);
    vi.stubEnv('LYNOX_VAULT_KEY', 'test-vault-key-for-pool-0000000000');
    vi.stubEnv('LYNOX_BILLING_TIER', '');
    vi.stubEnv('LYNOX_MANAGED_MODE', '');
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('MISTRAL_API_KEY', '');
    const vault = new SecretVault();
    vault.set('ANTHROPIC_API_KEY', 'user-anthropic');
    vault.set('MISTRAL_API_KEY', 'user-mistral');
    vault.close();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  function boot(): LynoxUserConfig {
    const userConfig: LynoxUserConfig = {};
    initSecrets(userConfig);
    return userConfig;
  }

  it.each(['managed', 'managed_pro', 'managed_max'])('%s without the pool key: neither vault key reaches the environment or api_key', (tier) => {
    vi.stubEnv('LYNOX_BILLING_TIER', tier);
    const userConfig = boot();
    expect(process.env['MISTRAL_API_KEY']).toBe('');
    expect(userConfig.api_key).toBeUndefined();
  });

  it('a pool tier with the pool key set keeps the pool key', () => {
    vi.stubEnv('LYNOX_BILLING_TIER', 'managed');
    vi.stubEnv('MISTRAL_API_KEY', 'pool-mistral');
    boot();
    expect(process.env['MISTRAL_API_KEY']).toBe('pool-mistral');
  });

  it('managed BYOK (hosted) still loads the keys the user stored', () => {
    vi.stubEnv('LYNOX_BILLING_TIER', 'hosted');
    const userConfig = boot();
    expect(process.env['MISTRAL_API_KEY']).toBe('user-mistral');
    expect(userConfig.api_key).toBe('user-anthropic');
  });

  it('self-host still loads the keys the user stored', () => {
    const userConfig = boot();
    expect(process.env['MISTRAL_API_KEY']).toBe('user-mistral');
    expect(userConfig.api_key).toBe('user-anthropic');
  });
});
