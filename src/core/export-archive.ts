import { closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, mkdtempSync, openSync, readdirSync, realpathSync, rmSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { DATA_DIR_INVENTORY } from './data-dir-inventory.js';
import { DATASTORE_EXPORT, DIR_JSON_STRIP, EXPORT_TABLES, type ExportedStore, type ExportTable } from './export-tables.js';
import { readSlot, type HeldSlot } from './export-slot.js';
import { shellIsolation, type ShellIsolation } from './shell-isolation.js';
import { snapshotBound, snapshotSqlite } from './sqlite-snapshot.js';
import { strictDecrypt } from './strict-decrypt.js';
import { TarWriter, tarNameProblem } from './tar-writer.js';
import { EXPORT_SCAN_MIN } from './secret-store.js';
import { isProvisionedInstance } from './wire-capture.js';
import { fdRealPath } from './workspace-fd.js';
import {
  appendWorkspace, checkStagingDir, EXPORT_STAGING_DIR, ExportSpaceError, freeBytesAt, guardContent, hasCredentialName,
  secretInodes, SPACE_FLOOR_BYTES, SPACE_RECHECK_BYTES, type ContentGuard, type WorkspaceManifest,
} from './workspace-export.js';

/**
 * The complete data export (Art. 15 copy, Art. 20 portability) as one tar, staged in the data
 * directory and then handed out: by the export command (`scripts/export-archive.ts`) on the operator's
 * path today, by the HTTP doors later.
 *
 * WHAT IS IN IT, AND WHY IT IS DECIDED ELSEWHERE. Every data-directory entry carries an `export`
 * decision in `data-dir-inventory.ts`, and every table of an included SQLite store one in
 * `export-tables.ts`. This file only carries out those decisions; it decides nothing itself.
 *
 * HOW A STORE IS READ. From a `VACUUM INTO` snapshot in the request's staging directory (never the
 * live file, never through the store classes, whose constructors migrate or recreate), by raw SQL,
 * one JSONL part per included table. EVERY text value is decrypted strictly with the store's key
 * (`strictDecrypt`): a value without the `enc:` prefix passes unchanged, a value with it is
 * decrypted or replaced by a marker, never written out as ciphertext. The column map in
 * `EXPORT_TABLES` is therefore an assertion the tests hold, not what keeps ciphertext out. Then
 * keyed digests are stripped (`strip`, `stripJson`), and every text value is masked with the
 * caller's masker (the vault's values and the secret patterns).
 *
 * WHAT THE RECIPIENT SEES. `README.txt` first (what each part is, in plain words), the parts,
 * `config.redacted.json`, `secret-names.json`, the workspace files, and `manifest.json` last (counts,
 * what is not included and why, what could not be read, the snapshot time).
 */

/** Name prefix of an archive request's directory inside the staging directory. */
export const ARCHIVE_DIR_PREFIX = 'archive-';
export const ARCHIVE_FILE = 'lynox-export.tar';
export const README_NAME = 'README.txt';
export const MANIFEST_NAME = 'manifest.json';
export const CONFIG_PART = 'config.redacted.json';
export const SECRET_NAMES_PART = 'secret-names.json';
/** What a value that could not be decrypted reads as in a part. */
export const UNDECRYPTABLE_MARKER = '[not readable: stored encrypted and could not be decrypted]';
/** What a JSON value reads as when a path had to be removed from it and it is not JSON. */
export const WITHHELD_SECRET_MARKER = '[withheld: these bytes hold a saved secret value]';
export const WITHHELD_JSON_MARKER = '[withheld: holds a field that is never exported, and could not be read as JSON to remove it]';

export interface ArchiveKeys {
  /** engine.db's column key (`deriveEngineEncKey`), or null without a vault key. */
  readonly engine: Buffer | null;
  /** history.db's column key (`deriveHistoryEncKey`), or null without a vault key. */
  readonly history: Buffer | null;
}

export interface PrepareArchiveOptions {
  /** The export slot, taken by the caller (`acquireSlot(…, 'export', …)`); refused when it is not live. */
  readonly slot: HeldSlot;
  readonly keys: ArchiveKeys;
  /**
   * Masks secret values in text (the vault's values in every form the export knows, and the secret
   * patterns), and says whether raw bytes hold one (`SecretStore.exportGuard`).
   */
  readonly guard: ContentGuard;
  /** The redacted settings (`redactConfigForResponse`), or null when there are none. */
  readonly config: Readonly<Record<string, unknown>> | null;
  /** The vault's secret names (never values). */
  readonly secretNames: readonly string[];
  readonly isolation?: ShellIsolation;
  /** Whether the control plane provisioned this instance (`isProvisionedInstance`): picks the README's sidecar sentence. */
  readonly provisioned?: boolean;
  readonly now?: () => number;
  /** How often the slot's time moves forward while the archive is staged (its heartbeat). */
  readonly heartbeatMs?: number;
}

export interface TablePart {
  readonly table: string;
  readonly file: string;
  readonly rows: number;
  /** Values that carried `enc:` and were decrypted. */
  readonly decrypted: number;
  /** Values that carried `enc:` and could not be decrypted: written as `UNDECRYPTABLE_MARKER`. */
  readonly undecryptable: number;
  /** JSON values withheld because a path could not be removed from them. */
  readonly withheld: number;
}

export interface StorePart {
  readonly store: string;
  readonly present: boolean;
  readonly tables: TablePart[];
  /** Tables not carried, with the reason the decision gives. */
  readonly not_included: Array<{ readonly table: string; readonly why: string }>;
  /** Tables the decisions do not know (a newer software version made them): not carried, and the export says it may be incomplete. */
  readonly undecided: string[];
}

export interface DirectoryPart {
  readonly directory: string;
  readonly present: boolean;
  readonly files: number;
  readonly bytes: number;
  /** Not copied: not a regular file, a name not safe to extract, a credential's name, a link to a credential, or a file the byte scan found a secret value in. */
  readonly skipped: string[];
  readonly unreadable: Array<{ readonly path: string; readonly code: string }>;
  /** Copied as they are because they are not text (not masked); the byte scan found no secret value in them. */
  readonly not_masked: string[];
  /** Withheld because the byte scan found a secret value in them (also under `skipped`). */
  readonly held_back_secret: string[];
}

export interface ArchiveManifest {
  readonly format: 'lynox-export/1';
  readonly created_at: string;
  /** When the first store was snapshotted: changes after this are not in the export. */
  readonly as_of: string;
  readonly stores: StorePart[];
  readonly directories: DirectoryPart[];
  readonly workspace: WorkspaceManifest;
  readonly config: boolean;
  /** Data-directory entries not carried, with the reason. Credentials are not listed by content. */
  readonly not_included: Array<{ readonly entry: string; readonly why: string }>;
  readonly may_be_incomplete: boolean;
}

export interface PreparedArchive {
  /** The request's own staging directory; remove it with `removeArchive` once handed out. */
  readonly dir: string;
  readonly path: string;
  readonly size: number;
  readonly manifest: ArchiveManifest;
}

/** Thrown when the export slot passed in is not the live one (released, broken as stale, or another's). */
export class ExportSlotError extends Error {
  constructor() {
    super('the export slot is not held by this export');
    this.name = 'ExportSlotError';
  }
}

// run-group-starter: one immediate that resolves once on the next turn; it starts nothing else and reports no spend.
const turn = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

/** Included SQLite stores, in inventory order. */
const INCLUDED_STORES: readonly string[] = DATA_DIR_INVENTORY.filter(e => e.kind === 'sqlite' && e.export.by === 'include').map(e => e.name);
/** Included directories other than the workspace (which has its own walk). */
const INCLUDED_DIRS: readonly string[] = DATA_DIR_INVENTORY.filter(e => e.kind === 'dir' && e.export.by === 'include' && e.name !== 'workspace').map(e => e.name);

const isMigrationTemp = (name: string): boolean => /_(?:v|new)$/.test(name) || name.startsWith('sqlite_');

function keyFor(store: string, keys: ArchiveKeys): Buffer | null {
  if (store === 'engine.db') return keys.engine;
  if (store === 'history.db') return keys.history;
  return null;
}

/** Remove a dotted JSON path (`$.a.b.c`) from `obj` in place. */
function removePath(obj: unknown, path: string): void {
  const parts = path.replace(/^\$\./, '').split('.');
  let cur: unknown = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur === null || typeof cur !== 'object') return;
    cur = (cur as Record<string, unknown>)[parts[i]!];
  }
  if (cur !== null && typeof cur === 'object') delete (cur as Record<string, unknown>)[parts[parts.length - 1]!];
}

/** `text` with `paths` removed, re-serialized; `null` when it is not JSON (the caller withholds it). */
function stripJsonText(text: string, paths: readonly string[]): string | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  for (const p of paths) removePath(v, p);
  return JSON.stringify(v);
}

/** Writes `text` lines to a part file, looking at the free space as it goes. */
class PartWriter {
  private fd: number;
  private sinceCheck = 0;
  constructor(readonly path: string, private readonly spacePath: string) {
    this.fd = openSync(path, 'wx', 0o600);
  }
  line(text: string): void {
    const buf = Buffer.from(`${text}\n`, 'utf8');
    let off = 0;
    while (off < buf.length) off += writeSync(this.fd, buf, off, buf.length - off);
    this.sinceCheck += buf.length;
    if (this.sinceCheck >= SPACE_RECHECK_BYTES) {
      this.sinceCheck = 0;
      const available = freeBytesAt(this.spacePath);
      if (available < SPACE_FLOOR_BYTES) throw new ExportSpaceError(SPACE_FLOOR_BYTES, available);
    }
  }
  close(): void {
    closeSync(this.fd);
  }
}

/** Add the file at `path` to the tar as `name`, then remove it. */
async function moveIntoTar(tar: TarWriter, name: string, path: string, mtime: number, spacePath: string): Promise<void> {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    // The part is copied while it still exists: the tar grows by its size before the part goes.
    const available = freeBytesAt(spacePath);
    if (available < SPACE_FLOOR_BYTES + size) throw new ExportSpaceError(SPACE_FLOOR_BYTES + size, available);
    await tar.addFile(name, fd, size, mtime);
  } finally {
    closeSync(fd);
  }
  unlinkSync(path);
}

/** One row as it goes into a part: decrypted strictly, stripped, masked. */
function exportRow(
  row: Record<string, unknown>,
  decision: ExportTable | null,
  key: Buffer | null,
  guard: ContentGuard,
  counts: { decrypted: number; undecryptable: number; withheld: number },
): Record<string, unknown> {
  const mask = guard.mask;
  const out: Record<string, unknown> = {};
  const strip = new Set(decision?.strip ?? []);
  for (const [col, value] of Object.entries(row)) {
    if (strip.has(col)) continue;
    if (typeof value === 'string') {
      const r = strictDecrypt(value, key);
      if (!r.ok) {
        counts.undecryptable++;
        out[col] = UNDECRYPTABLE_MARKER;
        continue;
      }
      if (r.kind === 'decrypted') counts.decrypted++;
      let text = r.text;
      const paths = decision?.stripJson?.[col];
      if (paths !== undefined) {
        const stripped = stripJsonText(text, paths);
        if (stripped === null) {
          counts.withheld++;
          out[col] = WITHHELD_JSON_MARKER;
          continue;
        }
        text = stripped;
      }
      out[col] = mask(text);
    } else if (Buffer.isBuffer(value)) {
      // Bytes cannot be masked in place: a value that holds a secret value is withheld, counted with the table.
      if (guard.holds(value)) {
        counts.withheld++;
        out[col] = WITHHELD_SECRET_MARKER;
      } else {
        out[col] = { base64: value.toString('base64') };
      }
    } else {
      out[col] = value;
    }
  }
  return out;
}

async function exportStore(
  tar: TarWriter,
  dataDir: string,
  dir: string,
  store: string,
  opts: PrepareArchiveOptions,
  mtime: number,
): Promise<StorePart> {
  const src = join(dataDir, store);
  if (!existsSync(src)) return { store, present: false, tables: [], not_included: [], undecided: [] };
  const bound = snapshotBound(src);
  const available = freeBytesAt(dir);
  if (available < bound + SPACE_FLOOR_BYTES) throw new ExportSpaceError(bound + SPACE_FLOOR_BYTES, available);
  const snap = join(dir, `${store}.snapshot`);
  snapshotSqlite(src, snap);
  const tables: TablePart[] = [];
  const notIncluded: Array<{ table: string; why: string }> = [];
  const undecided: string[] = [];
  const db = new Database(snap, { readonly: true });
  try {
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>).map(r => r.name).filter(n => !isMigrationTemp(n));
    let carry: (name: string) => { decision: ExportTable | null } | { why: string } | null;
    if (store === 'datastore.db') {
      const registered = names.includes(DATASTORE_EXPORT.registry)
        ? new Set((db.prepare(`SELECT name FROM "${DATASTORE_EXPORT.registry}"`).all() as Array<{ name: string }>).map(r => String(r.name)))
        : new Set<string>();
      carry = (name) => {
        if (name === DATASTORE_EXPORT.registry) return { decision: null };
        if (name.startsWith(DATASTORE_EXPORT.tablePrefix) && registered.has(name.slice(DATASTORE_EXPORT.tablePrefix.length))) return { decision: null };
        return null;
      };
    } else {
      const list = EXPORT_TABLES[store as ExportedStore];
      carry = (name) => {
        const inc = list.include[name];
        if (inc !== undefined) return { decision: inc };
        const why = list.name[name];
        if (why !== undefined) return { why };
        return null;
      };
    }
    const key = keyFor(store, opts.keys);
    for (const name of names) {
      const c = carry(name);
      if (c === null) { undecided.push(name); continue; }
      if ('why' in c) { notIncluded.push({ table: name, why: c.why }); continue; }
      const file = `stores/${store}/${name}.jsonl`;
      const partPath = join(dir, `part-${tables.length}.jsonl`);
      const w = new PartWriter(partPath, dir);
      const counts = { decrypted: 0, undecryptable: 0, withheld: 0 };
      let rows = 0;
      try {
        for (const row of db.prepare(`SELECT * FROM "${name.replace(/"/g, '""')}"`).iterate() as Iterable<Record<string, unknown>>) {
          w.line(JSON.stringify(exportRow(row, c.decision, key, opts.guard, counts)));
          rows++;
          if (rows % 1000 === 0) await turn();
        }
      } finally {
        w.close();
      }
      await moveIntoTar(tar, file, partPath, mtime, dir);
      tables.push({ table: name, file, rows, ...counts });
    }
  } finally {
    db.close();
    rmSync(snap, { force: true });
  }
  return { store, present: true, tables, not_included: notIncluded, undecided };
}

/**
 * Open `full` for reading only if it is still the regular file the walk saw (`ino`), reached
 * without a link, and still inside `rootReal`. The walk lstats first and opens after a turn of the
 * event loop, so an entry swapped for a link in between (or a directory above it swapped for one)
 * must not be followed: `O_NOFOLLOW` covers the last segment, and the opened file's real path,
 * read back from the fd, covers the directories above it. Where the fd's path cannot be read back
 * (`fdRealPath` gives null, e.g. on macOS) the file is refused, not read unchecked. `null` = refused.
 */
export function openVerified(full: string, rootReal: string, ino: number, readBack: (fd: number) => string | null = fdRealPath): number | null {
  let fd: number;
  try {
    fd = openSync(full, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch {
    return null;
  }
  let ok = false;
  try {
    const st = fstatSync(fd);
    if (st.isFile() && st.ino === ino) {
      const real = readBack(fd);
      ok = real !== null && real.startsWith(`${rootReal}/`);
    }
  } catch {
    ok = false;
  }
  if (!ok) {
    closeSync(fd);
    return null;
  }
  return fd;
}

/** Whether `realPath` is still the entry with inode `ino` (the root a walk lstat'ed before resolving it). */
export function resolvesTo(realPath: string, ino: number): boolean {
  try {
    return statSync(realPath).ino === ino;
  } catch {
    return false;
  }
}

/**
 * Copy an included directory (`memory/`, `artifacts/`, …): regular files only, never through a
 * link, each read through its verified fd. Text is masked; other files are byte-scanned and
 * withheld when they hold a secret value, else copied as they are and listed under `not_masked`.
 */
async function exportDirectory(tar: TarWriter, dataDir: string, dir: string, name: string, secrets: Set<string>, guard: ContentGuard): Promise<DirectoryPart> {
  const root = join(dataDir, name);
  const absent = (skipped: string[]): DirectoryPart => ({ directory: name, present: false, files: 0, bytes: 0, skipped, unreadable: [], not_masked: [], held_back_secret: [] });
  let rootSt;
  try {
    rootSt = lstatSync(root);
  } catch {
    return absent([]);
  }
  if (!rootSt.isDirectory()) return absent([name]);
  const rootReal = realpathSync(root);
  // The directory resolved must be the one just looked at, not a link swapped in between.
  if (!resolvesTo(rootReal, rootSt.ino)) return absent([name]);
  const strip = DIR_JSON_STRIP[name];
  const skipped: string[] = [];
  const unreadable: Array<{ path: string; code: string }> = [];
  const notMasked: string[] = [];
  const heldBack: string[] = [];
  let files = 0;
  let bytes = 0;
  const visit = async (rel: string): Promise<void> => {
    let entries: string[];
    try {
      entries = readdirSync(join(root, rel)).sort();
    } catch (err) {
      unreadable.push({ path: rel || '.', code: (err as NodeJS.ErrnoException).code ?? 'ERROR' });
      return;
    }
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry}` : entry;
      const full = join(root, childRel);
      let st;
      try {
        st = lstatSync(full);
      } catch (err) {
        unreadable.push({ path: childRel, code: (err as NodeJS.ErrnoException).code ?? 'ERROR' });
        continue;
      }
      if (st.isDirectory()) { await visit(childRel); continue; }
      const tarName = `${name}/${childRel}`;
      if (!st.isFile() || tarNameProblem(tarName) !== null || hasCredentialName(childRel) || secrets.has(`${st.dev}:${st.ino}`)) {
        skipped.push(childRel);
        continue;
      }
      await turn();
      const fd = openVerified(full, rootReal, st.ino);
      if (fd === null) { skipped.push(childRel); continue; }
      try {
        const fst = fstatSync(fd);
        const available = freeBytesAt(dir);
        if (available < SPACE_FLOOR_BYTES + fst.size) throw new ExportSpaceError(SPACE_FLOOR_BYTES + fst.size, available);
        const c = guardContent(fd, fst.size, guard);
        if (c.kind === 'secret') { skipped.push(childRel); heldBack.push(childRel); continue; }
        let out = c.bytes;
        if (strip !== undefined && entry.endsWith('.json')) {
          // A JSON file here can carry fields that are never exported: removed, or the file is withheld.
          const stripped = c.kind === 'text' && out !== null ? stripJsonText(out.toString('utf8'), strip) : null;
          if (stripped === null) { skipped.push(childRel); continue; }
          out = Buffer.from(stripped, 'utf8');
        }
        if (c.kind === 'raw') notMasked.push(childRel);
        if (out !== null) {
          tar.addBuffer(tarName, out, fst.mtimeMs / 1000);
          bytes += out.length;
        } else {
          await tar.addFile(tarName, fd, fst.size, fst.mtimeMs / 1000);
          bytes += fst.size;
        }
        files++;
      } catch (err) {
        if (err instanceof ExportSpaceError) throw err;
        unreadable.push({ path: childRel, code: (err as NodeJS.ErrnoException).code ?? 'ERROR' });
      } finally {
        closeSync(fd);
      }
    }
  };
  await visit('');
  return { directory: name, present: true, files, bytes, skipped, unreadable, not_masked: notMasked, held_back_secret: heldBack };
}

/** Each included directory in plain words, for the README. */
const DIR_ABOUT: Readonly<Record<string, string>> = {
  memory: 'the notes the assistant keeps, one text file per area, and for each project a list of the files it has already read',
  artifacts: 'the documents and pages the assistant made for you, as files (artifacts.jsonl describes them)',
  apis: 'the descriptions of the services you connected, one file each, without passwords or keys',
  sweeps: 'records of clean-ups in which duplicate people, companies or topics were merged or archived; each keeps the state from before, so the clean-up can be undone',
};

/** The README, in plain words, from the same decisions the archive follows. */
export function renderReadme(isolation: ShellIsolation, provisioned = false): string {
  const lines: string[] = [];
  lines.push('YOUR DATA FROM LYNOX');
  lines.push('');
  lines.push('This archive is a copy of the data this lynox installation holds for you. A few parts are left out;');
  lines.push('manifest.json lists each one under "not_included", with the reason.');
  lines.push('The quick JSON export in your account is a smaller summary; this archive holds much more.');
  lines.push('');
  lines.push('How to read it:');
  lines.push('- Each file under stores/ is one table, one record per line, in JSON (JSONL). Any text editor opens it;');
  lines.push('  a spreadsheet tool or a script can read it as well.');
  lines.push('- manifest.json lists every part with its number of records, what is not included and why,');
  lines.push('  and the time the copy was taken ("as_of"). Changes after that time are not in this copy.');
  lines.push('- If manifest.json says "may_be_incomplete": true, some part could not be read in full; its entry in manifest.json says which.');
  lines.push('- Passwords and keys you saved are not exported: the files that hold them are left out, and secret-names.json');
  lines.push('  lists only their names. Where a saved value appears anywhere else as text, it is hidden. In the records and in');
  lines.push('  text files it is replaced; files that are not text, such as PDFs or images, are checked for them: a file in');
  lines.push('  which the check finds a saved value is left out (marked "held_back_secret" in manifest.json), any other is');
  lines.push('  copied as it is (marked "not_masked"). The check cannot see inside compressed files, such as Word or Excel');
  lines.push(`  documents, ZIP archives and many PDFs, and it misses values shorter than ${String(EXPORT_SCAN_MIN)} characters, so a copied`);
  lines.push('  file may still contain a saved value.');
  lines.push('- A few internal check values are removed from some tables; they hold none of your content.');
  lines.push('- config.redacted.json holds your settings, with keys and passwords removed.');
  lines.push(`- A value that reads "${UNDECRYPTABLE_MARKER}" was stored encrypted and could not be read back.`);
  lines.push('');
  for (const store of INCLUDED_STORES) {
    if (store === 'datastore.db') {
      lines.push(`stores/${store}/`);
      lines.push(`  ${DATASTORE_EXPORT.registry}.jsonl: the tables you created yourself, and their columns`);
      lines.push(`  ${DATASTORE_EXPORT.tablePrefix}<name>.jsonl: the records of your table <name>`);
      lines.push('');
      continue;
    }
    const list = EXPORT_TABLES[store as ExportedStore];
    lines.push(`stores/${store}/`);
    for (const [table, d] of Object.entries(list.include)) lines.push(`  ${table}.jsonl: ${d.about}`);
    lines.push('');
  }
  lines.push('Folders:');
  for (const name of INCLUDED_DIRS) lines.push(`  ${name}/: ${DIR_ABOUT[name] ?? ''}`);
  if (isolation.kind === 'sidecar') {
    lines.push('  workspace/: not in this archive. On this installation your files are stored apart from the assistant.');
    lines.push(provisioned
      ? '  To get them, write to privacy@lynox.ai and ask for them.'
      : '  To get them, ask the operator of this installation.');
  } else {
    lines.push('  workspace/: the files you and the assistant saved');
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

/**
 * Stage the complete archive in a new directory under `export-staging/` and return it. The caller
 * holds the export slot for as long as the staged archive exists (refreshing it while it streams),
 * and removes it with `removeArchive` once handed out. The directory carries the slot's job in its
 * name, so `--finish` can tell its own archive from another's. On any error the staging directory
 * is removed and the error thrown (`ExportSpaceError` when the disk would cross the floor).
 */
export async function prepareArchive(dataDir: string, opts: PrepareArchiveOptions): Promise<PreparedArchive> {
  const live = readSlot(dataDir);
  if (live === null || live.kind !== 'export' || live.job !== opts.slot.info.job) throw new ExportSlotError();
  const isolation = opts.isolation ?? shellIsolation();
  const provisioned = opts.provisioned ?? isProvisionedInstance();
  const now = opts.now ?? Date.now;
  const staging = join(dataDir, EXPORT_STAGING_DIR);
  checkStagingDir(staging, true);
  const dir = mkdtempSync(join(staging, `${archiveDirPrefixFor(opts.slot.info.job)}`));
  const path = join(dir, ARCHIVE_FILE);
  // The heartbeat while staging: a large instance can take longer than the slot's TTL, and an
  // erasure must not find the slot stale (and remove this archive) while it is still being made.
  const beat = setInterval(() => {
    try { opts.slot.refresh(); } catch { /* the next beat tries again; the TTL is the bound */ }
  }, opts.heartbeatMs ?? 60_000);
  beat.unref();
  try {
    const fd = openSync(path, 'wx', 0o600);
    let manifest: ArchiveManifest;
    try {
      const tar = new TarWriter(fd);
      const mtime = now() / 1000;
      tar.addBuffer(README_NAME, Buffer.from(renderReadme(isolation, provisioned), 'utf8'), mtime);
      const asOf = new Date(now()).toISOString();
      const stores: StorePart[] = [];
      for (const store of INCLUDED_STORES) stores.push(await exportStore(tar, dataDir, dir, store, opts, mtime));
      const secrets = secretInodes(dataDir);
      const directories: DirectoryPart[] = [];
      for (const name of INCLUDED_DIRS) directories.push(await exportDirectory(tar, dataDir, dir, name, secrets, opts.guard));
      const workspace = await appendWorkspace(tar, dataDir, path, isolation, opts.guard);
      if (opts.config !== null) tar.addBuffer(CONFIG_PART, Buffer.from(opts.guard.mask(JSON.stringify(opts.config, null, 2)), 'utf8'), mtime);
      tar.addBuffer(SECRET_NAMES_PART, Buffer.from(JSON.stringify([...opts.secretNames].sort(), null, 2), 'utf8'), mtime);
      const notIncluded = DATA_DIR_INVENTORY.flatMap(e => (e.export.by === 'name' ? [{ entry: e.name, why: e.export.why }] : []));
      const incomplete = stores.some(s => s.undecided.length > 0 || s.tables.some(t => t.undecryptable > 0 || t.withheld > 0))
        || directories.some(d => d.skipped.length > 0 || d.unreadable.length > 0)
        || workspace.may_be_incomplete;
      manifest = {
        format: 'lynox-export/1',
        created_at: new Date(now()).toISOString(),
        as_of: asOf,
        stores,
        directories,
        workspace,
        config: opts.config !== null,
        not_included: notIncluded,
        may_be_incomplete: incomplete,
      };
      tar.addBuffer(MANIFEST_NAME, Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'), now() / 1000);
      tar.finish();
    } finally {
      closeSync(fd);
    }
    // Once more at the end: the caller's own heartbeat (`--touch`) starts from a fresh time.
    opts.slot.refresh();
    return { dir, path, size: statSync(path).size, manifest };
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  } finally {
    clearInterval(beat);
  }
}

/** The name prefix of the staged archive directory of export `job`. */
export function archiveDirPrefixFor(job: string): string {
  return `${ARCHIVE_DIR_PREFIX}${job}-`;
}

/** Remove a staged archive's directory (after the hand-over, at the TTL, or on an abort). */
export function removeArchive(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/** Name prefix of the workspace route's request directories (`workspace-export.ts`). */
const WORKSPACE_REQUEST_PREFIX = 'workspace-';

/**
 * Every staged export that exists now: archive directories and the workspace route's request
 * directories. The erasures remove the ones whose holder is gone (`sweepStaleExports`) and refuse
 * while an export holds the slot.
 * Empty when the staging directory is missing or not this process's own.
 */
export function stagedExportDirs(dataDir: string): string[] {
  const staging = join(dataDir, EXPORT_STAGING_DIR);
  let names: string[];
  try {
    if (!checkStagingDir(staging, false)) return [];
    names = readdirSync(staging);
  } catch {
    return [];
  }
  return names.filter(n => n.startsWith(ARCHIVE_DIR_PREFIX) || n.startsWith(WORKSPACE_REQUEST_PREFIX)).map(n => join(staging, n));
}

/**
 * Remove every staged export whose holder is gone: when no export holds the slot (free, or stale:
 * its heartbeat stopped), no staged export can still be on its way out, so each one left is an
 * orphan of a crash or of a hand path that never ran `--finish`. Run by the export command before
 * it starts and by both erasures before they decide, so an orphan neither lingers decrypted nor
 * holds the erasures off. Returns how many it removed.
 */
export function sweepStaleExports(dataDir: string, now: number = Date.now()): number {
  const live = readSlot(dataDir, now);
  if (live !== null && live.kind === 'export') return 0;
  let removed = 0;
  for (const d of stagedExportDirs(dataDir)) {
    removeArchive(d);
    removed++;
  }
  return removed;
}

/**
 * The HTTP API's boot sweep for staged archives: remove every staged export unless the export
 * command holds the slot right now (its archive is live in another process). Returns how many were removed.
 */
export function sweepStagedArchives(dataDir: string): number {
  const live = readSlot(dataDir);
  if (live !== null && live.kind === 'export' && live.holder === 'command') return 0;
  let removed = 0;
  for (const d of stagedExportDirs(dataDir)) {
    if (!d.slice(d.lastIndexOf('/') + 1).startsWith(ARCHIVE_DIR_PREFIX)) continue;
    removeArchive(d);
    removed++;
  }
  return removed;
}
