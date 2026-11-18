import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { SecretVault, VaultKeyMismatchError, vaultKeyMismatchText, getVaultDbPath } from './secret-vault.js';
import { assertVaultKeyOpensVault, initSecrets } from './engine-init.js';

/**
 * The key check of a vault: a vault opens only under the key it was written with, and a vault
 * written before the check existed gets its check row only when that is certain. Fixtures only:
 * every vault here is made in a temporary directory.
 */
describe('SecretVault key check', () => {
  const KEY_A = 'vault-key-a-000000000000000000000000';
  const KEY_B = 'vault-key-b-111111111111111111111111';
  let dir: string;
  let path: string;

  const open = (key: string, p = path): SecretVault => new SecretVault({ path: p, masterKey: key });
  const raw = (p = path): Database.Database => new Database(p);
  const checkRows = (p = path): number => {
    const db = raw(p);
    try {
      return (db.prepare("SELECT COUNT(*) AS c FROM vault_meta WHERE key = 'key_check'").get() as { c: number }).c;
    } finally {
      db.close();
    }
  };
  /** A vault as one written before the check existed: entries under KEY_A, no check row. */
  const legacyVault = (entries: Record<string, string>): void => {
    const v = open(KEY_A);
    for (const [name, value] of Object.entries(entries)) v.set(name, value);
    v.close();
    const db = raw();
    db.prepare("DELETE FROM vault_meta WHERE key = 'key_check'").run();
    db.close();
  };
  /** Copy one encrypted row from a vault under another key and salt into the vault at `path`. */
  const plantForeignRow = (name: string): void => {
    const other = join(dir, 'other.db');
    const o = open(KEY_B, other);
    o.set(name, 'from-b');
    o.close();
    const src = raw(other);
    const row = src.prepare('SELECT encrypted_value, iv, auth_tag FROM vault_secrets WHERE name = ?').get(name) as { encrypted_value: Buffer; iv: Buffer; auth_tag: Buffer };
    src.close();
    const db = raw();
    db.prepare('INSERT INTO vault_secrets (name, encrypted_value, iv, auth_tag) VALUES (?, ?, ?, ?)').run(name, row.encrypted_value, row.iv, row.auth_tag);
    db.close();
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-vault-check-'));
    path = join(dir, 'vault.db');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes the check row into a new, empty vault and opens again under the same key', () => {
    open(KEY_A).close();
    expect(checkRows()).toBe(1);
    const again = open(KEY_A);
    expect(again.size).toBe(0);
    again.close();
  });

  it('refuses a key the check row does not open, and writes nothing', () => {
    const a = open(KEY_A);
    a.set('PROBE_A', 'alpha');
    a.close();
    expect(() => open(KEY_B)).toThrow(VaultKeyMismatchError);
    const back = open(KEY_A);
    expect(back.get('PROBE_A')).toBe('alpha');
    expect(back.list().map(e => e.name)).toEqual(['PROBE_A']);
    back.close();
    expect(checkRows()).toBe(1);
  });

  it('refuses a key on an empty vault that another key wrote the check row for', () => {
    open(KEY_A).close();
    expect(() => open(KEY_B)).toThrow(VaultKeyMismatchError);
  });

  it('refuses a check row that decrypts under the key but to something else than the check text', () => {
    const v = open(KEY_A);
    v.set('X', 'not the check text');
    v.close();
    // The check row replaced by an entry that KEY_A does decrypt, in the row's layout iv|tag|data.
    const db = raw();
    const row = db.prepare("SELECT encrypted_value, iv, auth_tag FROM vault_secrets WHERE name = 'X'").get() as { encrypted_value: Buffer; iv: Buffer; auth_tag: Buffer };
    db.prepare("UPDATE vault_meta SET value = ? WHERE key = 'key_check'").run(Buffer.concat([row.iv, row.auth_tag, row.encrypted_value]));
    db.close();
    expect(() => open(KEY_A)).toThrow(VaultKeyMismatchError);
  });

  it('legacy vault without entries: no key is pinned until an entry shows which one it is', () => {
    legacyVault({});
    open(KEY_B).close();   // a wrong key first: it learns nothing and writes no row
    expect(checkRows()).toBe(0);
    const a = open(KEY_A);   // the right key still opens it
    a.set('P1', 'one');
    a.close();
    expect(checkRows(), 'the entry is not yet the check').toBe(0);
    open(KEY_A).close();   // the next open finds an entry under A and writes the row
    expect(checkRows()).toBe(1);
    expect(() => open(KEY_B)).toThrow(VaultKeyMismatchError);
  });

  /** Run `open(key)` while another connection writes `row` as the check row just before this open's own insert. */
  const openRacing = (key: string, row: Buffer): SecretVault => {
    const real = Database.prototype.prepare;
    const spy = vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (this: Database.Database, sql: string) {
      if (sql.startsWith('INSERT OR IGNORE INTO vault_meta')) {
        spy.mockRestore();
        const other = raw();
        other.prepare("INSERT INTO vault_meta (key, value) VALUES ('key_check', ?)").run(row);
        other.close();
      }
      return real.call(this, sql);
    });
    try { return open(key); } finally { spy.mockRestore(); }
  };
  const takeCheckRow = (): Buffer => {
    const db = raw();
    try {
      const v = (db.prepare("SELECT value FROM vault_meta WHERE key = 'key_check'").get() as { value: Buffer }).value;
      db.prepare("DELETE FROM vault_meta WHERE key = 'key_check'").run();
      return v;
    } finally { db.close(); }
  };

  it('two opens at once: the row written first stands, and the second open is held to it', () => {
    legacyVault({ P1: 'one' });
    open(KEY_A).close();
    const first = takeCheckRow();   // the row a concurrent open under A writes
    openRacing(KEY_A, first).close();   // no primary-key error, the row that stands is checked
    const db = raw();
    const stood = (db.prepare("SELECT value FROM vault_meta WHERE key = 'key_check'").get() as { value: Buffer }).value;
    db.close();
    expect(stood.equals(first)).toBe(true);
  });

  it('two opens at once under different keys: the later one is refused by the row that stands', () => {
    legacyVault({ P1: 'one' });
    open(KEY_A).close();
    const first = takeCheckRow();
    const forged = Buffer.from(first);
    forged[forged.length - 1] ^= 0xff;   // a row no key here opens, as one written under another key
    expect(() => openRacing(KEY_A, forged)).toThrow(VaultKeyMismatchError);
  });

  it('legacy vault, every entry decrypts: writes the check row', () => {
    legacyVault({ P1: 'one', P2: 'two' });
    expect(checkRows()).toBe(0);
    open(KEY_A).close();
    expect(checkRows()).toBe(1);
    expect(() => open(KEY_B)).toThrow(VaultKeyMismatchError);
  });

  it('legacy vault, no entry decrypts: refuses the key and writes no check row', () => {
    legacyVault({ P1: 'one' });
    expect(() => open(KEY_B)).toThrow(VaultKeyMismatchError);
    expect(checkRows(), 'the foreign key is not fixed as the right one').toBe(0);
    open(KEY_A).close();
    expect(checkRows()).toBe(1);
  });

  it('legacy vault holding entries under two keys: opens, writes no check row, counts the foreign entry', () => {
    legacyVault({ P1: 'one' });
    plantForeignRow('FROM_B');
    const v = open(KEY_A);
    expect(v.undecryptableCount()).toBe(1);
    expect(v.get('P1')).toBe('one');
    v.close();
    expect(checkRows(), 'a mixed vault is not stamped with the key loaded now').toBe(0);
  });

  it('rotateVault re-keys the check row: the new key opens, the old key is refused', () => {
    const a = open(KEY_A);
    a.set('P1', 'one');
    a.close();
    expect(SecretVault.rotateVault(path, KEY_A, KEY_B)).toBe(1);
    expect(checkRows()).toBe(1);
    const b = open(KEY_B);
    expect(b.get('P1')).toBe('one');
    b.close();
    expect(() => open(KEY_A)).toThrow(VaultKeyMismatchError);
  });

  it('names the directory, the way back and, for a lost key, how to start over without lynox deleting anything', () => {
    const text = vaultKeyMismatchText(dir);
    expect(text).toContain(`(vault.db in ${dir})`);
    expect(text).toContain('Set LYNOX_VAULT_KEY to the key the vault was created with');
    expect(text).toContain('move vault.db, vault.db-wal and vault.db-shm out of the data directory');
    expect(text).toContain('Keep the moved files');
    const a = open(KEY_A);
    a.set('P1', 'one');
    a.close();
    let thrown: unknown;
    try { open(KEY_B); } catch (err) { thrown = err; }
    expect(thrown).toBeInstanceOf(VaultKeyMismatchError);
    expect((thrown as Error).message).toBe(text);
  });
});

describe('boot: a vault key that does not open the vault stops the start', () => {
  const KEY_A = 'vault-key-a-000000000000000000000000';
  const KEY_B = 'vault-key-b-111111111111111111111111';
  const MARKER = 'LYNOX_LLM_ENDPOINT_SLOT_MIGRATION';
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-vault-boot-'));
    vi.stubEnv('LYNOX_DATA_DIR', dir);
    vi.stubEnv('LYNOX_BILLING_TIER', '');
    vi.stubEnv('LYNOX_MANAGED_MODE', '');
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('MISTRAL_API_KEY', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  const seed = (): void => {
    const v = new SecretVault({ path: getVaultDbPath(), masterKey: KEY_A });
    v.set('PROBE_A', 'alpha');
    v.close();
  };

  it('assertVaultKeyOpensVault throws on a foreign key and passes on the vault\'s own key', () => {
    seed();
    vi.stubEnv('LYNOX_VAULT_KEY', KEY_B);
    expect(() => assertVaultKeyOpensVault()).toThrow(VaultKeyMismatchError);
    vi.stubEnv('LYNOX_VAULT_KEY', KEY_A);
    expect(() => assertVaultKeyOpensVault()).not.toThrow();
  });

  it('assertVaultKeyOpensVault creates no vault where none is', () => {
    vi.stubEnv('LYNOX_VAULT_KEY', KEY_A);
    assertVaultKeyOpensVault();
    expect(existsSync(getVaultDbPath())).toBe(false);
  });

  it('initSecrets passes the mismatch on, and the slot-migration marker is not written under the foreign key', () => {
    seed();
    vi.stubEnv('LYNOX_VAULT_KEY', KEY_B);
    expect(() => initSecrets({})).toThrow(VaultKeyMismatchError);
    const a = new SecretVault({ path: getVaultDbPath(), masterKey: KEY_A });
    expect(a.has(MARKER)).toBe(false);
    expect(a.undecryptableCount()).toBe(0);
    a.close();
  });

  it('CONTROL: under the vault\'s own key initSecrets opens the vault and writes the marker', () => {
    seed();
    vi.stubEnv('LYNOX_VAULT_KEY', KEY_A);
    const result = initSecrets({});
    expect(result.vault).not.toBeNull();
    result.vault?.close();
    const a = new SecretVault({ path: getVaultDbPath(), masterKey: KEY_A });
    expect(a.has(MARKER)).toBe(true);
    a.close();
  });

  it('initSecrets keeps every other vault error as before: no vault, the start goes on', () => {
    // A directory where the vault file belongs: opening it fails, and not because of the key.
    mkdirSync(getVaultDbPath(), { recursive: true });
    vi.stubEnv('LYNOX_VAULT_KEY', KEY_A);
    const result = initSecrets({});
    expect(result.vault).toBeNull();
    expect(result.store, 'the store is built without the vault, as before').not.toBeNull();
  });

  it('initSecrets keeps an error after the vault as before: no store, the start goes on', () => {
    vi.stubEnv('LYNOX_VAULT_KEY', KEY_A);
    const config = {} as Record<string, unknown>;
    Object.defineProperty(config, 'provider', { get() { throw new Error('config read failed'); } });
    let result: ReturnType<typeof initSecrets> | undefined;
    expect(() => { result = initSecrets(config); }).not.toThrow();
    expect(result?.store).toBeNull();
  });
});
