/**
 * The file half of the Art. 17 erasure (`DELETE /api/data`): what lies in the data dir,
 * and removing what the erasure owes.
 *
 * The decision per entry lives in `DATA_DIR_INVENTORY` (`erase`), not here. This module
 * only classifies what is actually on disk against that table and removes. The stores
 * the engine holds open (`erase: step`) are emptied by the route through their own
 * handles; removing their files under an open connection would leave the old rows
 * readable in-process.
 *
 * Two properties carry the design:
 *
 *  · AN UNKNOWN ENTRY IS REPORTED, NEVER REMOVED UNASKED. The data dir is configurable
 *    (`--data-dir`, `LYNOX_DATA_DIR`) and can be a broad directory such as `$HOME`.
 *    Removing "everything this table does not keep" would wipe it. So the route scans
 *    first, and an entry this table does not know stops the erasure before anything is
 *    deleted — unless the caller names it back, with the identity the scan reported.
 *  · NOTHING IS FOLLOWED. Every entry is `lstat`ed: a symlink is unlinked, never
 *    descended into (a `workspace` linked to a directory elsewhere must not empty that
 *    directory), and an entry on another device than the data dir (a bind mount) is
 *    refused rather than emptied.
 */
import { lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, type Stats } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR_INVENTORY, type DataDirEntry } from './data-dir-inventory.js';

/** SQLite sidecars that belong to the file they extend. */
const SIDECAR = /^(.+?)(-wal|-shm|-journal)$/;
/** `atomic-write.ts`: `${filePath}.${pid}.${uuid8}.tmp`, left behind by a crash between write and rename. */
const ATOMIC_TEMP = /^(.+)\.\d+\.[0-9a-f]{8}\.tmp$/;
/**
 * Residue the engine itself writes beside a store, anchored to the exact names its writers
 * produce: the recovery copies of `engine-db.ts` / `run-history.ts` and the rotation backup
 * of `secret-vault.ts`. Anchored on purpose — an unanchored pattern would match a user's
 * own `thesis.bak-2024` in a broad data dir.
 */
const ENGINE_RESIDUE = [
  /^(engine|history)\.db\.corrupt-\d+$/,
  /^vault\.db\.rotate-bak$/,
];
/** Written by operating systems and tools into any directory they touch; no user content. */
const OS_LITTER = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini', 'lost+found']);

export type EntryClass =
  | { readonly kind: 'declared'; readonly entry: DataDirEntry }
  | { readonly kind: 'sidecar'; readonly of: string }
  | { readonly kind: 'temp'; readonly of: string }
  | { readonly kind: 'residue' }
  | { readonly kind: 'litter' }
  | { readonly kind: 'unknown' };

const BY_NAME = new Map(DATA_DIR_INVENTORY.map(e => [e.name, e]));

const isResidue = (name: string): boolean => ENGINE_RESIDUE.some(re => re.test(name));

export function classifyEntry(name: string): EntryClass {
  const entry = BY_NAME.get(name);
  if (entry) return { kind: 'declared', entry };
  if (OS_LITTER.has(name)) return { kind: 'litter' };
  if (isResidue(name)) return { kind: 'residue' };
  const side = SIDECAR.exec(name);
  if (side) {
    const base = side[1]!;
    if (BY_NAME.has(base)) return { kind: 'sidecar', of: base };
    if (isResidue(base)) return { kind: 'residue' };
  }
  const temp = ATOMIC_TEMP.exec(name);
  if (temp && BY_NAME.has(temp[1]!)) return { kind: 'temp', of: temp[1]! };
  return { kind: 'unknown' };
}

/** What the caller must echo back to have an unknown entry removed. */
export interface EntryIdentity {
  readonly name: string;
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
}

const identityOf = (name: string, st: Stats): EntryIdentity =>
  ({ name, dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs });

export interface DataDirScan {
  /** The data dir as resolved on disk, so a data dir that is itself a symlink compares correctly. */
  readonly dir: string;
  readonly dev: number;
  readonly unknown: readonly EntryIdentity[];
  /** Litter seen, named for the log only — it neither blocks nor counts. */
  readonly litter: readonly string[];
}

export function scanDataDir(dataDir: string): DataDirScan {
  const dir = realpathSync(dataDir);
  const dev = statSync(dir).dev;
  const unknown: EntryIdentity[] = [];
  const litter: string[] = [];
  for (const name of readdirSync(dir)) {
    const cls = classifyEntry(name);
    if (cls.kind === 'litter') litter.push(name);
    else if (cls.kind === 'unknown') unknown.push(identityOf(name, lstatSync(join(dir, name))));
  }
  unknown.sort((a, b) => a.name.localeCompare(b.name));
  return { dir, dev, unknown, litter };
}

/**
 * Whether `acknowledged` names exactly the unknown entries the scan found, each with the
 * identity it had then. A name alone is not enough: what the caller agreed to remove is
 * the entry they were shown, not whatever stands behind that name by the time this runs.
 */
export function sameUnknownSet(scan: readonly EntryIdentity[], acknowledged: readonly EntryIdentity[]): boolean {
  if (scan.length !== acknowledged.length) return false;
  const want = new Map(acknowledged.map(a => [a.name, a]));
  if (want.size !== acknowledged.length) return false;
  return scan.every(s => {
    const a = want.get(s.name);
    return a !== undefined && a.dev === s.dev && a.ino === s.ino && a.size === s.size && a.mtimeMs === s.mtimeMs;
  });
}

/** Parses the caller's `remove_unknown` list; anything malformed is `null`. */
export function parseAcknowledged(raw: unknown): EntryIdentity[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return null;
  const out: EntryIdentity[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) return null;
    const r = item as Record<string, unknown>;
    const { name, dev, ino, size, mtimeMs } = r;
    if (typeof name !== 'string' || name === '' || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) return null;
    if (![dev, ino, size, mtimeMs].every(n => typeof n === 'number' && Number.isFinite(n))) return null;
    out.push({ name, dev: dev as number, ino: ino as number, size: size as number, mtimeMs: mtimeMs as number });
  }
  return out;
}

export interface RemoveOutcome {
  readonly removed: readonly string[];
  /** `name` → why it could not be removed; the route reports each as a failure. */
  readonly failures: ReadonlyArray<{ readonly name: string; readonly reason: string }>;
}

/**
 * Removes every top-level entry that is `remove` in the inventory (with its sidecars), the
 * atomic-write temp a crash left beside ANY declared entry (a `config.json` temp holds the
 * whole config), the engine's own residue, and the acknowledged unknown entries. The
 * sidecars of a `step` store stay: they belong to the connection the route empties through.
 * `backups` goes LAST: a backup started while the route awaited copies stores that are
 * still full, and must not outlive the erasure.
 *
 * Directories the inventory declares are recreated empty, with the mode they had: code
 * that writes into them expects them to exist.
 */
export function removeOwedEntries(
  scan: DataDirScan,
  acknowledgedUnknown: readonly string[],
  /** Injected only by tests: a mount cannot be created without privileges. */
  lstat: (path: string) => Stats = lstatSync,
): RemoveOutcome {
  const removed: string[] = [];
  const failures: Array<{ name: string; reason: string }> = [];
  const ack = new Set(acknowledgedUnknown);
  const owed: string[] = [];
  for (const name of readdirSync(scan.dir)) {
    const cls = classifyEntry(name);
    const owedHere =
      (cls.kind === 'declared' && cls.entry.erase.by === 'remove')
      || (cls.kind === 'sidecar' && BY_NAME.get(cls.of)?.erase.by === 'remove')
      || cls.kind === 'temp'
      || cls.kind === 'residue'
      || (cls.kind === 'unknown' && ack.has(name));
    if (owedHere) owed.push(name);
  }
  owed.sort((a, b) => Number(a === 'backups') - Number(b === 'backups'));
  for (const name of owed) {
    const path = join(scan.dir, name);
    let st: Stats;
    try {
      st = lstat(path);
    } catch {
      continue;   // gone since the listing
    }
    if (!st.isSymbolicLink() && st.dev !== scan.dev) {
      failures.push({ name, reason: 'on another device than the data dir (a mount); not emptied' });
      continue;
    }
    try {
      // `rmSync` on a symlink removes the link itself, never its target.
      rmSync(path, { recursive: true, force: true });
      removed.push(name);
      const entry = BY_NAME.get(name);
      if (entry?.kind === 'dir' && st.isDirectory()) mkdirSync(path, { mode: st.mode & 0o777 });
    } catch (err) {
      failures.push({ name, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return { removed, failures };
}
