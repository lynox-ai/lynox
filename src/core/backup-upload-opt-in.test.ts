import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readFileSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { BackupManager } from './backup.js';
import type { BackupManifest } from './backup.js';
import { driveUploadOptedIn } from './backup-upload-gdrive.js';
import { isEncryptedBackupFile } from './backup-crypto.js';
import type { GDriveBackupUploader, UploadResult } from './backup-upload-gdrive.js';

/**
 * The two conditions that stand between a local backup and a copy of it at a third party.
 *
 * They are separate questions with separate homes, and the split is the point:
 *
 *   consent   — `driveUploadOptedIn(userConfig)`, read where the engine WIRES the uploader.
 *   encrypted — `manifest.encrypted`, read where `createBackup` CALLS it.
 *
 * `driveBackupAllowed` is a third, older condition (which deployment may upload at all) and has
 * its own suite in `backup-drive-tier-boundary.test.ts`. That the engine consults all of them is
 * `engine-init-wiring-boot.test.ts`; a unit test that hands a setting in cannot see a dropped
 * call.
 *
 * ⚠ The half of this that is easy to leave out, and the reason it is written first in every
 * block below: the promise is "no UPLOAD", not "no BACKUP". A test that only asserts the upload
 * did not happen passes under both readings and therefore proves neither. Each refusal below
 * carries TWO witnesses — the local archive EXISTS and is readable, and the uploader was never
 * called.
 */

const VAULT_KEY = 'test-vault-key-for-opt-in-suite';

function seedLynoxDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lynox-optin-'));
  const db = new Database(join(dir, 'history.db'));
  db.pragma('journal_mode = WAL');
  db.prepare('CREATE TABLE test (id INTEGER PRIMARY KEY, value TEXT)').run();
  db.prepare("INSERT INTO test VALUES (1, 'hello')").run();
  db.close();
  mkdirSync(join(dir, 'memory', '_global'), { recursive: true });
  writeFileSync(join(dir, 'memory', '_global', 'facts.txt'), 'a fact worth not leaking');
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ default_tier: 'balanced' }));
  return dir;
}

interface Spy {
  readonly calls: Array<{ dir: string; encrypted: boolean }>;
  readonly uploader: GDriveBackupUploader;
}

/**
 * A stub with `upload`'s real signature, so a change to that signature breaks this file rather
 * than silently making the spy unreachable. It is also what keeps this suite honest about
 * the rule that a gate's test must not cause the very effect the gate prevents — with a spy the
 * "effect" is an array entry.
 */
function spyUploader(): Spy {
  const calls: Array<{ dir: string; encrypted: boolean }> = [];
  const stub = {
    upload: async (backupDir: string, manifest: BackupManifest): Promise<UploadResult> => {
      calls.push({ dir: backupDir, encrypted: manifest.encrypted });
      return { success: true, folderId: 'stub-folder', filesUploaded: manifest.files.length };
    },
  };
  return { calls, uploader: stub as unknown as GDriveBackupUploader };
}

/**
 * "The local backup is intact", read off DISK rather than off the result.
 *
 * ⚠ The first version of this helper counted directory entries and manifest rows — both
 * CORRELATES of intact. Executed against a fixture with a manifest listing three files and none
 * of them on disk, it returned `true`; a zero-byte database also passed. So it is now the
 * property: every non-directory entry the manifest claims must exist with non-zero size, and the
 * database must open. Anything weaker lets the assertion it serves pass on an empty archive.
 */
function localArchiveIsReadable(path: string): boolean {
  if (!existsSync(join(path, 'manifest.json'))) return false;
  const manifest = JSON.parse(readFileSync(join(path, 'manifest.json'), 'utf-8')) as BackupManifest;
  const files = manifest.files.filter(f => f.type !== 'directory');
  if (files.length === 0) return false;
  for (const f of files) {
    const full = join(path, f.path);
    if (!existsSync(full)) return false;
    if (statSync(full).size === 0) return false;
  }
  // And the database is a database — unless the archive is ciphertext, where it must NOT be.
  const dbPath = join(path, 'history.db');
  if (!existsSync(dbPath)) return false;
  if (manifest.encrypted) return isEncryptedBackupFile(dbPath);
  const db = new Database(dbPath, { readonly: true });
  try {
    return (db.prepare('SELECT count(*) AS n FROM test').get() as { n: number }).n > 0;
  } finally {
    db.close();
  }
}

describe('driveUploadOptedIn — the consent condition, decided without a boot', () => {
  it('is false when the setting is absent, which is the shipped default', () => {
    // `backup_gdrive` is `optional()`, so an untouched config reaches this as `undefined`.
    // Both published doc pages state the default as `false`; this is that sentence, in code.
    expect(driveUploadOptedIn({})).toBe(false);
    expect(driveUploadOptedIn()).toBe(false);
  });

  it('is false when the setting is explicitly off', () => {
    expect(driveUploadOptedIn({ backup_gdrive: false })).toBe(false);
  });

  it('is true only on an explicit opt-in', () => {
    expect(driveUploadOptedIn({ backup_gdrive: true })).toBe(true);
  });

  it('refuses a truthy non-boolean — the opt-in is a value, not a hint', () => {
    // `=== true` rather than truthiness. The schema types this as boolean, but a config file is
    // user-written text and a hand-edited `"true"` must not read as consent. This is the
    // assertion that dies if the check is relaxed to `!!config.backup_gdrive`.
    const stringly = { backup_gdrive: 'true' } as unknown as { backup_gdrive?: boolean | undefined };
    const numberly = { backup_gdrive: 1 } as unknown as { backup_gdrive?: boolean | undefined };
    expect(driveUploadOptedIn(stringly)).toBe(false);
    expect(driveUploadOptedIn(numberly)).toBe(false);
  });
});

describe('createBackup — an unencrypted archive never leaves the machine', () => {
  let lynoxDir: string;
  let backupDir: string;
  let stderr: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    lynoxDir = seedLynoxDir();
    backupDir = join(lynoxDir, 'backups');
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderr.mockRestore();
    rmSync(lynoxDir, { recursive: true, force: true });
  });

  function stderrText(): string {
    return stderr.mock.calls.map(c => String(c[0])).join('');
  }

  it('uploads when a vault key produced an encrypted archive', () => {
    // The positive control for every refusal below. Without it, a gate that refuses
    // unconditionally — or a spy that is simply never reachable — would look like a pass.
    const { calls, uploader } = spyUploader();
    const manager = new BackupManager(
      lynoxDir, { backupDir, retentionDays: 30, encrypt: true, gdriveUploader: uploader }, VAULT_KEY,
    );

    return manager.createBackup().then(result => {
      expect(result.success).toBe(true);
      expect(result.manifest.encrypted).toBe(true);
      // ⚠ THE WITNESS THIS SUITE WAS MISSING: that encryption actually RAN. Without it, breaking
      // step 5 to `if (false && this.vaultKey)` left all ten tests green — nothing encrypted,
      // `manifest.encrypted` still true, and the spy recording an upload of a plaintext archive
      // labelled encrypted, which is the exact scenario this file's header exists to prevent. The
      // manifest field and the spy's copy of it are three fields and zero bytes; this reads bytes.
      expect(isEncryptedBackupFile(join(result.path, 'history.db'))).toBe(true);
      expect(localArchiveIsReadable(result.path)).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.dir).toBe(result.path);
      // And the skip line must NOT appear on a successful upload — otherwise the message stops
      // discriminating and its readers learn to ignore it.
      expect(stderrText()).not.toContain('Google Drive upload skipped');
    });
  });

  it('WITHOUT a vault key: the local backup exists AND the uploader is never called', async () => {
    // The forgotten half, in one test because the two halves are one promise. The requirement is
    // "no UPLOAD without a vault key" — not "no BACKUP": an unencrypted local copy on a machine
    // its owner controls is a thing worth keeping, so losing it here would be a regression
    // dressed as a fix.
    const { calls, uploader } = spyUploader();
    const manager = new BackupManager(
      lynoxDir, { backupDir, retentionDays: 30, encrypt: true, gdriveUploader: uploader }, null,
    );

    const result = await manager.createBackup();

    // WITNESS 1 — the backup ran and is on disk, readable, with content.
    expect(result.success).toBe(true);
    expect(result.manifest.encrypted).toBe(false);   // no key, so the constructor cleared it
    expect(localArchiveIsReadable(result.path)).toBe(true);
    expect(existsSync(join(result.path, 'history.db'))).toBe(true);

    // WITNESS 2 — and nothing went anywhere.
    expect(calls).toHaveLength(0);
  });

  it('with a key but backup_encrypt off: local backup exists, still no upload', async () => {
    // Stricter than the literal sentence and deliberately so. The reason given for the rule is
    // that unencrypted on your own machine is not the same as unencrypted at a third party, and
    // an archive whose owner switched encryption OFF is exactly that case. Recorded here rather
    // than left as a side effect, so a later reader can reverse it on purpose if they disagree.
    const { calls, uploader } = spyUploader();
    const manager = new BackupManager(
      lynoxDir, { backupDir, retentionDays: 30, encrypt: false, gdriveUploader: uploader }, VAULT_KEY,
    );

    const result = await manager.createBackup();

    expect(result.success).toBe(true);
    expect(result.manifest.encrypted).toBe(false);
    expect(localArchiveIsReadable(result.path)).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('an EMPTY vault key does not count as a key — no upload, and the manifest does not lie', async () => {
    // The divergence that defeats the whole gate if `manifest.encrypted` is a declaration of
    // INTENT rather than a record of what HAPPENED. Two conditions were written for the same
    // question and differ on exactly one value:
    //
    //   constructor:  config.encrypt && vaultKey !== null   → '' passes ('' is not null)
    //   step 5:       this.encrypt && this.vaultKey         → '' fails  ('' is falsy)
    //
    // Reachable from the outside: `LYNOX_VAULT_KEY=` (set, empty) makes `process.env[…] ?? null`
    // yield `''`, and an explicit `backup_encrypt: true` supplies the other half. Nothing would
    // be encrypted, the manifest would say `encrypted: true`, and an upload gate reading that
    // field would send a plaintext archive to a third party while believing the opposite.
    const { calls, uploader } = spyUploader();
    const manager = new BackupManager(
      lynoxDir, { backupDir, retentionDays: 30, encrypt: true, gdriveUploader: uploader }, '',
    );

    const result = await manager.createBackup();

    expect(result.success).toBe(true);
    // The manifest must record what happened, not what was asked for.
    expect(result.manifest.encrypted).toBe(false);
    // And the files must actually be what the manifest says they are.
    expect(isEncryptedBackupFile(join(result.path, 'history.db'))).toBe(false);
    // Both witnesses, as everywhere in this block.
    expect(localArchiveIsReadable(result.path)).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('SAYS it skipped, rather than failing silently', async () => {
    // A setting whose effect quietly disappears is the defect this change repairs, so the new
    // refusal must not become a second one. Opting in without a key has to be legible from the
    // output alone.
    const { uploader } = spyUploader();
    const manager = new BackupManager(
      lynoxDir, { backupDir, retentionDays: 30, encrypt: true, gdriveUploader: uploader }, null,
    );

    await manager.createBackup();

    // ⚠ Asserted as ONE sentence, not as four unordered substrings. With `toContain` × 4 the
    // actionable half — the part that tells the operator what to do — could be deleted, and the
    // message could be made to say the opposite of what happened, with every assertion green.
    // What a person reads is the promise; a token set is not.
    expect(stderrText()).toBe(
      '[lynox:backup] Google Drive upload skipped — this backup is not encrypted. '
      + 'Set LYNOX_VAULT_KEY to a non-empty value (and do not set backup_encrypt to false) '
      + 'to upload. The local backup is intact.\n',
    );
  });

  it('uploadAllowed() === false refuses the upload even on an encrypted archive', async () => {
    // The consent condition at the UNIT level. It lives here rather than at the wiring because a
    // wiring gate answers "was it true at the last boot"; this answers "is it true now", which is
    // the only form in which revoking the setting can take effect without a restart. The engine
    // hands in a closure over its live config; the boot suite proves the revocation end to end.
    const { calls, uploader } = spyUploader();
    const manager = new BackupManager(
      lynoxDir,
      { backupDir, retentionDays: 30, encrypt: true, gdriveUploader: uploader, uploadAllowed: () => false },
      VAULT_KEY,
    );

    const result = await manager.createBackup();

    expect(result.success).toBe(true);
    expect(result.manifest.encrypted).toBe(true);          // encryption is unaffected
    expect(localArchiveIsReadable(result.path)).toBe(true); // witness 1
    expect(calls).toHaveLength(0);                          // witness 2
    // And silent: not opting in is the normal state, so a line here would fire on every backup of
    // every instance that never asked for an upload.
    expect(stderrText()).not.toContain('Google Drive upload skipped');
  });

  it('a FAILED upload is reported, not swallowed', async () => {
    // The real uploader does not throw on a refusal — a missing `drive.file` scope, an API error
    // and a network failure all come back as `{ success: false, error }`. The result used to be
    // discarded, so a genuine failure was completely silent while the code claimed its refusals
    // were written. A spy that returns a failure is the only way to reach that path.
    const failing = {
      upload: async (): Promise<UploadResult> => ({
        success: false, folderId: '', filesUploaded: 0,
        error: 'Missing drive.file scope. Run /google auth to grant access.',
      }),
    } as unknown as GDriveBackupUploader;
    const manager = new BackupManager(
      lynoxDir, { backupDir, retentionDays: 30, encrypt: true, gdriveUploader: failing }, VAULT_KEY,
    );

    const result = await manager.createBackup();

    expect(result.success).toBe(true);   // an upload failure does not fail the backup
    expect(stderrText()).toContain('Google Drive upload failed');
    expect(stderrText()).toContain('Missing drive.file scope');
  });

  it('verifyBackup accepts an ENCRYPTED archive — the sqlite relabel it used to omit', async () => {
    // Three sites answer "are these files ciphertext, so skip the SQLite integrity check":
    // `createBackup` step 9, `restoreBackup`, and this public method — which did not ask. On an
    // encrypted archive `PRAGMA integrity_check` runs against ciphertext and throws "file is not
    // a database", so every encrypted backup was reported invalid. Its own tests ran on an
    // unencrypted manager, where the relabel is a no-op, which is why nothing saw it.
    const manager = new BackupManager(
      lynoxDir, { backupDir, retentionDays: 30, encrypt: true }, VAULT_KEY,
    );
    const created = await manager.createBackup();
    expect(created.manifest.encrypted).toBe(true);

    const verdict = manager.verifyBackup(created.path);

    expect(verdict.errors).toEqual([]);
    expect(verdict.valid).toBe(true);
    expect(verdict.files_checked).toBeGreaterThan(0);
  });

  it('verifyBackup still catches a corrupt database in an UNENCRYPTED archive', async () => {
    // The other direction, and the one that makes the relabel a decision rather than a blanket
    // skip: without it, mutating the condition to always relabel would silently stop checking
    // SQLite integrity on every unencrypted backup — a corrupt `VACUUM INTO` output would be
    // promoted as a good archive. This is the assertion that dies in that case.
    const manager = new BackupManager(
      lynoxDir, { backupDir, retentionDays: 30, encrypt: false }, null,
    );
    const created = await manager.createBackup();
    expect(created.manifest.encrypted).toBe(false);
    // Corrupt the copy in the archive, keeping its size so only an integrity check notices.
    const dbPath = join(created.path, 'history.db');
    const size = statSync(dbPath).size;
    writeFileSync(dbPath, Buffer.alloc(size, 0x41));

    const verdict = manager.verifyBackup(created.path);

    expect(verdict.valid).toBe(false);
    expect(verdict.errors.join(' ')).toContain('history.db');
  });

  it('says nothing about a skip when there is no uploader at all', async () => {
    // The discriminator for the message above: it must be tied to a REFUSAL, not printed on
    // every unencrypted backup. An instance with no uploader attached is the common case and must
    // stay quiet — otherwise the line trains its readers to ignore it.
    //
    // ⚠ Note what this does NOT say. An earlier version claimed "self-host without Google
    // connected is the common case", which is false: the engine attaches the uploader on tier
    // alone, with no auth term (deliberately — a brokered credential is built later), so a
    // self-host instance without Google connected DOES get an uploader. What keeps it quiet is
    // the absence of an uploader, and at the engine level the absence of consent.
    const manager = new BackupManager(
      lynoxDir, { backupDir, retentionDays: 30, encrypt: false }, null,
    );

    await manager.createBackup();

    expect(stderrText()).not.toContain('Google Drive upload skipped');
  });
});
