import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync, statSync, mkdirSync, realpathSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bulkPlanTool, bulkStatusTool } from './bulk.js';
import { EngineDb } from '../../core/engine-db.js';
import { DataStore } from '../../core/data-store.js';
import { BulkLedger } from '../../core/bulk-ledger.js';
import type { PreviewTarget, TargetDiff } from '../../core/bulk-ledger.js';
import { BULK_MAX_TARGETS, readBulkImage } from '../../core/bulk-plan.js';
import { setTenantWorkspace, clearTenantWorkspace } from '../../core/workspace.js';
import type { IAgent, MemoryScopeRef } from '../../types/index.js';

/**
 * Acceptance for the dry-run slice of PRD bulk-changes-reversible (§7 a, §3.2):
 * a dry run over ≥ 200 targets records per target the before-state, the after-state
 * and their diff, and leaves the target system byte-for-byte unchanged. Plus the two
 * properties the slice owes as a holder of customer data (§3.1, §3.10): images are
 * encrypted at rest, and nothing the model receives carries a target's content.
 */

const scope: MemoryScopeRef = { type: 'context', id: 'bulk-test' };
const MARK = 'ZXQ-SECRET-MARK';

let dir: string;
let ws: string;
let engineDb: EngineDb;
let ledger: BulkLedger;
let store: DataStore;

function agent(): IAgent {
  return { toolContext: { bulkLedger: ledger, dataStore: store }, currentThreadId: 'thread-1' } as unknown as IAgent;
}

/** Every file under `root` with its bytes and mtime — the "byte-identical" witness. */
function snapshot(root: string): Map<string, { bytes: string; mtimeMs: number }> {
  const out = new Map<string, { bytes: string; mtimeMs: number }>();
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.set(p, { bytes: readFileSync(p).toString('base64'), mtimeMs: statSync(p).mtimeMs });
    }
  };
  walk(root);
  return out;
}

/** Apply a one-hunk text diff to `before`; must reproduce the planned after-state. */
function applyTextDiff(before: string | undefined, diff: TargetDiff): string {
  if (diff.kind === 'none') return before ?? '';
  if (diff.kind !== 'text') throw new Error('expected a text diff');
  const lines = before === undefined ? [] : before.split('\n');
  return [...lines.slice(0, diff.from), ...diff.added, ...lines.slice(diff.from + diff.removed.length)].join('\n');
}

function runIdOf(result: string): string {
  const m = /Bulk run ([0-9a-f-]{36})/.exec(result);
  if (!m) throw new Error(`no run id in: ${result}`);
  return m[1]!;
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'lynox-bulk-')));
  ws = join(dir, 'workspace');
  mkdirSync(ws);
  setTenantWorkspace(ws);
  engineDb = new EngineDb(join(dir, 'engine.db'), 'test-vault-key');
  ledger = new BulkLedger(engineDb);
  store = new DataStore(join(dir, 'datastore.db'));
});

afterEach(() => {
  clearTenantWorkspace();
  engineDb.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('bulk_plan over workspace files', () => {
  function seed(): { source: string } {
    const rows: { target: string; after: string }[] = [];
    mkdirSync(join(ws, 'pages'));
    for (let i = 0; i < 200; i++) {
      const name = `pages/p${String(i)}.md`;
      writeFileSync(join(ws, name), `# Page ${String(i)}\nprice: 10\n${MARK}-before-${String(i)}\nfooter\n`);
      rows.push({ target: name, after: `# Page ${String(i)}\nprice: 12\n${MARK}-after-${String(i)}\nfooter\n` });
    }
    for (let i = 0; i < 20; i++) {
      const name = `pages/same${String(i)}.md`;
      writeFileSync(join(ws, name), `unchanged ${String(i)}\n`);
      rows.push({ target: name, after: `unchanged ${String(i)}\n` });
    }
    for (let i = 0; i < 20; i++) rows.push({ target: `pages/new${String(i)}.md`, after: `${MARK}-new-${String(i)}\n` });
    writeFileSync(join(ws, 'plan.json'), JSON.stringify(rows));
    return { source: 'plan.json' };
  }

  it('records 240 targets with before, after and diff, and changes no file', async () => {
    const { source } = seed();
    const before = snapshot(ws);

    const result = await bulkPlanTool.handler({ target_system: 'workspace', source_file: join(ws, source) }, agent());

    expect(snapshot(ws)).toEqual(before);
    expect(result).toContain('Targets: 240 — update 200, create 20, unchanged 20, invalid 0');
    expect(result).toContain('Undo class if applied: mixed');

    const preview: PreviewTarget[] = ledger.getPreview(runIdOf(result), { limit: 1000 });
    expect(preview).toHaveLength(240);
    for (const t of preview) {
      const planned = t.after as string;
      const prior = t.before!.absent ? undefined : (t.before as { value: string }).value;
      expect(applyTextDiff(prior, t.diff)).toBe(planned);
      if (/\/p\d+\.md$/.test(t.key)) {
        expect(t.change).toBe('update');
        expect(t.undo).toBe('restorable');
        expect(prior).toContain(`${MARK}-before-`);
        expect(t.diff).toMatchObject({ kind: 'text', from: 1 });
      } else if (/\/same\d+\.md$/.test(t.key)) {
        expect(t.change).toBe('unchanged');
        expect(t.diff).toEqual({ kind: 'none' });
      } else {
        expect(t.change).toBe('create');
        expect(t.undo).toBe('compensatable');
        expect(t.before).toEqual({ absent: true });
      }
    }
  });

  it('returns no target key, value or diff to the model — from bulk_plan or bulk_status', async () => {
    const { source } = seed();
    const planned = await bulkPlanTool.handler({ target_system: 'workspace', source_file: source }, agent());
    const status = await bulkStatusTool.handler({ run_id: runIdOf(planned) }, agent());
    const listed = await bulkStatusTool.handler({}, agent());
    for (const text of [planned, status, listed]) {
      expect(text).not.toContain(MARK);
      expect(text).not.toContain('pages/');
      expect(text).not.toContain('price');
    }
  });

  it('stores keys and images encrypted at rest', async () => {
    const { source } = seed();
    await bulkPlanTool.handler({ target_system: 'workspace', source_file: source }, agent());
    const raw = engineDb.getDb().prepare('SELECT target_key, before, after_planned FROM bulk_targets').all() as Record<string, string | null>[];
    expect(raw).toHaveLength(240);
    const dump = JSON.stringify(raw);
    expect(dump).not.toContain(MARK);
    expect(dump).not.toContain('pages');
  });

  it('marks a target outside the workspace invalid, by reason, without reading it', async () => {
    writeFileSync(join(dir, 'outside.txt'), `${MARK}\n`);
    writeFileSync(join(ws, 'plan.json'), JSON.stringify([
      { target: '../outside.txt', after: 'x' },
      { target: 'inside.txt', after: 'y' },
    ]));
    const result = await bulkPlanTool.handler({ target_system: 'workspace', source_file: 'plan.json' }, agent());
    expect(result).toContain('invalid 1 (path_outside_workspace 1)');
    const preview = ledger.getPreview(runIdOf(result));
    expect(preview.find((t) => t.change === 'invalid')!.before).toBeNull();
    expect(readFileSync(join(dir, 'outside.txt'), 'utf8')).toBe(`${MARK}\n`);
  });

  it('marks a new target under a symlinked directory that leaves the workspace invalid', async () => {
    mkdirSync(join(dir, 'elsewhere'));
    symlinkSync(join(dir, 'elsewhere'), join(ws, 'link'));
    writeFileSync(join(ws, 'plan.json'), JSON.stringify([{ target: 'link/new.txt', after: 'x' }]));
    const result = await bulkPlanTool.handler({ target_system: 'workspace', source_file: 'plan.json' }, agent());
    expect(result).toContain('invalid 1 (path_outside_workspace 1)');
  });

  it('keys two spellings of one file as one target and refuses the doubled plan', async () => {
    writeFileSync(join(ws, 'a.txt'), 'a');
    symlinkSync(join(ws, 'a.txt'), join(ws, 'alias.txt'));
    writeFileSync(join(ws, 'plan.json'), JSON.stringify([{ target: 'a.txt', after: '1' }, { target: 'alias.txt', after: '2' }]));
    expect(await bulkPlanTool.handler({ target_system: 'workspace', source_file: 'plan.json' }, agent()))
      .toBe('Error: The source names the same target more than once.');
  });

  it('refuses to read through a symlink at the leaf, even one planted after resolution', () => {
    writeFileSync(join(dir, 'secret.txt'), MARK);
    symlinkSync(join(dir, 'secret.txt'), join(ws, 'late-link.txt'));
    expect(() => readBulkImage(join(ws, 'late-link.txt'), 1024)).toThrow();
  });

  it('reads a CSV source with quoted commas, quotes and line breaks', async () => {
    writeFileSync(join(ws, 'plan.csv'), 'target,after\r\n"q.txt","a, ""b""\nc"\r\n');
    const result = await bulkPlanTool.handler({ target_system: 'workspace', source_file: 'plan.csv' }, agent());
    expect(ledger.getPreview(runIdOf(result))[0]!.after).toBe('a, "b"\nc');
  });

  it('refuses a source outside the workspace, a doubled target, and too many targets', async () => {
    writeFileSync(join(dir, 'plan.json'), '[]');
    expect(await bulkPlanTool.handler({ target_system: 'workspace', source_file: '../plan.json' }, agent()))
      .toBe('Error: The source file must be inside the workspace.');

    writeFileSync(join(ws, 'dup.json'), JSON.stringify([{ target: 'a.txt', after: '1' }, { target: './a.txt', after: '2' }]));
    expect(await bulkPlanTool.handler({ target_system: 'workspace', source_file: 'dup.json' }, agent()))
      .toBe('Error: The source names the same target more than once.');

    const many = Array.from({ length: BULK_MAX_TARGETS + 1 }, (_, i) => ({ target: `f${String(i)}.txt`, after: '' }));
    writeFileSync(join(ws, 'many.json'), JSON.stringify(many));
    expect(await bulkPlanTool.handler({ target_system: 'workspace', source_file: 'many.json' }, agent()))
      .toContain('more than 5000 targets');

    expect(ledger.listRuns()).toEqual([]);
  });

  it('refuses both sources at once, and neither', async () => {
    expect(await bulkPlanTool.handler({ target_system: 'workspace', source_file: 'a.json', source_collection: 'x' }, agent()))
      .toBe('Error: Give exactly one of source_file or source_collection.');
    expect(await bulkPlanTool.handler({ target_system: 'workspace' }, agent()))
      .toBe('Error: Give exactly one of source_file or source_collection.');
  });
});

describe('bulk_plan over data-store rows', () => {
  function seed(): void {
    store.createCollection({
      name: 'products', scope, uniqueKey: ['sku'],
      columns: [{ name: 'sku', type: 'string' }, { name: 'price', type: 'number' }, { name: 'note', type: 'string' }],
    });
    const records = Array.from({ length: 210 }, (_, i) => ({ sku: `S${String(i)}`, price: 10, note: `${MARK}-${String(i)}` }));
    for (let i = 0; i < records.length; i += 100) store.insertRecords({ collection: 'products', records: records.slice(i, i + 100) });
  }

  function allRows(): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    for (let offset = 0; ; offset += 500) {
      const { rows, total } = store.queryRecords({ collection: 'products', limit: 500, offset, sort: [{ field: 'sku', direction: 'asc' }] });
      out.push(...rows);
      if (offset + 500 >= total) return out;
    }
  }

  it('plans 210 rows from a CSV — full after-rows, field diffs — and changes no row', async () => {
    seed();
    const lines = ['target,price'];
    for (let i = 0; i < 200; i++) lines.push(`S${String(i)},12.5`);
    for (let i = 200; i < 205; i++) lines.push(`S${String(i)},10`);
    for (let i = 0; i < 5; i++) lines.push(`N${String(i)},7`);
    writeFileSync(join(ws, 'prices.csv'), lines.join('\n'));
    const rowsBefore = allRows();

    const result = await bulkPlanTool.handler(
      { target_system: 'data_store', target_collection: 'products', source_file: 'prices.csv' }, agent(),
    );

    expect(allRows()).toEqual(rowsBefore);
    expect(store.getCollectionInfo('products')!.recordCount).toBe(210);
    expect(result).toContain('Targets: 210 — update 200, create 5, unchanged 5, invalid 0');
    expect(result).not.toContain(MARK);

    const preview = ledger.getPreview(runIdOf(result));
    const s0 = preview.find((t) => t.key === 'S0')!;
    expect(s0.before).toEqual({ absent: false, value: { sku: 'S0', price: 10, note: `${MARK}-0` } });
    expect(s0.after).toEqual({ sku: 'S0', price: 12.5, note: `${MARK}-0` });
    expect(s0.diff).toEqual({ kind: 'fields', fields: [{ field: 'price', before: 10, after: 12.5 }] });
    const n0 = preview.find((t) => t.key === 'N0')!;
    expect(n0.after).toEqual({ sku: 'N0', price: 7, note: null });
    expect(n0.undo).toBe('compensatable');
  });

  it('reads the source from a staging collection', async () => {
    seed();
    store.createCollection({
      name: 'staged', scope,
      columns: [{ name: 'target', type: 'string' }, { name: 'price', type: 'number' }],
    });
    store.insertRecords({ collection: 'staged', records: [{ target: 'S1', price: 99 }, { target: 'S2', price: 10 }] });
    const result = await bulkPlanTool.handler(
      { target_system: 'data_store', target_collection: 'products', source_collection: 'staged' }, agent(),
    );
    expect(result).toContain('Targets: 2 — update 1, create 0, unchanged 1, invalid 0');
  });

  it('pages a staging collection past one query page, and caps it at the target limit', async () => {
    seed();
    store.createCollection({ name: 'staged', scope, columns: [{ name: 'target', type: 'string' }, { name: 'price', type: 'number' }] });
    const put = (from: number, to: number): void => {
      for (let i = from; i < to; i += 100) {
        store.insertRecords({
          collection: 'staged',
          records: Array.from({ length: Math.min(100, to - i) }, (_, j) => ({ target: `X${String(i + j)}`, price: 1 })),
        });
      }
    };
    put(0, 501);
    const paged = await bulkPlanTool.handler({ target_system: 'data_store', target_collection: 'products', source_collection: 'staged' }, agent());
    expect(paged).toContain('Targets: 501 — update 0, create 501');

    put(501, BULK_MAX_TARGETS + 1);
    expect(await bulkPlanTool.handler({ target_system: 'data_store', target_collection: 'products', source_collection: 'staged' }, agent()))
      .toContain(`more than ${String(BULK_MAX_TARGETS)} targets`);
  });

  it('holds a collection source to the same byte cap as a file', async () => {
    seed();
    store.createCollection({ name: 'fat', scope, columns: [{ name: 'target', type: 'string' }, { name: 'note', type: 'string' }] });
    // 1100 rows of ~9 KB over three pages of 500: under the cap after page one, over it
    // after page two. The read must stop there — a cap counted per page never trips, and
    // one checked only after the loop reads page three first.
    for (let i = 0; i < 1100; i += 100) {
      store.insertRecords({
        collection: 'fat',
        records: Array.from({ length: 100 }, (_, j) => ({ target: `F${String(i + j)}`, note: 'n'.repeat(9 * 1024) })),
      });
    }
    const reads = vi.spyOn(store, 'queryRecords');
    expect(await bulkPlanTool.handler({ target_system: 'data_store', target_collection: 'products', source_collection: 'fat' }, agent()))
      .toBe('Error: The source is larger than 5 MB.');
    expect(reads.mock.calls.filter(([p]) => p.collection === 'fat')).toHaveLength(2);
  });

  it('refuses a source file that is not UTF-8', async () => {
    seed();
    writeFileSync(join(ws, 'latin1.csv'), Buffer.from('target,price\nS\xe9,1\n', 'latin1'));
    expect(await bulkPlanTool.handler({ target_system: 'data_store', target_collection: 'products', source_file: 'latin1.csv' }, agent()))
      .toBe('Error: The source file is not UTF-8 text.');
  });

  it('marks unknown columns, subject columns and unconvertible values invalid, by reason', async () => {
    store.createCollection({
      name: 'people', scope, uniqueKey: ['email'],
      columns: [
        { name: 'email', type: 'string' }, { name: 'age', type: 'number' },
        { name: 'employer', type: 'subject', subjectKind: 'organization' },
      ],
    });
    writeFileSync(join(ws, 'p.json'), JSON.stringify([
      { target: 'a@x.test', after: { nope: 1 } },
      { target: 'b@x.test', after: { employer: 'Acme' } },
      { target: 'c@x.test', after: { age: 'old' } },
      { target: 'd@x.test', after: { age: 30 } },
    ]));
    const result = await bulkPlanTool.handler({ target_system: 'data_store', target_collection: 'people', source_file: 'p.json' }, agent());
    expect(result).toContain('create 1');
    expect(result).toContain('invalid 3 (');
    expect(result).toContain('unknown_column 1');
    expect(result).toContain('subject_column 1');
    expect(result).toContain('bad_value 1');
    expect(result).not.toContain('@x.test');
  });

  it('treats number keys that store the same value as one target', async () => {
    store.createCollection({
      name: 'nums', scope, uniqueKey: ['n'],
      columns: [{ name: 'n', type: 'number' }, { name: 'v', type: 'string' }],
    });
    writeFileSync(join(ws, 'n.json'), JSON.stringify([{ target: '12', after: { v: 'a' } }, { target: '12.0', after: { v: 'b' } }]));
    expect(await bulkPlanTool.handler({ target_system: 'data_store', target_collection: 'nums', source_file: 'n.json' }, agent()))
      .toBe('Error: The source names the same target more than once.');
  });

  it('refuses a collection without a single-column unique key', async () => {
    store.createCollection({ name: 'loose', scope, columns: [{ name: 'a', type: 'string' }] });
    writeFileSync(join(ws, 'l.json'), JSON.stringify([{ target: 'x', after: { a: 'y' } }]));
    expect(await bulkPlanTool.handler({ target_system: 'data_store', target_collection: 'loose', source_file: 'l.json' }, agent()))
      .toBe('Error: The target collection needs a single-column unique key to address its rows.');
  });
});

describe('bulk tools without a ledger', () => {
  it('refuse instead of failing', async () => {
    const bare = { toolContext: { bulkLedger: null, dataStore: null } } as unknown as IAgent;
    expect(await bulkPlanTool.handler({ target_system: 'workspace', source_file: 'x' }, bare)).toBe('Bulk runs are not available on this instance.');
    expect(await bulkStatusTool.handler({}, bare)).toBe('Bulk runs are not available on this instance.');
  });
});
