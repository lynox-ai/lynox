import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash, createHmac, hkdfSync } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  BULK_MAX_TARGET_BYTES, BULK_MAX_TARGETS, BULK_MAX_TOTAL_BYTES, BulkSourceError,
  parseCsv, parseSourceText, planDataStore, planWorkspace, readBulkImage, rowsToSource,
} from './bulk-plan.js';
import type { WorkspaceAccess } from './bulk-plan.js';
import { BULK_MAX_PREVIEWED_RUNS, BulkLedger } from './bulk-ledger.js';
import type { PlannedTarget } from './bulk-ledger.js';
import { EngineDb } from './engine-db.js';
import { DataStore } from './data-store.js';
import type { MemoryScopeRef } from '../types/index.js';

/** Bounds, reasons and ledger behaviour of the bulk dry run, driven below the tool. */

const scope: MemoryScopeRef = { type: 'context', id: 'bulk-plan-test' };
let dir: string;

beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), 'lynox-bulkplan-'))); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

/** A workspace that exists only in memory: path = `/ws/<target>`, content from `files`. */
function fakeAccess(files: Record<string, string>): WorkspaceAccess {
  return {
    resolve: (t) => (t.startsWith('..') ? null : `/ws/${t}`),
    read: (p) => {
      const v = files[p.slice('/ws/'.length)];
      return v === undefined ? { absent: true } : { absent: false, value: v };
    },
  };
}

const reasons = (targets: PlannedTarget[]): (string | null)[] => targets.map((t) => ('invalid' in t ? t.invalid : null));

describe('source parsing', () => {
  it('stops a CSV at the target cap instead of parsing the whole source', () => {
    // The tail is malformed: a parser that read to the end and checked the quote first would
    // report it, one that stops at the cap never reaches it. Limit: a parser that read to
    // the end and checked the cap before the quote passes too — the memory it spent is not
    // observable from here.
    const csv = 'target,after\n' + 'a,b\n'.repeat(BULK_MAX_TARGETS + 1) + '"unterminated';
    expect(() => parseCsv(csv)).toThrow(`more than ${String(BULK_MAX_TARGETS)} targets`);
    expect(() => parseCsv('target,after\n' + 'a,b\n'.repeat(BULK_MAX_TARGETS))).not.toThrow();
  });

  it('does not count blank lines toward the cap', () => {
    const csv = 'target,after\n' + 'a,b\n\n\n'.repeat(BULK_MAX_TARGETS);
    expect(parseCsv(csv)).toHaveLength(BULK_MAX_TARGETS);
  });

  it('refuses a JSON array over the cap before inspecting its elements', () => {
    // Numbers, not objects: an element check that ran first would answer "array of objects".
    const json = JSON.stringify(Array.from({ length: BULK_MAX_TARGETS + 1 }, (_, i) => i));
    expect(() => parseSourceText(json, 'json')).toThrow(`more than ${String(BULK_MAX_TARGETS)} targets`);
  });

  it('refuses a source over the size cap', () => {
    expect(() => parseSourceText(' '.repeat(5 * 1024 * 1024 + 1), 'json')).toThrow('larger than 5 MB');
  });

  it('strips a byte-order mark from JSON as from CSV', () => {
    expect(parseSourceText('﻿[{"target":"a","after":"b"}]', 'json')).toEqual([{ target: 'a', after: 'b' }]);
    expect(parseSourceText('﻿target,after\na,b', 'csv')).toEqual([{ target: 'a', after: 'b' }]);
  });

  it('refuses a CSV header that names a column twice', () => {
    expect(() => parseCsv('target,price,price\na,1,2')).toThrow(BulkSourceError);
  });

  it('takes a number or boolean target as its text', () => {
    expect(rowsToSource([{ target: 12, after: {} }, { target: true, after: {} }]).map((r) => r.target)).toEqual(['12', 'true']);
  });
});

describe('planWorkspace bounds and reasons', () => {
  it('marks an after-state over the per-target cap too large', () => {
    const planned = planWorkspace([{ target: 'a', after: 'x'.repeat(BULK_MAX_TARGET_BYTES) }], fakeAccess({}));
    expect(reasons(planned)).toEqual(['target_too_large']);
  });

  it('refuses a plan whose after-states exceed the total cap', () => {
    const size = BULK_MAX_TARGET_BYTES - 16;
    const n = Math.ceil(BULK_MAX_TOTAL_BYTES / size) + 1;
    const source = Array.from({ length: n }, (_, i) => ({ target: `f${String(i)}`, after: 'y'.repeat(size) }));
    expect(() => planWorkspace(source, fakeAccess({}))).toThrow('in total');
  });

  it('counts before-images at their serialized size against the total cap', () => {
    // 40 existing files of 256 KB control characters: 10 MB on disk, ~60 MB as JSON. A
    // budget that counted raw bytes, or skipped before-images, would let this through.
    const body = '\u0001'.repeat(256 * 1024);
    const files: Record<string, string> = {};
    const source = Array.from({ length: 40 }, (_, i) => { files[`f${String(i)}`] = body; return { target: `f${String(i)}`, after: 'x' }; });
    expect(() => planWorkspace(source, fakeAccess(files))).toThrow('in total');
    expect(() => planWorkspace(source.slice(0, 4), fakeAccess(files))).not.toThrow();
  });

  it('counts target keys against the total cap', () => {
    // Invalid targets keep the source's text as their key; 40 keys of 1 MB are 40 MB.
    const source = Array.from({ length: 40 }, (_, i) => ({ target: `../${'k'.repeat(1024 * 1024)}${String(i)}`, after: 'x' }));
    expect(() => planWorkspace(source, fakeAccess({}))).toThrow('in total');
  });

  it('marks a non-text after-state and an unreadable target by reason', () => {
    const access = fakeAccess({});
    const planned = planWorkspace([
      { target: 'obj', after: { not: 'text' } },
      { target: 'dir', after: 'x' },
    ], { ...access, read: (p) => { if (p.endsWith('dir')) throw new Error('EISDIR'); return access.read(p); } });
    expect(reasons(planned)).toEqual(['after_not_text', 'unreadable']);
  });

  it('refuses a plan that names the same invalid target twice', () => {
    expect(() => planWorkspace([{ target: '../x', after: 'a' }, { target: '../x', after: 'b' }], fakeAccess({})))
      .toThrow('same target more than once');
  });
});

describe('readBulkImage', () => {
  it('marks bytes that are not UTF-8 as not text rather than decoding them', () => {
    writeFileSync(join(dir, 'latin1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9]));
    expect(readBulkImage(join(dir, 'latin1.txt'), 1024)).toBe('not_text');
  });

  it('keeps valid UTF-8 beyond ASCII, a byte-order mark and an empty file as text', () => {
    writeFileSync(join(dir, 'utf8.txt'), 'café ✓');
    writeFileSync(join(dir, 'bom.txt'), '\ufeffx');
    writeFileSync(join(dir, 'empty.txt'), '');
    expect(readBulkImage(join(dir, 'utf8.txt'), 1024)).toEqual({ absent: false, value: 'café ✓' });
    expect(readBulkImage(join(dir, 'bom.txt'), 1024)).toEqual({ absent: false, value: '\ufeffx' });
    expect(readBulkImage(join(dir, 'empty.txt'), 1024)).toEqual({ absent: false, value: '' });
  });

  it('refuses a directory', () => {
    mkdirSync(join(dir, 'd'));
    expect(() => readBulkImage(join(dir, 'd'), 1024)).toThrow('not a regular file');
  });

  it('does not block on a FIFO', () => {
    const fifo = join(dir, 'pipe');
    execFileSync('mkfifo', [fifo]);
    expect(() => readBulkImage(fifo, 1024)).toThrow('not a regular file');
  });
});

describe('planDataStore', () => {
  let store: DataStore;
  beforeEach(() => { store = new DataStore(join(dir, 'ds.db')); });
  afterEach(() => { store.close(); });

  function products(n: number): void {
    store.createCollection({
      name: 'products', scope, uniqueKey: ['sku'],
      columns: [{ name: 'sku', type: 'string' }, { name: 'price', type: 'number' }],
    });
    for (let i = 0; i < n; i += 100) {
      store.insertRecords({
        collection: 'products',
        records: Array.from({ length: Math.min(100, n - i) }, (_, j) => ({ sku: `S${String(i + j)}`, price: 1 })),
      });
    }
  }

  it('finds before-images past the first lookup batch', () => {
    products(600);
    const source = Array.from({ length: 600 }, (_, i) => ({ target: `S${String(i)}`, after: { price: 2 } }));
    const last = planDataStore(source, store, 'products')[599]!;
    expect(last).toMatchObject({ key: 'S599', before: { absent: false, value: { sku: 'S599', price: 1 } } });
  });

  it('refuses to null the key column, and a key the column cannot hold', () => {
    products(1);
    store.createCollection({ name: 'nums', scope, uniqueKey: ['n'], columns: [{ name: 'n', type: 'number' }] });
    expect(reasons(planDataStore([
      { target: 'S0', after: { sku: null } },
      { target: 'S0x', after: { sku: 'other' } },
    ], store, 'products'))).toEqual(['bad_key', 'bad_key']);
    expect(reasons(planDataStore([{ target: 'abc', after: {} }], store, 'nums'))).toEqual(['bad_key']);
  });

  it('reads an empty cell in a typed column as no value', () => {
    products(1);
    const [t] = planDataStore([{ target: 'S0', after: { price: '' } }], store, 'products');
    expect(t).toMatchObject({ after: { sku: 'S0', price: null } });
  });

  it('counts target keys against the total cap', () => {
    // A number key the column cannot hold stays invalid with the source's text as its key,
    // so only the keys are charged: 40 keys of 1 MB. (For a valid target the key is also
    // inside its after-row, so keys alone cannot be isolated there.)
    store.createCollection({ name: 'nums', scope, uniqueKey: ['n'], columns: [{ name: 'n', type: 'number' }] });
    const source = Array.from({ length: 40 }, (_, i) => ({ target: `${'x'.repeat(1024 * 1024)}${String(i)}`, after: {} }));
    expect(() => planDataStore(source, store, 'nums')).toThrow('in total');
  });

  it('refuses a missing collection and a subject-keyed one', () => {
    store.createCollection({
      name: 'people', scope, uniqueKey: ['who'],
      columns: [{ name: 'who', type: 'subject', subjectKind: 'person' }],
    });
    expect(() => planDataStore([{ target: 'a', after: {} }], store, 'nope')).toThrow('does not exist');
    expect(() => planDataStore([{ target: 'a', after: {} }], store, 'people')).toThrow('subject column');
  });
});

describe('BulkLedger', () => {
  let engineDb: EngineDb;
  let ledger: BulkLedger;
  beforeEach(() => { engineDb = new EngineDb(join(dir, 'engine.db'), 'key-one'); ledger = new BulkLedger(engineDb); });
  afterEach(() => { engineDb.close(); });

  const record = (targets: PlannedTarget[]): string =>
    ledger.recordDryRun({ createdBy: 't', targetSystem: 'workspace', scope: 'workspace', targets }).id;
  const one = (key: string, after = 'x'): PlannedTarget[] => [{ key, before: { absent: true }, after }];
  const hashOf = (id: string): string =>
    (engineDb.getDb().prepare('SELECT rule_hash FROM bulk_runs WHERE id = ?').get(id) as { rule_hash: string }).rule_hash;

  it('prunes only previews: an older run in another phase survives', () => {
    engineDb.getDb().prepare(
      "INSERT INTO bulk_runs (id, created_at, rule_hash, target_system, undo, phase) VALUES ('approved-1', '2000-01-01 00:00:00', 'h', 'workspace', 'restorable', 'approved')",
    ).run();
    for (let i = 0; i < BULK_MAX_PREVIEWED_RUNS + 2; i++) record(one(`p${String(i)}`));
    expect(ledger.getStatus('approved-1')?.phase).toBe('approved');
  });

  it('keeps only the newest unapproved previews, newest first', () => {
    const ids = Array.from({ length: BULK_MAX_PREVIEWED_RUNS + 2 }, (_, i) => record(one(`k${String(i)}`)));
    const listed = ledger.listRuns(50).map((r) => r.id);
    expect(listed).toEqual(ids.slice(-BULK_MAX_PREVIEWED_RUNS).reverse());
    expect(ledger.listRuns(3)).toHaveLength(3);
    const orphans = engineDb.getDb().prepare('SELECT COUNT(*) AS n FROM bulk_targets WHERE run_id NOT IN (SELECT id FROM bulk_runs)').get() as { n: number };
    expect(orphans.n).toBe(0);
  });

  it('pages the preview', () => {
    const id = record(Array.from({ length: 240 }, (_, i) => ({ key: `k${String(i).padStart(3, '0')}`, before: { absent: true }, after: 'x' })));
    const first = ledger.getPreview(id, { limit: 200 });
    const rest = ledger.getPreview(id, { offset: 200, limit: 200 });
    expect(first).toHaveLength(200);
    expect(rest.map((t) => t.seq)).toEqual(Array.from({ length: 40 }, (_, i) => 200 + i));
  });

  it('hashes the rule under the engine key: stable for one rule, not a plain digest', () => {
    const a = hashOf(record(one('alice@example.test')));
    const b = hashOf(record(one('alice@example.test')));
    expect(a).toBe(b);
    // Stable across a reopen with the same vault key — a key drawn fresh per handle would
    // pass the same-handle check above and fail here.
    engineDb.close();
    engineDb = new EngineDb(join(dir, 'engine.db'), 'key-one');
    ledger = new BulkLedger(engineDb);
    expect(hashOf(record(one('alice@example.test')))).toBe(a);
    const plain = createHash('sha256');
    for (const p of ['workspace', 'workspace', 'alice@example.test', '"x"']) plain.update(`${String(Buffer.byteLength(p))}:`).update(p);
    expect(a).not.toBe(plain.digest('hex'));

    // Not the AES key reused: the MAC runs under its own HKDF subkey.
    const aesKey = Buffer.from(hkdfSync('sha256', 'key-one', 'lynox-engine', 'lynox-engine-encryption', 32));
    const underAes = createHmac('sha256', aesKey);
    for (const p of ['workspace', 'workspace', 'alice@example.test', '"x"']) underAes.update(`${String(Buffer.byteLength(p))}:`).update(p);
    expect(a).not.toBe(underAes.digest('hex'));

    const other = new EngineDb(join(dir, 'engine2.db'), 'key-two');
    try {
      const c = new BulkLedger(other).recordDryRun({ createdBy: 't', targetSystem: 'workspace', scope: 'workspace', targets: one('alice@example.test') });
      const hc = (other.getDb().prepare('SELECT rule_hash FROM bulk_runs WHERE id = ?').get(c.id) as { rule_hash: string }).rule_hash;
      expect(hc).not.toBe(a);
    } finally {
      other.close();
    }
  });
});
