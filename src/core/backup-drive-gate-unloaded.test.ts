import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Engine } from './engine.js';
import { reloadConfig } from './config.js';
import type { LynoxConfig } from '../types/index.js';
import type { GDriveBackupUploader, UploadResult } from './backup-upload-gdrive.js';

/**
 * The FAIL-CLOSED direction of the Drive gate, in its own file because the only way to reach it
 * is a module-level mock.
 *
 * `Engine._driveUploadAllowed` returns `false` when the engine never cached the gate functions,
 * which happens when the dynamic import of `backup-upload-gdrive.js` fails. Everything else in
 * the gate is covered in `engine-init-wiring-boot.test.ts` and `backup-upload-opt-in.test.ts`;
 * this one line was a surviving mutant, and its mutant is fail-OPEN — an upload with no consent
 * read at all.
 *
 * Reaching it needs two things at once, which is why it could not be covered in those files: the
 * import has to fail (so no uploader is attached by the engine, and step 10 would never ask), AND
 * an uploader has to be attached anyway — which is what an embedder does when it calls
 * `getBackupManager()!.setGDriveUploader(...)`. The mock supplies the first, the test the second.
 *
 * `vi.mock` is hoisted and file-wide, so the mock cannot live beside tests that need the real
 * module. That is the whole reason for a separate file, and it is cheaper than leaving the
 * fail-closed branch of a security gate uncovered.
 */
vi.mock('./backup-upload-gdrive.js', () => {
  throw new Error('mocked: the Drive module failed to load');
});

describe('Drive gate — a module that never loaded refuses the upload', () => {
  const dirs: string[] = [];
  const engines: Engine[] = [];
  const saved = new Map<string, string | undefined>();

  function setEnv(key: string, value: string | undefined): void {
    if (!saved.has(key)) saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  afterEach(async () => {
    for (const e of engines) { try { await e.shutdown(); } catch { /* best effort */ } }
    engines.length = 0;
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    saved.clear();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
    reloadConfig();
  });

  it('refuses even with consent granted and an uploader attached by hand', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-gate-unloaded-'));
    dirs.push(dir);
    for (const k of ['LYNOX_DATA_DIR', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET',
      'LYNOX_MANAGED_INSTANCE_ID', 'LYNOX_BILLING_TIER', 'LYNOX_MANAGED_MODE',
      'LYNOX_VAULT_KEY'] as const) setEnv(k, undefined);
    setEnv('LYNOX_DATA_DIR', dir);
    // Self-host, consent granted — every condition the user controls says yes.
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ backup_gdrive: true }));
    mkdirSync(join(dir, 'memory', '_global'), { recursive: true });
    writeFileSync(join(dir, 'memory', '_global', 'facts.txt'), 'a fact');

    reloadConfig();
    const engine = new Engine({} as LynoxConfig);
    engines.push(engine);
    await engine.init();

    const manager = engine.getBackupManager();
    expect(manager).not.toBeNull();
    // FIXTURE GUARD: the engine must NOT have attached an uploader — if it did, the mock did not
    // take effect and this test would be exercising the ordinary path.
    expect(manager!.getGDriveUploader(), 'the mocked import must have prevented the wiring').toBeNull();
    // FIXTURE GUARD: and the consent really is granted, so a refusal below cannot be explained by
    // the setting being absent.
    expect(engine.getUserConfig().backup_gdrive).toBe(true);

    // What an embedder does: attach an uploader to the engine's manager itself.
    const calls: string[] = [];
    const stub = {
      upload: async (backupDir: string): Promise<UploadResult> => {
        calls.push(backupDir);
        return { success: true, folderId: 'stub', filesUploaded: 1 };
      },
    };
    manager!.setGDriveUploader(stub as unknown as GDriveBackupUploader);

    const result = await manager!.createBackup();

    expect(result.success).toBe(true);
    expect(result.manifest.encrypted).toBe(true);        // a vault key was generated at boot
    expect(existsSync(join(result.path, 'manifest.json'))).toBe(true);   // witness 1
    expect(calls).toHaveLength(0);                                        // witness 2
  });
});
