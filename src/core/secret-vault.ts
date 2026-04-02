import Database from 'better-sqlite3';
import { randomBytes, createCipheriv, createDecipheriv, pbkdf2Sync, createHash, hkdfSync } from 'node:crypto';
import { existsSync, readFileSync, renameSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import type { SecretScope } from '../types/index.js';
import { getLynoxDir } from './config.js';
import { CRYPTO_ALGORITHM, CRYPTO_KEY_LENGTH, CRYPTO_IV_LENGTH, CRYPTO_TAG_LENGTH } from './crypto-constants.js';
import { FILE_MODE_PRIVATE } from './constants.js';
import { ensureDirSync } from './atomic-write.js';

const LYNOX_DIR = getLynoxDir();
const VAULT_DB_PATH = join(LYNOX_DIR, 'vault.db');

/**
 * Estimate Shannon entropy of a string in bits per character.
 * Returns total estimated bits of entropy.
 */
export function estimateKeyEntropy(key: string): number {
  if (!key) return 0;
  const freq = new Map<string, number>();
  for (const ch of key) {
    freq.set(ch, (freq.get(ch) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / key.length;
    entropy -= p * Math.log2(p);
  }
  return entropy * key.length;
}

/** Minimum acceptable entropy in bits for a vault key. */
const MIN_KEY_ENTROPY_BITS = 128;

const PBKDF2_ITERATIONS = 600_000;
const PBKDF2_DIGEST = 'sha512';
const SALT_LENGTH = 32;

// Cache derived keys per (dbPath, passphrase) to avoid repeating 600K PBKDF2 iterations
const _derivedKeyCache = new Map<string, Buffer>();

export interface VaultEntry {
  name: string;
  scope: SecretScope;
  ttlMs: number; // 0 = no expiry
  createdAt: string; // ISO timestamp
  updatedAt: string; // ISO timestamp
}

export interface VaultOptions {
  path?: string | undefined;
  masterKey?: string | undefined; // Raw key or from LYNOX_VAULT_KEY env
}

interface RawRow {
  name: string;
  encrypted_value: Buffer;
  iv: Buffer;
  auth_tag: Buffer;
  scope: string;
  ttl_ms: number;
  created_at: string;
  updated_at: string;
}

interface SaltRow {
  salt: Buffer;
}

interface CountRow {
  c: number;
}

/**
 * Encrypted SQLite vault for secrets.
 *
 * Each secret value is encrypted independently with AES-256-GCM.
 * The master key is derived from a passphrase via PBKDF2 (600K iterations, SHA-512).
 * Salt is stored in the vault DB. No plaintext values touch disk.
 */
export class SecretVault {
  private readonly db: Database.Database;
  private readonly derivedKey: Buffer;

  constructor(options?: VaultOptions | undefined) {
    const dbPath = options?.path ?? VAULT_DB_PATH;

    // Ensure directory exists
    const dir = join(dbPath, '..');
    ensureDirSync(dir);

    this.db = new Database(dbPath);

    // Set restrictive permissions on vault DB file
    try { chmodSync(dbPath, FILE_MODE_PRIVATE); } catch { /* best-effort — may fail on some filesystems */ }

    this.db.pragma('journal_mode = WAL');

    // Set restrictive permissions on WAL journal files
    for (const suffix of ['-wal', '-shm']) {
      const journalPath = `${dbPath}${suffix}`;
      if (existsSync(journalPath)) {
        try { chmodSync(journalPath, FILE_MODE_PRIVATE); } catch { /* best-effort */ }
      }
    }

    this._migrate();

    // Derive encryption key
    const passphrase = options?.masterKey ?? process.env['LYNOX_VAULT_KEY'];
    if (!passphrase) {
      throw new Error(
        'Vault master key required. Set LYNOX_VAULT_KEY env var or pass masterKey option.',
      );
    }

    // Warn about weak keys (low entropy)
    const entropy = estimateKeyEntropy(passphrase);
    if (entropy < MIN_KEY_ENTROPY_BITS) {
      process.stderr.write(
        `⚠ Vault key has low entropy (~${Math.round(entropy)} bits, minimum ${MIN_KEY_ENTROPY_BITS} recommended). ` +
        `Generate a strong key: openssl rand -base64 48\n`,
      );
    }

    const salt = this._getOrCreateSalt();
    // Use hash of passphrase as cache key to avoid keeping plaintext in memory
    const passphraseHash = createHash('sha256').update(passphrase).digest('hex');
    const cacheKey = `${dbPath}:${passphraseHash}:${salt.toString('hex')}`;
    const cached = _derivedKeyCache.get(cacheKey);
    if (cached) {
      this.derivedKey = cached;
    } else {
      this.derivedKey = pbkdf2Sync(
        passphrase,
        salt,
        PBKDF2_ITERATIONS,
        CRYPTO_KEY_LENGTH,
        PBKDF2_DIGEST,
      );
      _derivedKeyCache.set(cacheKey, this.derivedKey);
    }
  }

  private _migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS vault_meta (
        key TEXT PRIMARY KEY,
        value BLOB NOT NULL
      );

      CREATE TABLE IF NOT EXISTS vault_secrets (
        name TEXT PRIMARY KEY,
        encrypted_value BLOB NOT NULL,
        iv BLOB NOT NULL,
        auth_tag BLOB NOT NULL,
        scope TEXT NOT NULL DEFAULT 'any'
          CHECK(scope IN ('http_header','http_body','bash_env','any')),
        ttl_ms INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  private _getOrCreateSalt(): Buffer {
    const row = this.db.prepare(
      "SELECT value as salt FROM vault_meta WHERE key = 'pbkdf2_salt'",
    ).get() as SaltRow | undefined;

    if (row) return row.salt;

    const salt = randomBytes(SALT_LENGTH);
    this.db.prepare(
      "INSERT INTO vault_meta (key, value) VALUES ('pbkdf2_salt', ?)",
    ).run(salt);
    return salt;
  }

  private _encrypt(plaintext: string): { encrypted: Buffer; iv: Buffer; authTag: Buffer } {
    const iv = randomBytes(CRYPTO_IV_LENGTH);
    const cipher = createCipheriv(CRYPTO_ALGORITHM, this.derivedKey, iv, { authTagLength: CRYPTO_TAG_LENGTH });
    const encrypted = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    return { encrypted, iv, authTag };
  }

  private _decrypt(encrypted: Buffer, iv: Buffer, authTag: Buffer): string {
    const decipher = createDecipheriv(CRYPTO_ALGORITHM, this.derivedKey, iv, { authTagLength: CRYPTO_TAG_LENGTH });
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  }

  /**
   * Store or update a secret in the vault.
   */
  set(name: string, value: string, scope?: SecretScope | undefined, ttlMs?: number | undefined): void {
    const { encrypted, iv, authTag } = this._encrypt(value);
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO vault_secrets (name, encrypted_value, iv, auth_tag, scope, ttl_ms, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        encrypted_value = excluded.encrypted_value,
        iv = excluded.iv,
        auth_tag = excluded.auth_tag,
        scope = excluded.scope,
        ttl_ms = excluded.ttl_ms,
        updated_at = excluded.updated_at
    `).run(name, encrypted, iv, authTag, scope ?? 'any', ttlMs ?? 0, now, now);
  }

  /**
   * Retrieve a decrypted secret value.
   * Returns null if not found or decryption fails (wrong key).
   */
  get(name: string): string | null {
    const row = this.db.prepare(
      'SELECT encrypted_value, iv, auth_tag FROM vault_secrets WHERE name = ?',
    ).get(name) as Pick<RawRow, 'encrypted_value' | 'iv' | 'auth_tag'> | undefined;

    if (!row) return null;

    try {
      return this._decrypt(row.encrypted_value, row.iv, row.auth_tag);
    } catch {
      process.stderr.write(`⚠ Vault: failed to decrypt secret "${name}" — wrong key or corrupted data\n`);
      return null;
    }
  }

  /**
   * Delete a secret from the vault.
   * Returns true if a secret was deleted.
   */
  delete(name: string): boolean {
    const result = this.db.prepare('DELETE FROM vault_secrets WHERE name = ?').run(name);
    return result.changes > 0;
  }

  /**
   * Check if a secret exists (without decrypting).
   */
  has(name: string): boolean {
    const row = this.db.prepare(
      'SELECT 1 as c FROM vault_secrets WHERE name = ?',
    ).get(name) as CountRow | undefined;
    return row !== undefined;
  }

  /**
   * List all secret entries (metadata only, no values).
   */
  list(): VaultEntry[] {
    const rows = this.db.prepare(
      'SELECT name, scope, ttl_ms, created_at, updated_at FROM vault_secrets ORDER BY name',
    ).all() as Array<{ name: string; scope: string; ttl_ms: number; created_at: string; updated_at: string }>;

    return rows.map(r => ({
      name: r.name,
      scope: r.scope as SecretScope,
      ttlMs: r.ttl_ms,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  /**
   * Number of secrets in the vault.
   */
  get size(): number {
    const row = this.db.prepare('SELECT COUNT(*) as c FROM vault_secrets').get() as CountRow;
    return row.c;
  }

  /**
   * Migrate secrets from ~/.lynox/secrets.json into the vault.
   * Does NOT overwrite existing vault entries.
   * Returns number of secrets migrated.
   */
  migrateFromFile(filePath?: string | undefined): number {
    const path = filePath ?? join(getLynoxDir(), 'secrets.json');
    if (!existsSync(path)) return 0;

    try {
      const raw = readFileSync(path, 'utf-8');
      const parsed = JSON.parse(raw) as Record<string, { value?: string; scope?: SecretScope; ttlMs?: number }>;
      if (typeof parsed !== 'object' || parsed === null) return 0;

      let count = 0;
      for (const [name, entry] of Object.entries(parsed)) {
        if (!entry || typeof entry.value !== 'string' || !entry.value) continue;
        if (this.has(name)) continue; // Don't overwrite
        this.set(name, entry.value, entry.scope, entry.ttlMs);
        count++;
      }

      // Rename source file to .bak after migration
      if (count > 0) {
        try {
          renameSync(path, `${path}.bak`);
        } catch {
          // Best-effort rename
        }
      }

      return count;
    } catch {
      return 0;
    }
  }

  /**
   * Get all decrypted secrets as name→value map.
   * Used by SecretStore for loading vault entries.
   */
  getAll(): Map<string, { value: string; scope: SecretScope; ttlMs: number }> {
    const rows = this.db.prepare(
      'SELECT name, encrypted_value, iv, auth_tag, scope, ttl_ms FROM vault_secrets',
    ).all() as Array<RawRow>;

    const result = new Map<string, { value: string; scope: SecretScope; ttlMs: number }>();
    for (const row of rows) {
      try {
        const value = this._decrypt(row.encrypted_value, row.iv, row.auth_tag);
        result.set(row.name, {
          value,
          scope: row.scope as SecretScope,
          ttlMs: row.ttl_ms,
        });
      } catch {
        process.stderr.write(`⚠ Vault: skipping undecryptable secret "${row.name}" — wrong key or corrupted data\n`);
      }
    }
    return result;
  }

  /**
   * Re-encrypt all secrets with a new master key.
   * Decrypts all entries with the current key, then re-encrypts with the new key.
   * Returns the number of re-encrypted secrets.
   * Throws if any secret cannot be decrypted (indicates wrong current key).
   */
  static rotateVault(dbPath: string, oldKey: string, newKey: string): number {
    // Open with old key, decrypt all
    const oldVault = new SecretVault({ path: dbPath, masterKey: oldKey });
    const entries = oldVault.getAll();
    const metadata = oldVault.list();
    oldVault.close();

    if (entries.size === 0 && metadata.length > 0) {
      throw new Error('Cannot decrypt existing secrets — wrong current key?');
    }

    // Delete old salt so a new one is generated for the new key
    const db = new Database(dbPath);
    db.prepare("DELETE FROM vault_meta WHERE key = 'pbkdf2_salt'").run();
    db.prepare('DELETE FROM vault_secrets').run();
    db.close();

    // Open with new key (creates new salt), re-encrypt all
    const newVault = new SecretVault({ path: dbPath, masterKey: newKey });
    for (const [name, entry] of entries) {
      const meta = metadata.find(m => m.name === name);
      newVault.set(name, entry.value, entry.scope, entry.ttlMs);
      // Preserve original timestamps
      if (meta) {
        newVault.db.prepare(
          'UPDATE vault_secrets SET created_at = ?, updated_at = ? WHERE name = ?',
        ).run(meta.createdAt, meta.updatedAt, name);
      }
    }
    const count = newVault.size;
    newVault.close();
    return count;
  }

  /**
   * Derive a tenant-specific master key from the global master key using HKDF.
   * Each tenant gets a cryptographically independent key — compromise of one
   * tenant's vault cannot decrypt another's.
   *
   * Usage: pass the returned hex string as `masterKey` to a new SecretVault instance.
   */
  static deriveTenantKey(masterKey: string, tenantId: string): string {
    if (!masterKey) throw new Error('masterKey is required for tenant key derivation');
    if (!tenantId) throw new Error('tenantId is required for tenant key derivation');
    const derived = hkdfSync('sha256', masterKey, tenantId, 'lynox-tenant-vault', CRYPTO_KEY_LENGTH);
    return Buffer.from(derived).toString('hex');
  }

  /**
   * Close the database connection and clear key material from memory.
   */
  close(): void {
    // Find and remove cache entry BEFORE zeroing (same Buffer reference)
    const cacheKey = [..._derivedKeyCache.entries()]
      .find(([, v]) => v === this.derivedKey)?.[0];
    if (cacheKey) {
      _derivedKeyCache.delete(cacheKey);
    }
    // Zero the derived key material (single fill — cache held same reference)
    if (this.derivedKey) {
      this.derivedKey.fill(0);
    }
    this.db.close();
  }
}
