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
  return mkdtempSync(join(tmpdir(), 'nodyn-backup-test-'));
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
  let nodynDir: string;
  let backupDir: string;
  let manager: BackupManager;

  beforeEach(() => {
    nodynDir = createTmpDir();
    backupDir = join(nodynDir, 'backups');

    // Create test data
    createTestSqlite(join(nodynDir, 'history.db'));
    mkdirSync(join(nodynDir, 'memory', '_global'), { recursive: true });
    writeFileSync(join(nodynDir, 'memory', '_global', 'facts.txt'), 'User is a developer');
    writeFileSync(join(nodynDir, 'config.json'), JSON.stringify({ default_tier: 'sonnet' }));

    manager = new BackupManager(nodynDir, {
      backupDir,
      retentionDays: 30,
      encrypt: false,
    }, null);
  });

  afterEach(() => {
    rmSync(nodynDir, { recursive: true, force: true });
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
    expect(config['default_tier']).toBe('sonnet');
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
    writeFileSync(join(nodynDir, 'config.json'), JSON.stringify({ default_tier: 'opus' }));

    const result = await manager.restoreBackup(backup.path);
    expect(result.success).toBe(true);
    expect(result.pre_restore_backup_path).toBeTruthy();
    expect(existsSync(result.pre_restore_backup_path)).toBe(true);

    // Config should be restored to original
    const config = JSON.parse(readFileSync(join(nodynDir, 'config.json'), 'utf-8')) as Record<string, unknown>;
    expect(config['default_tier']).toBe('sonnet');
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
  let nodynDir: string;
  let backupDir: string;
  let manager: BackupManager;
  const VAULT_KEY = 'test-vault-key-for-backup-encryption';

  beforeEach(() => {
    nodynDir = createTmpDir();
    backupDir = join(nodynDir, 'backups');

    createTestSqlite(join(nodynDir, 'history.db'));
    writeFileSync(join(nodynDir, 'config.json'), '{"api_key":"secret"}');

    manager = new BackupManager(nodynDir, {
      backupDir,
      retentionDays: 30,
      encrypt: true,
    }, VAULT_KEY);
  });

  afterEach(() => {
    rmSync(nodynDir, { recursive: true, force: true });
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
    writeFileSync(join(nodynDir, 'config.json'), '{"api_key":"changed"}');

    const result = await manager.restoreBackup(backup.path);
    expect(result.success).toBe(true);

    // Should be decrypted back to original
    const config = JSON.parse(readFileSync(join(nodynDir, 'config.json'), 'utf-8')) as Record<string, unknown>;
    expect(config['api_key']).toBe('secret');
  });
});
