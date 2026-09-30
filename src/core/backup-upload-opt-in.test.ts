import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
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

/** Both witnesses of "the local backup is intact", read off disk rather than off the result. */
function localArchiveIsReadable(path: string): boolean {
  if (!existsSync(join(path, 'manifest.json'))) return false;
  const manifest = JSON.parse(readFileSync(join(path, 'manifest.json'), 'utf-8')) as BackupManifest;
  return manifest.files.length > 0 && readdirSync(path).length > 1;
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
      expect(calls).toHaveLength(1);
      expect(calls[0]!.encrypted).toBe(true);
      expect(calls[0]!.dir).toBe(result.path);
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

    const text = stderrText();
    expect(text).toContain('Google Drive upload skipped');
    expect(text).toContain('not encrypted');
    expect(text).toContain('LYNOX_VAULT_KEY');
    expect(text).toContain('local backup is intact');
  });

  it('says nothing about a skip when there is no uploader at all', async () => {
    // The discriminator for the message above: it must be tied to a REFUSAL, not printed on
    // every unencrypted backup. Self-host without Google connected is the common case and must
    // stay quiet — otherwise the line trains its readers to ignore it.
    const manager = new BackupManager(
      lynoxDir, { backupDir, retentionDays: 30, encrypt: false }, null,
    );

    await manager.createBackup();

    expect(stderrText()).not.toContain('Google Drive upload skipped');
  });
});
