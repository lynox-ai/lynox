import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initSecrets } from './engine-init.js';
import { SecretVault, getVaultDbPath } from './secret-vault.js';
import { getLynoxDir } from './config.js';
import type { LynoxUserConfig } from '../types/index.js';

/**
 * A boot with a key the vault was not written with must not move plaintext secrets into it.
 * The two boot migrations (`secrets.json`, the secret fields of `config.json`) write into the
 * vault and then delete their source; under a foreign key the copies would not decrypt once
 * the right key is back, and the plaintext would be gone for good.
 */
describe('initSecrets — no plaintext moved into a vault the key does not open', () => {
  const KEY_A = 'vault-key-a-000000000000000000000000';
  const KEY_B = 'vault-key-b-111111111111111111111111';
  let dir: string;

  const secretsPath = (): string => join(getLynoxDir(), 'secrets.json');
  const configPath = (): string => join(getLynoxDir(), 'config.json');

  function vaultUnder(key: string): SecretVault {
    return new SecretVault({ path: getVaultDbPath(), masterKey: key });
  }

  function boot(key: string): LynoxUserConfig {
    vi.stubEnv('LYNOX_VAULT_KEY', key);
    const userConfig: LynoxUserConfig = { api_key: 'plain-api-key' };
    const result = initSecrets(userConfig);
    result.vault?.close();
    return userConfig;
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-vault-foreign-'));
    vi.stubEnv('LYNOX_DATA_DIR', dir);
    vi.stubEnv('LYNOX_BILLING_TIER', '');
    vi.stubEnv('LYNOX_MANAGED_MODE', '');
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('MISTRAL_API_KEY', '');
    vi.stubEnv('GOOGLE_CLIENT_ID', '');
    vi.stubEnv('GOOGLE_CLIENT_SECRET', '');
    const v = vaultUnder(KEY_A);
    v.set('PROBE_A', 'alpha');
    v.close();
    writeFileSync(secretsPath(), JSON.stringify({ LEGACY_X: { value: 'plain-x' } }));
    writeFileSync(configPath(), JSON.stringify({ api_key: 'plain-api-key' }));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it('counts the entries a foreign key does not decrypt, and none under the right key', () => {
    const a = vaultUnder(KEY_A);
    expect(a.undecryptableCount()).toBe(0);
    a.close();
    const b = vaultUnder(KEY_B);
    expect(b.undecryptableCount()).toBe(1);
    b.close();
  });

  it('under a foreign key keeps secrets.json and config.json as they are, and writes nothing into the vault', () => {
    boot(KEY_B);
    expect(existsSync(secretsPath()), 'secrets.json is the only copy of LEGACY_X').toBe(true);
    expect(JSON.parse(readFileSync(secretsPath(), 'utf-8'))).toEqual({ LEGACY_X: { value: 'plain-x' } });
    expect(JSON.parse(readFileSync(configPath(), 'utf-8'))).toEqual({ api_key: 'plain-api-key' });
    const a = vaultUnder(KEY_A);
    expect(a.has('LEGACY_X')).toBe(false);
    expect(a.has('ANTHROPIC_API_KEY')).toBe(false);
    expect(a.get('PROBE_A')).toBe('alpha');
    a.close();
  });

  it('CONTROL: with the vault\'s own key the same boot moves both and deletes the plaintext', () => {
    boot(KEY_A);
    expect(existsSync(secretsPath())).toBe(false);
    expect(JSON.parse(readFileSync(configPath(), 'utf-8'))).toEqual({});
    const a = vaultUnder(KEY_A);
    expect(a.get('LEGACY_X')).toBe('plain-x');
    expect(a.get('ANTHROPIC_API_KEY')).toBe('plain-api-key');
    a.close();
  });

  it('after a boot under a foreign key, the right key keeps holding them back, and nothing is lost', () => {
    // The foreign boot stamps the endpoint-slot marker under its own key (`migrateLegacyEndpointKey`
    // stamps unconditionally), and that row stays undecryptable under the vault's key. So the
    // plaintext stays where it is on every later boot, with a warning, instead of being moved.
    boot(KEY_B);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      boot(KEY_A);
      expect(stderr.mock.calls.map(c => String(c[0])).join('')).toContain('do not decrypt with the current LYNOX_VAULT_KEY');
    } finally {
      stderr.mockRestore();
    }
    expect(JSON.parse(readFileSync(secretsPath(), 'utf-8'))).toEqual({ LEGACY_X: { value: 'plain-x' } });
    expect(JSON.parse(readFileSync(configPath(), 'utf-8'))).toEqual({ api_key: 'plain-api-key' });
    const a = vaultUnder(KEY_A);
    expect(a.get('PROBE_A')).toBe('alpha');
    expect(a.has('LEGACY_X')).toBe(false);
    expect(a.undecryptableCount(), 'the marker the foreign boot stamped').toBe(1);
    a.close();
  });
});
