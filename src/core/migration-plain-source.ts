/**
 * The source's half of the plaintext migration path: a store's encrypted columns decrypted in
 * memory, so the destination can encrypt them under its own key (`migration-rekey.ts` is the
 * destination's half and owns the shared shapes).
 *
 * The source's own image is not untrusted here, but nothing of it may reach a file in plaintext:
 * the image is opened from a Buffer in memory with `temp_store=MEMORY`, and `secure_delete` zeroes
 * what the rewrite frees (a plaintext is shorter than its ciphertext, so an overflow value that
 * shrinks frees pages). The image is not vacuumed afterwards: `VACUUM` would renumber the rowids
 * of a table without an INTEGER PRIMARY KEY, which a migration keeps. The destination drops all
 * free space with its own `VACUUM INTO` copy.
 */
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { strictDecrypt, ENCRYPTED_PREFIX, type StrictDecryptResult } from './strict-decrypt.js';
import {
  LEDGER_COLUMNS,
  MAX_HEADER_BYTES,
  PLAIN_COLUMNS,
  encodePlainPayload,
  patchWalHeader,
  reencryptLedgers,
  type ListedLedgerCell,
  type ListedValue,
  type PlainColumn,
  type PlainHeader,
  type PlainStore,
} from './migration-rekey.js';
import { storePath, maxPlainStoreBytes, type MigrationCeiling } from './migration-ceiling.js';

export interface PlainSourceCounts {
  /** Values that decrypted and travel as plaintext. */
  decrypted: number;
  /** Values that did not decrypt; they travel as they were and are listed. */
  failed: number;
}

export interface PlainSourceResult {
  /** The framed payload: header (the two lists) and the rewritten image. */
  payload: Buffer;
  /** The column list for the chunk's meta, absent columns included. */
  columns: PlainColumn[];
  counts: PlainSourceCounts;
}

export interface PlainSourceOptions {
  /** The store's column key (`deriveEngineEncKey` / `deriveHistoryEncKey` of this instance's vault key). */
  key: Buffer;
  /** The decrypt; a test replaces it. */
  decrypt?: ((stored: string, key: Buffer) => StrictDecryptResult) | undefined;
  /** Rows per transaction (default 1,000). */
  stepRows?: number | undefined;
  /** The largest header the destination parses (default its own bound); a test lowers it. */
  maxHeaderBytes?: number | undefined;
}

const quoted = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/** Why a store has no plaintext form; the export then sends it raw, as today. */
export class NoPlainForm extends Error {}

/** The framed payload, or NoPlainForm when its header would be over the size the destination parses. */
function frame<T>(header: PlainHeader<T>, body: Buffer, maxHeaderBytes: number): Buffer {
  try {
    if (Buffer.byteLength(JSON.stringify(header), 'utf-8') > maxHeaderBytes) throw new NoPlainForm('its list of values that did not decrypt is over the size the destination reads');
    return encodePlainPayload(header, body);
  } finally {
    body.fill(0);
  }
}

/**
 * Rewrite `image` (a `VACUUM INTO` snapshot of `store`, ciphertext) so that every column of the
 * plaintext set holds plaintext, and frame it for a `sqlite_db_plain` chunk.
 *
 * Per value, by strict decrypt: no prefix stays as it is (the destination encrypts it);
 * decrypted is written as its plaintext, and listed as "looks encrypted" when that plaintext
 * itself starts with `enc:`; a value that does not decrypt stays unchanged and is listed as
 * failed; the export goes on. NULL and non-text values are skipped, `''` stays `''`. A table or
 * column of the set the image does not have is named as absent. A value is listed by table,
 * column and primary key (its columns' values in declared order, the rowid for a table without
 * one), as the destination reads it.
 *
 * Steps of `stepRows` rows by rowid, one transaction per step. A throw leaves the in-memory image
 * with the steps before it; the caller discards it and nothing has been sent.
 */
export function rewriteStoreForPlain(image: Buffer, store: PlainStore, options: PlainSourceOptions): PlainSourceResult {
  const decrypt = options.decrypt ?? strictDecrypt;
  const step = options.stepRows ?? 1000;
  const db = new Database(patchWalHeader(image));
  try {
    db.pragma('temp_store = MEMORY');
    db.pragma('secure_delete = ON');
    const counts: PlainSourceCounts = { decrypted: 0, failed: 0 };
    const header: { failed: ListedValue[]; looksEncrypted: ListedValue[] } = { failed: [], looksEncrypted: [] };
    const columns: PlainColumn[] = [];

    for (const [table, cols] of PLAIN_COLUMNS[store]) {
      const info = db.prepare(`PRAGMA table_info(${quoted(table)})`).all() as Array<{ name: string; pk: number }>;
      const has = new Set(info.map((c) => c.name.toLowerCase()));
      const pkCols = info.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
      const pkSelect = pkCols.length > 0 ? pkCols.map(quoted).join(', ') : 'rowid';
      if (info.length > 0) {
        // The two lists name a value by its row's key, and the destination finds it by that key. A
        // PRIMARY KEY without NOT NULL takes NULL in any number of rows (its unique index lets NULLs
        // repeat; apart from them it allows no two rows one key), and a key or rowid beyond 2^53
        // reads back as another number: then a listing could name the wrong row. Such a table sends
        // the store raw.
        const SAFE = Number.MAX_SAFE_INTEGER;
        const unsafe = (c: string): string => `(typeof(${c}) = 'integer' AND (${c} > ${String(SAFE)} OR ${c} < -${String(SAFE)}))`;
        const t = quoted(table);
        const nullKey = pkCols.length > 0 ? pkCols.map((c) => `${quoted(c)} IS NULL`).join(' OR ') : '0';
        const bad = db.prepare(`SELECT 1 FROM ${t} WHERE ${nullKey} OR ${[unsafe('rowid'), ...pkCols.map((c) => unsafe(quoted(c)))].join(' OR ')} LIMIT 1`).get();
        if (bad) throw new NoPlainForm(`${table} has a row key the lists cannot name one row by`);
      }
      for (const column of cols) {
        if (!has.has(column)) {
          columns.push({ table, column, absent: true });
          continue;
        }
        columns.push({ table, column });
        // What the destination's rewrite cannot take: a BLOB in a column of the set (its final check
        // refuses one), and a row at a rowid at or below 0 that holds a value (its paging, like this
        // one, starts above 0, so the value would arrive unlisted and unread). Either sends the store raw.
        const c = quoted(column);
        const odd = db.prepare(`SELECT 1 FROM ${quoted(table)} WHERE typeof(${c}) = 'blob' OR (rowid <= 0 AND typeof(${c}) = 'text' AND ${c} <> '') LIMIT 1`).get();
        if (odd) throw new NoPlainForm(`${table}.${column} holds a value the plaintext path cannot carry`);
        const read = db.prepare(`SELECT rowid AS _r, ${pkSelect}, ${quoted(column)} AS _v FROM ${quoted(table)} WHERE rowid > ? ORDER BY rowid LIMIT ?`).raw();
        const write = db.prepare(`UPDATE ${quoted(table)} SET ${quoted(column)} = ? WHERE rowid = ?`);
        const runStep = db.transaction((after: number): number | null => {
          const rows = read.all(after, step) as unknown[][];
          let last: number | null = null;
          for (const row of rows) {
            last = row[0] as number;
            const value = row[row.length - 1];
            if (typeof value !== 'string' || !value.startsWith(ENCRYPTED_PREFIX)) continue;
            const pk = row.slice(1, row.length - 1) as Array<string | number | null>;
            const r = decrypt(value, options.key);
            if (!r.ok) {
              header.failed.push({ table, pk, column });
              counts.failed++;
              continue;
            }
            if (r.text.startsWith(ENCRYPTED_PREFIX)) header.looksEncrypted.push({ table, pk, column });
            write.run(r.text, last);
            counts.decrypted++;
          }
          return rows.length < step ? null : last;
        });
        let after: number | null = 0;
        while (after !== null) after = runStep(after);
      }
    }

    const plainHeader: PlainHeader<ListedValue> = header;
    return { payload: frame(plainHeader, db.serialize(), options.maxHeaderBytes ?? MAX_HEADER_BYTES), columns, counts };
  } finally {
    db.close();
  }
}

export interface PlainLedgers {
  /** The framed payload: header (the two lists) and `{ files }` with the decrypted ledgers. */
  payload: Buffer;
  /** The bytes of the raw form (`{ files }` as read), which the destination's re-encrypted form must equal. */
  rawBytes: number;
  counts: PlainSourceCounts;
}

/**
 * The merge ledgers in their plaintext form, or null when they cannot take it and engine.db with
 * them has to travel raw. Each ledger's contact cells (`LEDGER_COLUMNS`, both sides) are strictly
 * decrypted under engine.db's key, with the same categories as a store's columns.
 *
 * The destination re-encrypts every cell that is not listed as failed and refuses the import
 * unless the result is exactly as large as the raw form. So before choosing this form the source
 * runs the destination's own rewrite over it with a throwaway key and keeps the form only if that
 * goes through at the raw form's size. A cell the raw form holds in plain (written while no key
 * was set), a ledger not written the way the merge runner writes it, or a name in another case
 * would each make the destination refuse; the check turns them into the raw path instead.
 */
export function rewriteLedgersForPlain(
  files: Record<string, string>,
  key: Buffer,
  decrypt: (stored: string, key: Buffer) => StrictDecryptResult = strictDecrypt,
  maxHeaderBytes: number = MAX_HEADER_BYTES,
): PlainLedgers | null {
  const rawBytes = Buffer.byteLength(JSON.stringify({ files }), 'utf-8');
  const header: { failed: ListedLedgerCell[]; looksEncrypted: ListedLedgerCell[] } = { failed: [], looksEncrypted: [] };
  const counts: PlainSourceCounts = { decrypted: 0, failed: 0 };
  const plain: Record<string, string> = {};
  for (const [file, content] of Object.entries(files)) {
    let ledger: Record<string, unknown>;
    try { ledger = JSON.parse(content) as Record<string, unknown>; } catch { return null; }
    const detail = (ledger?.['entry'] as Record<string, unknown> | undefined)?.['detail'] as Record<string, unknown> | null | undefined;
    const table = detail?.['table'];
    const cols = typeof table === 'string' ? LEDGER_COLUMNS.get(table) : undefined;
    if (detail && cols) {
      for (const side of ['dupRow', 'canonicalRow'] as const) {
        const row = detail[side] as Record<string, unknown> | null | undefined;
        if (!row) continue;
        for (const column of cols) {
          const value = row[column];
          if (typeof value !== 'string' || !value.startsWith(ENCRYPTED_PREFIX)) continue;
          const r = decrypt(value, key);
          if (!r.ok) {
            header.failed.push({ file, side, column });
            counts.failed++;
            continue;
          }
          if (r.text.startsWith(ENCRYPTED_PREFIX)) header.looksEncrypted.push({ file, side, column });
          row[column] = r.text;
          counts.decrypted++;
        }
      }
    }
    plain[file] = JSON.stringify(ledger);
  }
  // The destination's rewrite, with a key that never leaves this call.
  const probeKey = randomBytes(key.length);
  try {
    const parsed: Record<string, unknown> = {};
    for (const [file, content] of Object.entries(plain)) parsed[file] = content;
    const { files: back } = reencryptLedgers(parsed, header, { key: probeKey });
    if (Buffer.byteLength(JSON.stringify({ files: back }), 'utf-8') !== rawBytes) return null;
  } catch {
    return null;
  } finally {
    probeKey.fill(0);
  }
  try {
    return { payload: frame(header, Buffer.from(JSON.stringify({ files: plain }), 'utf-8'), maxHeaderBytes), rawBytes, counts };
  } catch (err: unknown) {
    if (err instanceof NoPlainForm) return null;
    throw err;
  }
}

/** One store's two forms, in bytes. */
export interface StoreForms {
  store: PlainStore;
  /** Its `sqlite_db_plain` payload, or null when it has none (the rewrite failed or was not tried). */
  plainBytes: number | null;
  /** Why it has none, when that was decided before the rewrite (`plainFormRefusal`); else `no-plain-form`. */
  refused?: 'bounds' | 'memory' | 'source-memory' | undefined;
  /** Its raw `VACUUM INTO` snapshot. */
  rawBytes: number;
}

export interface PathInput {
  ceiling: MigrationCeiling;
  stores: readonly StoreForms[];
  /** Every chunk that is neither a database nor the merge ledgers, in bytes. */
  otherBytes: number;
  /** The databases that never take the plaintext path, in bytes. */
  otherDatabaseBytes: number;
  /** The merge ledgers, or null when there are none. */
  sweeps: { rawBytes: number; plainBytes: number | null } | null;
  /** The sweeps chunk's cap at the destination (64 MiB). */
  sweepsCapBytes: number;
}

export type PathReason = 'no-plain-form' | 'memory' | 'ledgers' | 'bounds' | 'source-memory';

/**
 * Which stores take the plaintext path, judged the way the destination judges the manifest at
 * `setManifest`: over the forms that travel, the merge ledgers at the larger of their two forms
 * in the bundle and at their raw form in the rest, each plaintext store on its own predicate.
 * engine.db takes it only together with the ledgers, and only when their plaintext form exists
 * and fits the sweeps cap.
 *
 * Every store starts on the plaintext path; a store whose predicate fails over the current
 * choice moves to the raw path, and the check repeats until nothing moves (a move only goes from
 * plaintext to raw, so it ends). The result is a choice the destination accepts.
 */
export function choosePlainPaths(input: PathInput): Map<PlainStore, { path: 'plain' | 'raw'; reason?: PathReason }> {
  const out = new Map<PlainStore, { path: 'plain' | 'raw'; reason?: PathReason }>();
  for (const s of input.stores) out.set(s.store, s.plainBytes === null ? { path: 'raw', reason: s.refused ?? 'no-plain-form' } : { path: 'plain' });
  const engine = out.get('engine.db');
  if (engine?.path === 'plain' && input.sweeps) {
    const plainLedgers = input.sweeps.plainBytes;
    if (plainLedgers === null || Math.max(plainLedgers, input.sweeps.rawBytes) > input.sweepsCapBytes) out.set('engine.db', { path: 'raw', reason: 'ledgers' });
  }
  // run-group-starter: a loop that ends within this call; it starts nothing that outlives it.
  for (;;) {
    const enginePlain = out.get('engine.db')?.path === 'plain';
    const sweepsTravel = input.sweeps ? (enginePlain && input.sweeps.plainBytes !== null ? input.sweeps.plainBytes : input.sweeps.rawBytes) : 0;
    const sweepsRaw = input.sweeps?.rawBytes ?? 0;
    const storeTravel = input.stores.reduce((n, s) => n + (out.get(s.store)?.path === 'plain' ? s.plainBytes! : s.rawBytes), 0);
    const bundleBytes = input.otherBytes + input.otherDatabaseBytes + storeTravel + Math.max(sweepsTravel, sweepsRaw);
    const restBytes = input.otherBytes + sweepsRaw;
    const failing = input.stores.find((s) => out.get(s.store)?.path === 'plain'
      && storePath(input.ceiling, { bundleBytes, restBytes, storeBytes: s.plainBytes! }) !== 'plain');
    if (!failing) return out;
    out.set(failing.store, { path: 'raw', reason: 'memory' });
  }
}

/**
 * Why a store cannot take the plaintext path, judged from its raw snapshot BEFORE its plaintext
 * form is built, or null when it may. Building that form holds several copies of the store in
 * memory, so a store that could never travel in it is not rewritten at all.
 *
 * The judgment uses the raw size as a lower bound of the plaintext form's: the rewrite updates the
 * snapshot's rows in place, serializes the same pages and puts a header in front, so the form is
 * not smaller. The other databases are counted at their raw size for the same reason. That makes
 * the first two checks necessary conditions of the later choice, never stricter than it:
 * - `bounds`: the bundle would be over the source's own size bound with the store at that size;
 * - `memory`: the store is over the largest one the destination's numbers allow next to the rest
 *   (`maxPlainStoreBytes`), which also covers numbers it cannot judge.
 * The third is new and may be stricter than the choice, on purpose: the choice judges the
 * destination's memory, this one the source's own.
 * - `source-memory`: building the form would take this instance over its own memory limit: its
 *   resident memory before the first rewrite plus `kSourceBaseMb` and `kSource` times this store
 *   and the stores already let through (a line above the source's measured peak over it).
 * The destination's numbers are untrusted. A destination that announces a vast limit still meets
 * `bounds` and `source-memory`, which are the source's own; `bounds` caps the bundle's size,
 * `source-memory` what the rewrite may hold.
 */
export function plainFormRefusal(input: {
  ceiling: MigrationCeiling;
  /** The store's raw snapshot, in bytes. */
  rawBytes: number;
  /** Everything else in the bundle at its smallest: other chunks, the ledgers raw, the other databases raw. */
  othersBytes: number;
  /** The rest as `choosePlainPaths` counts it: the non-database chunks and the ledgers raw. */
  restBytes: number;
  /** The source's bound on a bundle's total size. */
  maxTotalBytes: number;
  /**
   * This instance's memory: its limit and its resident memory before the first rewrite, in MiB;
   * the source's fixed part (MiB) and k; and the raw bytes of the stores already let through.
   */
  source: { limitMb: number; rssMb: number; baseMb: number; k: number; formedBytes: number };
}): 'bounds' | 'memory' | 'source-memory' | null {
  if (input.rawBytes > input.maxTotalBytes - input.othersBytes) return 'bounds';
  if (input.rawBytes > maxPlainStoreBytes(input.ceiling, input.othersBytes, input.restBytes)) return 'memory';
  const { limitMb, rssMb, baseMb, k, formedBytes } = input.source;
  // Anything it cannot judge refuses, as `storePath` does.
  if (![limitMb, rssMb, baseMb, k, formedBytes].every((n) => Number.isFinite(n) && n >= 0) || k < 1) return 'source-memory';
  if (rssMb + baseMb + (k * (formedBytes + input.rawBytes)) / (1024 * 1024) > limitMb) return 'source-memory';
  return null;
}

/** Bytes of the destination's `/api/health` body the source reads at most; a real one is about 1 kB. */
export const MAX_HEALTH_BYTES = 64 * 1024;
/** How long the source waits for the destination's `/api/health`. */
export const HEALTH_TIMEOUT_MS = 10_000;

/**
 * The destination's offer: the numbers to decide with, or null for the raw path. The destination
 * is untrusted input here: the plaintext path is taken only when its handshake says `true` for
 * `acceptsPlainStores` (nothing else counts) AND its health body carries all four numbers, each
 * finite and above 0. Anything else, a missing or malformed field included, is the raw path, as
 * today; an older destination answers neither.
 */
export function plainOffer(handshake: unknown, health: unknown): MigrationCeiling | null {
  if ((handshake as Record<string, unknown> | null)?.['acceptsPlainStores'] !== true) return null;
  const m = (health as Record<string, unknown> | null)?.['migration'] as Record<string, unknown> | null | undefined;
  const nums = ['import_limit_mb', 'baseline_mb', 'k', 'rest_factor'].map((k) => m?.[k]);
  if (!nums.every((n): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0)) return null;
  const [importLimitMb, baselineMb, k, restFactor] = nums as [number, number, number, number];
  return { import_limit_mb: importLimitMb, baseline_mb: baselineMb, k, rest_factor: restFactor };
}

/**
 * The destination's `/api/health` body, parsed, or null: through `fetchFn` (the pinned fetch the
 * migration uses for the target) with a timeout, read up to `MAX_HEALTH_BYTES`. A failure of any
 * kind (no answer in time, not 200, too large, not JSON) is null, so the export takes the raw path.
 */
export async function readDestinationHealth(
  fetchFn: (url: string, init: RequestInit) => Promise<Response>,
  targetUrl: string,
  timeoutMs: number = HEALTH_TIMEOUT_MS,
): Promise<unknown> {
  try {
    const res = await fetchFn(`${targetUrl}/api/health`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok || !res.body) return null;
    const reader = res.body.getReader();
    const parts: Uint8Array[] = [];
    let size = 0;
    // run-group-starter: reads one bounded body within this call; it starts nothing that outlives it.
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_HEALTH_BYTES) { await reader.cancel(); return null; }
      parts.push(value);
    }
    return JSON.parse(Buffer.concat(parts).toString('utf-8')) as unknown;
  } catch {
    return null;
  }
}
