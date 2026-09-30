/**
 * The dry-run half of a bulk run (PRD bulk-changes-reversible §3.2): turn a source of
 * (target, after) pairs into planned targets with their before-images. Reads only —
 * no function here writes to a target system, and the tests assert the target system
 * is byte-identical afterwards.
 *
 * The source is DATA the model, a script or a workflow step wrote (a workspace file,
 * or a data-store query), never a tool argument with N entries — the loop is not in
 * the model (PRD §1.6).
 */
import { closeSync, constants as fsConstants, existsSync, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { DataStore } from './data-store.js';
import { coercePlainColumnValue } from './data-store.js';
import { getFileAreaDir, isPathWithin, resolveFileAreaPath } from './workspace.js';
import type { BeforeImage, PlannedTarget } from './bulk-ledger.js';

/** Most targets one plan may carry. */
export const BULK_MAX_TARGETS = 5000;
/** Largest single target image: a planned after-state as serialized JSON, a file's
 *  before-image as its size on disk. */
export const BULK_MAX_TARGET_BYTES = 1024 * 1024;
/**
 * Largest total one plan may record — before-images, after-states and target keys, each
 * counted as the JSON the ledger serializes (escapes included). What lands in engine.db is
 * that total encrypted and base64-encoded (about 4/3 of it) plus a fixed framing per row.
 */
export const BULK_MAX_TOTAL_BYTES = 32 * 1024 * 1024;
/** Largest source file. */
export const BULK_MAX_SOURCE_BYTES = 5 * 1024 * 1024;
/** Page size for data-store reads — `queryRecords` caps its `limit` at this. */
export const BULK_QUERY_PAGE = 500;

/** A source that cannot be planned at all. The message is engine-authored and never
 *  quotes the source, so it is safe to return to the model. */
export class BulkSourceError extends Error {}

export interface SourceRow { target: string; after: unknown }

const META_FIELDS = new Set(['_id', '_created_at', '_updated_at']);

const tooManyTargets = (): BulkSourceError =>
  new BulkSourceError(`The source has more than ${String(BULK_MAX_TARGETS)} targets.`);

/**
 * RFC 4180 CSV: comma-separated, `"` quoting with `""` as an escaped quote, CRLF or LF
 * line ends, quoted fields may span lines. The first row is the header. Stops as soon as
 * the row count passes {@link BULK_MAX_TARGETS}: a 5 MB source of empty lines would
 * otherwise build millions of rows before any cap applied.
 */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const endRow = (): void => {
    row.push(field);
    if (!(row.length === 1 && row[0] === '')) {
      rows.push(row);
      if (rows.length > BULK_MAX_TARGETS + 1) throw tooManyTargets();
    }
    row = [];
    field = '';
  };
  while (i < text.length) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"' && field === '') { quoted = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r' && text[i + 1] === '\n') { i++; continue; }
    if (c === '\n') { endRow(); i++; continue; }
    field += c; i++;
  }
  if (quoted) throw new BulkSourceError('The CSV source ends inside a quoted field.');
  if (field !== '' || row.length > 0) endRow();
  const [header, ...body] = rows;
  if (!header) return [];
  if (new Set(header).size !== header.length) throw new BulkSourceError('The CSV header names a column twice.');
  return body.map((r) => {
    if (r.length !== header.length) throw new BulkSourceError('A CSV row has a different number of fields than the header.');
    return Object.fromEntries(header.map((h, j) => [h, r[j]!]));
  });
}

/** Parse a source file's text. JSON: an array of objects. CSV: header row plus rows. */
export function parseSourceText(text: string, format: 'json' | 'csv'): Record<string, unknown>[] {
  if (Buffer.byteLength(text, 'utf8') > BULK_MAX_SOURCE_BYTES) {
    throw new BulkSourceError(`The source is larger than ${String(BULK_MAX_SOURCE_BYTES / 1024 / 1024)} MB.`);
  }
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (format === 'csv') return parseCsv(body);
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { throw new BulkSourceError('The JSON source does not parse.'); }
  if (!Array.isArray(parsed)) throw new BulkSourceError('The JSON source must be an array of objects.');
  if (parsed.length > BULK_MAX_TARGETS) throw tooManyTargets();
  if (!parsed.every((r) => r !== null && typeof r === 'object' && !Array.isArray(r))) {
    throw new BulkSourceError('The JSON source must be an array of objects.');
  }
  return parsed as Record<string, unknown>[];
}

/**
 * Rows → (target, after) pairs. `target` names the target (a string, or a number or
 * boolean taken as its text — a number-typed staging column yields numbers). The
 * after-state is the row's `after` field when it has one; otherwise every other field
 * except the store's own `_id`/`_created_at`/`_updated_at` (so a CSV or a staging
 * collection can carry the new column values directly).
 */
export function rowsToSource(rows: readonly Record<string, unknown>[]): SourceRow[] {
  if (rows.length === 0) throw new BulkSourceError('The source has no rows.');
  if (rows.length > BULK_MAX_TARGETS) throw tooManyTargets();
  return rows.map((row) => {
    const raw = row['target'];
    const target = typeof raw === 'number' || typeof raw === 'boolean' ? String(raw) : raw;
    if (typeof target !== 'string' || target.trim() === '') {
      throw new BulkSourceError('Every source row needs a non-empty field "target".');
    }
    if ('after' in row) return { target, after: row['after'] };
    const after: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) if (k !== 'target' && !META_FIELDS.has(k)) after[k] = v;
    return { target, after };
  });
}

function rejectDuplicates(keys: readonly string[]): void {
  const seen = new Set<string>();
  for (const k of keys) {
    if (seen.has(k)) throw new BulkSourceError('The source names the same target more than once.');
    seen.add(k);
  }
}

/** Serialized size of an image — the quantity both caps are about. Measured once. */
function imageBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? 'null', 'utf8');
}

/** Keys are stored too — an invalid target keeps the source's own text as its key —
 *  so they count against the same budget as the images. */
function chargeKeys(budget: ByteBudget, targets: PlannedTarget[]): PlannedTarget[] {
  for (const t of targets) budget.charge(imageBytes(t.key));
  return targets;
}

class ByteBudget {
  private used = 0;
  charge(bytes: number): void {
    this.used += bytes;
    if (this.used > BULK_MAX_TOTAL_BYTES) {
      throw new BulkSourceError(`The plan's images exceed ${String(BULK_MAX_TOTAL_BYTES / 1024 / 1024)} MB in total.`);
    }
  }
}

/**
 * A bulk run's workspace file — target or source — as an absolute path in the file
 * area, or `null` when it leaves the area. Built on
 * `resolveFileAreaPath`, the one confinement resolver the download route and
 * `media_process` share, and stricter in one case that resolver leaves to the caller: a
 * path that does not exist yet is checked through the real path of its closest existing
 * ancestor, so a symlinked directory cannot carry a planned target out of the area. An
 * existing file is keyed by its real path, so two spellings of one file are one target.
 */
export function resolveBulkFilePath(target: string): string | null {
  const logical = resolveFileAreaPath(target);
  if (logical === null) return null;
  const base = getFileAreaDir();
  const realBase = existsSync(base) ? realpathSync(base) : base;
  if (existsSync(logical)) {
    const real = realpathSync(logical);
    return isPathWithin(real, realBase) ? real : null;
  }
  let ancestor = dirname(logical);
  let tail = basename(logical);
  while (!existsSync(ancestor) && ancestor !== dirname(ancestor)) {
    tail = join(basename(ancestor), tail);
    ancestor = dirname(ancestor);
  }
  if (!existsSync(ancestor)) return null;
  const real = join(realpathSync(ancestor), tail);
  return isPathWithin(real, realBase) ? real : null;
}

/**
 * A file's current content — its before-image — or absent. Opens once and stats the
 * same descriptor (nothing can be swapped between check and read), refuses a symlink
 * planted at the leaf after the path was resolved, and opens non-blocking so a FIFO
 * cannot park the engine's event loop inside `open`. `too_large` above `maxBytes`;
 * `not_text` when the bytes are not UTF-8 — decoding would replace them, and a
 * before-image that is not the file's real content restores something else. Throws for
 * anything that is not a regular file.
 */
export function readBulkImage(
  absPath: string, maxBytes: number,
): { absent: true } | { absent: false; value: string } | 'too_large' | 'not_text' {
  let fd: number;
  try {
    fd = openSync(absPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { absent: true };
    throw err;
  }
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) throw new Error('not a regular file');
    if (stats.size > maxBytes) return 'too_large';
    const buf = Buffer.alloc(stats.size);
    if (stats.size > 0) readSync(fd, buf, 0, stats.size, 0);
    const value = buf.toString('utf-8');
    if (!Buffer.from(value, 'utf-8').equals(buf)) return 'not_text';
    return { absent: false, value };
  } finally {
    closeSync(fd);
  }
}

/** How workspace targets are located and read. Injected so a test can drive the
 *  planning logic against a fake file system. */
export interface WorkspaceAccess {
  /** Absolute, confined path for a target; null when it leaves the workspace. */
  resolve(target: string): string | null;
  /** Current content, or absent. `too_large` over {@link BULK_MAX_TARGET_BYTES}. */
  read(absPath: string): BeforeImage | 'too_large' | 'not_text';
}

/** Plan workspace targets: each target is a file, its after-state the full new text. */
export function planWorkspace(source: readonly SourceRow[], access: WorkspaceAccess): PlannedTarget[] {
  const budget = new ByteBudget();
  const resolved = source.map((row) => {
    try {
      return { row, path: access.resolve(row.target) };
    } catch {
      return { row, path: null };
    }
  });
  // Every key has to be known before any file is read: a doubled target refuses the
  // whole plan rather than recording half of it. Invalid targets are keyed by what the
  // source said, so they count too.
  rejectDuplicates(resolved.map((r) => r.path ?? r.row.target));
  return chargeKeys(budget, resolved.map(({ row, path }): PlannedTarget => {
    if (path === null) return { key: row.target, invalid: 'path_outside_workspace' };
    if (typeof row.after !== 'string') return { key: path, invalid: 'after_not_text' };
    const afterBytes = imageBytes(row.after);
    if (afterBytes > BULK_MAX_TARGET_BYTES) return { key: path, invalid: 'target_too_large' };
    let before: BeforeImage | 'too_large' | 'not_text';
    try {
      before = access.read(path);
    } catch {
      return { key: path, invalid: 'unreadable' };
    }
    if (before === 'too_large') return { key: path, invalid: 'target_too_large' };
    if (before === 'not_text') return { key: path, invalid: 'not_text' };
    budget.charge(afterBytes);
    if (!before.absent) budget.charge(imageBytes(before.value));
    return { key: path, before, after: row.after };
  }));
}

/**
 * Plan data-store targets in one collection. The collection needs a single-column
 * unique key; `target` is that key's value. The after-state is the FULL row the rule
 * produces (the existing row with the named fields replaced), because an upsert
 * writes every column — a partial after-state would plan a different row than the
 * one an apply writes.
 */
export function planDataStore(source: readonly SourceRow[], store: DataStore, collection: string): PlannedTarget[] {
  const info = store.getCollectionInfo(collection);
  if (!info) throw new BulkSourceError('The target collection does not exist.');
  if (!info.uniqueKey || info.uniqueKey.length !== 1) {
    throw new BulkSourceError('The target collection needs a single-column unique key to address its rows.');
  }
  const keyCol = info.uniqueKey[0]!;
  const colDefs = new Map(info.columns.map((c) => [c.name, c]));
  const keyDef = colDefs.get(keyCol)!;
  if (keyDef.type === 'subject') {
    throw new BulkSourceError('The target collection is keyed on a subject column, which a dry run cannot resolve without writing.');
  }

  // The key as the column stores it, so "12" and "12.0" on a number key are one
  // target, not two plans for the same row.
  const keyed = source.map((row) => {
    try {
      const stored = coercePlainColumnValue(row.target, keyDef);
      return { row, stored, key: String(stored) };
    } catch {
      return { row, stored: null, key: null };
    }
  });
  rejectDuplicates(keyed.map((k) => k.key ?? k.row.target));

  // Before-images in batches of the query's own maximum page size.
  const beforeByKey = new Map<string, Record<string, unknown>>();
  const lookups = keyed.filter((k) => k.key !== null);
  for (let i = 0; i < lookups.length; i += BULK_QUERY_PAGE) {
    const batch = lookups.slice(i, i + BULK_QUERY_PAGE).map((k) => k.stored);
    const { rows } = store.queryRecords({ collection, filter: { [keyCol]: { $in: batch } }, limit: BULK_QUERY_PAGE });
    for (const r of rows) {
      const clean: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(r)) if (!META_FIELDS.has(k)) clean[k] = v;
      beforeByKey.set(String(r[keyCol]), clean);
    }
  }

  const budget = new ByteBudget();
  return chargeKeys(budget, keyed.map(({ row, stored, key }): PlannedTarget => {
    if (key === null) return { key: row.target, invalid: 'bad_key' };
    const after = row.after;
    if (after === null || typeof after !== 'object' || Array.isArray(after)) {
      return { key, invalid: 'bad_value' };
    }
    const planned: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(after as Record<string, unknown>)) {
      const col = colDefs.get(field);
      if (!col) return { key, invalid: 'unknown_column' };
      if (col.type === 'subject') return { key, invalid: 'subject_column' };
      // An empty CSV cell means "no value" for a typed column; only text keeps ''.
      const absent = value === null || value === undefined || (value === '' && col.type !== 'string');
      if (absent) {
        // Nulling the key would plan a row that no longer answers to its key.
        if (field === keyCol) return { key, invalid: 'bad_key' };
        planned[field] = null;
        continue;
      }
      try {
        planned[field] = coercePlainColumnValue(value, col);
      } catch {
        return { key, invalid: 'bad_value' };
      }
      if (field === keyCol && String(planned[field]) !== key) return { key, invalid: 'bad_key' };
    }
    const existing = beforeByKey.get(key);
    const before: BeforeImage = existing ? { absent: false, value: existing } : { absent: true };
    const full: Record<string, unknown> = existing
      ? { ...existing, ...planned }
      : { ...Object.fromEntries(info.columns.map((c) => [c.name, null])), ...planned, [keyCol]: stored };
    const fullBytes = imageBytes(full);
    if (fullBytes > BULK_MAX_TARGET_BYTES) return { key, invalid: 'target_too_large' };
    budget.charge(fullBytes);
    if (existing) budget.charge(imageBytes(existing));
    return { key, before, after: full };
  }));
}
