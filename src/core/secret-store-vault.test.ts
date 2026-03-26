import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('./observability.js', () => ({
  channels: {
    secretAccess: { publish: vi.fn() },
  },
}));

import { SecretStore } from './secret-store.js';
import { SecretVault } from './secret-vault.js';

const TEST_KEY = 'vault-integration-test-key-123456';

describe('SecretStore + Vault integration', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lynox-store-vault-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function createVault(): SecretVault {
    return new SecretVault({ path: join(tmpDir, 'vault.db'), masterKey: TEST_KEY });
  }

  it('loads vault secrets into SecretStore', () => {
    const vault = createVault();
    vault.set('VAULT_SECRET', 'encrypted-value-1234');
    const store = new SecretStore(undefined, vault);
    expect(store.listNames()).toContain('VAULT_SECRET');
    store.recordConsent('VAULT_SECRET');
    expect(store.resolve('VAULT_SECRET')).toBe('encrypted-value-1234');
    vault.close();
  });

  it('set() writes through to vault', () => {
    const vault = createVault();
    const store = new SecretStore(undefined, vault);
    store.set('NEW_SECRET', 'new-value-1234567890', 'http_header');

    // Verify in vault
    expect(vault.get('NEW_SECRET')).toBe('new-value-1234567890');
    // Verify in store
    expect(store.listNames()).toContain('NEW_SECRET');
    store.recordConsent('NEW_SECRET');
    expect(store.resolve('NEW_SECRET')).toBe('new-value-1234567890');
    vault.close();
  });

  it('set() throws without vault', () => {
    const store = new SecretStore();
    expect(() => store.set('X', 'value-1234567890')).toThrow('Cannot set secrets without a vault');
  });

  it('deleteSecret() removes from both vault and memory', () => {
    const vault = createVault();
    vault.set('DELETE_ME', 'to-be-deleted-12345');
    const store = new SecretStore(undefined, vault);
    store.recordConsent('DELETE_ME');

    expect(store.deleteSecret('DELETE_ME')).toBe(true);
    expect(store.listNames()).not.toContain('DELETE_ME');
    expect(vault.get('DELETE_ME')).toBeNull();
    vault.close();
  });

  it('deleteSecret() returns false for non-existent', () => {
    const vault = createVault();
    const store = new SecretStore(undefined, vault);
    expect(store.deleteSecret('NONEXISTENT')).toBe(false);
    vault.close();
  });

  it('hasVault returns true when vault attached', () => {
    const vault = createVault();
    const store = new SecretStore(undefined, vault);
    expect(store.hasVault).toBe(true);
    vault.close();
  });

  it('hasVault returns false without vault', () => {
    const store = new SecretStore();
    expect(store.hasVault).toBe(false);
  });

  it('env vars take precedence over vault', () => {
    const origVal = process.env['LYNOX_SECRET_OVERLAP'];
    process.env['LYNOX_SECRET_OVERLAP'] = 'from-env-value-1234';
    try {
      const vault = createVault();
      vault.set('OVERLAP', 'from-vault-value-1234');
      const store = new SecretStore(undefined, vault);
      store.recordConsent('OVERLAP');
      expect(store.resolve('OVERLAP')).toBe('from-env-value-1234');
      vault.close();
    } finally {
      if (origVal !== undefined) {
        process.env['LYNOX_SECRET_OVERLAP'] = origVal;
      } else {
        delete process.env['LYNOX_SECRET_OVERLAP'];
      }
    }
  });
});
