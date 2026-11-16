/**
 * The destination's half of the plaintext path (`migration-rekey.ts`): a `sqlite_db_plain`
 * store and plaintext-form merge ledgers are checked at `setManifest`, re-encrypted under the
 * destination's key in memory, and staged as ciphertext.
 *
 * The source's half is not in this build, so the bundles here are made by a fixture that does
 * what the source will do: decrypt the columns of the set under the source key in an in-memory
 * copy and list what it could not read. The stores themselves are real: created by `EngineDb`
 * and `RunHistory` under the source key, read back on the destination under its own.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { EngineDb, deriveEngineEncKey } from './engine-db.js';
import { RunHistory, deriveHistoryEncKey } from './run-history.js';
import { MigrationImporter } from './migration-import.js';
import {
  computeManifestHash, deriveTransferKey, deserializePublicKey, encryptChunk, generateEphemeralKeypair,
  serializePublicKey, sha256, type EncryptedChunk, type MigrationChunkMeta, type MigrationManifest,
} from './migration-crypto.js';
import { strictDecrypt } from './strict-decrypt.js';
import {
  ENCRYPTED_COLUMNS, PLAIN_COLUMNS, countEncryptedPlainColumns, decodePlainPayload, encodePlainPayload, isListedValue, encryptStoredText, patchWalHeader,
  reencryptColumns, reencryptImage, reencryptLedgers,
  type ListedLedgerCell, type ListedValue, type PlainColumn, type PlainHeader, type PlainStore,
} from './migration-rekey.js';
import type { MigrationCeiling } from './migration-ceiling.js';
import { MAX_HEALTH_BYTES, choosePlainPaths, plainOffer, readDestinationHealth, rewriteStoreForPlain } from './migration-plain-source.js';
import { MigrationExporter } from './migration-export.js';

const SRC = 'source-vault-key-for-the-plaintext-path-2026';
const DST = 'destination-vault-key-for-the-plaintext-path-2026';
const OTHER = 'a-third-key-the-source-cannot-read-2026';
const TOKEN = 'c'.repeat(64);
const MIB = 1024 * 1024;
const ROOMY: MigrationCeiling = { import_limit_mb: 1_000_000, baseline_mb: 0, k: 1, rest_factor: 1 };

const keyOf = (store: PlainStore, vault: string): Buffer => (store === 'engine.db' ? deriveEngineEncKey(vault) : deriveHistoryEncKey(vault));

let dirs: string[] = [];
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), 'mig-plain-')); dirs.push(d); return d; };
beforeEach(() => { dirs = []; });
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

// ── Fixture: real stores under the source key ──

type Cols = Array<{ name: string; type: string; notnull: number; dflt_value: unknown; pk: number }>;

/**
 * Insert a row into `table` with `values`, filling every other NOT NULL column without a default:
 * the first literal of a `col IN ('…')` check where the schema has one, `{}` for a JSON column.
 */
function insertRow(db: Database.Database, table: string, values: Record<string, unknown>, i: number): void {
  const cols = db.prepare(`PRAGMA table_info("${table}")`).all() as Cols;
  const sql = (db.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(table) as { sql: string }).sql;
  const row: Record<string, unknown> = {};
  for (const c of cols) {
    if (c.name in values) { row[c.name] = values[c.name]; continue; }
    if (c.pk === 1 && /INT/i.test(c.type) && cols.filter(x => x.pk > 0).length === 1) continue; // rowid alias
    if (c.notnull === 0 && c.pk === 0) continue;
    if (c.dflt_value !== null && c.pk === 0) continue;
    // Row i takes the i-th literal, so a checked key column stays unique across the rows.
    const list = new RegExp(`\\b${c.name}\\b\\s+IN\\s*\\(([^)]*)\\)`, 'i').exec(sql)?.[1];
    const literals = list ? [...list.matchAll(/'([^']*)'/g)].map(m => m[1]!) : [];
    const literal = literals.length > 0 ? literals[(i - 1) % literals.length] : undefined;
    row[c.name] = literal ?? (/INT|REAL|NUM/i.test(c.type) ? i : /_json$/.test(c.name) ? '{}' : `${c.name}-${String(i)}`);
  }
  const names = Object.keys(row);
  db.prepare(`INSERT INTO "${table}" (${names.map(n => `"${n}"`).join(', ')}) VALUES (${names.map(() => '?').join(', ')})`)
    .run(...names.map(n => row[n] as string | number | null));
}

/**
 * What the fixture wrote into each encrypted column, by `store:table.column`, in row order:
 * `plain` and `notnull` under the source key, `empty` as `''`, `null` as NULL, `other` under a
 * key the source does not have.
 */
type Row = { kind: 'plain' | 'empty' | 'null' | 'notnull' | 'other'; text: string | null };
type Written = Map<string, Row[]>;

/** Tables whose key admits fewer rows (memory_blocks: 'profile' and 'playbook'): the rows they get. */
const FEW_ROWS: Readonly<Record<string, ReadonlyArray<Row['kind']>>> = { memory_blocks: ['plain', 'other'] };

/**
 * engine.db and history.db, created by their classes under `vault`, with rows in every column of
 * the set and in the raw-only columns. Per column: a plaintext, `''`, NULL (or a second plaintext
 * where the column is NOT NULL), and a value under another key (it does not decrypt on the source).
 */
function seedStores(dir: string, vault: string): Written {
  new EngineDb(join(dir, 'engine.db'), vault).close();
  new RunHistory(join(dir, 'history.db'), vault).close();
  const written: Written = new Map();
  for (const store of ['engine.db', 'history.db'] as const) {
    const db = new Database(join(dir, store));
    db.pragma('foreign_keys = OFF');
    const key = keyOf(store, vault);
    const other = keyOf(store, OTHER);
    for (const [table, cols] of ENCRYPTED_COLUMNS[store]) {
      const present = new Set((db.prepare(`PRAGMA table_info("${table}")`).all() as Cols).map(c => c.name));
      const info = db.prepare(`PRAGMA table_info("${table}")`).all() as Cols;
      const kinds = FEW_ROWS[table] ?? ['plain', 'empty', 'null', 'other'];
      const values: Array<Record<string, unknown>> = kinds.map(() => ({}));
      for (const column of cols) {
        if (!present.has(column)) continue;
        const notnull = info.find(c => c.name === column)!.notnull === 1;
        const rows: Row[] = kinds.map((k) => {
          if (k === 'null' && notnull) return { kind: 'notnull', text: `${table}.${column} not null` };
          if (k === 'empty') return { kind: k, text: '' };
          if (k === 'null') return { kind: k, text: null };
          return { kind: k, text: `${table}.${column} ${k === 'plain' ? 'secret one' : 'under another key'}` };
        });
        rows.forEach((r, i) => {
          values[i]![column] = r.kind === 'plain' || r.kind === 'notnull' ? encryptStoredText(r.text!, key) : r.kind === 'other' ? encryptStoredText(r.text!, other) : r.text;
        });
        written.set(`${store}:${table}.${column}`, rows);
      }
      // memory_blocks: the store seeds its rows, so the fixture replaces them.
      if (FEW_ROWS[table]) db.prepare(`DELETE FROM "${table}"`).run();
      values.forEach((v, i) => insertRow(db, table, v, i + 1));
    }
    db.close();
  }
  return written;
}

/**
 * The source's rewrite (`rewriteStoreForPlain`) over a copy of the store, split into its header
 * and image. With `skip`, an older source that encrypted those columns but neither decrypted nor
 * named them: then the fixture below does the source's work and leaves them out.
 */
function plainImage(path: string, store: PlainStore, vault: string, opts: { drop?: string[]; skip?: string[] } = {}): { image: Buffer; columns: PlainColumn[]; header: PlainHeader<ListedValue> } {
  const file = new Database(path);
  let bytes = file.serialize();
  file.close();
  if ((opts.drop ?? []).length > 0) {
    const d = new Database(patchWalHeader(bytes));
    for (const t of opts.drop ?? []) d.exec(`DROP TABLE "${t}"`);
    bytes = d.serialize();
    d.close();
  }
  if ((opts.skip ?? []).length === 0) {
    const r = rewriteStoreForPlain(bytes, store, { key: keyOf(store, vault) });
    const { header, body } = decodePlainPayload(r.payload, store, isListedValue);
    return { image: body, columns: r.columns, header };
  }
  return olderSourceImage(bytes, store, vault, opts.skip ?? []);
}

/** An older source: decrypts the set except `skip`, which it neither decrypts nor names. */
function olderSourceImage(bytes: Buffer, store: PlainStore, vault: string, skip: string[]): { image: Buffer; columns: PlainColumn[]; header: PlainHeader<ListedValue> } {
  const db = new Database(patchWalHeader(bytes));
  const opts = { skip };
  for (const t of opts.drop ?? []) db.exec(`DROP TABLE "${t}"`);
  const key = keyOf(store, vault);
  const columns: PlainColumn[] = [];
  const failed: ListedValue[] = [];
  const looksEncrypted: ListedValue[] = [];
  for (const [table, cols] of PLAIN_COLUMNS[store]) {
    const info = db.prepare(`PRAGMA table_info("${table}")`).all() as Cols;
    for (const column of cols) {
      if (opts.skip?.includes(`${table}.${column}`)) continue;
      if (!info.some(c => c.name === column)) { columns.push({ table, column, absent: true }); continue; }
      columns.push({ table, column });
      const pk = info.filter(c => c.pk > 0).sort((a, b) => a.pk - b.pk).map(c => `"${c.name}"`);
      const pkSel = pk.length > 0 ? pk.join(', ') : 'rowid';
      for (const row of db.prepare(`SELECT rowid AS _r, ${pkSel}, "${column}" AS _v FROM "${table}"`).raw().all() as unknown[][]) {
        const value = row[row.length - 1];
        if (typeof value !== 'string' || value === '') continue;
        const listed: ListedValue = { table, pk: row.slice(1, row.length - 1) as Array<string | number | null>, column };
        const r = strictDecrypt(value, key);
        if (!r.ok) { failed.push(listed); continue; }
        if (r.text.startsWith('enc:')) looksEncrypted.push(listed);
        db.prepare(`UPDATE "${table}" SET "${column}" = ? WHERE rowid = ?`).run(r.text, row[0] as number);
      }
    }
  }
  const image = db.serialize();
  db.close();
  return { image, columns, header: { failed, looksEncrypted } };
}

// ── Bundle ──

interface Part { type: MigrationChunkMeta['type']; name: string; data: Buffer; meta?: Partial<MigrationChunkMeta> }

function handshake(importer: MigrationImporter): Buffer {
  const server = importer.startHandshake(TOKEN);
  const client = generateEphemeralKeypair();
  const key = deriveTransferKey(client.privateKey, deserializePublicKey(server.serverPubKey), Buffer.from(server.challengeNonce, 'hex'));
  importer.completeHandshake(serializePublicKey(client.publicKey));
  return key;
}

function bundle(parts: Part[], transferKey: Buffer): { manifest: MigrationManifest; chunks: EncryptedChunk[] } {
  const metas: MigrationChunkMeta[] = parts.map((p, seq) => ({ seq, type: p.type, name: p.name, originalSize: p.data.length, checksum: sha256(p.data), ...p.meta }));
  const base = { version: 1 as const, exportedAt: new Date().toISOString(), lynoxVersion: 'test', totalChunks: metas.length, chunks: metas };
  const manifest: MigrationManifest = { ...base, manifestHash: computeManifestHash(base) };
  return { manifest, chunks: parts.map((p, seq) => encryptChunk(p.data, transferKey, seq, manifest.manifestHash)) };
}

function plainPart(dir: string, store: PlainStore, opts: Parameters<typeof plainImage>[3] = {}): Part {
  const { image, columns, header } = plainImage(join(dir, store), store, SRC, opts);
  return { type: 'sqlite_db_plain', name: store, data: encodePlainPayload(header, image), meta: { columns } };
}

/** A store as today's exporter sends it: a `VACUUM INTO` snapshot, raw. */
function rawPart(dir: string, store: string): Part {
  const snap = join(dir, `${store}.snap`);
  const db = new Database(join(dir, store), { readonly: true });
  db.prepare('VACUUM INTO ?').run(snap);
  db.close();
  const data = readFileSync(snap);
  rmSync(snap);
  return { type: 'sqlite_db', name: store, data };
}

function importer(dst: string, ceiling: MigrationCeiling = ROOMY): MigrationImporter {
  return new MigrationImporter({ lynoxDir: dst, vaultKey: DST, migrationCeiling: ceiling, acceptPlainStores: true });
}

function run(dst: string, parts: Part[], ceiling?: MigrationCeiling): ReturnType<MigrationImporter['restore']> {
  const imp = importer(dst, ceiling);
  const { manifest, chunks } = bundle(parts, handshake(imp));
  imp.setManifest(manifest);
  for (const c of chunks) imp.receiveChunk(c);
  try { return imp.restore(); } finally { imp.cleanup(); }
}

function readColumn(dir: string, store: string, table: string, column: string): unknown[] {
  const db = new Database(join(dir, store), { readonly: true });
  try { return (db.prepare(`SELECT "${column}" AS v FROM "${table}" ORDER BY rowid`).all() as Array<{ v: unknown }>).map(r => r.v); } finally { db.close(); }
}

/** Encrypted values in `cols` of `store` at `dir`, counted on the stored text. */
function encryptedIn(dir: string, store: PlainStore, cols: Array<[string, string]>): number {
  return cols.reduce((n, [t, c]) => n + readColumn(dir, store, t, c).filter(v => typeof v === 'string' && v.startsWith('enc:')).length, 0);
}
const rawOnlyColumns = (store: PlainStore): Array<[string, string]> => [...ENCRYPTED_COLUMNS[store]]
  .filter(([t]) => !PLAIN_COLUMNS[store].has(t)).flatMap(([t, cs]) => [...cs].map(c => [t, c] as [string, string]));

const listing = (dir: string): Array<[string, number]> => readdirSync(dir).sort().map(f => [f, statSync(join(dir, f)).mtimeMs]);

// ── Tests ──

describe('a plaintext store arrives readable under the destination key', () => {
  it('re-encrypts every column of the set; failed values, raw-only columns, empty text and NULL stay as they were', () => {
    const src = tmp(); const dst = tmp();
    const written = seedStores(src, SRC);
    const report = run(dst, [plainPart(src, 'engine.db'), plainPart(src, 'history.db')]);

    let checked = 0;
    for (const store of ['engine.db', 'history.db'] as const) {
      const dstKey = keyOf(store, DST);
      for (const [table, cols] of PLAIN_COLUMNS[store]) {
        for (const column of cols) {
          const rows = written.get(`${store}:${table}.${column}`);
          if (!rows) continue;
          const stored = readColumn(dst, store, table, column);
          const before = readColumn(src, store, table, column);
          expect(stored).toHaveLength(rows.length);
          rows.forEach((r, i) => {
            const at = `${store} ${table}.${column} row ${String(i + 1)} (${r.kind})`;
            // A plaintext of the source reads back, strictly, under the destination key.
            if (r.kind === 'plain' || r.kind === 'notnull') expect(strictDecrypt(stored[i] as string, dstKey), at).toEqual({ ok: true, kind: 'decrypted', text: r.text });
            // '' stays '' in the stored column and NULL stays NULL: neither is encrypted.
            if (r.kind === 'empty') expect(stored[i], at).toBe('');
            if (r.kind === 'null') expect(stored[i], at).toBeNull();
            // Did not decrypt on the source: arrives exactly as it was stored there.
            if (r.kind === 'other') expect(stored[i], at).toBe(before[i]);
          });
          checked++;
        }
      }
    }
    // The set is 14 columns over both stores; every one was seeded and checked.
    expect(checked).toBe([...PLAIN_COLUMNS['engine.db'].values(), ...PLAIN_COLUMNS['history.db'].values()].reduce((n, s) => n + s.size, 0));
    expect(checked).toBe(14);

    // The raw-only columns travel under the source key: byte-equal to the source.
    for (const [table, cols] of ENCRYPTED_COLUMNS['engine.db']) {
      if (PLAIN_COLUMNS['engine.db'].has(table)) continue;
      for (const column of cols) {
        if (!written.has(`engine.db:${table}.${column}`)) continue;
        expect(readColumn(dst, 'engine.db', table, column), `${table}.${column}`).toEqual(readColumn(src, 'engine.db', table, column));
      }
    }

    // Through the store class on the destination, too: the key derivation the engine uses.
    const engine = new EngineDb(join(dst, 'engine.db'), DST);
    try {
      const v = engine.getDb().prepare('SELECT text FROM memories ORDER BY rowid LIMIT 1').get() as { text: string };
      expect(engine.decStrict(v.text)).toEqual({ ok: true, kind: 'decrypted', text: written.get('engine.db:memories.text')![0]!.text });
    } finally { engine.close(); }

    const engineReport = report.encryptedColumns?.find(r => r.what === 'engine.db');
    const historyReport = report.encryptedColumns?.find(r => r.what === 'history.db');
    expect(engineReport).toMatchObject({ path: 'plain' });
    expect(historyReport).toMatchObject({ path: 'plain', carriedUnreadable: 0 });
    // Rows 1 and 3 (where not NULL) of each column.
    const count = (store: PlainStore, kinds: Array<Row['kind']>): number => [...PLAIN_COLUMNS[store]]
      .flatMap(([t, cs]) => [...cs].flatMap(c => written.get(`${store}:${t}.${c}`)!)).filter(r => kinds.includes(r.kind)).length;
    const expected = (store: PlainStore): number => count(store, ['plain', 'notnull']);
    expect(engineReport!.failedOnSource).toBe(count('engine.db', ['other']));
    expect(historyReport!.failedOnSource).toBe(count('history.db', ['other']));
    expect(engineReport!.reencrypted).toBe(expected('engine.db'));
    expect(historyReport!.reencrypted).toBe(expected('history.db'));
    // The raw-only columns of engine.db hold encrypted values: counted as carried unreadable.
    const rawOnly = encryptedIn(src, 'engine.db', rawOnlyColumns('engine.db'));
    expect(rawOnly).toBeGreaterThan(0);
    expect(engineReport!.carriedUnreadable).toBe(rawOnly);
  });

  it('writes no plaintext of the set into the stores it puts in place, not even in free space', () => {
    const src = tmp(); const dst = tmp();
    const written = seedStores(src, SRC);
    run(dst, [plainPart(src, 'engine.db'), plainPart(src, 'history.db')]);
    const needles = [...written.values()].flat().filter(r => r.kind === 'plain' || r.kind === 'notnull').map(r => r.text!);
    expect(needles.length).toBeGreaterThan(20);
    for (const store of ['engine.db', 'history.db']) {
      const bytes = readFileSync(join(dst, store));
      const found = needles.filter(n => bytes.includes(Buffer.from(n, 'utf-8')));
      expect(found, `${store} holds plaintext of the set`).toEqual([]);
    }
    // The control: the plaintext image that travelled holds every needle of its store.
    const image = splitPayload(plainPart(src, 'engine.db').data).image;
    expect(needles.filter(n => n.startsWith('knowledge_entries')).every(n => image.includes(Buffer.from(n, 'utf-8')))).toBe(true);
  });

  it('re-encrypts a plaintext that starts with enc: when the source listed it, and reads it back as written', () => {
    const src = tmp(); const dst = tmp();
    seedStores(src, SRC);
    const db = new Database(join(src, 'engine.db'));
    db.prepare('UPDATE memories SET text = ? WHERE rowid = (SELECT min(rowid) FROM memories)').run(encryptStoredText('enc:xyz', deriveEngineEncKey(SRC)));
    db.close();
    run(dst, [plainPart(src, 'engine.db')]);
    expect(strictDecrypt(readColumn(dst, 'engine.db', 'memories', 'text')[0] as string, deriveEngineEncKey(DST))).toEqual({ ok: true, kind: 'decrypted', text: 'enc:xyz' });
  });

  it('refuses a value that looks encrypted and that neither list names, before anything is written', () => {
    const src = tmp(); const dst = tmp();
    seedStores(src, SRC);
    const part = plainPart(src, 'engine.db');
    // The source "forgot" one failed value: it travels as ciphertext with no listing.
    const { header, image } = splitPayload(part.data);
    const forgot = header.failed.find(v => v.table === 'people')!;
    const data = encodePlainPayload({ failed: header.failed.filter(v => v !== forgot), looksEncrypted: header.looksEncrypted }, image);
    const before = listing(dst);
    expect(() => run(dst, [{ ...part, data }])).toThrow(/people\.(email|phone).*neither decrypted nor listed/);
    expect(listing(dst)).toEqual(before);
  });

  it('migrates a source image without a table of the set, and counts a column of this set the source did not rewrite', () => {
    const src = tmp(); const dst = tmp();
    const written = seedStores(src, SRC);
    // An older source: no inbound_events at all, and memories.text encrypted but not decrypted.
    const report = run(dst, [plainPart(src, 'engine.db', { drop: ['inbound_events'], skip: ['memories.text'] })]);
    const memories = readColumn(dst, 'engine.db', 'memories', 'text');
    expect(memories).toEqual(readColumn(src, 'engine.db', 'memories', 'text'));
    expect(strictDecrypt(memories[0] as string, deriveEngineEncKey(SRC))).toMatchObject({ text: written.get('engine.db:memories.text')![0]!.text });
    const engineReport = report.encryptedColumns!.find(r => r.what === 'engine.db')!;
    // memories.text's encrypted values plus every raw-only one; inbound_events is gone with its table.
    const expected = encryptedIn(src, 'engine.db', [['memories', 'text'], ...rawOnlyColumns('engine.db')]);
    expect(encryptedIn(src, 'engine.db', [['memories', 'text']])).toBeGreaterThan(0);
    expect(engineReport.carriedUnreadable).toBe(expected);
    const db = new Database(join(dst, 'engine.db'), { readonly: true });
    try { expect(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'inbound_events'").get()).toEqual({ n: 0 }); } finally { db.close(); }
  });

  it('refuses a column the meta names as rewritten that the image does not have, before anything is written', () => {
    const src = tmp(); const dst = tmp();
    seedStores(src, SRC);
    const { image, header } = plainImage(join(src, 'engine.db'), 'engine.db', SRC, { drop: ['inbound_events'] });
    const data = encodePlainPayload(header, image);
    expect(() => run(dst, [{ type: 'sqlite_db_plain', name: 'engine.db', data, meta: { columns: [{ table: 'inbound_events', column: 'values_json' }] } }]))
      .toThrow(/has no such column/);
    expect(readdirSync(dst)).toEqual([]);
  });

  it('opens a received image whose header says WAL', () => {
    const src = tmp();
    seedStores(src, SRC);
    const file = new Database(join(src, 'engine.db'));
    const bytes = file.serialize();
    file.close();
    // The control: the image the store serializes says WAL.
    expect([bytes[18], bytes[19]]).toEqual([2, 2]);
    const patched = patchWalHeader(bytes);
    expect([patched[18], patched[19]]).toEqual([1, 1]);
    expect(Buffer.compare(patched.subarray(20), bytes.subarray(20))).toBe(0);
    expect(Buffer.compare(patched.subarray(0, 18), bytes.subarray(0, 18))).toBe(0);
    expect([bytes[18], bytes[19]], 'pure: the input is not changed').toEqual([2, 2]);
    // Unpatched it does not open from a Buffer: the patch is what makes the path work.
    expect(() => new Database(bytes).prepare('SELECT 1 FROM memories').get()).toThrow();
    const dst = tmp();
    const { header, columns } = plainImage(join(src, 'engine.db'), 'engine.db', SRC);
    const walImage = Buffer.from(splitPayload(plainPart(src, 'engine.db').data).image);
    walImage[18] = 2; walImage[19] = 2;
    run(dst, [{ type: 'sqlite_db_plain', name: 'engine.db', data: encodePlainPayload(header, walImage), meta: { columns } }]);
    expect(existsSync(join(dst, 'engine.db'))).toBe(true);
  });
});

function splitPayload(data: Buffer): { header: PlainHeader<ListedValue>; image: Buffer } {
  const len = data.readUInt32BE(0);
  return { header: JSON.parse(data.subarray(4, 4 + len).toString('utf-8')) as PlainHeader<ListedValue>, image: data.subarray(4 + len) };
}

describe('a raw store from an older source is still taken', () => {
  it('accepts engine.db and history.db as sqlite_db and counts their encrypted columns of the set as carried unreadable', () => {
    const src = tmp(); const dst = tmp();
    seedStores(src, SRC);
    const report = run(dst, [rawPart(src, 'engine.db'), rawPart(src, 'history.db')]);
    expect(report.databasesRestored.sort()).toEqual(['engine.db', 'history.db']);
    // Per column of the set: rows 1, 3 (when not NULL) and 4 are encrypted.
    for (const store of ['engine.db', 'history.db'] as const) {
      const r = report.encryptedColumns!.find(x => x.what === store)!;
      expect(r.path).toBe('raw');
      expect(r.reencrypted).toBe(0);
      let expected = 0;
      for (const [table, cols] of PLAIN_COLUMNS[store]) {
        for (const column of cols) expected += readColumn(src, store, table, column).filter(v => typeof v === 'string' && v.startsWith('enc:')).length;
      }
      expect(expected).toBeGreaterThan(0);
      expect(r.carriedUnreadable).toBe(expected);
    }
    // And nothing next to the stores is left behind (the count reads the staged copy).
    expect(readdirSync(dst).filter(f => f.includes('migration-tmp'))).toEqual([]);
  });
});

describe('setManifest refuses what the plaintext path cannot take, before any chunk is sent', () => {
  function refused(parts: Part[], pattern: RegExp, ceiling?: MigrationCeiling): void {
    const dst = tmp();
    const imp = importer(dst, ceiling);
    const { manifest } = bundle(parts, handshake(imp));
    expect(() => imp.setManifest(manifest)).toThrow(pattern);
    expect(imp.isComplete()).toBe(false);
    expect(readdirSync(dst)).toEqual([]);
  }
  const fake = (type: MigrationChunkMeta['type'], name: string, meta?: Partial<MigrationChunkMeta>, bytes = 16): Part => ({ type, name, data: Buffer.alloc(bytes, 1), meta });
  const memories: PlainColumn[] = [{ table: 'memories', column: 'text' }];

  it('a column the target instance does not know, refused at the manifest with the update-first message', () => {
    refused([fake('sqlite_db_plain', 'engine.db', { columns: [{ table: 'memories', column: 'mood' }] })], /^The target instance runs an older version than the source and cannot encrypt "memories\.mood" in engine\.db\. None of the data was transferred, and the target instance is unchanged\. Update the target instance first, then migrate again\.$/);
  });
  it('a raw-only column named as plaintext', () => {
    refused([fake('sqlite_db_plain', 'engine.db', { columns: [{ table: 'approval_entries', column: 'payload_json' }] })], /cannot encrypt/);
  });
  it('a history column named for engine.db', () => {
    refused([fake('sqlite_db_plain', 'engine.db', { columns: [{ table: 'runs', column: 'task_text' }] })], /cannot encrypt/);
  });
  it('a plaintext store without its column list', () => {
    refused([fake('sqlite_db_plain', 'engine.db')], /without its column list/);
  });
  it('a column list on a later part, or on a raw store', () => {
    refused([fake('sqlite_db_plain', 'engine.db:part0', { columns: memories }), fake('sqlite_db_plain', 'engine.db:part1', { columns: memories })], /not the first part/);
    refused([fake('sqlite_db', 'engine.db', { columns: memories })], /not the first part/);
  });
  it('a plaintext store without its first part', () => {
    refused([fake('sqlite_db_plain', 'engine.db:part1')], /without its first part/);
  });
  it('a ledger form the target instance does not know, and a raw size on raw ledgers', () => {
    refused([fake('sqlite_db_plain', 'engine.db', { columns: memories }), fake('sweeps', 'sweeps', { ledgerForm: 'sealed' as 'plain', ledgerRawBytes: 16 })], /does not know/);
    refused([fake('sqlite_db', 'engine.db'), fake('sweeps', 'sweeps', { ledgerRawBytes: 16 })], /raw size for merge ledgers that travel raw/);
  });
  it('a plaintext store other than engine.db and history.db', () => {
    refused([fake('sqlite_db_plain', 'agent-memory.db', { columns: [] })], /Disallowed database name/);
  });
  it('the same store raw and as plaintext', () => {
    refused([fake('sqlite_db', 'engine.db'), fake('sqlite_db_plain', 'engine.db', { columns: memories })], /both raw and as plaintext/);
    refused([fake('sqlite_db_plain', 'history.db', { columns: [] }), fake('sqlite_db', 'history.db:part0')], /both raw and as plaintext/);
  });
  it('merge ledgers whose form does not follow engine.db', () => {
    refused([fake('sqlite_db', 'engine.db'), fake('sweeps', 'sweeps', { ledgerForm: 'plain', ledgerRawBytes: 16 })], /same path/);
    refused([fake('sqlite_db_plain', 'engine.db', { columns: memories }), fake('sweeps', 'sweeps')], /same path/);
    refused([fake('sqlite_db_plain', 'engine.db', { columns: memories }), fake('sweeps', 'sweeps', { ledgerForm: 'plain' })], /without their raw size/);
  });
  it('a plaintext store over this instance\'s memory, and takes it just under', () => {
    // baseline 0, k 2, rest factor 1, limit 10 MiB: B + R + S <= 10 MiB.
    const tight: MigrationCeiling = { import_limit_mb: 10, baseline_mb: 0, k: 2, rest_factor: 1 };
    const rest = fake('memory', 'memory', undefined, 2 * MIB);
    // B = 2 + S, R = 2: 4 + 2S <= 10 → S <= 3 MiB.
    const fits = fake('sqlite_db_plain', 'engine.db', { columns: memories }, 3 * MIB);
    const over = fake('sqlite_db_plain', 'engine.db', { columns: memories }, 3 * MIB + 2);
    refused([over, rest], /does not fit the target instance's memory/, tight);
    const imp = importer(tmp(), tight);
    expect(() => imp.setManifest(bundle([fits, rest], handshake(imp)).manifest)).not.toThrow();
    // The rule sums the parts: two parts each well under the bound, together over it.
    refused([
      fake('sqlite_db_plain', 'engine.db:part0', { columns: memories }, 2 * MIB),
      fake('sqlite_db_plain', 'engine.db:part1', undefined, MIB + 2),
      rest,
    ], /does not fit/, tight);
  });
  it('plaintext ledgers whose raw form is above the sweeps cap', () => {
    refused([fake('sqlite_db_plain', 'engine.db', { columns: memories }), fake('sweeps', 'sweeps', { ledgerForm: 'plain', ledgerRawBytes: 64 * MIB + 1 })], /above their cap/);
  });
  it('counts the ledgers at their raw size in the rest', () => {
    const tight: MigrationCeiling = { import_limit_mb: 10, baseline_mb: 0, k: 2, rest_factor: 1 };
    // Ledgers travel at 1 MiB in plaintext but declare 2 MiB raw: B = 3 + 2 = 5... the store at
    // 2 MiB: B = 2 + 2 = 4 (sweeps at the larger form), R = 2, S = 2 → 4 + 2 + 2 = 8 fits;
    // at 3 MiB: 5 + 2 + 3 = 10 fits; at 3 MiB + 2 it does not, though with the travelling size
    // (1 MiB) it would.
    const sweeps = fake('sweeps', 'sweeps', { ledgerForm: 'plain', ledgerRawBytes: 2 * MIB }, MIB);
    refused([fake('sqlite_db_plain', 'engine.db', { columns: memories }, 3 * MIB + 2), sweeps], /does not fit/, tight);
    const imp = importer(tmp(), tight);
    expect(() => imp.setManifest(bundle([fake('sqlite_db_plain', 'engine.db', { columns: memories }, 3 * MIB), sweeps], handshake(imp)).manifest)).not.toThrow();
  });
});

describe('the transfer binds what travels', () => {
  it('refuses a chunk whose length is not its declared size', () => {
    const src = tmp(); const dst = tmp();
    seedStores(src, SRC);
    const part = plainPart(src, 'engine.db');
    const imp = importer(dst);
    const key = handshake(imp);
    // The manifest declares one byte more than the chunk carries, with the chunk's own checksum.
    const meta: MigrationChunkMeta = { seq: 0, type: part.type, name: part.name, originalSize: part.data.length + 1, checksum: sha256(part.data), ...part.meta };
    const base = { version: 1 as const, exportedAt: new Date().toISOString(), lynoxVersion: 'test', totalChunks: 1, chunks: [meta] };
    const manifest = { ...base, manifestHash: computeManifestHash(base) };
    imp.setManifest(manifest);
    expect(() => imp.receiveChunk(encryptChunk(part.data, key, 0, manifest.manifestHash))).toThrow(/Size mismatch/);
  });

  it('refuses an altered plaintext chunk, and a column list changed on the meta', () => {
    const src = tmp();
    seedStores(src, SRC);
    const part = plainPart(src, 'engine.db');
    {
      const imp = importer(tmp());
      const { manifest, chunks } = bundle([part], handshake(imp));
      imp.setManifest(manifest);
      const bytes = Buffer.from(chunks[0]!.data, 'base64');
      bytes[bytes.length - 1]! ^= 1;
      expect(() => imp.receiveChunk({ ...chunks[0]!, data: bytes.toString('base64') })).toThrow();
    }
    {
      // The column list is bound by the manifest hash: changed after it, the manifest is refused.
      const imp = importer(tmp());
      const { manifest } = bundle([part], handshake(imp));
      const altered = { ...manifest, chunks: manifest.chunks.map(c => ({ ...c, columns: c.columns!.slice(1) })) };
      expect(() => imp.setManifest(altered)).toThrow(/Manifest hash verification failed/);
    }
    {
      // …and with the hash recomputed, every chunk's additional data no longer matches.
      const imp = importer(tmp());
      const { manifest, chunks } = bundle([part], handshake(imp));
      const rest = { version: manifest.version, exportedAt: manifest.exportedAt, lynoxVersion: manifest.lynoxVersion, totalChunks: manifest.totalChunks, chunks: manifest.chunks.map(c => ({ ...c, columns: c.columns!.slice(1) })) };
      imp.setManifest({ ...rest, manifestHash: computeManifestHash(rest) });
      expect(() => imp.receiveChunk(chunks[0]!)).toThrow();
    }
  });

  it('keeps the listed values in the payload: a top-level manifest field is not covered by the hash', () => {
    // Why the lists cannot be a manifest field: the hash ignores one.
    const base = { version: 1 as const, exportedAt: 'x', lynoxVersion: 'y', totalChunks: 0, chunks: [] };
    expect(computeManifestHash({ ...base, failed: [{ table: 't' }] } as typeof base)).toBe(computeManifestHash(base));
    // And the payload carries them: an import reads its header from the chunk.
    const src = tmp();
    seedStores(src, SRC);
    expect(splitPayload(plainPart(src, 'engine.db').data).header.failed.length).toBeGreaterThan(0);
  });
});

describe('the rewrite runs in steps of 1,000 rows, one transaction each', () => {
  it('keeps the first 1,000 rows rewritten and rolls back the next 499 when the check throws on the 1,500th', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE memories (id TEXT PRIMARY KEY, text TEXT)');
    const insert = db.prepare('INSERT INTO memories (id, text) VALUES (?, ?)');
    for (let i = 1; i <= 1500; i++) insert.run(`m${String(i)}`, `note ${String(i)}`);
    const key = deriveEngineEncKey(DST);
    let calls = 0;
    const decrypt = (stored: string, k: Buffer) => { if (++calls === 1500) throw new Error('boom'); return strictDecrypt(stored, k); };
    expect(() => reencryptColumns(db, 'engine.db', [{ table: 'memories', column: 'text' }], { failed: [], looksEncrypted: [] }, { key, decrypt })).toThrow('boom');
    const rows = db.prepare('SELECT text FROM memories ORDER BY rowid').all() as Array<{ text: string }>;
    // Rewritten: ciphertext under the key, not the plaintext (which strictDecrypt calls `plain`).
    expect(rows.slice(0, 1000).map(r => strictDecrypt(r.text, key))).toEqual(Array.from({ length: 1000 }, (_, i) => ({ ok: true, kind: 'decrypted', text: `note ${String(i + 1)}` })));
    expect(rows.slice(1000).map(r => r.text)).toEqual(Array.from({ length: 500 }, (_, i) => `note ${String(i + 1001)}`));
    db.close();
  });

  it('leaves no replaced plaintext in the serialized image, in free space either', () => {
    // Made the way the source makes it: a store under its key, a `VACUUM INTO` snapshot, the
    // cells rewritten in place to plaintext (never longer than their ciphertext).
    const dir = tmp();
    const file = new Database(join(dir, 'engine.db'));
    file.pragma('journal_mode = WAL');
    file.exec('CREATE TABLE memories (id TEXT PRIMARY KEY, text TEXT)');
    const srcKey = deriveEngineEncKey(SRC);
    const insert = file.prepare('INSERT INTO memories (id, text) VALUES (?, ?)');
    const plain = (i: number): string => `needle-${String(i).padStart(5, '0')}-plaintext`;
    for (let i = 1; i <= 3000; i++) insert.run(`m${String(i)}`, encryptStoredText(plain(i), srcKey));
    file.prepare('VACUUM INTO ?').run(join(dir, 'snap.db'));
    file.close();
    const source = new Database(readFileSync(join(dir, 'snap.db')));
    const toPlain = source.prepare('UPDATE memories SET text = ? WHERE id = ?');
    source.transaction(() => { for (let i = 1; i <= 3000; i++) toPlain.run(plain(i), `m${String(i)}`); })();
    const image = source.serialize();
    source.close();
    const occurrences = (buf: Buffer): number => { let n = 0; for (let i = buf.indexOf('needle-'); i !== -1; i = buf.indexOf('needle-', i + 1)) n++; return n; };
    // The control: the arriving image holds each needle exactly once, as a live cell.
    expect(occurrences(image)).toBe(3000);
    const { image: out, counts } = reencryptImage(image, 'engine.db', [{ table: 'memories', column: 'text' }], { failed: [], looksEncrypted: [] }, { key: deriveEngineEncKey(DST) });
    expect(counts.reencrypted).toBe(3000);
    expect(occurrences(out), 'plaintext left in the image').toBe(0);
  });

  const NONE = { failed: [], looksEncrypted: [] };
  const MEM = [{ table: 'memories', column: 'text' }];
  const memDb = (ddl: string, rows: Array<[unknown, ...unknown[]]>): Database.Database => {
    const db = new Database(':memory:');
    db.exec(ddl);
    for (const r of rows) db.prepare(`INSERT INTO memories VALUES (${r.map(() => '?').join(', ')})`).run(...r as Array<string | number | null>);
    return db;
  };

  it.each([
    ['a text key', 'CREATE TABLE memories (id TEXT PRIMARY KEY, text TEXT)', ['a'], ['b']],
    ['an integer primary key', 'CREATE TABLE memories (id INTEGER PRIMARY KEY, text TEXT)', [7], [9]],
    ['a composite key', 'CREATE TABLE memories (a TEXT, b INTEGER, text TEXT, PRIMARY KEY (a, b))', ['x', 1], ['x', 2]],
    ['no declared key (the rowid)', 'CREATE TABLE memories (text TEXT)', [1], [2]],
  ])('matches a failed listing by the primary key with %s', (_label, ddl, failedPk, plainPk) => {
    const other = encryptStoredText('under another key', deriveEngineEncKey(OTHER));
    const cols = (pk: unknown[], v: string): [unknown, ...unknown[]] => (pk.length === 1 && ddl.includes('(text TEXT)') ? [v] : [...pk, v]) as [unknown, ...unknown[]];
    const db = memDb(ddl, [cols(failedPk, other), cols(plainPk, 'readable')]);
    const key = deriveEngineEncKey(DST);
    const counts = reencryptColumns(db, 'engine.db', MEM, { failed: [{ table: 'memories', column: 'text', pk: failedPk as Array<string | number> }], looksEncrypted: [] }, { key });
    expect(counts).toEqual({ reencrypted: 1, failedOnSource: 1, carriedUnreadable: 0 });
    const texts = (db.prepare('SELECT text FROM memories ORDER BY rowid').all() as Array<{ text: string }>).map(r => r.text);
    expect(texts[0]).toBe(other);
    expect(strictDecrypt(texts[1]!, key)).toEqual({ ok: true, kind: 'decrypted', text: 'readable' });
    db.close();
  });

  it('refuses a value listed as not decrypted that is not encrypted: it would stay plaintext at rest', () => {
    const db = memDb('CREATE TABLE memories (id TEXT PRIMARY KEY, text TEXT)', [['a', 'plain words']]);
    expect(() => reencryptColumns(db, 'engine.db', MEM, { failed: [{ table: 'memories', column: 'text', pk: ['a'] }], looksEncrypted: [] }, { key: deriveEngineEncKey(DST) }))
      .toThrow(/as not decrypted that is not encrypted/);
    db.close();
  });

  it('refuses a column marked absent that the image has', () => {
    const db = memDb('CREATE TABLE memories (id TEXT PRIMARY KEY, text TEXT)', [['a', 'plain words']]);
    expect(() => reencryptColumns(db, 'engine.db', [{ table: 'memories', column: 'text', absent: true }], NONE, { key: deriveEngineEncKey(DST) }))
      .toThrow(/as absent, but its image has that column/);
    db.close();
  });

  it('refuses a table with a column that shadows the rowid', () => {
    const db = memDb('CREATE TABLE memories (rowid INTEGER, text TEXT)', [[5, 'plain words']]);
    expect(() => reencryptColumns(db, 'engine.db', MEM, NONE, { key: deriveEngineEncKey(DST) })).toThrow(/shadows the rowid/);
    db.close();
  });

  it('refuses when plaintext is left after the rewrite: a row the paging does not reach, a BLOB', () => {
    const below = memDb('CREATE TABLE memories (id TEXT PRIMARY KEY, text TEXT)', [['a', 'reached']]);
    below.prepare('INSERT INTO memories (rowid, id, text) VALUES (0, ?, ?)').run('z', 'at rowid 0');
    expect(() => reencryptColumns(below, 'engine.db', MEM, NONE, { key: deriveEngineEncKey(DST) })).toThrow(/still holds 1 unencrypted value/);
    below.close();
    // The same for a column of the set the source did not name.
    const unnamed = memDb('CREATE TABLE memories (id TEXT PRIMARY KEY, text TEXT)', [['a', 'reached']]);
    unnamed.prepare('INSERT INTO memories (rowid, id, text) VALUES (0, ?, ?)').run('z', 'at rowid 0');
    expect(() => reencryptColumns(unnamed, 'engine.db', [], NONE, { key: deriveEngineEncKey(DST) })).toThrow(/still holds 1 unencrypted value/);
    unnamed.close();
    const blob = memDb('CREATE TABLE memories (id TEXT PRIMARY KEY, text TEXT)', [['a', 'reached']]);
    blob.prepare('INSERT INTO memories VALUES (?, ?)').run('b', Buffer.from('plain bytes'));
    expect(() => reencryptColumns(blob, 'engine.db', MEM, NONE, { key: deriveEngineEncKey(DST) })).toThrow(/still holds 1 unencrypted value/);
    blob.close();
  });

  it('refuses an image with a trigger on a table of the set: it could write a plaintext back', () => {
    const trig = memDb('CREATE TABLE memories (id TEXT PRIMARY KEY, text TEXT)', [['a', 'kept']]);
    trig.exec("CREATE TRIGGER back AFTER UPDATE OF text ON memories BEGIN UPDATE memories SET text = 'kept' WHERE id = new.id; END");
    expect(() => reencryptColumns(trig, 'engine.db', MEM, NONE, { key: deriveEngineEncKey(DST) })).toThrow(/carries a trigger on memories/);
    expect(trig.prepare('SELECT text FROM memories').get()).toEqual({ text: 'kept' });
    trig.close();
    // The table's name in the trigger in another case: SQLite fires it all the same.
    const cased = memDb('CREATE TABLE memories (id TEXT PRIMARY KEY, text TEXT)', [['a', 'kept']]);
    cased.exec('CREATE TABLE copied (v TEXT); CREATE TRIGGER out AFTER UPDATE ON "Memories" BEGIN INSERT INTO copied VALUES (old.text); END');
    expect(() => reencryptColumns(cased, 'engine.db', MEM, NONE, { key: deriveEngineEncKey(DST) })).toThrow(/carries a trigger on Memories/);
    cased.close();
  });

  it('encrypts plaintext in a column of the set the source did not name, and leaves its ciphertext as sent', () => {
    const src = encryptStoredText('under the source key', deriveEngineEncKey(SRC));
    const db = memDb('CREATE TABLE memories (id TEXT PRIMARY KEY, text TEXT)', [['a', 'never encrypted'], ['b', src], ['c', '']]);
    const key = deriveEngineEncKey(DST);
    const counts = reencryptColumns(db, 'engine.db', [], NONE, { key });
    expect(counts).toEqual({ reencrypted: 1, failedOnSource: 0, carriedUnreadable: 1 });
    const texts = (db.prepare('SELECT text FROM memories ORDER BY rowid').all() as Array<{ text: string }>).map(r => r.text);
    expect(strictDecrypt(texts[0]!, key)).toEqual({ ok: true, kind: 'decrypted', text: 'never encrypted' });
    expect(texts.slice(1)).toEqual([src, '']);
    db.close();
  });

  it('takes a failed listing of a plaintext that only starts with enc:, as an honest source sends it', () => {
    // strictDecrypt cannot tell such a text from a corrupt ciphertext: both are `failed`.
    const db = memDb('CREATE TABLE memories (id TEXT PRIMARY KEY, text TEXT)', [['a', 'enc: see attached']]);
    const counts = reencryptColumns(db, 'engine.db', MEM, { failed: [{ table: 'memories', column: 'text', pk: ['a'] }], looksEncrypted: [] }, { key: deriveEngineEncKey(DST) });
    expect(counts).toEqual({ reencrypted: 0, failedOnSource: 1, carriedUnreadable: 0 });
    expect(db.prepare('SELECT text FROM memories').get()).toEqual({ text: 'enc: see attached' });
    db.close();
  });

  it('keeps the rowids of a table without an INTEGER PRIMARY KEY, gaps included', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE memories (text TEXT)');
    const insert = db.prepare('INSERT INTO memories (rowid, text) VALUES (?, ?)');
    for (const r of [3, 5, 100]) insert.run(r, `note ${String(r)}`);
    const image = db.serialize();
    db.close();
    const { image: out } = reencryptImage(image, 'engine.db', MEM, NONE, { key: deriveEngineEncKey(DST) });
    const back = new Database(out);
    try { expect((back.prepare('SELECT rowid AS r FROM memories ORDER BY rowid').all() as Array<{ r: number }>).map(x => x.r)).toEqual([3, 5, 100]); } finally { back.close(); }
  });

  it('refuses a value that does not read back after re-encryption', () => {
    const db = new Database(':memory:');
    db.exec("CREATE TABLE memories (id TEXT PRIMARY KEY, text TEXT); INSERT INTO memories VALUES ('a', 'x')");
    expect(() => reencryptColumns(db, 'engine.db', [{ table: 'memories', column: 'text' }], { failed: [], looksEncrypted: [] },
      { key: deriveEngineEncKey(DST), decrypt: () => ({ ok: true, kind: 'decrypted', text: 'y' }) })).toThrow(/did not read back/);
    expect(db.prepare('SELECT text FROM memories').get()).toEqual({ text: 'x' });
    db.close();
  });
});

describe('plaintext merge ledgers are re-encrypted with engine.db', () => {
  const FILE = 'merge-2026-11-16T00-00-00-000Z-abc123.json';
  const ledger = (email: string | null, phone: string | null, other: string | null) => ({
    version: 1, phase: 'merge', createdAt: '2026-11-16T00:00:00.000Z',
    entry: {
      dupId: 'd', canonicalId: 'c', kind: 'person', ownerUserId: 'u', dupArchivedAtWas: null, dupMergedIntoWas: null,
      canonicalAliasesWas: '[]', canonicalParentWasDup: false, repoints: [], memorySubjects: { dupRows: [], canonicalMemoryIdsBefore: [] }, cooccurrences: [],
      detail: { table: 'people', dupRow: { subject_id: 'd', email, phone }, canonicalRow: { subject_id: 'c', email: other, phone: '' } },
    },
    dataStore: [], threadAnchors: [], applied: true,
  });

  /** The two forms of one ledger: raw under the source key, and plaintext with its header. */
  function forms(opts: { failedOther?: boolean; unlisted?: boolean } = {}) {
    const srcKey = deriveEngineEncKey(SRC);
    const otherValue = opts.failedOther ? encryptStoredText('c@other', deriveEngineEncKey(OTHER)) : encryptStoredText('c@example.org', srcKey);
    const rawLedger = ledger(encryptStoredText('d@example.org', srcKey), encryptStoredText('+41 1', srcKey), otherValue);
    const raw = JSON.stringify({ files: { [FILE]: JSON.stringify(rawLedger, null, 2) } });
    const plainLedger = ledger(opts.unlisted ? encryptStoredText('x', srcKey) : 'd@example.org', '+41 1', opts.failedOther ? otherValue : 'c@example.org');
    const failed: ListedLedgerCell[] = opts.failedOther ? [{ file: FILE, side: 'canonicalRow', column: 'email' }] : [];
    const body = Buffer.from(JSON.stringify({ files: { [FILE]: JSON.stringify(plainLedger) } }), 'utf-8');
    return { rawBytes: Buffer.byteLength(raw), payload: encodePlainPayload({ failed, looksEncrypted: [] }, body) };
  }

  function withLedgers(src: string, payload: Buffer, rawBytes: number): Part[] {
    return [plainPart(src, 'engine.db'), { type: 'sweeps', name: 'sweeps', data: payload, meta: { ledgerForm: 'plain', ledgerRawBytes: rawBytes } }];
  }

  it('writes each ledger with its cells under the destination key, at the raw form\'s size', () => {
    const src = tmp(); const dst = tmp();
    seedStores(src, SRC);
    const { rawBytes, payload } = forms({ failedOther: true });
    const report = run(dst, withLedgers(src, payload, rawBytes));
    const written = JSON.parse(readFileSync(join(dst, 'sweeps', FILE), 'utf-8')) as ReturnType<typeof ledger>;
    const key = deriveEngineEncKey(DST);
    expect(strictDecrypt(written.entry.detail.dupRow.email!, key)).toEqual({ ok: true, kind: 'decrypted', text: 'd@example.org' });
    expect(strictDecrypt(written.entry.detail.dupRow.phone!, key)).toEqual({ ok: true, kind: 'decrypted', text: '+41 1' });
    // Failed on the source: unchanged; '' stays ''.
    expect(strictDecrypt(written.entry.detail.canonicalRow.email!, deriveEngineEncKey(OTHER))).toMatchObject({ text: 'c@other' });
    expect(written.entry.detail.canonicalRow.phone).toBe('');
    expect(report.mergeLedgersImported).toBe(1);
    expect(report.encryptedColumns!.find(r => r.what === 'merge ledgers')).toEqual({ what: 'merge ledgers', path: 'plain', reencrypted: 2, failedOnSource: 1, carriedUnreadable: 0 });
  });

  it('refuses a ledger cell listed as not decrypted that is not encrypted', () => {
    const src = tmp();
    seedStores(src, SRC);
    const body = Buffer.from(JSON.stringify({ files: { [FILE]: JSON.stringify(ledger('d@example.org', null, 'c@example.org')) } }));
    const payload = encodePlainPayload({ failed: [{ file: FILE, side: 'dupRow', column: 'email' }], looksEncrypted: [] }, body);
    const dst = tmp();
    expect(() => run(dst, withLedgers(src, payload, 1))).toThrow(/as not decrypted that is not encrypted/);
    expect(readdirSync(dst)).toEqual([]);
  });

  it('takes a ledger cell listed as not decrypted that is a plaintext starting with enc:, and leaves it', () => {
    const src = tmp(); const dst = tmp();
    seedStores(src, SRC);
    const srcKey = deriveEngineEncKey(SRC);
    const rawLedger = ledger(encryptStoredText('d@example.org', srcKey), null, 'enc: see attached');
    const rawBytes = Buffer.byteLength(JSON.stringify({ files: { [FILE]: JSON.stringify(rawLedger, null, 2) } }));
    const body = Buffer.from(JSON.stringify({ files: { [FILE]: JSON.stringify(ledger('d@example.org', null, 'enc: see attached')) } }));
    const payload = encodePlainPayload({ failed: [{ file: FILE, side: 'canonicalRow', column: 'email' }], looksEncrypted: [] }, body);
    const report = run(dst, withLedgers(src, payload, rawBytes));
    const written = JSON.parse(readFileSync(join(dst, 'sweeps', FILE), 'utf-8')) as ReturnType<typeof ledger>;
    expect(written.entry.detail.canonicalRow.email).toBe('enc: see attached');
    expect(report.encryptedColumns!.find(r => r.what === 'merge ledgers')).toMatchObject({ reencrypted: 1, failedOnSource: 1 });
  });

  it('refuses before any swap when the re-encrypted ledgers are not the declared raw size', () => {
    const src = tmp(); const dst = tmp();
    seedStores(src, SRC);
    const { rawBytes, payload } = forms();
    expect(() => run(dst, withLedgers(src, payload, rawBytes + 1))).toThrow(/the source declared/);
    expect(readdirSync(dst)).toEqual([]);
  });

  it('refuses an unlisted value that looks encrypted, and an entry that is not a merge ledger', () => {
    const src = tmp();
    seedStores(src, SRC);
    const unlisted = forms({ unlisted: true });
    const dst = tmp();
    expect(() => run(dst, withLedgers(src, unlisted.payload, unlisted.rawBytes))).toThrow(/neither decrypted nor listed/);
    expect(readdirSync(dst)).toEqual([]);
    const body = Buffer.from(JSON.stringify({ files: { [FILE]: JSON.stringify({ version: 1, phase: 'archive' }) } }));
    expect(() => run(tmp(), withLedgers(src, encodePlainPayload({ failed: [], looksEncrypted: [] }, body), 1))).toThrow(/not a merge ledger/);
  });
});

describe('the image is the source\'s and is opened as untrusted', () => {
  const NONE = { failed: [], looksEncrypted: [] };
  const MEM: PlainColumn[] = [{ table: 'memories', column: 'text' }];
  const image = (ddl: string, fill?: (db: Database.Database) => void): Buffer => {
    const db = new Database(':memory:');
    db.exec(ddl);
    fill?.(db);
    const out = db.serialize();
    db.close();
    return out;
  };
  const rekey = (img: Buffer, columns: PlainColumn[] = MEM) => reencryptImage(img, 'engine.db', columns, NONE, { key: deriveEngineEncKey(DST) });

  it('does not take a plaintext store by default; a raw one still goes through', () => {
    const src = tmp(); const dst = tmp();
    seedStores(src, SRC);
    const imp = new MigrationImporter({ lynoxDir: dst, vaultKey: DST, migrationCeiling: ROOMY });
    expect(() => imp.setManifest(bundle([plainPart(src, 'engine.db')], handshake(imp)).manifest)).toThrow(/carries a store as plaintext, which the target instance does not take yet/);
    imp.cleanup();
    const raw = new MigrationImporter({ lynoxDir: dst, vaultKey: DST, migrationCeiling: ROOMY });
    expect(() => raw.setManifest(bundle([rawPart(src, 'engine.db')], handshake(raw)).manifest)).not.toThrow();
    raw.cleanup();
    expect(readdirSync(dst)).toEqual([]);
  });

  it('runs no cascade: a child table\'s trigger does not fire on the rewrite', () => {
    const img = image(`CREATE TABLE memories (id TEXT PRIMARY KEY, text TEXT UNIQUE);
      CREATE TABLE child (ref TEXT REFERENCES memories(text) ON UPDATE CASCADE);
      CREATE TABLE fired (n INTEGER);
      CREATE TRIGGER on_child AFTER UPDATE ON child BEGIN INSERT INTO fired VALUES (1); END;
      INSERT INTO memories VALUES ('a', 'plain words'); INSERT INTO child VALUES ('plain words');`);
    const back = new Database(rekey(img).image);
    try {
      expect(back.prepare('SELECT count(*) AS n FROM fired').get()).toEqual({ n: 0 });
      expect(back.prepare('SELECT ref FROM child').get()).toEqual({ ref: 'plain words' });
    } finally { back.close(); }
  });

  it('refuses a virtual table anywhere in the image', () => {
    const img = image("CREATE TABLE memories (id TEXT PRIMARY KEY, text TEXT); CREATE VIRTUAL TABLE notes USING fts5(body); INSERT INTO memories VALUES ('a', 'x')");
    expect(() => rekey(img)).toThrow(/carries a virtual table \(notes/);
  });

  it('refuses a generated column on a table of the set', () => {
    const img = image("CREATE TABLE memories (id TEXT PRIMARY KEY, text TEXT, shout TEXT GENERATED ALWAYS AS (upper(text)) STORED); INSERT INTO memories (id, text) VALUES ('a', 'x')");
    expect(() => rekey(img)).toThrow(/has a generated or hidden column in memories/);
  });

  it.each([
    ['an expression index', 'CREATE INDEX ix ON memories (lower(text))'],
    ['a partial index', "CREATE INDEX ix ON memories (id) WHERE text <> ''"],
  ])('refuses %s on a table of the set', (_label, ddl) => {
    const img = image(`CREATE TABLE memories (id TEXT PRIMARY KEY, text TEXT); ${ddl}; INSERT INTO memories VALUES ('a', 'x')`);
    expect(() => rekey(img)).toThrow(/has an index on an expression or a partial index on memories/);
  });

  it('takes an ordinary index on a table of the set', () => {
    const img = image("CREATE TABLE memories (id TEXT PRIMARY KEY, text TEXT); CREATE INDEX ix ON memories (text); INSERT INTO memories VALUES ('a', 'x')");
    expect(rekey(img).counts.reencrypted).toBe(1);
  });

  it('refuses an image that fails its integrity check', () => {
    const img = image('CREATE TABLE memories (id TEXT PRIMARY KEY, text TEXT)', (db) => {
      const insert = db.prepare('INSERT INTO memories VALUES (?, ?)');
      for (let i = 0; i < 200; i++) insert.run(`m${String(i)}`, 'x'.repeat(100));
    });
    // A cell pointer of the last page out of range: the image opens, the check finds it.
    const last = img.length - 4096;
    img[last + 8] = 0xff; img[last + 9] = 0xff;
    expect(() => rekey(img)).toThrow(/fails its integrity check/);
    // A fault the check reports without throwing: a NULL under a NOT NULL the schema names.
    const nulled = image("CREATE TABLE memories (id TEXT PRIMARY KEY, text TEXT, note TEXT); INSERT INTO memories VALUES ('a', 'x', NULL)", (db) => {
      db.unsafeMode(true);
      db.pragma('writable_schema = ON');
      db.prepare("UPDATE sqlite_master SET sql = 'CREATE TABLE memories (id TEXT PRIMARY KEY, text TEXT, note TEXT NOT NULL)' WHERE name = 'memories'").run();
      db.pragma('writable_schema = OFF');
    });
    expect(() => rekey(nulled)).toThrow(/fails its integrity check/);
  });

  it('names the set in lower case, so a name from the image compares in lower case', () => {
    for (const store of ['engine.db', 'history.db'] as const) {
      for (const [table, cols] of PLAIN_COLUMNS[store]) {
        expect(table).toBe(table.toLowerCase());
        for (const c of cols) expect(c).toBe(c.toLowerCase());
      }
    }
  });

  it('carries nothing of the free space the image arrived with', () => {
    const img = image("CREATE TABLE memories (id TEXT PRIMARY KEY, text TEXT); INSERT INTO memories VALUES ('a', 'kept')", (db) => {
      db.prepare('INSERT INTO memories VALUES (?, ?)').run('gone', `freespace-needle-${'y'.repeat(6000)}`);
      db.prepare("DELETE FROM memories WHERE id = 'gone'").run();
    });
    // The control: the deleted plaintext is still in the arriving image.
    expect(img.includes('freespace-needle')).toBe(true);
    const out = rekey(img).image;
    expect(out.includes('freespace-needle')).toBe(false);
    const back = new Database(out);
    try { expect(back.pragma('freelist_count', { simple: true })).toBe(0); } finally { back.close(); }
  });

  it('evaluates nothing of a table outside the set when it copies the image, and fires no trigger there', () => {
    // An expression that throws when SQLite evaluates it, put in through the schema text as a
    // source could: an expression index, a partial index, a CHECK and a DEFAULT on a table outside
    // the set, and a trigger there. Neither `quick_check` (CHECK off) nor the `VACUUM INTO` copy
    // evaluates them.
    const BOOM = 'abs(-9223372036854775808)';
    const img = image(`CREATE TABLE memories (id TEXT PRIMARY KEY, text TEXT);
      CREATE TABLE other (a INT CHECK (a > 0), b INT DEFAULT 1);
      CREATE INDEX by_expr ON other (a + 1); CREATE INDEX by_part ON other (a) WHERE a > 0;
      CREATE TABLE fired (n INT);
      CREATE TRIGGER on_other AFTER INSERT ON other BEGIN INSERT INTO fired VALUES (1); END;
      INSERT INTO memories VALUES ('m', 'plain words'); INSERT INTO other (a) VALUES (1), (2); DELETE FROM fired;`, (db) => {
      db.unsafeMode(true);
      db.pragma('writable_schema = ON');
      const set = db.prepare('UPDATE sqlite_master SET sql = ? WHERE name = ?');
      set.run(`CREATE TABLE other (a INT CHECK (a > ${BOOM}), b INT DEFAULT (${BOOM}))`, 'other');
      set.run(`CREATE INDEX by_expr ON other (a + ${BOOM})`, 'by_expr');
      set.run(`CREATE INDEX by_part ON other (a) WHERE a > ${BOOM}`, 'by_part');
      db.pragma('writable_schema = OFF');
    });
    const { image: out, counts } = rekey(img);
    expect(counts.reencrypted).toBe(1);
    const back = new Database(out);
    try {
      expect(back.prepare('SELECT count(*) AS n FROM fired').get()).toEqual({ n: 0 });
      expect(back.prepare('SELECT count(*) AS n FROM other').get()).toEqual({ n: 2 });
      // The control: the same schema evaluates its expressions on a write, and throws.
      expect(() => back.prepare('INSERT INTO other (a) VALUES (5)').run()).toThrow(/integer overflow/);
    } finally { back.close(); }
  });

  it.each(['STORED', 'VIRTUAL'])('refuses a %s generated column on a table outside the set, before anything reads it', (kind) => {
    const BOOM = 'abs(-9223372036854775808)';
    const img = image(`CREATE TABLE memories (id TEXT PRIMARY KEY, text TEXT); CREATE TABLE other (a INT, g INT GENERATED ALWAYS AS (a + 1) ${kind});
      INSERT INTO memories VALUES ('m', 'x'); INSERT INTO other (a) VALUES (1);`, (db) => {
      db.unsafeMode(true);
      db.pragma('writable_schema = ON');
      db.prepare('UPDATE sqlite_master SET sql = ? WHERE name = ?').run(`CREATE TABLE other (a INT, g INT GENERATED ALWAYS AS (a + ${BOOM}) ${kind})`, 'other');
      db.pragma('writable_schema = OFF');
    });
    expect(() => rekey(img)).toThrow(/has a generated or hidden column in other/);
  });

  it('refuses a generated column on a table the schema text names with SQLite\'s prefix', () => {
    const img = image("CREATE TABLE memories (id TEXT PRIMARY KEY, text TEXT); CREATE TABLE x (a INT, g INT GENERATED ALWAYS AS (a + 1) VIRTUAL); INSERT INTO memories VALUES ('m', 'x'); INSERT INTO x (a) VALUES (1);", (db) => {
      db.unsafeMode(true);
      db.pragma('writable_schema = ON');
      db.prepare("UPDATE sqlite_master SET name = 'sqlite_x', tbl_name = 'sqlite_x', sql = 'CREATE TABLE sqlite_x (a INT, g INT GENERATED ALWAYS AS (a + abs(-9223372036854775808)) VIRTUAL)' WHERE name = 'x'").run();
      db.pragma('writable_schema = OFF');
    });
    expect(() => rekey(img)).toThrow(/has a generated or hidden column in sqlite_x/);
  });

  it('takes SQLite\'s own tables', () => {
    const img = image("CREATE TABLE memories (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT); INSERT INTO memories (text) VALUES ('x'); CREATE INDEX by_text ON memories (text); ANALYZE;");
    expect(rekey(img).counts.reencrypted).toBe(1);
  });

  it('lets no view of the source call a function the connection registers', () => {
    const img = image("CREATE TABLE memories (id TEXT PRIMARY KEY, text TEXT); CREATE TABLE other (a INT); CREATE VIEW v AS SELECT leak(a) AS x FROM other; INSERT INTO memories VALUES ('m', 'x'); INSERT INTO other VALUES (1);");
    let outcome = '';
    reencryptImage(img, 'engine.db', MEM, NONE, {
      key: deriveEngineEncKey(DST),
      onOpen: (db) => {
        db.function('leak', (a: unknown) => a);
        try { db.prepare('SELECT x FROM v').all(); outcome = 'ran'; } catch (err) { outcome = (err as Error).message; }
      },
    });
    expect(outcome).toMatch(/unsafe use of leak/);
  });

  it('removes a scratch directory an earlier import left behind', () => {
    const src = tmp(); const dst = tmp();
    seedStores(src, SRC);
    mkdirSync(join(dst, '.rekey-left'));
    writeFileSync(join(dst, '.rekey-left', 'image.db'), 'enc:left over');
    run(dst, [plainPart(src, 'engine.db')]);
    expect(readdirSync(dst).filter((e) => e.startsWith('.rekey-'))).toEqual([]);
  });

  it('leaves no scratch file behind', () => {
    const dir = tmp();
    const img = image("CREATE TABLE memories (id TEXT PRIMARY KEY, text TEXT); INSERT INTO memories VALUES ('a', 'x')");
    reencryptImage(img, 'engine.db', MEM, NONE, { key: deriveEngineEncKey(DST), scratchDir: dir });
    expect(readdirSync(dir)).toEqual([]);
  });

  describe('a column named in another case is the same column', () => {
    it('refuses a column marked absent that the image has in another case', () => {
      const img = image("CREATE TABLE memories (id TEXT PRIMARY KEY, TEXT TEXT); INSERT INTO memories VALUES ('a', 'plain words')");
      expect(() => rekey(img, [{ table: 'memories', column: 'text', absent: true }])).toThrow(/as absent, but its image has that column/);
    });

    it('encrypts a column of the set the source did not name, in another case', () => {
      const img = image("CREATE TABLE memories (id TEXT PRIMARY KEY, TEXT TEXT); INSERT INTO memories VALUES ('a', 'plain words')");
      const { image: out, counts } = rekey(img, []);
      expect(counts.reencrypted).toBe(1);
      const back = new Database(out);
      try { expect(strictDecrypt((back.prepare('SELECT TEXT AS v FROM memories').get() as { v: string }).v, deriveEngineEncKey(DST))).toMatchObject({ ok: true, text: 'plain words' }); } finally { back.close(); }
    });

    it('checks such a column after the rewrite, a row the paging does not reach included', () => {
      const img = image('CREATE TABLE memories (id TEXT PRIMARY KEY, TEXT TEXT)', (db) => {
        db.prepare('INSERT INTO memories (rowid, id, TEXT) VALUES (0, ?, ?)').run('z', 'at rowid 0');
      });
      expect(() => rekey(img, [])).toThrow(/still holds 1 unencrypted value/);
    });

    it('counts the encrypted values of a raw store in such a column', () => {
      const dir = tmp();
      const db = new Database(join(dir, 'engine.db'));
      db.exec('CREATE TABLE memories (id TEXT PRIMARY KEY, TEXT TEXT)');
      db.prepare('INSERT INTO memories VALUES (?, ?)').run('a', encryptStoredText('x', deriveEngineEncKey(SRC)));
      db.close();
      expect(countEncryptedPlainColumns(join(dir, 'engine.db'), 'engine.db')).toBe(1);
    });

    const ledgerFile = (detail: Record<string, unknown>): Record<string, unknown> => ({
      'merge-x.json': JSON.stringify({ version: 1, phase: 'merge', entry: { detail } }),
    });
    it('refuses a ledger that names its table in another case', () => {
      expect(() => reencryptLedgers(ledgerFile({ table: 'People', dupRow: { email: 'd@example.org' } }), NONE, { key: deriveEngineEncKey(DST) }))
        .toThrow(/names its table in another case/);
    });
    it('refuses a ledger that names a contact column in another case', () => {
      expect(() => reencryptLedgers(ledgerFile({ table: 'people', dupRow: { EMAIL: 'd@example.org' } }), NONE, { key: deriveEngineEncKey(DST) }))
        .toThrow(/names a contact column in another case/);
    });
  });
});

// ── The source half, through the real exporter ──

describe('the source sends its stores as plaintext when the destination takes them', () => {
  const FILE = 'merge-2026-11-16T00-00-00-000Z-abc123.json';
  /** A merge ledger as the merge runner writes it, with its contact cells under `key` (or `plainEmail` left in plain). */
  function writeLedger(dir: string, key: Buffer, opts: { plainEmail?: boolean } = {}): void {
    mkdirSync(join(dir, 'sweeps'), { recursive: true });
    const ledger = {
      version: 1, phase: 'merge', createdAt: '2026-11-16T00:00:00.000Z',
      entry: {
        dupId: 'd', canonicalId: 'c', kind: 'person', ownerUserId: 'u', dupArchivedAtWas: null, dupMergedIntoWas: null,
        canonicalAliasesWas: '[]', canonicalParentWasDup: false, repoints: [], memorySubjects: { dupRows: [], canonicalMemoryIdsBefore: [] }, cooccurrences: [],
        detail: { table: 'people', dupRow: { subject_id: 'd', email: opts.plainEmail ? 'd@example.org' : encryptStoredText('d@example.org', key), phone: encryptStoredText('+41 1', key) }, canonicalRow: { subject_id: 'c', email: encryptStoredText('c@example.org', key), phone: '' } },
      },
      dataStore: [], threadAnchors: [], applied: true,
    };
    writeFileSync(join(dir, 'sweeps', FILE), JSON.stringify(ledger, null, 2));
  }

  /** Export from `src` with `options`, import into `dst`; the manifest and both reports. */
  function migrate(src: string, dst: string, options: Parameters<MigrationExporter['export']>[2], ceiling: MigrationCeiling = ROOMY) {
    const imp = importer(dst, ceiling);
    const exporter = new MigrationExporter({ lynoxDir: src, vaultKey: SRC });
    const exported = exporter.export(handshake(imp), undefined, options);
    imp.setManifest(exported.manifest);
    for (const c of exported.chunks) imp.receiveChunk(c);
    try { return { manifest: exported.manifest, source: exported.plain, report: imp.restore() }; } finally { imp.cleanup(); }
  }
  const typeOf = (m: MigrationManifest, store: string): string | undefined => m.chunks.find(c => c.name === store || c.name === `${store}:part0`)?.type;

  it('decrypts the set in memory and the destination reads every value back under its own key', () => {
    const src = tmp(); const dst = tmp();
    const written = seedStores(src, SRC);
    writeLedger(src, keyOf('engine.db', SRC));
    const { manifest, source, report } = migrate(src, dst, { plain: { ceiling: ROOMY } });

    expect(typeOf(manifest, 'engine.db')).toBe('sqlite_db_plain');
    expect(typeOf(manifest, 'history.db')).toBe('sqlite_db_plain');
    expect(manifest.chunks.find(c => c.type === 'sweeps')?.ledgerForm).toBe('plain');
    for (const store of ['engine.db', 'history.db'] as const) {
      for (const [table, cols] of PLAIN_COLUMNS[store]) {
        for (const column of cols) {
          const rows = written.get(`${store}:${table}.${column}`);
          if (!rows) continue;
          const stored = readColumn(dst, store, table, column);
          rows.forEach((r, i) => {
            if (r.kind === 'plain' || r.kind === 'notnull') expect(strictDecrypt(stored[i] as string, keyOf(store, DST)), `${store} ${table}.${column}`).toEqual({ ok: true, kind: 'decrypted', text: r.text });
          });
        }
      }
    }
    const ledger = JSON.parse(readFileSync(join(dst, 'sweeps', FILE), 'utf-8')) as { entry: { detail: { dupRow: { email: string } } } };
    expect(strictDecrypt(ledger.entry.detail.dupRow.email, keyOf('engine.db', DST))).toEqual({ ok: true, kind: 'decrypted', text: 'd@example.org' });
    // The source's counts: what decrypted and what did not, per store.
    const count = (store: PlainStore, kinds: Array<Row['kind']>): number => [...PLAIN_COLUMNS[store]]
      .flatMap(([t, cs]) => [...cs].flatMap(c => written.get(`${store}:${t}.${c}`) ?? [])).filter(r => kinds.includes(r.kind)).length;
    expect(source?.stores).toEqual([
      { store: 'engine.db', path: 'plain', decrypted: count('engine.db', ['plain', 'notnull']), failed: count('engine.db', ['other']) },
      { store: 'history.db', path: 'plain', decrypted: count('history.db', ['plain', 'notnull']), failed: count('history.db', ['other']) },
    ]);
    expect(source?.ledgers).toEqual({ path: 'plain', decrypted: 3, failed: 0 });
    expect(report.encryptedColumns?.find(r => r.what === 'engine.db')).toMatchObject({ path: 'plain', failedOnSource: count('engine.db', ['other']) });
  });

  it('sends every store raw, as today, when the destination does not take plaintext', () => {
    const src = tmp(); const dst = tmp();
    seedStores(src, SRC);
    writeLedger(src, keyOf('engine.db', SRC));
    const { manifest, source } = migrate(src, dst, undefined);
    expect(typeOf(manifest, 'engine.db')).toBe('sqlite_db');
    expect(typeOf(manifest, 'history.db')).toBe('sqlite_db');
    expect(manifest.chunks.find(c => c.type === 'sweeps')?.ledgerForm).toBeUndefined();
    expect(source).toBeUndefined();
  });

  it('sends a store raw when the destination\'s numbers say it does not fit, and the destination takes that choice', () => {
    const src = tmp(); const dst = tmp();
    seedStores(src, SRC);
    const tight: MigrationCeiling = { import_limit_mb: 0.5, baseline_mb: 0, k: 1, rest_factor: 0 };
    const { manifest, source } = migrate(src, dst, { plain: { ceiling: tight } }, tight);
    expect(typeOf(manifest, 'engine.db')).toBe('sqlite_db');
    expect(source?.stores.find(s => s.store === 'engine.db')).toMatchObject({ path: 'raw', reason: 'memory' });
  });

  it('sends engine.db raw together with its ledgers when the ledgers cannot take the plaintext form', () => {
    const src = tmp(); const dst = tmp();
    seedStores(src, SRC);
    // A cell in plain in the raw ledger: re-encrypted on the destination it would no longer match the raw size.
    writeLedger(src, keyOf('engine.db', SRC), { plainEmail: true });
    const { manifest, source } = migrate(src, dst, { plain: { ceiling: ROOMY } });
    expect(typeOf(manifest, 'engine.db')).toBe('sqlite_db');
    expect(typeOf(manifest, 'history.db')).toBe('sqlite_db_plain');
    expect(manifest.chunks.find(c => c.type === 'sweeps')?.ledgerForm).toBeUndefined();
    expect(source?.stores.find(s => s.store === 'engine.db')).toMatchObject({ path: 'raw', reason: 'ledgers' });
    expect(source?.ledgers?.path).toBe('raw');
  });

  it('exports after an export that was killed left its snapshot file behind', () => {
    const src = tmp(); const dst = tmp();
    seedStores(src, SRC);
    writeFileSync(join(src, 'engine.db.migration-tmp'), 'left behind');
    const { manifest } = migrate(src, dst, { plain: { ceiling: ROOMY } });
    expect(typeOf(manifest, 'engine.db')).toBe('sqlite_db_plain');
    expect(existsSync(join(src, 'engine.db.migration-tmp'))).toBe(false);
  });

  it('writes no plaintext of the set to a file on the source', () => {
    const src = tmp(); const dst = tmp();
    seedStores(src, SRC);
    const started = Date.now() - 1000;
    migrate(src, dst, { plain: { ceiling: ROOMY } });
    const canary = Buffer.from('secret one');
    const hits: string[] = [];
    const scan = (dir: string, depth: number): void => {
      let names: string[];
      try { names = readdirSync(dir); } catch { return; }
      for (const n of names) {
        const p = join(dir, n);
        let st;
        try { st = statSync(p); } catch { continue; }
        if (st.isDirectory()) { if (depth > 0 && p !== dst) scan(p, depth - 1); continue; }
        if (!st.isFile() || st.mtimeMs < started || st.size > 64 * MIB) continue;
        try { if (readFileSync(p).includes(canary)) hits.push(p); } catch { /* unreadable */ }
      }
    };
    scan(src, 3);
    scan(tmpdir(), 1);
    expect(hits).toEqual([]);
    // Control: the destination's stores hold the same values, as ciphertext; the source's snapshot form would show them.
    const control = rewriteStoreForPlain(readFileSync(join(src, 'engine.db')), 'engine.db', { key: keyOf('engine.db', SRC) });
    expect(control.payload.includes(canary)).toBe(true);
  });
});

describe('the source\'s rewrite of a store image', () => {
  it('names a table or column of the set that the image lacks as absent, and rewrites the rest', () => {
    const src = tmp();
    seedStores(src, SRC);
    const d = new Database(join(src, 'engine.db'));
    d.exec('DROP TABLE entry_sources');
    d.close();
    const r = rewriteStoreForPlain(readFileSync(join(src, 'engine.db')), 'engine.db', { key: keyOf('engine.db', SRC) });
    expect(r.columns).toContainEqual({ table: 'entry_sources', column: 'text', absent: true });
    expect(r.columns).toContainEqual({ table: 'memories', column: 'text' });
    expect(r.columns.filter(c => c.absent)).toHaveLength(1);
  });
});

describe('the source chooses each store\'s path the way the destination judges it', () => {
  const at = (mb: number): number => mb * MIB;
  const base = (over: Partial<Parameters<typeof choosePlainPaths>[0]> = {}): Parameters<typeof choosePlainPaths>[0] => ({
    ceiling: { import_limit_mb: 100, baseline_mb: 0, k: 2, rest_factor: 0 },
    stores: [{ store: 'engine.db', plainBytes: at(10), rawBytes: at(10) }, { store: 'history.db', plainBytes: at(10), rawBytes: at(10) }],
    otherBytes: 0, otherDatabaseBytes: 0, sweeps: null, sweepsCapBytes: 64 * MIB, ...over,
  });

  it('takes the plaintext path just under the bound and the raw path just over', () => {
    // bundle 20 + (k-1) * 10 = 30 MiB.
    expect(choosePlainPaths(base({ ceiling: { import_limit_mb: 30, baseline_mb: 0, k: 2, rest_factor: 0 } })).get('engine.db')).toEqual({ path: 'plain' });
    expect(choosePlainPaths(base({ ceiling: { import_limit_mb: 29.99, baseline_mb: 0, k: 2, rest_factor: 0 } })).get('engine.db')).toEqual({ path: 'raw', reason: 'memory' });
  });

  it('moves one store to the raw path and keeps the other on the plaintext path when that fits', () => {
    const paths = choosePlainPaths(base({
      ceiling: { import_limit_mb: 60, baseline_mb: 0, k: 2, rest_factor: 0 },
      stores: [{ store: 'engine.db', plainBytes: at(40), rawBytes: at(5) }, { store: 'history.db', plainBytes: at(5), rawBytes: at(5) }],
    }));
    expect(paths.get('engine.db')).toEqual({ path: 'raw', reason: 'memory' });
    expect(paths.get('history.db')).toEqual({ path: 'plain' });
  });

  it('keeps engine.db raw when its ledgers have no plaintext form or exceed the sweeps cap', () => {
    expect(choosePlainPaths(base({ sweeps: { rawBytes: 10, plainBytes: null } })).get('engine.db')).toEqual({ path: 'raw', reason: 'ledgers' });
    expect(choosePlainPaths(base({ sweeps: { rawBytes: 10, plainBytes: 64 * MIB + 1 } })).get('engine.db')).toEqual({ path: 'raw', reason: 'ledgers' });
    expect(choosePlainPaths(base({ sweeps: { rawBytes: 10, plainBytes: 64 * MIB } })).get('engine.db')).toEqual({ path: 'plain' });
  });

  it('counts the ledgers at the larger of their two forms in the bundle, as the destination does', () => {
    // Raw ledgers 10 MiB, their plaintext form 1 MiB. Bundle with the raw size: 10 + 10 + 10 = 30, rest 10;
    // peak = 30 + 10 + (k - 1) * 10 = 50 at k 2. Counted at the travelling form it would read 41.
    const sweeps = { rawBytes: at(10), plainBytes: at(1) };
    const ceiling = (limit: number) => ({ import_limit_mb: limit, baseline_mb: 0, k: 2, rest_factor: 1 });
    expect(choosePlainPaths(base({ ceiling: ceiling(50), sweeps })).get('engine.db')).toEqual({ path: 'plain' });
    expect(choosePlainPaths(base({ ceiling: ceiling(49.9), sweeps })).get('engine.db')).toEqual({ path: 'raw', reason: 'memory' });
  });

  it('a store without a plaintext form takes the raw path', () => {
    expect(choosePlainPaths(base({ stores: [{ store: 'history.db', plainBytes: null, rawBytes: 1 }] })).get('history.db')).toEqual({ path: 'raw', reason: 'no-plain-form' });
  });
});

describe('the source reads the destination\'s offer as untrusted input', () => {
  const health = { migration: { import_limit_mb: 1536, baseline_mb: 191, k: 7.1, rest_factor: 1.944 } };
  it('takes the plaintext path only on acceptsPlainStores === true and four finite numbers above 0', () => {
    expect(plainOffer({ acceptsPlainStores: true }, health)).toEqual(health.migration);
    for (const flag of [undefined, false, 'true', 1, null]) expect(plainOffer({ acceptsPlainStores: flag }, health), String(flag)).toBeNull();
    expect(plainOffer(null, health)).toBeNull();
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '7', null, undefined]) {
      expect(plainOffer({ acceptsPlainStores: true }, { migration: { ...health.migration, k: bad } }), String(bad)).toBeNull();
    }
    expect(plainOffer({ acceptsPlainStores: true }, {})).toBeNull();
    expect(plainOffer({ acceptsPlainStores: true }, null)).toBeNull();
  });

  it('reads the health body within its size cap and its timeout, and nothing else', async () => {
    const ok = (body: string, status = 200) => async (): Promise<Response> => new Response(body, { status });
    expect(await readDestinationHealth(ok(JSON.stringify(health)), 'https://t')).toEqual(health);
    expect(await readDestinationHealth(ok('{not json'), 'https://t')).toBeNull();
    expect(await readDestinationHealth(ok(JSON.stringify(health), 503), 'https://t')).toBeNull();
    expect(await readDestinationHealth(ok(`{"pad":"${'x'.repeat(MAX_HEALTH_BYTES)}"}`), 'https://t')).toBeNull();
    // Just under the cap still reads.
    const under = `{"pad":"${'x'.repeat(MAX_HEALTH_BYTES - 20)}"}`;
    expect(await readDestinationHealth(ok(under), 'https://t')).toEqual(JSON.parse(under));
    expect(await readDestinationHealth(async () => { throw new Error('connect'); }, 'https://t')).toBeNull();
    // A destination that accepts the connection and never answers: the timeout ends the wait.
    const hang = (_u: string, init: RequestInit): Promise<Response> => new Promise((_, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    });
    expect(await readDestinationHealth(hang, 'https://t', 50)).toBeNull();
  });

  it('the destination answers its handshake with whether it takes plaintext stores', () => {
    const d = tmp();
    expect(new MigrationImporter({ lynoxDir: d, vaultKey: DST }).startHandshake(TOKEN).acceptsPlainStores).toBe(false);
    expect(new MigrationImporter({ lynoxDir: tmp(), vaultKey: DST, acceptPlainStores: true }).startHandshake(TOKEN).acceptsPlainStores).toBe(true);
  });
});
