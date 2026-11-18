import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LynoxConfig } from '../types/index.js';
import { Engine } from './engine.js';
import { reloadConfig } from './config.js';
import { SecretVault, VaultKeyMismatchError } from './secret-vault.js';
import { _resetVaultKeySource } from './vault-key-source.js';

/**
 * A vault key that does not open the vault stops `Engine.init` before any other store opens:
 * no history.db or engine.db is created under it. `initSecrets` would refuse the key as well, but
 * only after both stores have opened and written their schema under the foreign key. Fixtures only.
 */
describe('Engine boot — a vault key that does not open the vault', () => {
  const KEY_A = 'vault-key-a-000000000000000000000000';
  const KEY_B = 'vault-key-b-111111111111111111111111';
  let dir: string | undefined;

  afterEach(() => {
    vi.unstubAllEnvs();
    _resetVaultKeySource();
    reloadConfig();
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  const prepare = (): string => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-vault-refusal-'));
    vi.stubEnv('LYNOX_DATA_DIR', dir);
    vi.stubEnv('LYNOX_BILLING_TIER', '');
    vi.stubEnv('LYNOX_MANAGED_MODE', '');
    const v = new SecretVault({ path: join(dir, 'vault.db'), masterKey: KEY_A });
    v.set('PROBE_A', 'alpha');
    v.close();
    return dir;
  };

  it('stops before the stores open, so nothing is written under the foreign key', async () => {
    const d = prepare();
    vi.stubEnv('LYNOX_VAULT_KEY', KEY_B);
    _resetVaultKeySource();
    reloadConfig();
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      await expect(new Engine({} as LynoxConfig).init()).rejects.toThrow(VaultKeyMismatchError);
    } finally {
      stderr.mockRestore();
    }
    expect(existsSync(join(d, 'history.db')), 'history.db was not opened').toBe(false);
    expect(existsSync(join(d, 'engine.db')), 'engine.db was not opened').toBe(false);
  });

  it('CONTROL: under the vault\'s own key the same boot opens the stores', async () => {
    const d = prepare();
    vi.stubEnv('LYNOX_VAULT_KEY', KEY_A);
    _resetVaultKeySource();
    reloadConfig();
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const engine = new Engine({} as LynoxConfig);
    try {
      await engine.init();
    } finally {
      stderr.mockRestore();
    }
    await engine.shutdown();
    expect(existsSync(join(d, 'history.db')) || existsSync(join(d, 'engine.db'))).toBe(true);
  });
});
