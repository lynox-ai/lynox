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
 *  · NOTHING IS FOLLOWED, AND NOTHING FOLLOWED IS CLAIMED. A declared entry the erasure
 *    owes that is a symlink (`backups -> /mnt/disk`) holds its content at the target; an
 *    entry that is, or contains, a mount point holds it on another filesystem. Emptying
 *    either would reach outside the data dir, and unlinking the link would answer "all
 *    deleted" over data that is still there. So the scan reports them and the route
 *    refuses before anything is deleted. A mount is recognised by its device number; a
 *    bind mount from the SAME filesystem has the same one and is not recognised.
 */
import { lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, type Stats } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR_INVENTORY, type DataDirEntry } from './data-dir-inventory.js';

/** SQLite sidecars that belong to the database they extend — only a `sqlite` entry has them. */
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
    if (BY_NAME.get(base)?.kind === 'sqlite') return { kind: 'sidecar', of: base };
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

/** Whether the erasure removes this entry (an unknown one only once acknowledged). */
function owedBy(cls: EntryClass, ack: { has(name: string): boolean }, name: string): boolean {
  switch (cls.kind) {
    case 'declared': return cls.entry.erase.by === 'remove';
    case 'sidecar': return BY_NAME.get(cls.of)?.erase.by === 'remove';
    // A crash-left temp of a kept entry is kept with it: it may be another process's write
    // in flight (a CLI and a server sharing the data dir), and it holds what `keep` keeps.
    case 'temp': return BY_NAME.get(cls.of)?.erase.by !== 'keep';
    case 'residue': return true;
    case 'unknown': return ack.has(name);
    case 'litter': return false;
  }
}

/**
 * The first path inside `dir` (relative) that sits on another device than `dev`, or
 * `null`. Walks with `lstat`, so a symlink inside is not followed — removing it only
 * removes the link.
 */
function foreignDeviceInside(dir: string, dev: number, lstat: (path: string) => Stats): string | null {
  const stack = [''];
  while (stack.length > 0) {
    const rel = stack.pop()!;
    for (const child of readdirSync(join(dir, rel))) {
      const childRel = rel === '' ? child : join(rel, child);
      const st = lstat(join(dir, childRel));
      if (st.isSymbolicLink()) continue;
      if (st.dev !== dev) return childRel;
      if (st.isDirectory()) stack.push(childRel);
    }
  }
  return null;
}

/**
 * Why removing or emptying this entry would reach outside the data dir, or `null`.
 * `followsLink`: a declared entry the erasure removes or empties through its path (not
 * a SQLite store, whose open handle writes the target in place) that is a symlink.
 */
function linkedReason(name: string, cls: EntryClass, st: Stats, dataDirDev: number, path: string, lstat: (path: string) => Stats): string | null {
  if (st.isSymbolicLink()) {
    const followsLink = cls.kind === 'declared' && cls.entry.erase.by !== 'keep' && cls.entry.kind !== 'sqlite';
    return followsLink ? 'a symbolic link; its content is at the target, outside the data dir' : null;
  }
  if (st.dev !== dataDirDev) return 'a mount point; its content is on another filesystem';
  if (st.isDirectory()) {
    const inside = foreignDeviceInside(path, dataDirDev, lstat);
    if (inside !== null) return `contains a mount point (${inside}); its content is on another filesystem`;
  }
  return null;
}

export interface LinkedEntry {
  readonly name: string;
  readonly reason: string;
}

export interface DataDirScan {
  /** The data dir as resolved on disk, so a data dir that is itself a symlink compares correctly. */
  readonly dir: string;
  readonly dev: number;
  readonly unknown: readonly EntryIdentity[];
  /**
   * Entries the erasure would remove or empty — or would remove once acknowledged — that
   * reach outside the data dir. The route refuses while there is one.
   */
  readonly linked: readonly LinkedEntry[];
  /** Entries this instance knows and removes without asking, for the caller to be told. */
  readonly removedWithoutAsking: readonly string[];
  /** Litter seen, named for the log only — it neither blocks nor counts. */
  readonly litter: readonly string[];
}

export function scanDataDir(dataDir: string, lstat: (path: string) => Stats = lstatSync): DataDirScan {
  const dir = realpathSync(dataDir);
  const dev = statSync(dir).dev;
  const unknown: EntryIdentity[] = [];
  const linked: LinkedEntry[] = [];
  const removedWithoutAsking: string[] = [];
  const litter: string[] = [];
  const everyUnknown = { has: () => true };
  for (const name of readdirSync(dir)) {
    const cls = classifyEntry(name);
    if (cls.kind === 'litter') { litter.push(name); continue; }
    const path = join(dir, name);
    const st = lstat(path);
    if (cls.kind === 'unknown') unknown.push(identityOf(name, st));
    else if (owedBy(cls, everyUnknown, name)) removedWithoutAsking.push(name);
    // Asked of everything the erasure could touch through a path: what it removes, what it
    // empties in place (a `step` directory or file), and every unknown entry, which it
    // removes once acknowledged.
    const touched = cls.kind === 'unknown' || owedBy(cls, everyUnknown, name) || (cls.kind === 'declared' && cls.entry.erase.by === 'step');
    if (!touched) continue;
    const reason = linkedReason(name, cls, st, dev, path, lstat);
    if (reason !== null) linked.push({ name, reason });
  }
  unknown.sort((a, b) => a.name.localeCompare(b.name));
  linked.sort((a, b) => a.name.localeCompare(b.name));
  removedWithoutAsking.sort((a, b) => a.localeCompare(b));
  return { dir, dev, unknown, linked, removedWithoutAsking, litter };
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
  const owed: Array<{ name: string; cls: EntryClass }> = [];
  let names: string[];
  try {
    names = readdirSync(scan.dir);
  } catch (err) {
    return { removed, failures: [{ name: '.', reason: err instanceof Error ? err.message : String(err) }] };
  }
  for (const name of names) {
    const cls = classifyEntry(name);
    if (owedBy(cls, ack, name)) owed.push({ name, cls });
  }
  owed.sort((a, b) => Number(a.name === 'backups') - Number(b.name === 'backups'));
  for (const { name, cls } of owed) {
    const path = join(scan.dir, name);
    let st: Stats;
    try {
      st = lstat(path);
    } catch {
      continue;   // gone since the listing
    }
    // The scan refused these already; asked again because the stretch runs after an await.
    let reason: string | null;
    try {
      reason = linkedReason(name, cls, st, scan.dev, path, lstat);
    } catch (err) {
      reason = `could not be checked for links and mounts: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (reason !== null) {
      failures.push({ name, reason: `${reason}; not removed` });
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

/** `backup.ts` names each backup `<ISO without : and .>Z`, a collision suffix, and `.tmp` while it is written. */
const BACKUP_NAME = /^\d{4}-\d{2}-\d{2}T\d{8}Z(-\d+)?(\.tmp)?$/;

/**
 * A configured `backup_dir` outside the data dir holds full copies of the stores the
 * erasure just emptied. Only entries with the name `backup.ts` gives a backup are
 * removed — the directory is the user's choice and may hold other things — and, as
 * everywhere here, a symlink is unlinked, never followed.
 */
export function removeBackupsOutside(backupDir: string, dataDir: string): RemoveOutcome {
  const removed: string[] = [];
  const failures: Array<{ name: string; reason: string }> = [];
  let dir: string;
  try {
    dir = realpathSync(backupDir);
  } catch {
    return { removed, failures };   // no such directory: nothing was backed up there
  }
  let names: string[];
  try {
    if (dir === join(realpathSync(dataDir), 'backups')) return { removed, failures };   // the data dir's own, removed with it
    names = readdirSync(dir);
  } catch (err) {
    // Runs after every store was emptied: a throw here would skip the config reset and
    // drop the structured answer, so it is reported as a failure like any other.
    return { removed, failures: [{ name: '.', reason: err instanceof Error ? err.message : String(err) }] };
  }
  for (const name of names) {
    if (!BACKUP_NAME.test(name)) continue;
    try {
      rmSync(join(dir, name), { recursive: true, force: true });
      removed.push(name);
    } catch (err) {
      failures.push({ name, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return { removed, failures };
}
