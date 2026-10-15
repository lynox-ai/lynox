import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { BackupManager, isRestorableEntryPath } from './backup.js';
import { canonicalJson, deriveBackupKey, deriveManifestKey, encryptFile, decryptFile, isEncryptedBackupFile, manifestMac } from './backup-crypto.js';
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

  // The Art. 17 erasure refuses while `busy`: a backup or restore that is still running
  // when the stores are emptied writes their old content back afterwards.
  it('is busy while a backup or a restore runs, and not after either settles', async () => {
    expect(manager.busy).toBe(false);
    const backup = manager.createBackup();
    expect(manager.busy).toBe(true);
    const made = await backup;
    expect(manager.busy).toBe(false);

    const restore = manager.restoreBackup(made.path, { allowUnverified: true });
    expect(manager.busy).toBe(true);
    await restore;
    expect(manager.busy).toBe(false);

    await manager.restoreBackup(join(lynoxDir, 'no-such-backup'));
    expect(manager.busy).toBe(false);
  });

  it('counts a restore by itself, not only through the safety backup it takes', async () => {
    const made = await manager.createBackup();
    // The safety backup is the restore's one await; stubbed so it does not count, the
    // restore's own counter is all that can make `busy` true while it runs.
    let seen: boolean | undefined;
    vi.spyOn(manager, 'createBackup').mockImplementation(async () => {
      seen = manager.busy;
      return { success: false, path: '', manifest: made.manifest, duration_ms: 0, error: 'stub' };
    });
    await manager.restoreBackup(made.path, { allowUnverified: true });
    expect(seen).toBe(true);
    expect(manager.busy).toBe(false);
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

    const result = await manager.restoreBackup(backup.path, { allowUnverified: true });
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
    const result = await wrongKey.restoreBackup(created.path, { allowUnverified: true });

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

    const result = await manager.restoreBackup(created.path, { allowUnverified: true });
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

    const result = await manager.restoreBackup(created.path, { allowUnverified: true });
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

describe('restoreBackup refuses manifest paths that leave their place', () => {
  let lynoxDir: string;
  let backupDir: string;
  const escapees: string[] = [];

  beforeEach(() => {
    lynoxDir = createTmpDir();
    backupDir = join(lynoxDir, 'backups');
    writeFileSync(join(lynoxDir, 'config.json'), JSON.stringify({ default_tier: 'balanced' }));
  });

  afterEach(() => {
    rmSync(lynoxDir, { recursive: true, force: true });
    for (const p of escapees.splice(0)) rmSync(p, { force: true });
  });

  /** Adds an entry with `path` to a fresh backup's manifest, its bytes placed where the restore reads them. */
  async function backupWithEntry(path: string, bytes: string): Promise<{ manager: BackupManager; backupPath: string }> {
    const manager = new BackupManager(lynoxDir, { backupDir, retentionDays: 30, encrypt: false }, null);
    const created = await manager.createBackup();
    expect(created.success).toBe(true);
    const src = join(created.path, path);
    // Every directory the path names must exist in the backup, so an unchecked restore can
    // open it by name: `memory/..` resolves only through an existing `memory`.
    mkdirSync(join(created.path, 'memory'), { recursive: true });
    mkdirSync(dirname(src), { recursive: true });
    writeFileSync(src, bytes);
    const manifestPath = join(created.path, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as { files: Array<Record<string, unknown>> };
    manifest.files.push({ path, size_bytes: Buffer.byteLength(bytes), checksum_sha256: computeFileChecksum(src), type: 'file' });
    writeFileSync(manifestPath, JSON.stringify(manifest));
    return { manager, backupPath: created.path };
  }

  it('refuses a leading .. and writes nothing outside the data dir', async () => {
    const name = `${basename(lynoxDir)}-escaped.txt`;
    const outside = join(dirname(lynoxDir), name);
    escapees.push(outside, join(dirname(backupDir), name));
    const { manager, backupPath } = await backupWithEntry(`../${name}`, 'planted');
    const backupsBefore = manager.listBackups().length;

    const result = await manager.restoreBackup(backupPath);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/outside the backup/);
    expect(existsSync(outside)).toBe(false);
    // Refused before the restore's own work began: no safety backup was taken.
    expect(result.pre_restore_backup_path).toBe('');
    expect(manager.listBackups().length).toBe(backupsBefore);
  });

  it('refuses a .. inside the path, which resolves inside the data dir but leaves its entry', async () => {
    // A consistent backup: the bytes sit at their own file, so only the path is wrong.
    const { manager, backupPath } = await backupWithEntry('memory/../planted.txt', 'planted');

    const result = await manager.restoreBackup(backupPath);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/outside the backup/);
    expect(existsSync(join(lynoxDir, 'planted.txt'))).toBe(false);
  });

  it('restores the same backup when the added entry is a plain path (control)', async () => {
    const { manager, backupPath } = await backupWithEntry('memory/planted.txt', 'plain');

    const result = await manager.restoreBackup(backupPath, { allowUnverified: true });

    expect(result.success).toBe(true);
    expect(readFileSync(join(lynoxDir, 'memory', 'planted.txt'), 'utf-8')).toBe('plain');
  });

  it('verifyBackup reports the path instead of reading through it', async () => {
    const { manager, backupPath } = await backupWithEntry('memory/../planted.txt', 'planted');
    const result = manager.verifyBackup(backupPath);
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/outside the backup/);
  });

  it('refuses a manifest whose files is not a list, without throwing', async () => {
    const manager = new BackupManager(lynoxDir, { backupDir, retentionDays: 30, encrypt: false }, null);
    const created = await manager.createBackup();
    const manifestPath = join(created.path, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>;
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, files: { path: 'config.json' } }));

    const result = await manager.restoreBackup(created.path);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not a list/);
  });

  it('isRestorableEntryPath takes plain relative names only', () => {
    for (const ok of ['config.json', 'workspace/a/b.txt', '..env', 'a/.hidden', 'a..b/c']) {
      expect(isRestorableEntryPath(ok), ok).toBe(true);
    }
    for (const bad of ['', '/etc/passwd', '../x', 'a/../b', 'a/./b', './a', 'a//b', 'a/', 'a/..', 'a\0b', 7, null, undefined]) {
      expect(isRestorableEntryPath(bad), String(bad)).toBe(false);
    }
  });
});

describe('restoreBackup asks for the proof of origin', () => {
  let lynoxDir: string;
  let backupDir: string;
  const KEY = 'vault-key-provenance';

  beforeEach(() => {
    lynoxDir = createTmpDir();
    backupDir = join(lynoxDir, 'backups');
    writeFileSync(join(lynoxDir, 'config.json'), JSON.stringify({ default_tier: 'balanced' }));
  });

  afterEach(() => { rmSync(lynoxDir, { recursive: true, force: true }); });

  const mgr = (encrypt: boolean, key: string | null = KEY): BackupManager =>
    new BackupManager(lynoxDir, { backupDir, retentionDays: 30, encrypt }, key);

  function readManifest(path: string): Record<string, unknown> {
    return JSON.parse(readFileSync(join(path, 'manifest.json'), 'utf-8')) as Record<string, unknown>;
  }
  function writeManifest(path: string, manifest: Record<string, unknown>): void {
    writeFileSync(join(path, 'manifest.json'), JSON.stringify(manifest));
  }
  /** Drifts the live config so a restore that ran shows: the backup holds `balanced`. */
  function driftLive(): void {
    writeFileSync(join(lynoxDir, 'config.json'), JSON.stringify({ default_tier: 'deep' }));
  }
  const liveTier = (): unknown => (JSON.parse(readFileSync(join(lynoxDir, 'config.json'), 'utf-8')) as Record<string, unknown>)['default_tier'];

  it('signs every backup of an engine with a vault key, encrypted or not, and restores it without asking', async () => {
    for (const encrypt of [false, true]) {
      writeFileSync(join(lynoxDir, 'config.json'), JSON.stringify({ default_tier: 'balanced' }));
      const created = await mgr(encrypt).createBackup();
      expect(created.success).toBe(true);
      const manifest = readManifest(created.path);
      expect(manifest['auth']).toEqual({ alg: 'hmac-sha256', mac: manifestMac(manifest, deriveManifestKey(KEY)) });
      driftLive();

      const result = await mgr(encrypt).restoreBackup(created.path);

      expect(result.success, String(result.error)).toBe(true);
      expect(liveTier()).toBe('balanced');
    }
  });

  it('refuses a backup whose file list was changed, and restores it once the caller allows it', async () => {
    const created = await mgr(false).createBackup();
    const manifest = readManifest(created.path);
    // An extra entry, with its file and a matching checksum: everything a forger can do without the key.
    writeFileSync(join(created.path, 'planted.txt'), 'planted');
    (manifest['files'] as unknown[]).push({ path: 'planted.txt', size_bytes: 7, checksum_sha256: computeFileChecksum(join(created.path, 'planted.txt')), type: 'file' });
    writeManifest(created.path, manifest);
    driftLive();

    const refused = await mgr(false).restoreBackup(created.path);

    expect(refused.success).toBe(false);
    expect(refused.code).toBe('unverified_backup');
    expect(refused.provenance).toBe('mismatch');
    expect(refused.pre_restore_backup_path).toBe('');
    expect(existsSync(join(lynoxDir, 'planted.txt'))).toBe(false);
    expect(liveTier()).toBe('deep');

    const allowed = await mgr(false).restoreBackup(created.path, { allowUnverified: true });
    expect(allowed.success, String(allowed.error)).toBe(true);
    expect(readFileSync(join(lynoxDir, 'planted.txt'), 'utf-8')).toBe('planted');
  });

  it('refuses an encrypted backup whose manifest was turned to encrypted: false', async () => {
    const created = await mgr(true).createBackup();
    writeManifest(created.path, { ...readManifest(created.path), encrypted: false });
    driftLive();

    const refused = await mgr(true).restoreBackup(created.path);

    expect(refused.code).toBe('unverified_backup');
    expect(refused.provenance).toBe('mismatch');
    expect(liveTier()).toBe('deep');
  });

  it('refuses a backup without a signature, and one made under another vault key, until the caller allows it', async () => {
    const unsigned = await mgr(false).createBackup();
    const { auth: _auth, ...rest } = readManifest(unsigned.path);
    writeManifest(unsigned.path, rest);
    const none = await mgr(false).restoreBackup(unsigned.path);
    expect(none.code).toBe('unverified_backup');
    expect(none.provenance).toBe('none');
    expect(none.error).toMatch(/no proof of origin/);

    const foreign = await mgr(false, 'another-vault-key').createBackup();
    const other = await mgr(false).restoreBackup(foreign.path);
    expect(other.provenance).toBe('mismatch');
    expect(other.error).toMatch(/does not match this vault key/);

    driftLive();
    const allowed = await mgr(false).restoreBackup(unsigned.path, { allowUnverified: true });
    expect(allowed.success, String(allowed.error)).toBe(true);
    expect(liveTier()).toBe('balanced');
  });

  it('asks on an engine without a vault key, and restores once the caller allows it', async () => {
    const created = await mgr(false, null).createBackup();
    expect(readManifest(created.path)['auth']).toBeUndefined();
    driftLive();

    const refused = await mgr(false, null).restoreBackup(created.path);
    expect(refused.code).toBe('unverified_backup');
    expect(refused.provenance).toBe('no-key');
    expect(liveTier()).toBe('deep');

    const allowed = await mgr(false, null).restoreBackup(created.path, { allowUnverified: true });
    expect(allowed.success, String(allowed.error)).toBe(true);
    expect(liveTier()).toBe('balanced');
  });

  it('takes only the literal true as the caller allowing it', async () => {
    const created = await mgr(false, null).createBackup();
    const loose = await mgr(false, null).restoreBackup(created.path, { allowUnverified: 'yes' as unknown as boolean });
    expect(loose.code).toBe('unverified_backup');
  });

  it('refuses a plaintext file in an encrypted backup even when the caller allows an unverified one', async () => {
    const created = await mgr(true).createBackup();
    const manifest = readManifest(created.path);
    // Swap the ciphertext of config.json for plaintext and fix its entry: no key needed for that.
    writeFileSync(join(created.path, 'config.json'), JSON.stringify({ default_tier: 'planted' }));
    const entry = (manifest['files'] as Array<Record<string, unknown>>).find(e => e['path'] === 'config.json')!;
    entry['size_bytes'] = readFileSync(join(created.path, 'config.json')).length;
    entry['checksum_sha256'] = computeFileChecksum(join(created.path, 'config.json'));
    writeManifest(created.path, manifest);
    driftLive();

    const result = await mgr(true).restoreBackup(created.path, { allowUnverified: true });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/holds a file that is not/);
    expect(liveTier()).toBe('deep');
  });

  it('refuses a file swapped after the verify pass, read once and checked as staged', async () => {
    for (const encrypt of [false, true]) {
      writeFileSync(join(lynoxDir, 'config.json'), JSON.stringify({ default_tier: 'balanced' }));
      const manager = mgr(encrypt);
      const created = await manager.createBackup();
      driftLive();
      // The window between verify and staging is the safety backup; the swap lands inside it.
      const spy = vi.spyOn(manager, 'createBackup').mockImplementation(async () => {
        writeFileSync(join(created.path, 'config.json'), JSON.stringify({ default_tier: 'swapped' }));
        return { success: false, path: '', manifest: created.manifest, duration_ms: 0, error: 'stub' };
      });
      try {
        const result = await manager.restoreBackup(created.path);
        expect(result.success, `encrypt=${String(encrypt)}`).toBe(false);
        expect(result.error).toMatch(/changed after it was verified/);
        expect(liveTier()).toBe('deep');
      } finally {
        spy.mockRestore();
      }
    }
  });

  it('asks before it verifies the files: a backup without proof and with a missing file is a question, not a verify error', async () => {
    const created = await mgr(false).createBackup();
    const { auth: _auth, ...rest } = readManifest(created.path);
    writeManifest(created.path, rest);
    rmSync(join(created.path, 'config.json'));

    const result = await mgr(false).restoreBackup(created.path);

    expect(result.code).toBe('unverified_backup');
  });

  it('reads a malformed signature as a mismatch, without throwing', async () => {
    const created = await mgr(false).createBackup();
    const manifest = readManifest(created.path);
    const mac = (manifest['auth'] as { mac: string }).mac;
    for (const auth of [null, [], { alg: 'sha1', mac }, { alg: 'hmac-sha256', mac: 7 }, { alg: 'hmac-sha256', mac: mac.toUpperCase() }, { alg: 'hmac-sha256', mac: `${mac}zz` }]) {
      writeManifest(created.path, { ...manifest, auth });
      const result = await mgr(false).restoreBackup(created.path);
      expect(result.provenance, JSON.stringify(auth)).toBe('mismatch');
    }
  });

  it('does not sign with an empty vault key, and asks on restore', async () => {
    const created = await mgr(false, '').createBackup();
    expect(readManifest(created.path)['auth']).toBeUndefined();
    expect((await mgr(false, '').restoreBackup(created.path)).provenance).toBe('no-key');
  });

  it('refuses a manifest that is JSON null instead of throwing', async () => {
    const created = await mgr(false).createBackup();
    writeFileSync(join(created.path, 'manifest.json'), 'null');
    const result = await mgr(false).restoreBackup(created.path);
    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid manifest.json');
  });

  it('keys the manifest MAC apart from the file cipher, and ignores key order and the auth field', () => {
    expect(deriveManifestKey(KEY).equals(deriveBackupKey(KEY))).toBe(false);
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 'x' }] })).toBe(canonicalJson({ a: [{ c: 'x', d: 2 }], b: 1 }));
    const k = deriveManifestKey(KEY);
    expect(manifestMac({ a: 1, auth: { mac: 'x' } }, k)).toBe(manifestMac({ a: 1 }, k));
    expect(manifestMac({ a: 1 }, k)).not.toBe(manifestMac({ a: 2 }, k));
  });
});
