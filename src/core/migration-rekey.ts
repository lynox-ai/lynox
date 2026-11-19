/**
 * A migration's stores arrive readable on the destination: the destination's half.
 *
 * Every real migration lands under another vault key, so engine.db and history.db copied raw
 * arrive with their encrypted columns unreadable. On the plaintext path the source decrypts the
 * columns of the set below in memory and sends the image as a `sqlite_db_plain` chunk, inside
 * the transfer encryption; the destination re-encrypts the same columns under its own key, in
 * memory, before anything is written. The destination never receives the source key.
 *
 * THE SET IS DERIVED, NOT LISTED. It is every column the export map (`export-tables.ts`) marks
 * encrypted in engine.db and history.db, minus the approval queue's and the bulk ledger's tables.
 * Those travel raw, as today: re-encrypting them would make an approval executable and a bulk
 * run undoable on the destination, which is a question of their semantics at a migration, not of
 * readability.
 *
 * WHAT TRAVELS WITH A STORE.
 * - On the chunk's meta (bound into every chunk's additional data through the manifest hash):
 *   the columns the source rewrote, and those its image does not have (`absent`, an older schema).
 * - In the payload, authenticated with the image: a 4-byte big-endian length, a JSON header with
 *   two lists, then the image. `failed` names the values that did not decrypt on the source (they
 *   travel as they were and stay so); `looksEncrypted` names plaintexts that start with `enc:`
 *   (a user can write any text), which are encrypted like any other value. A value starting with
 *   `enc:` that neither list names can only come from a source defect, and re-encrypting it would
 *   wrap ciphertext twice, so the import refuses it.
 *
 * The merge ledgers under `sweeps/` copy the contact cells of a merged pair, encrypted, into JSON
 * files; a rollback compares them with the live cells. They therefore take the same path as
 * engine.db, framed the same way, and are re-encrypted here too (`reencryptLedgers`).
 */
import { createCipheriv, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { CRYPTO_ALGORITHM, CRYPTO_IV_LENGTH, CRYPTO_TAG_LENGTH } from './crypto-constants.js';
import { ENCRYPTED_PREFIX, strictDecrypt, type StrictDecryptResult } from './strict-decrypt.js';
import { EXPORT_TABLES } from './export-tables.js';
import { dropDeletedChatGuardDdl } from './deleted-chat-guard.js';

/** The stores that may travel on the plaintext path. */
export const PLAIN_STORES = ['engine.db', 'history.db'] as const;
export type PlainStore = (typeof PLAIN_STORES)[number];

/** Tables whose encrypted columns stay under the source key: their semantics at a migration are not settled. */
const RAW_ONLY_TABLES: ReadonlySet<string> = new Set(['approval_entries', 'bulk_runs', 'bulk_targets']);

function encryptedColumns(store: PlainStore, keep: (table: string) => boolean): ReadonlyMap<string, ReadonlySet<string>> {
  const out = new Map<string, ReadonlySet<string>>();
  for (const [table, decision] of Object.entries(EXPORT_TABLES[store].include)) {
    if (decision.encrypted && decision.encrypted.length > 0 && keep(table)) out.set(table, new Set(decision.encrypted));
  }
  return out;
}

/** Every column this build stores encrypted, per store. */
export const ENCRYPTED_COLUMNS: Readonly<Record<PlainStore, ReadonlyMap<string, ReadonlySet<string>>>> = {
  'engine.db': encryptedColumns('engine.db', () => true),
  'history.db': encryptedColumns('history.db', () => true),
};

/** The columns the plaintext path rewrites, per store. */
export const PLAIN_COLUMNS: Readonly<Record<PlainStore, ReadonlyMap<string, ReadonlySet<string>>>> = {
  'engine.db': encryptedColumns('engine.db', (t) => !RAW_ONLY_TABLES.has(t)),
  'history.db': encryptedColumns('history.db', (t) => !RAW_ONLY_TABLES.has(t)),
};

/** A contact cell a merge ledger copies, per detail table; the same set as engine.db's. */
export const LEDGER_COLUMNS: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  ['people', 'organizations'].map((t) => [t, PLAIN_COLUMNS['engine.db'].get(t) ?? new Set<string>()]),
);

export function isPlainStore(name: string): name is PlainStore {
  return (PLAIN_STORES as readonly string[]).includes(name);
}

/** A column a `sqlite_db_plain` chunk names on its meta. */
export interface PlainColumn {
  readonly table: string;
  readonly column: string;
  /** The source image has no such table or column (an older schema); nothing was rewritten. */
  readonly absent?: true | undefined;
}

/** A value one of the payload header's lists names: its table, primary key and column. */
export interface ListedValue {
  readonly table: string;
  /** The primary key's values in declared order (the rowid for a table without one). */
  readonly pk: ReadonlyArray<string | number | null>;
  readonly column: string;
}

/** A merge ledger's cell one of the sweeps header's lists names. */
export interface ListedLedgerCell {
  readonly file: string;
  readonly side: 'dupRow' | 'canonicalRow';
  readonly column: string;
}

export interface PlainHeader<T> {
  /** Values that did not decrypt on the source; they travel and stay as they were. */
  readonly failed: readonly T[];
  /** Plaintexts that start with `enc:`; they are encrypted like any other value. */
  readonly looksEncrypted: readonly T[];
}

/** Why the import refuses a plaintext store; the message names what the operator needs. */
export class PlainRefusal extends Error {}


/**
 * Check a `sqlite_db_plain` chunk's column list against this build (at `setManifest`, before any
 * chunk is transferred). Every column must be one this build stores encrypted AND one the
 * plaintext path rewrites: a column this build does not know would stay plaintext at rest here.
 */
export function checkPlainColumns(store: PlainStore, columns: unknown): PlainColumn[] {
  if (!Array.isArray(columns)) throw new PlainRefusal(`The manifest carries ${store} as plaintext without its column list.`);
  const seen = new Set<string>();
  const out: PlainColumn[] = [];
  for (const c of columns as unknown[]) {
    const entry = c as Record<string, unknown> | null;
    const table = entry?.['table'];
    const column = entry?.['column'];
    const absent = entry?.['absent'];
    if (typeof table !== 'string' || typeof column !== 'string' || (absent !== undefined && absent !== true)) {
      throw new PlainRefusal(`The manifest's column list for ${store} is malformed.`);
    }
    const key = `${table}.${column}`;
    if (seen.has(key)) throw new PlainRefusal(`The manifest's column list for ${store} names ${JSON.stringify(key.slice(0, 128))} twice.`);
    seen.add(key);
    if (!PLAIN_COLUMNS[store].get(table)?.has(column)) {
      // Read on the source, which relays it: "the target" is this instance.
      throw new PlainRefusal(`The target instance runs an older version than the source and cannot encrypt ${JSON.stringify(key.slice(0, 128))} in ${store}. None of the data was transferred, and the target instance is unchanged. Update the target instance first, then migrate again.`);
    }
    out.push(absent === true ? { table, column, absent: true } : { table, column });
  }
  return out;
}

/** Bytes of a header the import parses at most; a real one lists the values that did not decrypt. */
export const MAX_HEADER_BYTES = 16 * 1024 * 1024;

/** The framed payload: a 4-byte big-endian header length, the JSON header, the body. */
export function encodePlainPayload<T>(header: PlainHeader<T>, body: Buffer): Buffer {
  const json = Buffer.from(JSON.stringify(header), 'utf-8');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(json.length, 0);
  return Buffer.concat([len, json, body]);
}

/** Split a framed payload. The header's entries are checked by `isEntry`; anything else refuses. */
export function decodePlainPayload<T>(payload: Buffer, what: string, isEntry: (v: unknown) => v is T): { header: PlainHeader<T>; body: Buffer } {
  const malformed = (): PlainRefusal => new PlainRefusal(`Refusing to restore: the plaintext ${what} in the bundle is malformed — import aborted before anything was replaced.`);
  if (payload.length < 4) throw malformed();
  const len = payload.readUInt32BE(0);
  if (len > MAX_HEADER_BYTES || 4 + len > payload.length) throw malformed();
  let header: unknown;
  try { header = JSON.parse(payload.subarray(4, 4 + len).toString('utf-8')); } catch { throw malformed(); }
  const h = header as Record<string, unknown> | null;
  const failed = h?.['failed'];
  const looksEncrypted = h?.['looksEncrypted'];
  if (!Array.isArray(failed) || !Array.isArray(looksEncrypted) || !failed.every(isEntry) || !looksEncrypted.every(isEntry)) throw malformed();
  return { header: { failed, looksEncrypted }, body: payload.subarray(4 + len) };
}

export function isListedValue(v: unknown): v is ListedValue {
  const e = v as Record<string, unknown> | null;
  return typeof e?.['table'] === 'string' && typeof e['column'] === 'string' && Array.isArray(e['pk'])
    && (e['pk'] as unknown[]).every((p) => p === null || typeof p === 'string' || typeof p === 'number');
}

export function isListedLedgerCell(v: unknown): v is ListedLedgerCell {
  const e = v as Record<string, unknown> | null;
  return typeof e?.['file'] === 'string' && typeof e['column'] === 'string' && (e['side'] === 'dupRow' || e['side'] === 'canonicalRow');
}

/**
 * A SQLite image with its header's file-format bytes (18, 19) set from WAL (`2`) to rollback
 * journal (`1`). A `VACUUM INTO` image holds no WAL frames, and only a rollback-journal image
 * opens from a Buffer. Returns a copy; anything else is left as it is.
 */
export function patchWalHeader(image: Buffer): Buffer {
  const out = Buffer.from(image);
  if (out.length >= 20) {
    if (out[18] === 2) out[18] = 1;
    if (out[19] === 2) out[19] = 1;
  }
  return out;
}

/** Encrypt a text as the stores do (`EngineDb.enc`, `RunHistory`): `enc:` + base64(iv ‖ tag ‖ data). */
export function encryptStoredText(text: string, key: Buffer): string {
  const iv = randomBytes(CRYPTO_IV_LENGTH);
  const cipher = createCipheriv(CRYPTO_ALGORITHM, key, iv, { authTagLength: CRYPTO_TAG_LENGTH });
  const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return ENCRYPTED_PREFIX + Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
}

/** The stored length of a text encrypted by {@link encryptStoredText}; it depends on the plaintext's length only. */
export function encryptedLength(text: string): number {
  const raw = CRYPTO_IV_LENGTH + CRYPTO_TAG_LENGTH + Buffer.byteLength(text, 'utf8');
  return ENCRYPTED_PREFIX.length + 4 * Math.ceil(raw / 3);
}

export interface RekeyCounts {
  /** Values encrypted under this instance's key. */
  reencrypted: number;
  /** Values that did not decrypt on the source; they arrived and stay as they were. */
  failedOnSource: number;
  /** Encrypted values in columns of this instance's set that the source did not rewrite: unreadable here. */
  carriedUnreadable: number;
}

export interface RekeyOptions {
  /** The key to encrypt under (`deriveEngineEncKey` / `deriveHistoryEncKey` of this instance's vault key). */
  key: Buffer;
  /** The round-trip check's decrypt; a test replaces it. */
  decrypt?: ((stored: string, key: Buffer) => StrictDecryptResult) | undefined;
  /** Rows per transaction (default 1,000). */
  stepRows?: number | undefined;
  /**
   * Where `reencryptImage` writes the rewritten image for a moment to compact it (default: the
   * system temp directory). It holds only ciphertext and is removed before the call returns.
   */
  scratchDir?: string | undefined;
  /** Called with the in-memory connection once it is set up as untrusted, before anything reads the image; a test uses it. */
  onOpen?: ((db: Database.Database) => void) | undefined;
}

/** The names SQLite resolves to the rowid unless a column takes them. */
const ROWID_NAMES: ReadonlySet<string> = new Set(['rowid', 'oid', '_rowid_']);

const quoted = (name: string): string => `"${name.replace(/"/g, '""')}"`;
const listKey = (table: string, column: string, pk: ReadonlyArray<unknown>): string => JSON.stringify([table, column, pk]);

/** A table's columns with hidden and generated ones (`table_xinfo`; `hidden` is 0 for an ordinary column). */
function tableColumns(db: Database.Database, table: string): Array<{ name: string; pk: number; hidden: number }> {
  return db.prepare(`PRAGMA table_xinfo(${quoted(table)})`).all() as Array<{ name: string; pk: number; hidden: number }>;
}

/**
 * A table's column names in lower case: SQLite matches identifiers without regard to case. The
 * set's own names are lower case (a test holds it), so they compare with these as they are.
 */
const columnNames = (db: Database.Database, table: string): Set<string> => new Set(tableColumns(db, table).map((c) => c.name.toLowerCase()));

/**
 * What the image may not carry anywhere, checked before anything evaluates its schema: a virtual
 * table (its writes and reads run its module's code on data the source chose) and a generated or
 * hidden column (a read computes it, `quick_check` included: measured 2026-11-16). A store of this
 * build has neither. What `quick_check` and the `VACUUM INTO` copy do not evaluate was measured
 * the same day and is held by a test: an expression or partial index, a STORED generated column,
 * a DEFAULT, and with `ignore_check_constraints` a CHECK, on a table outside the set.
 */
function refuseUntrustedTables(db: Database.Database, refuse: (what: string) => PlainRefusal): void {
  let kinds: Array<{ name: string; type: string }>;
  try {
    kinds = db.prepare('PRAGMA table_list').all() as Array<{ name: string; type: string }>;
  } catch {
    throw refuse('has a table the target instance cannot read');
  }
  const odd = kinds.find((k) => k.type === 'virtual' || k.type === 'shadow');
  if (odd) throw refuse(`carries a virtual table (${odd.name.slice(0, 64)})`);
  for (const k of kinds) {
    // Every table, SQLite's own included: a source can give a table their prefix through the schema text.
    if (k.type !== 'table') continue;
    if (tableColumns(db, k.name).some((c) => c.hidden !== 0)) throw refuse(`has a generated or hidden column in ${k.name.slice(0, 64)}`);
  }
}

/**
 * Re-encrypt a received image's columns of the set, in place, on an open in-memory connection.
 * Steps of `stepRows` rows by rowid, one transaction per step: a throw rolls back its step and
 * leaves the earlier ones, and the caller discards the image. Every value is decrypted again and
 * compared with its plaintext before it is written. NULL is skipped and `''` stays `''`.
 *
 * A column `columns` names: every text not listed as failed is encrypted, and a value starting
 * with `enc:` must be listed in one of the two lists. A column of the set it does not name (an
 * older source that encrypted the column but did not decrypt it): a value starting with `enc:` is
 * left as sent and counted as carried unreadable, any other text is encrypted. Columns of tables
 * that travel raw are counted, never touched.
 *
 * What the source's lists say is checked, not trusted: a value listed as failed must start with
 * `enc:` (only the prefix: a plaintext written with that prefix while no key was set fails a
 * decrypt too, and an honest source lists it), a column marked absent must be missing from the image, no table of the set
 * may carry a trigger (it could write a plaintext back) or a column that shadows the rowid. Once
 * every column is done, no column of the set may hold a text that is not `''` or starts with
 * `enc:`, nor a BLOB: that also covers a row the paging cannot reach (a rowid at or below 0).
 * Each turns into a refusal.
 */
export function reencryptColumns(
  db: Database.Database,
  store: PlainStore,
  columns: readonly PlainColumn[],
  header: PlainHeader<ListedValue>,
  options: RekeyOptions,
): RekeyCounts {
  const decrypt = options.decrypt ?? strictDecrypt;
  const step = options.stepRows ?? 1000;
  const counts: RekeyCounts = { reencrypted: 0, failedOnSource: 0, carriedUnreadable: 0 };
  const failed = new Set(header.failed.map((v) => listKey(v.table, v.column, v.pk)));
  const looksEncrypted = new Set(header.looksEncrypted.map((v) => listKey(v.table, v.column, v.pk)));
  const named = new Set(columns.map((c) => `${c.table}.${c.column}`));
  const refuse = (what: string): PlainRefusal => new PlainRefusal(`Refusing to restore: ${store} in the bundle ${what} — import aborted before anything was replaced.`);

  const setTables = [...PLAIN_COLUMNS[store].keys()];
  // The guard that keeps a deleted chat's runs blank is triggers on these tables
  // (`deleted-chat-guard.ts`). They are dropped from the image by name, not let through: a dropped
  // trigger does nothing whatever its body says, and history.db creates them again when it opens.
  // Any other trigger is still refused below.
  if (store === 'history.db') db.exec(dropDeletedChatGuardDdl());
  const trigger = db.prepare(`SELECT tbl_name AS t FROM sqlite_master WHERE type = 'trigger' AND lower(tbl_name) IN (${setTables.map(() => '?').join(', ')}) LIMIT 1`).get(...setTables.map((t) => t.toLowerCase())) as { t: string } | undefined;
  if (trigger) throw refuse(`carries a trigger on ${trigger.t}`);
  refuseUntrustedTables(db, refuse);
  // On a table of the set, a rewrite also computes its expression indexes and the conditions of its partial ones.
  for (const table of setTables) {
    const indexes = db.prepare(`PRAGMA index_list(${quoted(table)})`).all() as Array<{ name: string; partial: number }>;
    for (const index of indexes) {
      const parts = db.prepare(`PRAGMA index_xinfo(${quoted(index.name)})`).all() as Array<{ cid: number }>;
      if (index.partial !== 0 || parts.some((c) => c.cid === -2)) throw refuse(`has an index on an expression or a partial index on ${table}`);
    }
  }

  for (const { table, column, absent } of columns) {
    const has = columnNames(db, table);
    if (absent) {
      if (has.has(column)) throw refuse(`names ${table}.${column} as absent, but its image has that column`);
      continue;
    }
    if (!has.has(column)) {
      throw refuse(`names ${table}.${column} as rewritten, but its image has no such column`);
    }
  }

  const rewrite = (table: string, column: string, isNamed: boolean): void => {
    const info = tableColumns(db, table);
    if (info.some((c) => ROWID_NAMES.has(c.name.toLowerCase()))) throw refuse(`has a column in ${table} that shadows the rowid`);
    const pkCols = info.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
    const pkSelect = pkCols.length > 0 ? pkCols.map(quoted).join(', ') : 'rowid';
    const read = db.prepare(`SELECT rowid AS _r, ${pkSelect}, ${quoted(column)} AS _v FROM ${quoted(table)} WHERE rowid > ? ORDER BY rowid LIMIT ?`).raw();
    const write = db.prepare(`UPDATE ${quoted(table)} SET ${quoted(column)} = ? WHERE rowid = ?`);
    const runStep = db.transaction((after: number): number | null => {
      const rows = read.all(after, step) as unknown[][];
      let last: number | null = null;
      for (const row of rows) {
        last = row[0] as number;
        const value = row[row.length - 1];
        if (typeof value !== 'string' || value === '') continue;
        if (!isNamed) {
          if (value.startsWith(ENCRYPTED_PREFIX)) { counts.carriedUnreadable++; continue; }
        } else {
          const key = listKey(table, column, row.slice(1, row.length - 1));
          if (failed.has(key)) {
            if (!value.startsWith(ENCRYPTED_PREFIX)) throw refuse(`lists a value in ${table}.${column} as not decrypted that is not encrypted`);
            counts.failedOnSource++;
            continue;
          }
          if (value.startsWith(ENCRYPTED_PREFIX) && !looksEncrypted.has(key)) {
            throw refuse(`carries a value in ${table}.${column} (key ${JSON.stringify(row.slice(1, row.length - 1)).slice(0, 200)}) that looks encrypted but that the source neither decrypted nor listed`);
          }
        }
        const stored = encryptStoredText(value, options.key);
        const back = decrypt(stored, options.key);
        if (!back.ok || back.text !== value) {
          throw refuse(`could not be re-encrypted: a value in ${table}.${column} did not read back`);
        }
        write.run(stored, last);
        counts.reencrypted++;
      }
      return rows.length < step ? null : last;
    });
    let after: number | null = 0;
    while (after !== null) after = runStep(after);
  };

  // The set, named columns first in the order the chunk lists them, then the ones it does not name.
  const present = (table: string): Set<string> => columnNames(db, table);
  for (const { table, column, absent } of columns) if (!absent) rewrite(table, column, true);
  for (const [table, cols] of PLAIN_COLUMNS[store]) {
    const has = present(table);
    for (const column of cols) if (!named.has(`${table}.${column}`) && has.has(column)) rewrite(table, column, false);
  }

  // Tables that travel raw: counted, never touched.
  for (const [table, cols] of ENCRYPTED_COLUMNS[store]) {
    if (PLAIN_COLUMNS[store].has(table)) continue;
    const has = present(table);
    for (const column of cols) {
      if (!has.has(column)) continue;
      const row = db.prepare(`SELECT count(*) AS n FROM ${quoted(table)} WHERE typeof(${quoted(column)}) = 'text' AND substr(${quoted(column)}, 1, ${String(ENCRYPTED_PREFIX.length)}) = ?`).get(ENCRYPTED_PREFIX) as { n: number };
      counts.carriedUnreadable += row.n;
    }
  }

  // After every column: nothing of the set is left that is not ciphertext or ''.
  for (const [table, cols] of PLAIN_COLUMNS[store]) {
    const has = present(table);
    for (const column of cols) {
      if (!has.has(column)) continue;
      const c = quoted(column);
      const left = db.prepare(`SELECT count(*) AS n FROM ${quoted(table)} WHERE typeof(${c}) = 'blob' OR (typeof(${c}) = 'text' AND ${c} <> '' AND substr(${c}, 1, ${String(ENCRYPTED_PREFIX.length)}) <> ?)`).get(ENCRYPTED_PREFIX) as { n: number };
      if (left.n > 0) throw refuse(`still holds ${String(left.n)} unencrypted value(s) in ${table}.${column} after the rewrite`);
    }
  }
  return counts;
}

/**
 * The received plaintext image of `store`, re-encrypted under `options.key`, as a ciphertext image
 * for the existing staging. Opened from the Buffer in memory with `temp_store=MEMORY`; the image
 * is the source's, so it is opened as untrusted: `trusted_schema` and `foreign_keys` off (a
 * cascade would run a child table's trigger on the rewrite), and a `quick_check` before anything
 * is written.
 *
 * The result is a `VACUUM INTO` copy of the rewritten image, read back and removed. It carries
 * the live content only: no free page or free block, so neither a plaintext a rewrite displaced
 * nor anything the image arrived with in its free space (measured 2026-11-16: a `serialize` of
 * the rewritten image still held a replaced plaintext without `secure_delete`, the `VACUUM INTO`
 * copy did not). Unlike `VACUUM`, which renumbers the rowids of a table without an INTEGER PRIMARY
 * KEY, `VACUUM INTO` keeps them (measured on SQLite 3.53.4; the import's rowid test holds it).
 * The copy is written only after every column of the set passed the final check, so it holds
 * ciphertext. `secure_delete` stays on for the in-memory rewrite.
 */
export function reencryptImage(
  image: Buffer,
  store: PlainStore,
  columns: readonly PlainColumn[],
  header: PlainHeader<ListedValue>,
  options: RekeyOptions,
): { image: Buffer; counts: RekeyCounts } {
  const copy = patchWalHeader(image);
  let db: Database.Database;
  try {
    db = new Database(copy);
  } catch (err: unknown) {
    copy.fill(0);
    throw new PlainRefusal(`Refusing to restore: ${store} in the bundle does not open as a database — import aborted before anything was replaced.`, { cause: err });
  }
  try {
    // Without effect on today's rewrite (it calls no function the schema could name). It keeps the
    // source's schema (a view, a trigger, a default, an index) from calling a function this
    // connection registers later, e.g. if the rewrite moves into SQL with `db.function`: those are
    // not innocuous, and SQLite refuses them in schema code at prepare.
    db.pragma('trusted_schema = OFF');
    db.pragma('foreign_keys = OFF');
    // A CHECK runs on every row `quick_check` reads and on every rewrite; the source wrote them.
    db.pragma('ignore_check_constraints = ON');
    db.pragma('temp_store = MEMORY');
    db.pragma('secure_delete = ON');
    options.onOpen?.(db);
    refuseUntrustedTables(db, (what) => new PlainRefusal(`Refusing to restore: ${store} in the bundle ${what} — import aborted before anything was replaced.`));
    let check: unknown[];
    try {
      check = db.pragma('quick_check', { simple: false }) as unknown[];
    } catch (err: unknown) {
      throw new PlainRefusal(`Refusing to restore: ${store} in the bundle fails its integrity check — import aborted before anything was replaced.`, { cause: err });
    }
    if (check.length !== 1 || (check[0] as { quick_check?: unknown }).quick_check !== 'ok') {
      throw new PlainRefusal(`Refusing to restore: ${store} in the bundle fails its integrity check — import aborted before anything was replaced.`);
    }
    const counts = reencryptColumns(db, store, columns, header, options);
    const dir = mkdtempSync(join(options.scratchDir ?? tmpdir(), '.rekey-'));
    try {
      const out = join(dir, 'image.db');
      db.prepare('VACUUM INTO ?').run(out);
      return { image: readFileSync(out), counts };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    db.close();
    copy.fill(0);
  }
}

/**
 * Count the encrypted values of `store`'s plaintext-path columns in a database file: what a raw
 * store carries unreadable. Only reads. The connection is read-write on purpose: on a file whose
 * header says WAL, a read-only one leaves a `-wal` and `-shm` behind, which the last read-write
 * connection removes as it closes.
 */
export function countEncryptedPlainColumns(path: string, store: PlainStore): number {
  const db = new Database(path, { fileMustExist: true });
  try {
    let n = 0;
    for (const [table, cols] of PLAIN_COLUMNS[store]) {
      const present = columnNames(db, table);
      for (const column of cols) {
        if (!present.has(column)) continue;
        const row = db.prepare(`SELECT count(*) AS n FROM ${quoted(table)} WHERE typeof(${quoted(column)}) = 'text' AND substr(${quoted(column)}, 1, ${String(ENCRYPTED_PREFIX.length)}) = ?`).get(ENCRYPTED_PREFIX) as { n: number };
        n += row.n;
      }
    }
    return n;
  } finally {
    db.close();
  }
}

/**
 * Re-encrypt the contact cells of the merge ledgers a plaintext-form sweeps chunk carries, under
 * engine.db's key on this instance. On the plaintext path every entry must be a merge ledger the
 * restore would write (`version: 1`, `phase: 'merge'`); the source sends no other. Each ledger is
 * written back as `JSON.stringify(ledger, null, 2)`, the form the merge runner writes, so its
 * re-encrypted size equals its raw form's: the caller checks the total against the size the
 * source declared.
 */
export function reencryptLedgers(
  files: Record<string, unknown>,
  header: PlainHeader<ListedLedgerCell>,
  options: RekeyOptions,
): { files: Record<string, string>; counts: RekeyCounts } {
  const decrypt = options.decrypt ?? strictDecrypt;
  const counts: RekeyCounts = { reencrypted: 0, failedOnSource: 0, carriedUnreadable: 0 };
  const cellKey = (file: string, side: string, column: string): string => JSON.stringify([file, side, column]);
  const failed = new Set(header.failed.map((c) => cellKey(c.file, c.side, c.column)));
  const looksEncrypted = new Set(header.looksEncrypted.map((c) => cellKey(c.file, c.side, c.column)));
  const refuse = (what: string): PlainRefusal => new PlainRefusal(`Refusing to restore merge ledgers: ${what} — import aborted before anything was replaced.`);
  const out: Record<string, string> = {};

  for (const [file, content] of Object.entries(files)) {
    if (typeof content !== 'string') throw refuse(`${JSON.stringify(file.slice(0, 128))} is not text`);
    let ledger: Record<string, unknown>;
    try { ledger = JSON.parse(content) as Record<string, unknown>; } catch { throw refuse(`${JSON.stringify(file.slice(0, 128))} does not parse`); }
    if (ledger?.['version'] !== 1 || ledger['phase'] !== 'merge') throw refuse(`${JSON.stringify(file.slice(0, 128))} is not a merge ledger`);
    const detail = (ledger['entry'] as Record<string, unknown> | undefined)?.['detail'] as Record<string, unknown> | null | undefined;
    const table = detail?.['table'];
    const cols = typeof table === 'string' ? LEDGER_COLUMNS.get(table) : undefined;
    // A rollback writes these names into SQL, which matches them without regard to case; a name
    // that differs from the known one only in case would carry a contact cell past this rewrite.
    if (typeof table === 'string' && !cols && [...LEDGER_COLUMNS.keys()].some((t) => t.toLowerCase() === table.toLowerCase())) {
      throw refuse(`${JSON.stringify(file.slice(0, 128))} names its table in another case`);
    }
    if (detail && cols) {
      for (const side of ['dupRow', 'canonicalRow'] as const) {
        const row = detail[side] as Record<string, unknown> | null | undefined;
        if (!row) continue;
        if (Object.keys(row).some((k) => !cols.has(k) && [...cols].some((c) => c.toLowerCase() === k.toLowerCase()))) {
          throw refuse(`${JSON.stringify(file.slice(0, 128))} names a contact column in another case`);
        }
        for (const column of cols) {
          const value = row[column];
          if (typeof value !== 'string' || value === '') continue;
          const key = cellKey(file, side, column);
          if (failed.has(key)) {
            if (!value.startsWith(ENCRYPTED_PREFIX)) throw refuse(`${JSON.stringify(file.slice(0, 128))} lists a ${column} as not decrypted that is not encrypted`);
            counts.failedOnSource++;
            continue;
          }
          if (value.startsWith(ENCRYPTED_PREFIX) && !looksEncrypted.has(key)) {
            throw refuse(`${JSON.stringify(file.slice(0, 128))} carries a ${column} that looks encrypted but that the source neither decrypted nor listed`);
          }
          const stored = encryptStoredText(value, options.key);
          const back = decrypt(stored, options.key);
          if (!back.ok || back.text !== value || stored.length !== encryptedLength(value)) {
            throw refuse(`re-encrypting a ${column} in ${JSON.stringify(file.slice(0, 128))} did not read back`);
          }
          row[column] = stored;
          counts.reencrypted++;
        }
      }
    }
    out[file] = JSON.stringify(ledger, null, 2);
  }
  return { files: out, counts };
}
