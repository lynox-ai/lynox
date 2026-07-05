import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { BackupManager } from './backup.js';
import { deriveBackupKey, encryptFile, decryptFile, isEncryptedBackupFile } from './backup-crypto.js';
import { computeFileChecksum, verifySqliteIntegrity } from './backup-verify.js';

function createTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'lynox-backup-test-'));
}

function createTestSqlite(path: string): void {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.prepare('CREATE TABLE test (id INTEGER PRIMARY KEY, value TEXT)').run();
  db.prepare("INSERT INTO test VALUES (1, 'hello')").run();
  db.prepare("INSERT INTO test VALUES (2, 'world')").run();
  db.close();
}

describe('backup-crypto', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = createTmpDir(); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('deriveBackupKey produces 32-byte key', () => {
    const key = deriveBackupKey('test-vault-key-123');
    expect(key).toBeInstanceOf(Buffer);
    expect(key.length).toBe(32);
  });

  it('deriveBackupKey is deterministic', () => {
    const key1 = deriveBackupKey('same-key');
    const key2 = deriveBackupKey('same-key');
    expect(key1.equals(key2)).toBe(true);
  });

  it('deriveBackupKey differs for different vault keys', () => {
    const key1 = deriveBackupKey('key-a');
    const key2 = deriveBackupKey('key-b');
    expect(key1.equals(key2)).toBe(false);
  });

  it('encrypt and decrypt round-trip', () => {
    const srcFile = join(tmpDir, 'plain.txt');
    const encFile = join(tmpDir, 'encrypted.bin');
    const decFile = join(tmpDir, 'decrypted.txt');
    const original = 'Hello, World! This is a test file with some content.';
    writeFileSync(srcFile, original);

    const key = deriveBackupKey('test-key');
    encryptFile(srcFile, encFile, key);

    // Encrypted file should differ from original
    const encContent = readFileSync(encFile);
    expect(encContent.toString()).not.toBe(original);
    expect(isEncryptedBackupFile(encFile)).toBe(true);

    // Decrypt
    decryptFile(encFile, decFile, key);
    expect(readFileSync(decFile, 'utf-8')).toBe(original);
  });

  it('decrypt with wrong key throws', () => {
    const srcFile = join(tmpDir, 'plain.txt');
    const encFile = join(tmpDir, 'encrypted.bin');
    const decFile = join(tmpDir, 'decrypted.txt');
    writeFileSync(srcFile, 'secret data');

    const key1 = deriveBackupKey('correct-key');
    const key2 = deriveBackupKey('wrong-key');
    encryptFile(srcFile, encFile, key1);

    expect(() => decryptFile(encFile, decFile, key2)).toThrow();
  });

  it('isEncryptedBackupFile returns false for plain files', () => {
    const plainFile = join(tmpDir, 'plain.txt');
    writeFileSync(plainFile, 'not encrypted');
    expect(isEncryptedBackupFile(plainFile)).toBe(false);
  });
});

describe('backup-verify', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = createTmpDir(); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('computeFileChecksum is deterministic', () => {
    const file = join(tmpDir, 'test.txt');
    writeFileSync(file, 'consistent content');
    const c1 = computeFileChecksum(file);
    const c2 = computeFileChecksum(file);
    expect(c1).toBe(c2);
    expect(c1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('computeFileChecksum differs for different content', () => {
    const f1 = join(tmpDir, 'a.txt');
    const f2 = join(tmpDir, 'b.txt');
    writeFileSync(f1, 'content A');
    writeFileSync(f2, 'content B');
    expect(computeFileChecksum(f1)).not.toBe(computeFileChecksum(f2));
  });

  it('verifySqliteIntegrity returns true for valid db', () => {
    const dbPath = join(tmpDir, 'valid.db');
    createTestSqlite(dbPath);
    expect(verifySqliteIntegrity(dbPath)).toBe(true);
  });

  it('verifySqliteIntegrity returns false for corrupt db', () => {
    const dbPath = join(tmpDir, 'corrupt.db');
    writeFileSync(dbPath, 'this is not a sqlite file');
    expect(verifySqliteIntegrity(dbPath)).toBe(false);
  });
});

describe('BackupManager', () => {
  let lynoxDir: string;
  let backupDir: string;
  let manager: BackupManager;

  beforeEach(() => {
    lynoxDir = createTmpDir();
    backupDir = join(lynoxDir, 'backups');

    // Create test data
    createTestSqlite(join(lynoxDir, 'history.db'));
    mkdirSync(join(lynoxDir, 'memory', '_global'), { recursive: true });
    writeFileSync(join(lynoxDir, 'memory', '_global', 'facts.txt'), 'User is a developer');
    writeFileSync(join(lynoxDir, 'config.json'), JSON.stringify({ default_tier: 'balanced' }));

    manager = new BackupManager(lynoxDir, {
      backupDir,
      retentionDays: 30,
      encrypt: false,
    }, null);
  });

  afterEach(() => {
    rmSync(lynoxDir, { recursive: true, force: true });
  });

  it('createBackup produces a valid backup', async () => {
    const result = await manager.createBackup();
    expect(result.success).toBe(true);
    expect(result.path).toBeTruthy();
    expect(result.manifest.files.length).toBeGreaterThan(0);
    expect(result.manifest.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);

    // Manifest written
    expect(existsSync(join(result.path, 'manifest.json'))).toBe(true);
  });

  it('createBackup uses VACUUM INTO for SQLite (produces valid copy)', async () => {
    const result = await manager.createBackup();
    expect(result.success).toBe(true);

    // Find the history.db in backup
    const historyEntry = result.manifest.files.find(f => f.path === 'history.db');
    expect(historyEntry).toBeDefined();
    expect(historyEntry!.type).toBe('sqlite');

    // Verify the backup copy is valid SQLite
    const backupDbPath = join(result.path, 'history.db');
    expect(verifySqliteIntegrity(backupDbPath)).toBe(true);

    // Verify data was copied
    const db = new Database(backupDbPath, { readonly: true });
    const rows = db.prepare('SELECT COUNT(*) as cnt FROM test').get() as { cnt: number };
    expect(rows.cnt).toBe(2);
    db.close();
  });

  it('createBackup copies memory files', async () => {
    const result = await manager.createBackup();
    expect(result.success).toBe(true);
    expect(existsSync(join(result.path, 'memory', '_global', 'facts.txt'))).toBe(true);
    expect(readFileSync(join(result.path, 'memory', '_global', 'facts.txt'), 'utf-8')).toBe('User is a developer');
  });

  it('createBackup copies config.json', async () => {
    const result = await manager.createBackup();
    expect(result.success).toBe(true);
    expect(existsSync(join(result.path, 'config.json'))).toBe(true);
    const config = JSON.parse(readFileSync(join(result.path, 'config.json'), 'utf-8')) as Record<string, unknown>;
    expect(config['default_tier']).toBe('balanced');
  });

  it('createBackup skips missing databases gracefully', async () => {
    // vault.db and datastore.db don't exist — should not fail
    const result = await manager.createBackup();
    expect(result.success).toBe(true);
    expect(result.manifest.files.find(f => f.path === 'vault.db')).toBeUndefined();
    expect(result.manifest.files.find(f => f.path === 'datastore.db')).toBeUndefined();
  });

  it('verifyBackup passes for freshly created backup', async () => {
    const result = await manager.createBackup();
    expect(result.success).toBe(true);
    const verification = manager.verifyBackup(result.path);
    expect(verification.valid).toBe(true);
    expect(verification.files_checked).toBeGreaterThan(0);
    expect(verification.errors).toHaveLength(0);
  });

  it('verifyBackup fails for missing manifest', () => {
    const fakeDir = join(backupDir, 'fake');
    mkdirSync(fakeDir, { recursive: true });
    const verification = manager.verifyBackup(fakeDir);
    expect(verification.valid).toBe(false);
    expect(verification.errors).toContain('Missing manifest.json');
  });

  it('listBackups returns backups sorted newest first', async () => {
    await manager.createBackup();
    // Small delay to ensure different timestamps
    await new Promise(r => setTimeout(r, 50));
    await manager.createBackup();

    const list = manager.listBackups();
    expect(list.length).toBe(2);
    expect(new Date(list[0]!.created_at).getTime()).toBeGreaterThanOrEqual(
      new Date(list[1]!.created_at).getTime(),
    );
  });

  it('pruneBackups with retentionDays=0 is disabled', async () => {
    await manager.createBackup();
    await new Promise(r => setTimeout(r, 50));
    await manager.createBackup();

    // retention=0 means disabled
    const pruned = manager.pruneBackups(0);
    expect(pruned).toBe(0);
    expect(manager.listBackups().length).toBe(2);
  });

  it('restoreBackup creates safety backup first', async () => {
    const backup = await manager.createBackup();
    expect(backup.success).toBe(true);

    // Modify the source data
    writeFileSync(join(lynoxDir, 'config.json'), JSON.stringify({ default_tier: 'deep' }));

    const result = await manager.restoreBackup(backup.path);
    expect(result.success).toBe(true);
    expect(result.pre_restore_backup_path).toBeTruthy();
    expect(existsSync(result.pre_restore_backup_path)).toBe(true);

    // Config should be restored to original
    const config = JSON.parse(readFileSync(join(lynoxDir, 'config.json'), 'utf-8')) as Record<string, unknown>;
    expect(config['default_tier']).toBe('balanced');
  });

  it('restoreBackup fails gracefully with missing manifest', async () => {
    const fakeDir = join(backupDir, 'fake');
    mkdirSync(fakeDir, { recursive: true });
    const result = await manager.restoreBackup(fakeDir);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Missing manifest.json');
  });
});

describe('BackupManager (encrypted)', () => {
  let lynoxDir: string;
  let backupDir: string;
  let manager: BackupManager;
  const VAULT_KEY = 'test-vault-key-for-backup-encryption';

  beforeEach(() => {
    lynoxDir = createTmpDir();
    backupDir = join(lynoxDir, 'backups');

    createTestSqlite(join(lynoxDir, 'history.db'));
    writeFileSync(join(lynoxDir, 'config.json'), '{"api_key":"secret"}');

    manager = new BackupManager(lynoxDir, {
      backupDir,
      retentionDays: 30,
      encrypt: true,
    }, VAULT_KEY);
  });

  afterEach(() => {
    rmSync(lynoxDir, { recursive: true, force: true });
  });

  it('creates encrypted backup', async () => {
    const result = await manager.createBackup();
    expect(result.success).toBe(true);
    expect(result.manifest.encrypted).toBe(true);

    // Config file in backup should be encrypted (not readable as JSON)
    const backupConfigPath = join(result.path, 'config.json');
    expect(isEncryptedBackupFile(backupConfigPath)).toBe(true);
  });

  it('restore decrypts encrypted backup', async () => {
    const backup = await manager.createBackup();
    expect(backup.success).toBe(true);

    // Modify source
    writeFileSync(join(lynoxDir, 'config.json'), '{"api_key":"changed"}');

    const result = await manager.restoreBackup(backup.path);
    expect(result.success).toBe(true);

    // Should be decrypted back to original
    const config = JSON.parse(readFileSync(join(lynoxDir, 'config.json'), 'utf-8')) as Record<string, unknown>;
    expect(config['api_key']).toBe('secret');
  });
});

describe('restoreBackup safety guards', () => {
  let lynoxDir: string;
  let backupDir: string;

  beforeEach(() => {
    lynoxDir = createTmpDir();
    backupDir = join(lynoxDir, 'backups');
    createTestSqlite(join(lynoxDir, 'history.db'));
    writeFileSync(join(lynoxDir, 'config.json'), JSON.stringify({ default_tier: 'balanced' }));
  });

  afterEach(() => { rmSync(lynoxDir, { recursive: true, force: true }); });

  function liveRowCount(): number {
    const db = new Database(join(lynoxDir, 'history.db'), { readonly: true });
    try {
      return (db.prepare('SELECT COUNT(*) as cnt FROM test').get() as { cnt: number }).cnt;
    } finally {
      db.close();
    }
  }

  it('refuses to restore an encrypted backup when the vault key is missing (no ciphertext over live DBs)', async () => {
    // Make an ENCRYPTED backup with a key.
    const encManager = new BackupManager(lynoxDir, { backupDir, retentionDays: 30, encrypt: true }, 'vault-key-xyz');
    const created = await encManager.createBackup();
    expect(created.success).toBe(true);
    expect(created.manifest.encrypted).toBe(true);

    // A fresh manager with NO key attempts the restore.
    const keyless = new BackupManager(lynoxDir, { backupDir, retentionDays: 30, encrypt: false }, null);
    const result = await keyless.restoreBackup(created.path);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/encrypted|key/i);
    // Live DB untouched — still valid SQLite with its 2 rows, NOT overwritten
    // with raw ciphertext (the pre-fix `copyFileSync` branch).
    expect(verifySqliteIntegrity(join(lynoxDir, 'history.db'))).toBe(true);
    expect(liveRowCount()).toBe(2);
  });

  it('refuses to restore an encrypted backup with the WRONG key before any live write', async () => {
    // Encrypted backup made with key A.
    const encManager = new BackupManager(lynoxDir, { backupDir, retentionDays: 30, encrypt: true }, 'vault-key-A');
    const created = await encManager.createBackup();
    expect(created.success).toBe(true);

    // A manager holding a DIFFERENT key attempts the restore — checksum verify
    // passes (ciphertext intact) but decrypt would AES-GCM-fail mid-loop.
    const wrongKey = new BackupManager(lynoxDir, { backupDir, retentionDays: 30, encrypt: true }, 'vault-key-B-different');
    const result = await wrongKey.restoreBackup(created.path);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/does not match this backup/i); // the key pre-flight message
    // Live DB untouched — the wrong key is caught BEFORE the destructive loop.
    expect(verifySqliteIntegrity(join(lynoxDir, 'history.db'))).toBe(true);
    expect(liveRowCount()).toBe(2);
  });

  it('refuses to restore a corrupt/truncated backup (verify-before-restore)', async () => {
    const manager = new BackupManager(lynoxDir, { backupDir, retentionDays: 30, encrypt: false }, null);
    const created = await manager.createBackup();
    expect(created.success).toBe(true);

    // Corrupt a backup file so its checksum no longer matches the manifest.
    writeFileSync(join(created.path, 'history.db'), 'CORRUPTED');

    const result = await manager.restoreBackup(created.path);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/verification failed/i);
    expect(liveRowCount()).toBe(2); // live DB never overwritten from a bad archive
  });

  it('leaves ALL live files untouched when the restore fails part-way (stage+swap, not half-restored)', async () => {
    // A backup that passes verify + key pre-flight can still fail DURING the
    // apply (disk full, an I/O error, a decrypt that throws on a later file).
    // The restore must not overwrite live DBs one-by-one in place — that leaves
    // the data dir half old / half new (some DBs reverted, others still current).
    // With stage+swap, all copy/decrypt runs to sibling temp paths first, so a
    // failure staging a LATER file aborts before any live file is swapped.
    const manager = new BackupManager(lynoxDir, { backupDir, retentionDays: 30, encrypt: false }, null);
    const created = await manager.createBackup(); // snapshot: history.db=2 rows, config.default_tier=balanced
    expect(created.success).toBe(true);

    // Drift the LIVE state away from the backup so a real restore WOULD change
    // it — history.db → 4 rows, config → deep. The failed restore must leave
    // exactly THIS drifted state intact (neither reverted nor half-reverted).
    const live = new Database(join(lynoxDir, 'history.db'));
    live.prepare("INSERT INTO test VALUES (3, 'three')").run();
    live.prepare("INSERT INTO test VALUES (4, 'four')").run();
    live.close();
    writeFileSync(join(lynoxDir, 'config.json'), JSON.stringify({ default_tier: 'deep' }));

    // Force config.json's staging copy to fail mid-restore (AFTER history.db has
    // already staged) by occupying its staging temp path with a directory —
    // copyFileSync onto a directory throws EISDIR. (ESM blocks spying on fs, so
    // this real-filesystem sabotage is the deterministic stand-in for a disk
    // I/O error / ENOSPC on a later file.)
    mkdirSync(join(lynoxDir, 'config.json.restore-staging'), { recursive: true });

    const result = await manager.restoreBackup(created.path);
    expect(result.success).toBe(false);

    // history.db was NEVER reverted over the live DB: live still has its drifted
    // 4 rows, not the backup's 2. (The pre-fix in-place restore copied history.db
    // over live before config.json failed → this would have read 2, or the whole
    // restore would have "succeeded" and reverted live wholesale.)
    expect(liveRowCount()).toBe(4);
    // config.json likewise untouched — still the drifted value.
    const cfg = JSON.parse(readFileSync(join(lynoxDir, 'config.json'), 'utf-8')) as Record<string, unknown>;
    expect(cfg['default_tier']).toBe('deep');
    // The staged temp for history.db was cleaned up on the abort.
    expect(existsSync(join(lynoxDir, 'history.db.restore-staging'))).toBe(false);
  });
});
