import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { initSecrets } from './engine-init.js';
import { SecretVault, VaultKeyMismatchError, getVaultDbPath } from './secret-vault.js';
import { getLynoxDir } from './config.js';
import type { LynoxUserConfig } from '../types/index.js';

/**
 * A boot with a key the vault was not written with must not move plaintext secrets into it.
 * The two boot migrations (`secrets.json`, the secret fields of `config.json`) write into the
 * vault and then delete their source; under a foreign key the copies would not decrypt once
 * the right key is back, and the plaintext would be gone for good. A key the vault's check row
 * refuses stops the boot outright; a vault that already holds entries under two keys opens, and
 * the migrations wait.
 */
describe('initSecrets — no plaintext moved into a vault the key does not open', () => {
  const KEY_A = 'vault-key-a-000000000000000000000000';
  const KEY_B = 'vault-key-b-111111111111111111111111';
  let dir: string;
  /** config.json as an old install held it: the API key and the Google client pair in plaintext. */
  const CONFIG = { api_key: 'plain-api-key', google_client_id: 'plain-gid', google_client_secret: 'plain-gsecret' };

  const secretsPath = (): string => join(getLynoxDir(), 'secrets.json');
  const configPath = (): string => join(getLynoxDir(), 'config.json');

  function vaultUnder(key: string): SecretVault {
    return new SecretVault({ path: getVaultDbPath(), masterKey: key });
  }

  function boot(key: string): LynoxUserConfig {
    vi.stubEnv('LYNOX_VAULT_KEY', key);
    const userConfig: LynoxUserConfig = { ...CONFIG };
    const result = initSecrets(userConfig);
    result.vault?.close();
    return userConfig;
  }

  /** One entry under another key and salt, copied into the vault: a vault holding two keys. */
  function plantForeignRow(name: string): void {
    const other = join(dir, 'other.db');
    const o = new SecretVault({ path: other, masterKey: KEY_B });
    o.set(name, 'from-b');
    o.close();
    const src = new Database(other);
    const row = src.prepare('SELECT encrypted_value, iv, auth_tag FROM vault_secrets WHERE name = ?').get(name) as { encrypted_value: Buffer; iv: Buffer; auth_tag: Buffer };
    src.close();
    const db = new Database(getVaultDbPath());
    db.prepare("DELETE FROM vault_meta WHERE key = 'key_check'").run();
    db.prepare('INSERT INTO vault_secrets (name, encrypted_value, iv, auth_tag) VALUES (?, ?, ?, ?)').run(name, row.encrypted_value, row.iv, row.auth_tag);
    db.close();
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
    writeFileSync(configPath(), JSON.stringify(CONFIG));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it('a foreign key does not open the vault', () => {
    expect(() => vaultUnder(KEY_B)).toThrow(VaultKeyMismatchError);
    const a = vaultUnder(KEY_A);
    expect(a.undecryptableCount()).toBe(0);
    a.close();
  });

  it('under a foreign key the boot stops, keeps secrets.json and config.json as they are, and writes nothing into the vault', () => {
    expect(() => boot(KEY_B)).toThrow(VaultKeyMismatchError);
    expect(existsSync(secretsPath()), 'secrets.json is the only copy of LEGACY_X').toBe(true);
    expect(JSON.parse(readFileSync(secretsPath(), 'utf-8'))).toEqual({ LEGACY_X: { value: 'plain-x' } });
    expect(JSON.parse(readFileSync(configPath(), 'utf-8'))).toEqual(CONFIG);
    const a = vaultUnder(KEY_A);
    expect(a.list().map(e => e.name)).toEqual(['PROBE_A']);
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
    expect(a.get('GOOGLE_CLIENT_ID')).toBe('plain-gid');
    expect(a.get('GOOGLE_CLIENT_SECRET')).toBe('plain-gsecret');
    a.close();
  });

  it('after a refused boot the right key finds the vault as it was and moves the plaintext', () => {
    expect(() => boot(KEY_B)).toThrow(VaultKeyMismatchError);
    boot(KEY_A);
    expect(existsSync(secretsPath())).toBe(false);
    const a = vaultUnder(KEY_A);
    expect(a.get('LEGACY_X')).toBe('plain-x');
    expect(a.undecryptableCount(), 'the refused boot stamped nothing').toBe(0);
    a.close();
  });

  it('a vault already holding entries under two keys opens, and the plaintext stays where it is', () => {
    plantForeignRow('FROM_B');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      boot(KEY_A);
      expect(stderr.mock.calls.map(c => String(c[0])).join('')).toContain('do not decrypt with the current LYNOX_VAULT_KEY');
    } finally {
      stderr.mockRestore();
    }
    expect(JSON.parse(readFileSync(secretsPath(), 'utf-8'))).toEqual({ LEGACY_X: { value: 'plain-x' } });
    expect(JSON.parse(readFileSync(configPath(), 'utf-8'))).toEqual(CONFIG);
    const a = vaultUnder(KEY_A);
    expect(a.get('PROBE_A')).toBe('alpha');
    expect(a.has('LEGACY_X')).toBe(false);
    expect(a.undecryptableCount()).toBe(1);
    a.close();
  });
});
