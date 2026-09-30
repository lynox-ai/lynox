import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
    const csv = 'target,after\n' + 'a,b\n'.repeat(BULK_MAX_TARGETS + 1);
    expect(() => parseCsv(csv)).toThrow(`more than ${String(BULK_MAX_TARGETS)} targets`);
    expect(() => parseCsv('target,after\n' + 'a,b\n'.repeat(BULK_MAX_TARGETS))).not.toThrow();
  });

  it('does not count blank lines toward the cap', () => {
    expect(parseCsv('target,after\n\n\na,b\n\n')).toEqual([{ target: 'a', after: 'b' }]);
  });

  it('refuses a JSON array over the cap before inspecting its elements', () => {
    const json = JSON.stringify(Array.from({ length: BULK_MAX_TARGETS + 1 }, () => ({})));
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

  it('refuses a plan whose images exceed the total cap', () => {
    const size = BULK_MAX_TARGET_BYTES - 16;
    const n = Math.ceil(BULK_MAX_TOTAL_BYTES / size) + 1;
    const source = Array.from({ length: n }, (_, i) => ({ target: `f${String(i)}`, after: 'y'.repeat(size) }));
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
    const plain = createHash('sha256');
    for (const p of ['workspace', 'workspace', 'alice@example.test', '"x"']) plain.update(`${String(Buffer.byteLength(p))}:`).update(p);
    expect(a).not.toBe(plain.digest('hex'));

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
