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
 *    refuses before anything is deleted. A mount is recognised by its device number and, on
 *    Linux, by its mount id: a bind mount or a second volume on the SAME filesystem has the
 *    same device number, and only the mount id tells it apart.
 */
import { lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, type Stats } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR_INVENTORY, type DataDirEntry } from './data-dir-inventory.js';
import { unsafeRoot } from './workspace-root.js';
import { mountIdAt } from './workspace-fd.js';

/**
 * SQLite sidecars that belong to the database they extend — only a `sqlite` entry has them.
 * The `sidecar` class also carries a log's rotation (`ROTATED` below): both follow the
 * decision of the entry they belong to.
 */
const SIDECAR = /^(.+?)(-wal|-shm|-journal)$/;
/**
 * The one kept generation of a size-rotated measurement log (`bounded-jsonl-log.ts`
 * renames `<name>.jsonl` to `<name>.jsonl.1`). It holds the same records as its live file,
 * so it follows that file's decision — only when the live name is declared.
 */
const ROTATED = /^(.+\.jsonl)\.1$/;
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
  /**
   * `workspace` while the workspace root lives elsewhere (`LYNOX_WORKSPACE_ROOT`): files left at
   * the old place. Acknowledged like an unknown entry, but this instance's data, so a link or a
   * mount there refuses like an owed entry — and it is not recreated after removal.
   */
  | { readonly kind: 'leftover' }
  | { readonly kind: 'unknown' };

/**
 * How the erasure sees the workspace root, which may live outside the data dir and is reached
 * through the anchor (`workspace-access.ts`), never by name.
 */
export interface WorkspaceErasure {
  /** The root is not `<data>/workspace`: a `workspace` entry in the data dir is a leftover. */
  readonly external: boolean;
  /** Whether this path (followed if a link) is the anchored root itself. */
  readonly isRoot: (path: string) => boolean;
  /** Directories below the root on another mount, from the anchor walk. */
  readonly mountBoundaries: () => readonly string[];
  /** Directories in the root (`''` for the root itself) that ARE the data dir, from the same walk. */
  readonly dataDirAt: () => readonly string[];
  /** The anchored root's device and inode, to find it inside the data dir (a bind mount). */
  readonly rootIdentity?: { readonly dev: number; readonly ino: number } | undefined;
}

/** The inventory name of the workspace row. */
const WORKSPACE = 'workspace';

/** Only a vanished entry is skipped; any other error reaching it is reported. */
const isGone = (err: unknown): boolean => (err as NodeJS.ErrnoException | null)?.code === 'ENOENT';

const BY_NAME = new Map(DATA_DIR_INVENTORY.map(e => [e.name, e]));

const isResidue = (name: string): boolean => ENGINE_RESIDUE.some(re => re.test(name));

export function classifyEntry(name: string, opts: { readonly externalWorkspace?: boolean } = {}): EntryClass {
  if (name === WORKSPACE && opts.externalWorkspace === true) return { kind: 'leftover' };
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
  const rotated = ROTATED.exec(name);
  if (rotated && BY_NAME.get(rotated[1]!)?.kind === 'file') return { kind: 'sidecar', of: rotated[1]! };
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
    case 'unknown':
    case 'leftover': return ack.has(name);
    case 'litter': return false;
  }
}

/** Whether the entry at `path` (lstat `st`) sits on another mount than the data dir. */
type OnOtherMount = (path: string, st: Stats) => boolean;

/**
 * The data dir's mount, as a predicate: another device, or (Linux) another mount id. The device
 * alone misses a bind mount or a second volume on the same filesystem.
 */
function otherMountThan(dir: string, dev: number, mountId: (path: string) => number | null): OnOtherMount {
  return otherMount(dev, mountId(dir), mountId);
}

/**
 * The mount id is asked of directories only: a removal descends into a directory, and that is what
 * reaches another filesystem; a file that is a mount point cannot be unlinked (EBUSY). An entry
 * that cannot be asked counts as on another mount (refused, never removed), except one that is
 * gone, which there is nothing left to remove.
 */
function otherMount(dev: number, own: number | null, mountId: (path: string) => number | null): OnOtherMount {
  return (path, st) => {
    if (st.dev !== dev) return true;
    if (own === null || !st.isDirectory()) return false;
    try {
      return mountId(path) !== own;
    } catch (err) {
      return !isGone(err);
    }
  };
}

/**
 * The first path inside `dir` (relative) that sits on another mount than the data dir, or
 * `null`. Walks with `lstat`, so a symlink inside is not followed — removing it only
 * removes the link.
 */
function foreignMountInside(dir: string, onOther: OnOtherMount, lstat: (path: string) => Stats): string | null {
  const stack = [''];
  while (stack.length > 0) {
    const rel = stack.pop()!;
    for (const child of readdirSync(join(dir, rel))) {
      const childRel = rel === '' ? child : join(rel, child);
      const path = join(dir, childRel);
      const st = lstat(path);
      if (st.isSymbolicLink()) continue;
      if (onOther(path, st)) return childRel;
      if (st.isDirectory()) stack.push(childRel);
    }
  }
  return null;
}

/**
 * Why removing or emptying this entry would reach outside the data dir or could not be
 * checked, with what the operator does about it — or `null`. The remedy depends on whose
 * content it is: for an entry the erasure owes, the content is this instance's data and
 * has to be erased where it lives; for an unknown entry it is not, and the remedy is to
 * take the entry out of the data dir instead of acknowledging it. One sentence for both
 * sends the operator the wrong way in one of them.
 */
function linkedReason(cls: EntryClass, st: Stats, onOther: OnOtherMount, path: string, lstat: (path: string) => Stats, walk: boolean): LinkedReason | null {
  // A SQLite store is emptied through the handle the engine holds open, which writes the
  // file wherever it lives — through a link or on another device alike.
  if (cls.kind === 'declared' && cls.entry.kind === 'sqlite') return null;
  const ours = cls.kind !== 'unknown';
  const elsewhere = ours
    ? 'This instance\'s data is there: erase it where it lives and remove the link or mount, or move the content into the data directory.'
    : 'This is not this instance\'s data: move the entry out of the data directory instead of acknowledging it.';
  if (st.isSymbolicLink()) {
    // An unknown link is only unlinked, its target untouched. One the erasure owes holds
    // this instance's data at the target, and unlinking it would answer "all deleted".
    const followsLink = cls.kind !== 'unknown' && !(cls.kind === 'declared' && cls.entry.erase.by === 'keep');
    return followsLink ? { reason: 'a symbolic link; its content is at the target, outside the data directory', remedy: elsewhere } : null;
  }
  if (onOther(path, st)) return { reason: 'a mount point; its content is on another filesystem', remedy: elsewhere };
  if (walk && st.isDirectory()) {
    // Fail closed: a directory that cannot be read may hold a mount the removal would empty.
    let inside: string | null;
    try {
      inside = foreignMountInside(path, onOther, lstat);
    } catch (err) {
      return {
        reason: `could not be read to check for mount points inside (${err instanceof Error ? err.message : String(err)})`,
        remedy: ours
          ? 'Make it readable to this instance, then erase.'
          : 'Make it readable to this instance, or move the entry out of the data directory instead of acknowledging it.',
      };
    }
    if (inside !== null) return { reason: `contains a mount point (${inside}); its content is on another filesystem`, remedy: elsewhere };
  }
  return null;
}

interface LinkedReason {
  readonly reason: string;
  /** What to do about it — differs by whether the content is this instance's data. */
  readonly remedy: string;
}

export interface LinkedEntry extends LinkedReason {
  readonly name: string;
}

export interface DataDirScan {
  /** The data dir as resolved on disk, so a data dir that is itself a symlink compares correctly. */
  readonly dir: string;
  readonly dev: number;
  /** The data dir's mount id (Linux), or null; with `dev`, what "on another mount" is measured against. */
  readonly mnt: number | null;
  readonly unknown: readonly EntryIdentity[];
  /**
   * Entries the erasure would remove or empty — or would remove once acknowledged — that
   * reach outside the data dir. The route refuses while there is one.
   */
  readonly linked: readonly LinkedEntry[];
  /** Entries this instance knows and removes without asking, for the caller to be told. */
  readonly removedWithoutAsking: readonly string[];
  /** Entries this instance knows and empties in place (`step`), for the caller to be told. */
  readonly emptiedInPlace: readonly string[];
  /** Litter seen, named for the log only — it neither blocks nor counts. */
  readonly litter: readonly string[];
}

export interface ScanOptions {
  /**
   * Unknown entries the caller acknowledged. Only those are checked for links and mounts:
   * the erasure owes nothing for an unknown entry until it is acknowledged, and walking a
   * broad data dir's every directory would cost the request — and fail on the first one it
   * may not read — for entries it will not touch.
   */
  readonly acknowledged?: ReadonlySet<string> | undefined;
  /** `false` skips the walk into directories (a rescan that only needs `unknown`). */
  readonly walk?: boolean | undefined;
  /** Injected only by tests: a mount cannot be created without privileges. */
  readonly lstat?: ((path: string) => Stats) | undefined;
  /** Injected only by tests, for the same reason: the mount id of a path, a link not followed. */
  readonly mountId?: ((path: string) => number | null) | undefined;
  /**
   * The workspace root. Without it the `workspace` row is treated by name, as a plain entry of
   * the data dir; the erase route passes it whenever the root exists or the engine holds it.
   */
  readonly workspace?: WorkspaceErasure | undefined;
}

/**
 * The directories in `dir` (relative), at any depth, that are the directory `id`; symlinks are not
 * followed. `skipTop` is a top-level name not to report or enter: the default root, which IS the
 * root by design. Fails loudly on an unreadable directory: it could hold the root.
 */
function directoriesWithIdentity(dir: string, id: { readonly dev: number; readonly ino: number }, skipTop: string | null): string[] {
  const found: string[] = [];
  const stack = [''];
  while (stack.length > 0) {
    const rel = stack.pop()!;
    for (const d of readdirSync(join(dir, rel), { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const childRel = rel === '' ? d.name : join(rel, d.name);
      if (rel === '' && (d.name === skipTop || OS_LITTER.has(d.name))) continue;
      const st = lstatSync(join(dir, childRel));
      if (st.dev === id.dev && st.ino === id.ino) { found.push(childRel); continue; }
      stack.push(childRel);
    }
  }
  return found;
}

/** Why a `<data>/workspace` link must not be emptied as the root (`unsafeRoot`), or null. */
function linkedRootReason(path: string, dataDir: string): string | null {
  let real: string;
  try {
    real = realpathSync(path);
  } catch (err) {
    return `a symbolic link whose target could not be resolved (${err instanceof Error ? err.message : String(err)})`;
  }
  switch (unsafeRoot(real, dataDir)) {
    case 'holds-data-dir': return `a symbolic link to ${real}, which is the data directory or contains it; emptying it would empty the data directory`;
    case 'inside-data-dir': return `a symbolic link to ${real}, inside the data directory; emptying it would empty that entry`;
    case null: return null;
  }
}

export function scanDataDir(dataDir: string, opts: ScanOptions = {}): DataDirScan {
  const lstat = opts.lstat ?? lstatSync;
  const ack = opts.acknowledged ?? new Set<string>();
  const walk = opts.walk ?? true;
  const mountId = opts.mountId ?? mountIdAt;
  const dir = realpathSync(dataDir);
  const dev = statSync(dir).dev;
  const mnt = mountId(dir);
  const onOther = otherMountThan(dir, dev, mountId);
  const unknown: EntryIdentity[] = [];
  const linked: LinkedEntry[] = [];
  const removedWithoutAsking: string[] = [];
  const emptiedInPlace: string[] = [];
  const litter: string[] = [];
  const ws = opts.workspace;
  // The root is emptied through the anchor, which refuses a mount below it: asked here, before
  // anything is deleted, so the whole erasure stops instead of failing after the stores.
  if (ws !== undefined) {
    const boundaries = ws.mountBoundaries();
    if (boundaries.length > 0) {
      linked.push({
        name: WORKSPACE,
        reason: `the workspace root contains a mount point (${boundaries.join(', ')}); its content is on another filesystem`,
        remedy: 'This instance\'s data is there: erase it where it lives and remove the mount, or move the content into the workspace root.',
      });
    }
    // Emptying the root must not empty the data dir, and erasing the data dir must not empty the
    // root through another path. Paths alone cannot show either when a bind mount is involved: the
    // same directory appears under a second, unrelated name. So by identity, both ways.
    const dataDirAt = ws.dataDirAt();
    if (dataDirAt.length > 0) {
      linked.push({
        name: WORKSPACE,
        reason: `the workspace root contains the data directory (${dataDirAt.map(p => p === '' ? '.' : p).join(', ')}); emptying it would empty the data directory`,
        remedy: 'Point the workspace at a directory of its own, outside the data directory, then erase.',
      });
    }
    if (ws.rootIdentity !== undefined && walk) {
      const at = directoriesWithIdentity(dir, ws.rootIdentity, ws.external ? null : WORKSPACE);
      if (at.length > 0) {
        linked.push({
          name: WORKSPACE,
          reason: `the workspace root is also inside the data directory (${at.join(', ')}); erasing the data directory would empty it by that path`,
          remedy: 'Point the workspace at a directory of its own, outside the data directory, then erase.',
        });
      }
    }
  }
  for (const name of readdirSync(dir)) {
    const cls = classifyEntry(name, { externalWorkspace: ws?.external === true });
    if (cls.kind === 'litter') { litter.push(name); continue; }
    const path = join(dir, name);
    let st: Stats;
    try {
      st = lstat(path);
    } catch (err) {
      if (isGone(err)) continue;   // gone since the listing
      throw err;                   // the route answers 500, nothing erased
    }
    // The default root itself is emptied through the anchor, not removed by name: the root and
    // the anchor the engine holds survive the erasure. That holds for a `<data>/workspace` that is
    // a mount point or a link as well, as long as it IS the anchored root (followed): the anchor
    // empties the directory it holds, wherever that lives. A link to the data directory, to a
    // directory that contains it, or to one inside it is refused: emptying it would empty that.
    if (ws !== undefined && cls.kind === 'declared' && name === WORKSPACE && ws.isRoot(path)) {
      const unsafe = st.isSymbolicLink() ? linkedRootReason(path, dir) : null;
      if (unsafe === null) {
        emptiedInPlace.push(name);
      } else {
        linked.push({
          name,
          reason: unsafe,
          remedy: 'Point the workspace at a directory of its own, outside the data directory, then erase.',
        });
      }
      continue;
    }
    const inPlace = cls.kind === 'declared' && cls.entry.erase.by === 'step';
    if (cls.kind === 'unknown' || cls.kind === 'leftover') unknown.push(identityOf(name, st));
    else if (owedBy(cls, ack, name)) removedWithoutAsking.push(name);
    else if (inPlace) emptiedInPlace.push(name);
    // Asked of everything the erasure touches through a path: what it removes, what it
    // empties in place, and the unknown entries acknowledged for removal.
    if (!owedBy(cls, ack, name) && !inPlace) continue;
    const found = linkedReason(cls, st, onOther, path, lstat, walk);
    if (found !== null) linked.push({ name, ...found });
  }
  unknown.sort((a, b) => a.name.localeCompare(b.name));
  linked.sort((a, b) => a.name.localeCompare(b.name));
  removedWithoutAsking.sort((a, b) => a.localeCompare(b));
  emptiedInPlace.sort((a, b) => a.localeCompare(b));
  return { dir, dev, mnt, unknown, linked, removedWithoutAsking, emptiedInPlace, litter };
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
 * atomic-write temp a crash left beside a declared entry that is not kept (a `config.json`
 * temp holds the whole config), the engine's own residue, and the acknowledged unknown
 * entries. A link or mount found here after all is reported, not removed. The
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
  /** As in `ScanOptions.workspace`: the root is skipped here and emptied through its anchor. */
  workspace?: WorkspaceErasure,
  /** Injected only by tests, as `ScanOptions.mountId`. */
  mountId: (path: string) => number | null = mountIdAt,
): RemoveOutcome {
  const removed: string[] = [];
  const failures: Array<{ name: string; reason: string }> = [];
  const ack = new Set(acknowledgedUnknown);
  const owed: Array<{ name: string; cls: EntryClass }> = [];
  const onOther = otherMount(scan.dev, scan.mnt, mountId);
  let names: string[];
  try {
    names = readdirSync(scan.dir);
  } catch (err) {
    return { removed, failures: [{ name: '.', reason: err instanceof Error ? err.message : String(err) }] };
  }
  for (const name of names) {
    const cls = classifyEntry(name, { externalWorkspace: workspace?.external === true });
    if (workspace !== undefined && cls.kind === 'declared' && name === WORKSPACE && workspace.isRoot(join(scan.dir, name))) continue;
    if (owedBy(cls, ack, name)) owed.push({ name, cls });
  }
  owed.sort((a, b) => Number(a.name === 'backups') - Number(b.name === 'backups'));
  for (const { name, cls } of owed) {
    const path = join(scan.dir, name);
    let st: Stats;
    try {
      st = lstat(path);
    } catch (err) {
      if (isGone(err)) continue;   // gone since the listing
      failures.push({ name, reason: err instanceof Error ? err.message : String(err) });
      continue;
    }
    // The scan refused these already; asked again because the stretch runs after an await.
    const found = linkedReason(cls, st, onOther, path, lstat, true);
    if (found !== null) {
      failures.push({ name, reason: `${found.reason}; not removed` });
      continue;
    }
    try {
      // `rmSync` on a symlink removes the link itself, never its target.
      rmSync(path, { recursive: true, force: true });
      removed.push(name);
      // Keyed on the class, not the name: a `workspace` leftover is removed for good.
      if (cls.kind === 'declared' && cls.entry.kind === 'dir' && st.isDirectory()) mkdirSync(path, { mode: st.mode & 0o777 });
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
