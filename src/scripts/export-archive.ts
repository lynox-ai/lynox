/**
 * The complete data export as an engine command, run inside the instance: it opens the
 * vault to MASK, never to output, decrypts the stores in this process, and stages the archive in the
 * data directory's `export-staging/`. It prints one JSON line with where the archive is; the caller
 * streams that file out (calling `--touch` while it does, if that takes long) and then runs
 * `--finish`, which removes it and gives the slot back.
 *
 *   node dist/scripts/export-archive.js [--data-dir=PATH]
 *       → {"job":"…","dir":"…","path":"…","size":N,"may_be_incomplete":bool} on stdout, exit 0
 *   node dist/scripts/export-archive.js --touch --job=ID [--data-dir=PATH]
 *       → the slot's heartbeat while the archive is streamed, exit 0 (3 when the slot is not ID's)
 *   node dist/scripts/export-archive.js --finish --job=ID --dir=PATH [--data-dir=PATH]
 *       → removes job ID's staged archive and releases the slot, exit 0
 *
 * THE CALLER'S DUTY: `--touch` while it streams. The command keeps the slot alive while it
 * stages and refreshes it once at the end; from then on only the caller's `--touch` does. The slot
 * goes stale an hour after its last refresh (`EXPORT_SLOT_TTL_MS`), and an erasure then removes the
 * staged archive as an orphan and answers "erased". A caller that streams longer than that must
 * run `--touch` at least every 10 minutes until it runs `--finish`.
 *
 * Exit codes: 0 done · 2 usage · 3 the slot is held (another export or an erasure) · 4 not enough
 * disk space · 5 the vault key is missing or does not open the vault · 1 anything else. Nothing
 * secret is written to stdout or stderr: values never, the archive's path and counts only.
 *
 * THE VAULT KEY, OR NO EXPORT. Without the key the export could not mask the vault's values in the
 * stores' plain columns, and a value the agent wrote into a chat would leave in clear. So the
 * command refuses (exit 5) when `vault.db` exists and the key is missing or opens none of its
 * entries. It reads the key as the container entrypoint does: the environment, else the data
 * directory's `.env` (mode 0600/0400, not a link) — a `docker exec` does not inherit what the
 * entrypoint exported into the engine process alone.
 */
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { getLynoxDir, setDataDir } from '../core/config.js';
import { deriveEngineEncKey } from '../core/engine-db.js';
import { archiveDirPrefixFor, prepareArchive, removeArchive, sweepStaleExports } from '../core/export-archive.js';
import { acquireSlot, releaseSlotByJob, touchSlotByJob } from '../core/export-slot.js';
import { deriveHistoryEncKey } from '../core/run-history.js';
import { redactConfigForResponse } from '../core/secret-fields.js';
import { SecretStore } from '../core/secret-store.js';
import { SecretVault } from '../core/secret-vault.js';
import type { LynoxUserConfig } from '../types/index.js';
import { EXPORT_STAGING_DIR, ExportSpaceError } from '../core/workspace-export.js';

function arg(args: readonly string[], name: string): string | undefined {
  const a = args.find(x => x.startsWith(`--${name}=`));
  return a === undefined ? undefined : a.slice(name.length + 3);
}

function fail(code: number, message: string): never {
  process.stderr.write(`[export-archive] ${message}\n`);
  process.exit(code);
}

/** The vault key: the environment, else `<dataDir>/.env` read like the entrypoint reads it. Empty when neither has it. */
export function resolveVaultKey(dataDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env['LYNOX_VAULT_KEY'] ?? '';
  if (fromEnv !== '') return fromEnv;
  const path = join(dataDir, '.env');
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.isSymbolicLink()) return '';
    const mode = st.mode & 0o777;
    if (mode !== 0o600 && mode !== 0o400) return '';
    const line = readFileSync(path, 'utf8').split('\n').find(l => l.startsWith('LYNOX_VAULT_KEY='));
    return line === undefined ? '' : line.slice('LYNOX_VAULT_KEY='.length).trim();
  } catch {
    return '';
  }
}

/**
 * The settings, read here rather than through `readUserConfig`, which writes a parse error (with a
 * snippet of the file, which can hold a key) to stderr. `null` when there is no settings file;
 * `unreadable` when it does not parse as a JSON object.
 */
function readSettings(dataDir: string): LynoxUserConfig | null | 'unreadable' {
  const path = join(dataDir, 'config.json');
  if (!existsSync(path)) return null;
  try {
    const v: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? v as LynoxUserConfig : 'unreadable';
  } catch {
    return 'unreadable';
  }
}

/** Whether `err` means the disk was full: exit 4, not 1. */
export const isNoSpace = (err: unknown): boolean => {
  const code = (err as { code?: unknown } | null)?.code;
  return err instanceof ExportSpaceError || code === 'ENOSPC' || code === 'SQLITE_FULL';
};

/** `--finish`: remove job `job`'s staged archive `dir` (only that job's, in this data dir's staging) and release its slot. */
export function finish(dataDir: string, job: string, dir: string): void {
  const staging = resolve(join(dataDir, EXPORT_STAGING_DIR));
  const target = resolve(dir);
  if (dirname(target) !== staging || !basename(target).startsWith(archiveDirPrefixFor(job))) {
    throw new Error('--dir is not the staged archive of this job in this data directory');
  }
  removeArchive(target);
  releaseSlotByJob(dataDir, job);
}

export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dataDirArg = arg(args, 'data-dir');
  if (dataDirArg !== undefined) setDataDir(dataDirArg);
  const dataDir = getLynoxDir();

  if (args.includes('--finish')) {
    const job = arg(args, 'job');
    const dir = arg(args, 'dir');
    if (job === undefined || dir === undefined) fail(2, '--finish needs --job=ID and --dir=PATH');
    try {
      finish(dataDir, job, dir);
    } catch (err) {
      fail(2, err instanceof Error ? err.message : String(err));
    }
    return;
  }
  if (args.includes('--touch')) {
    const job = arg(args, 'job');
    if (job === undefined) fail(2, '--touch needs --job=ID');
    if (!touchSlotByJob(dataDir, job)) fail(3, 'the export slot is not held by this job');
    return;
  }

  // An orphan of a crash or of a hand path that never ran --finish: removed before this export.
  sweepStaleExports(dataDir);
  const taken = acquireSlot(dataDir, 'export', 'command');
  if (!taken.ok) fail(3, `the export slot is held (${taken.held.kind}, since ${new Date(taken.held.at).toISOString()})`);
  const slot = taken.slot;
  let preparedDir: string | null = null;
  try {
    const vaultKey = resolveVaultKey(dataDir);
    const vaultPath = join(dataDir, 'vault.db');
    let vault: SecretVault | null = null;
    if (existsSync(vaultPath)) {
      if (vaultKey === '') { slot.release(); fail(5, 'the vault key is missing; nothing was exported'); }
      vault = new SecretVault({ path: vaultPath, masterKey: vaultKey });
      if (vault.undecryptableCount() > 0) { vault.close(); slot.release(); fail(5, 'the vault key does not open the vault; nothing was exported'); }
    }
    const settings = readSettings(dataDir);
    const userConfig = settings === null || settings === 'unreadable' ? null : settings;
    const secrets = new SecretStore(userConfig ?? undefined, vault ?? undefined);
    const prepared = await prepareArchive(dataDir, {
      slot,
      keys: {
        engine: vaultKey !== '' ? deriveEngineEncKey(vaultKey) : null,
        history: vaultKey !== '' ? deriveHistoryEncKey(vaultKey) : null,
      },
      guard: secrets.exportGuard(),
      config: userConfig === null ? null : redactConfigForResponse(userConfig),
      secretNames: secrets.listNames(),
    });
    vault?.close();
    preparedDir = prepared.dir;
    process.stdout.write(`${JSON.stringify({
      job: slot.info.job, dir: prepared.dir, path: prepared.path, size: prepared.size,
      may_be_incomplete: prepared.manifest.may_be_incomplete || settings === 'unreadable',
    })}\n`);
  } catch (err) {
    // Nobody learns where an archive is that was not announced: it goes, and so does the slot.
    if (preparedDir !== null) removeArchive(preparedDir);
    slot.release();
    if (isNoSpace(err)) fail(4, 'not enough disk space to stage the export; nothing was exported');
    fail(1, `the export failed (${err instanceof Error ? err.name : 'error'}); nothing was exported`);
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  void main();
}
