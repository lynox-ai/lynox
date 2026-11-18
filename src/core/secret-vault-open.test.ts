import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { SecretVault, VaultKeyMismatchError } from './secret-vault.js';

/** Opening a vault: without a key nothing is opened, and two first opens share one salt. Fixtures only. */
describe('SecretVault open', () => {
  const KEY = 'vault-key-open-000000000000000000000';
  const OTHER = 'vault-key-other-11111111111111111111';
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-vault-open-'));
    path = join(dir, 'vault.db');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it('without a key it throws before it opens anything: no vault file is created', () => {
    vi.stubEnv('LYNOX_VAULT_KEY', '');
    expect(() => new SecretVault({ path })).toThrow('Vault master key required');
    expect(existsSync(path), 'no vault file was created').toBe(false);
  });

  it('two first opens at once under different keys: whichever checks in first pins the vault, the other is refused', () => {
    // The other open has written the salt and not yet its key-check row when this open starts:
    // both found no salt, so both count as the vault's first open.
    const real = Database.prototype.prepare;
    let raced = false;
    const spy = vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (this: Database.Database, sql: string) {
      if (!raced && sql.includes("INTO vault_meta (key, value) VALUES ('pbkdf2_salt'")) {
        raced = true;
        spy.mockRestore();
        const other = new Database(path);
        other.prepare("INSERT INTO vault_meta (key, value) VALUES ('pbkdf2_salt', ?)").run(randomBytes(32));
        other.close();
      }
      return real.call(this, sql);
    });
    try {
      new SecretVault({ path, masterKey: OTHER }).close();   // this open writes the row first
    } finally {
      spy.mockRestore();
    }
    expect(raced).toBe(true);
    // The other open's key now meets that row and is refused, instead of both keys opening an
    // unpinned vault.
    expect(() => new SecretVault({ path, masterKey: KEY })).toThrow(VaultKeyMismatchError);
    new SecretVault({ path, masterKey: OTHER }).close();
  });

  it('two first opens at once: the salt written first stands, and both opens use it', () => {
    // Another process creates the vault and its salt just before this open writes its own.
    const real = Database.prototype.prepare;
    let raced = false;
    const spy = vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (this: Database.Database, sql: string) {
      if (!raced && sql.includes("INTO vault_meta (key, value) VALUES ('pbkdf2_salt'")) {
        raced = true;
        spy.mockRestore();
        const other = new SecretVault({ path, masterKey: KEY });
        other.set('FROM_OTHER', 'first');
        other.close();
      }
      return real.call(this, sql);
    });
    let mine: SecretVault;
    try {
      mine = new SecretVault({ path, masterKey: KEY });
    } finally {
      spy.mockRestore();
    }
    expect(raced).toBe(true);
    // Its key comes from the salt that stands: it reads the other open's entry and writes its own
    // so that a later open reads both.
    expect(mine.get('FROM_OTHER')).toBe('first');
    mine.set('FROM_MINE', 'second');
    mine.close();
    const later = new SecretVault({ path, masterKey: KEY });
    expect(later.get('FROM_OTHER')).toBe('first');
    expect(later.get('FROM_MINE')).toBe('second');
    expect(later.undecryptableCount()).toBe(0);
    later.close();
  });
});
