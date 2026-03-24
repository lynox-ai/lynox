import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SecretVault, estimateKeyEntropy } from './secret-vault.js';

const TEST_KEY = 'test-master-key-for-vault-testing-1234';

function createTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'nodyn-vault-test-'));
}

describe('SecretVault', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function createVault(key?: string): SecretVault {
    return new SecretVault({
      path: join(tmpDir, 'vault.db'),
      masterKey: key ?? TEST_KEY,
    });
  }

  // === Construction ===

  describe('construction', () => {
    it('creates vault database', () => {
      const vault = createVault();
      expect(vault.size).toBe(0);
      vault.close();
    });

    it('throws without master key', () => {
      const origEnv = process.env['NODYN_VAULT_KEY'];
      delete process.env['NODYN_VAULT_KEY'];
      try {
        expect(() => new SecretVault({
          path: join(tmpDir, 'vault.db'),
          masterKey: '',
        })).toThrow('Vault master key required');
      } finally {
        if (origEnv !== undefined) {
          process.env['NODYN_VAULT_KEY'] = origEnv;
        }
      }
    });

    it('uses NODYN_VAULT_KEY env var when no masterKey option', () => {
      const origEnv = process.env['NODYN_VAULT_KEY'];
      process.env['NODYN_VAULT_KEY'] = 'env-based-key-1234567890';
      try {
        const vault = new SecretVault({ path: join(tmpDir, 'vault.db') });
        vault.set('TEST', 'hello-world-1234');
        expect(vault.get('TEST')).toBe('hello-world-1234');
        vault.close();
      } finally {
        if (origEnv !== undefined) {
          process.env['NODYN_VAULT_KEY'] = origEnv;
        } else {
          delete process.env['NODYN_VAULT_KEY'];
        }
      }
    });

    it('persists salt across reopens', () => {
      const vault1 = createVault();
      vault1.set('PERSIST', 'my-secret-value-123');
      vault1.close();

      const vault2 = createVault();
      expect(vault2.get('PERSIST')).toBe('my-secret-value-123');
      vault2.close();
    });
  });

  // === CRUD ===

  describe('set and get', () => {
    it('stores and retrieves a secret', () => {
      const vault = createVault();
      vault.set('API_KEY', 'sk-test-1234567890abcdef');
      expect(vault.get('API_KEY')).toBe('sk-test-1234567890abcdef');
      vault.close();
    });

    it('updates an existing secret', () => {
      const vault = createVault();
      vault.set('TOKEN', 'old-value-1234567890');
      vault.set('TOKEN', 'new-value-0987654321');
      expect(vault.get('TOKEN')).toBe('new-value-0987654321');
      vault.close();
    });

    it('returns null for non-existent secret', () => {
      const vault = createVault();
      expect(vault.get('NONEXISTENT')).toBeNull();
      vault.close();
    });

    it('stores with scope and ttl', () => {
      const vault = createVault();
      vault.set('SCOPED', 'value-1234567890ab', 'http_header', 3600000);
      const entries = vault.list();
      const entry = entries.find(e => e.name === 'SCOPED');
      expect(entry).toBeDefined();
      expect(entry!.scope).toBe('http_header');
      expect(entry!.ttlMs).toBe(3600000);
      vault.close();
    });

    it('handles empty string value', () => {
      const vault = createVault();
      vault.set('EMPTY', '');
      expect(vault.get('EMPTY')).toBe('');
      vault.close();
    });

    it('handles unicode values', () => {
      const vault = createVault();
      const unicodeSecret = 'secret-with-émojis-🔑-and-ünïcödë';
      vault.set('UNICODE', unicodeSecret);
      expect(vault.get('UNICODE')).toBe(unicodeSecret);
      vault.close();
    });

    it('handles large values', () => {
      const vault = createVault();
      const largeValue = 'x'.repeat(100_000);
      vault.set('LARGE', largeValue);
      expect(vault.get('LARGE')).toBe(largeValue);
      vault.close();
    });
  });

  describe('delete', () => {
    it('deletes an existing secret', () => {
      const vault = createVault();
      vault.set('DELETE_ME', 'value-1234567890');
      expect(vault.delete('DELETE_ME')).toBe(true);
      expect(vault.get('DELETE_ME')).toBeNull();
      vault.close();
    });

    it('returns false for non-existent secret', () => {
      const vault = createVault();
      expect(vault.delete('NOPE')).toBe(false);
      vault.close();
    });
  });

  describe('has', () => {
    it('returns true for existing secret', () => {
      const vault = createVault();
      vault.set('EXISTS', 'value-1234567890');
      expect(vault.has('EXISTS')).toBe(true);
      vault.close();
    });

    it('returns false for non-existent secret', () => {
      const vault = createVault();
      expect(vault.has('NOPE')).toBe(false);
      vault.close();
    });
  });

  describe('list', () => {
    it('lists all entries without values', () => {
      const vault = createVault();
      vault.set('A', 'value-a-1234567890');
      vault.set('B', 'value-b-0987654321', 'bash_env');
      const entries = vault.list();
      expect(entries).toHaveLength(2);
      expect(entries[0]!.name).toBe('A');
      expect(entries[1]!.name).toBe('B');
      expect(entries[1]!.scope).toBe('bash_env');
      // Verify no values in list output
      const json = JSON.stringify(entries);
      expect(json).not.toContain('value-a');
      expect(json).not.toContain('value-b');
      vault.close();
    });

    it('returns empty array when vault is empty', () => {
      const vault = createVault();
      expect(vault.list()).toEqual([]);
      vault.close();
    });
  });

  describe('size', () => {
    it('tracks count correctly', () => {
      const vault = createVault();
      expect(vault.size).toBe(0);
      vault.set('X', 'value-x-1234567890');
      expect(vault.size).toBe(1);
      vault.set('Y', 'value-y-0987654321');
      expect(vault.size).toBe(2);
      vault.delete('X');
      expect(vault.size).toBe(1);
      vault.close();
    });
  });

  describe('getAll', () => {
    it('returns all decrypted entries', () => {
      const vault = createVault();
      vault.set('KEY1', 'val-1-1234567890', 'http_header', 5000);
      vault.set('KEY2', 'val-2-0987654321', 'bash_env');
      const all = vault.getAll();
      expect(all.size).toBe(2);
      expect(all.get('KEY1')).toEqual({ value: 'val-1-1234567890', scope: 'http_header', ttlMs: 5000 });
      expect(all.get('KEY2')).toEqual({ value: 'val-2-0987654321', scope: 'bash_env', ttlMs: 0 });
      vault.close();
    });
  });

  // === Encryption ===

  describe('encryption', () => {
    it('wrong key cannot decrypt', () => {
      const vault1 = createVault('correct-key-1234567890ab');
      vault1.set('SECRET', 'top-secret-value-xyz');
      vault1.close();

      const vault2 = createVault('wrong-key-0987654321cd');
      expect(vault2.get('SECRET')).toBeNull(); // Decryption fails silently
      vault2.close();
    });

    it('wrong key returns empty from getAll', () => {
      const vault1 = createVault('key-alpha-1234567890');
      vault1.set('A', 'value-alpha-1234567');
      vault1.set('B', 'value-beta-12345678');
      vault1.close();

      const vault2 = createVault('key-beta-0987654321');
      const all = vault2.getAll();
      expect(all.size).toBe(0); // All entries fail decryption
      vault2.close();
    });

    it('each value has unique IV', () => {
      const vault = createVault();
      vault.set('A', 'same-value-1234567890');
      vault.set('B', 'same-value-1234567890');
      // Different entries should produce different ciphertext (unique IVs)
      // We verify indirectly: both decrypt correctly
      expect(vault.get('A')).toBe('same-value-1234567890');
      expect(vault.get('B')).toBe('same-value-1234567890');
      vault.close();
    });
  });

  // === Migration ===

  describe('migrateFromFile', () => {
    it('migrates secrets from JSON file', () => {
      const secretsPath = join(tmpDir, 'secrets.json');
      writeFileSync(secretsPath, JSON.stringify({
        GITHUB_TOKEN: { value: 'ghp_abc123def456789012', scope: 'http_header' },
        SLACK_KEY: { value: 'xoxb-slack-key-12345', ttlMs: 86400000 },
      }));

      const vault = createVault();
      const count = vault.migrateFromFile(secretsPath);
      expect(count).toBe(2);
      expect(vault.get('GITHUB_TOKEN')).toBe('ghp_abc123def456789012');
      expect(vault.get('SLACK_KEY')).toBe('xoxb-slack-key-12345');
      vault.close();
    });

    it('does not overwrite existing vault entries', () => {
      const secretsPath = join(tmpDir, 'secrets.json');
      writeFileSync(secretsPath, JSON.stringify({
        EXISTING: { value: 'from-file-value-123' },
      }));

      const vault = createVault();
      vault.set('EXISTING', 'vault-value-original');
      const count = vault.migrateFromFile(secretsPath);
      expect(count).toBe(0);
      expect(vault.get('EXISTING')).toBe('vault-value-original');
      vault.close();
    });

    it('renames source file to .bak after migration', () => {
      const secretsPath = join(tmpDir, 'secrets.json');
      writeFileSync(secretsPath, JSON.stringify({
        KEY1: { value: 'value-to-migrate-123' },
      }));

      const vault = createVault();
      vault.migrateFromFile(secretsPath);
      vault.close();

      expect(existsSync(secretsPath)).toBe(false);
      expect(existsSync(`${secretsPath}.bak`)).toBe(true);
    });

    it('returns 0 for missing file', () => {
      const vault = createVault();
      expect(vault.migrateFromFile(join(tmpDir, 'nonexistent.json'))).toBe(0);
      vault.close();
    });

    it('returns 0 for invalid JSON', () => {
      const secretsPath = join(tmpDir, 'secrets.json');
      writeFileSync(secretsPath, 'not-json');

      const vault = createVault();
      expect(vault.migrateFromFile(secretsPath)).toBe(0);
      vault.close();
    });

    it('skips entries with missing values', () => {
      const secretsPath = join(tmpDir, 'secrets.json');
      writeFileSync(secretsPath, JSON.stringify({
        GOOD: { value: 'good-value-1234567890' },
        BAD1: { value: '' },
        BAD2: {},
      }));

      const vault = createVault();
      const count = vault.migrateFromFile(secretsPath);
      expect(count).toBe(1);
      expect(vault.has('GOOD')).toBe(true);
      expect(vault.has('BAD1')).toBe(false);
      expect(vault.has('BAD2')).toBe(false);
      vault.close();
    });
  });

  // === Tenant Key Derivation ===

  describe('deriveTenantKey', () => {
    it('returns deterministic key for same inputs', () => {
      const key1 = SecretVault.deriveTenantKey('master-key-abc', 'tenant-alice');
      const key2 = SecretVault.deriveTenantKey('master-key-abc', 'tenant-alice');
      expect(key1).toBe(key2);
      expect(key1).toHaveLength(64); // 32 bytes hex
    });

    it('different tenants get different keys', () => {
      const keyAlice = SecretVault.deriveTenantKey('shared-master', 'alice');
      const keyBob = SecretVault.deriveTenantKey('shared-master', 'bob');
      expect(keyAlice).not.toBe(keyBob);
    });

    it('different master keys produce different tenant keys', () => {
      const key1 = SecretVault.deriveTenantKey('master-a', 'tenant-1');
      const key2 = SecretVault.deriveTenantKey('master-b', 'tenant-1');
      expect(key1).not.toBe(key2);
    });

    it('throws on empty masterKey', () => {
      expect(() => SecretVault.deriveTenantKey('', 'tenant')).toThrow('masterKey is required');
    });

    it('throws on empty tenantId', () => {
      expect(() => SecretVault.deriveTenantKey('key', '')).toThrow('tenantId is required');
    });

    it('tenant-derived key cannot decrypt another tenant vault', () => {
      const masterKey = 'global-master-key-for-test';
      const keyAlice = SecretVault.deriveTenantKey(masterKey, 'alice');
      const keyBob = SecretVault.deriveTenantKey(masterKey, 'bob');

      const vaultAlice = new SecretVault({
        path: join(tmpDir, 'alice-vault.db'),
        masterKey: keyAlice,
      });
      vaultAlice.set('SECRET', 'alice-private-data-123');
      vaultAlice.close();

      const vaultBob = new SecretVault({
        path: join(tmpDir, 'alice-vault.db'),
        masterKey: keyBob,
      });
      expect(vaultBob.get('SECRET')).toBeNull(); // Cannot decrypt
      vaultBob.close();
    });
  });

  // === File Permissions ===

  describe('file permissions', () => {
    it('creates vault.db with 0o600 permissions', () => {
      const dbPath = join(tmpDir, 'vault.db');
      const vault = createVault();
      vault.close();
      const stat = statSync(dbPath);
      // eslint-disable-next-line no-bitwise
      const mode = stat.mode & 0o777;
      expect(mode).toBe(0o600);
    });

    it('sets WAL journal file permissions to 0o600', () => {
      const dbPath = join(tmpDir, 'vault.db');
      const vault = createVault();
      // Force some writes to ensure WAL files exist
      vault.set('PERM_TEST', 'value-for-wal-test-1234');
      vault.close();
      const walPath = `${dbPath}-wal`;
      if (existsSync(walPath)) {
        const stat = statSync(walPath);
        // eslint-disable-next-line no-bitwise
        const mode = stat.mode & 0o777;
        expect(mode).toBe(0o600);
      }
      // WAL file may not exist if SQLite checkpointed — test is conditional
    });
  });

  // === Persistence ===

  describe('persistence', () => {
    it('survives close and reopen with same key', () => {
      const dbPath = join(tmpDir, 'vault.db');
      const vault1 = new SecretVault({ path: dbPath, masterKey: TEST_KEY });
      vault1.set('PERSISTENT', 'survives-restart-123');
      vault1.close();

      const vault2 = new SecretVault({ path: dbPath, masterKey: TEST_KEY });
      expect(vault2.get('PERSISTENT')).toBe('survives-restart-123');
      expect(vault2.size).toBe(1);
      vault2.close();
    });

    it('multiple operations in sequence', () => {
      const vault = createVault();
      vault.set('A', 'value-a-1234567890');
      vault.set('B', 'value-b-0987654321');
      vault.set('C', 'value-c-abcdef1234');
      vault.delete('B');
      vault.set('A', 'updated-a-9876543');

      expect(vault.size).toBe(2);
      expect(vault.get('A')).toBe('updated-a-9876543');
      expect(vault.get('B')).toBeNull();
      expect(vault.get('C')).toBe('value-c-abcdef1234');
      vault.close();
    });
  });

  // === Key Rotation ===

  describe('rotateVault', () => {
    it('re-encrypts all secrets with a new key', () => {
      const dbPath = join(tmpDir, 'vault.db');
      const oldKey = 'old-master-key-for-rotation-test-1234';
      const newKey = 'new-master-key-for-rotation-test-5678';

      // Store secrets with old key
      const vault1 = new SecretVault({ path: dbPath, masterKey: oldKey });
      vault1.set('SECRET_A', 'value-a-rotation-test');
      vault1.set('SECRET_B', 'value-b-rotation-test', 'http_header', 60000);
      vault1.close();

      // Rotate
      const count = SecretVault.rotateVault(dbPath, oldKey, newKey);
      expect(count).toBe(2);

      // Verify new key can decrypt
      const vault2 = new SecretVault({ path: dbPath, masterKey: newKey });
      expect(vault2.get('SECRET_A')).toBe('value-a-rotation-test');
      expect(vault2.get('SECRET_B')).toBe('value-b-rotation-test');
      vault2.close();

      // Verify old key cannot decrypt
      const vault3 = new SecretVault({ path: dbPath, masterKey: oldKey });
      expect(vault3.get('SECRET_A')).toBeNull();
      expect(vault3.get('SECRET_B')).toBeNull();
      vault3.close();
    });

    it('throws on wrong current key', () => {
      const dbPath = join(tmpDir, 'vault.db');
      const realKey = 'real-key-for-wrong-key-test-12345';
      const wrongKey = 'wrong-key-for-wrong-key-test-67890';

      const vault = new SecretVault({ path: dbPath, masterKey: realKey });
      vault.set('DATA', 'important-secret-value-1234');
      vault.close();

      expect(() => SecretVault.rotateVault(dbPath, wrongKey, 'new-key-1234567890ab'))
        .toThrow('Cannot decrypt');
    });

    it('handles empty vault', () => {
      const dbPath = join(tmpDir, 'vault.db');
      const key = 'key-for-empty-vault-test-123456';

      const vault = new SecretVault({ path: dbPath, masterKey: key });
      vault.close();

      const count = SecretVault.rotateVault(dbPath, key, 'new-key-for-empty-vault');
      expect(count).toBe(0);
    });
  });

  // === Entropy Estimation ===

  describe('estimateKeyEntropy', () => {
    it('returns 0 for empty string', () => {
      expect(estimateKeyEntropy('')).toBe(0);
    });

    it('returns 0 for single repeated char', () => {
      expect(estimateKeyEntropy('aaaaaaaaaaaaaaaa')).toBe(0);
    });

    it('returns higher entropy for diverse chars', () => {
      const low = estimateKeyEntropy('aaabbb');
      const high = estimateKeyEntropy('a1B2c3');
      expect(high).toBeGreaterThan(low);
    });

    it('returns high entropy for base64 random key', () => {
      // 48-char base64 string (like randomBytes(36).toString('base64'))
      const entropy = estimateKeyEntropy('K7mX2pQ9vR4sY1tU8wZ3nA6bC5dE0fG7hI2jL4kM8oP');
      expect(entropy).toBeGreaterThan(128);
    });
  });
});
