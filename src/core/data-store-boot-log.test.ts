import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';
import { DataStore } from './data-store.js';
import { Engine } from './engine.js';
import { reloadConfig } from './config.js';
import { reduceErrorTextForProcess, _resetErrorEgress } from './error-egress.js';
import { tableInLog } from './data-store-boot-log.js';
import type { LynoxConfig } from '../types/index.js';

/**
 * The boot lines about DataStore tables name a table in the container log only where the
 * instance holds no exact connection: a table's name is run text (the model names it).
 */

describe('tableInLog', () => {
  it('names a table by its name, and an invalid one as such', () => {
    expect(tableInLog('orders_ms_x', false)).toBe('table "orders_ms_x"');
    expect(tableInLog(null, false)).toBe('a table with an invalid name');
  });

  it('names no table under an exact connection', () => {
    expect(tableInLog('orders_ms_x', true)).toBe('a table');
    expect(tableInLog(null, true)).toBe('a table');
  });
});

describe('Engine boot — DataStore lines in the container log', () => {
  const SCOPE = { type: 'global' as const, id: '' };
  const COLS = [{ name: 'v', type: 'string' as const }];
  const dirs: string[] = [];
  const engines: Engine[] = [];
  let prevDataDir: string | undefined;

  afterEach(async () => {
    for (const e of engines) { try { await e.shutdown(); } catch { /* best effort */ } }
    engines.length = 0;
    if (prevDataDir === undefined) delete process.env['LYNOX_DATA_DIR'];
    else process.env['LYNOX_DATA_DIR'] = prevDataDir;
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
    vi.restoreAllMocks();
    _resetErrorEgress();
    reloadConfig();
  });

  /**
   * A data dir whose datastore.db gives each line its case: `ghost_kunde` is listed without a
   * table (missing), `broken_kunde` is a view where the table should be (its source columns
   * fail), and `twin_kunde` shares its id with `first_kunde` (renumbered).
   */
  function dataDir(): string {
    prevDataDir = process.env['LYNOX_DATA_DIR'];
    const dir = mkdtempSync(join(tmpdir(), 'lynox-ds-bootlog-'));
    dirs.push(dir);
    const ds = new DataStore(join(dir, 'datastore.db'));
    const db = ds['db'] as Database.Database;
    ds.createCollection({ name: 'first_kunde', scope: SCOPE, columns: COLS });
    ds.createCollection({ name: 'twin_kunde', scope: SCOPE, columns: COLS });
    db.exec('DROP INDEX IF EXISTS idx_ds_collections_collection_id');
    db.prepare("UPDATE ds_collections SET collection_id = (SELECT collection_id FROM ds_collections WHERE name = 'first_kunde') WHERE name = 'twin_kunde'").run();
    const listed = db.prepare("INSERT INTO ds_collections (name, scope_type, scope_id, schema_json, unique_key, record_count, created_at, updated_at) VALUES (?, 'global', '', ?, NULL, 0, 'x', 'x')");
    listed.run('ghost_kunde', '[]');
    db.exec(`CREATE VIEW "ds_broken_kunde" AS SELECT 1 AS _id, 'x' AS _created_at, 'x' AS _updated_at, 'v' AS v`);
    listed.run('broken_kunde', JSON.stringify(COLS));
    ds.close();
    return dir;
  }

  /** The DataStore lines the boot writes to stderr. */
  async function bootLines(dir: string): Promise<string[]> {
    const lines: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; });
    process.env['LYNOX_DATA_DIR'] = dir;
    reloadConfig();
    const engine = new Engine({} as LynoxConfig);
    engines.push(engine);
    await engine.init();
    vi.mocked(process.stderr.write).mockRestore();
    return lines.filter((l) => l.startsWith('[lynox] DataStore: ') && !l.includes('CRM-overlap'));
  }

  it('names each table, with the database text, where no exact connection is held', async () => {
    const lines = await bootLines(dataDir());
    const failed = lines.find((l) => l.includes('could not get its source columns'));
    expect(failed).toMatch(/^\[lynox\] DataStore: table "broken_kunde" could not get its source columns and refuses writes until a restart migrates it: .+\n$/);
    expect(lines).toContain('[lynox] DataStore: listed table(s) without a database table: ghost_kunde\n');
    expect(lines.find((l) => l.includes('shared its id'))).toMatch(/^\[lynox\] DataStore: table "twin_kunde" shared its id with another and got a new one: dsc_[0-9a-f]{16} -> dsc_[0-9a-f]{16}\n$/);
  });

  it('names no table, and leaves out the database text, under an exact connection', async () => {
    const dir = dataDir();
    reduceErrorTextForProcess();
    const lines = await bootLines(dir);
    expect(lines).toContain('[lynox] DataStore: a table could not get its source columns and refuses writes until a restart migrates it\n');
    expect(lines).toContain('[lynox] DataStore: 1 listed table(s) without a database table\n');
    expect(lines.find((l) => l.includes('shared its id'))).toMatch(/^\[lynox\] DataStore: a table shared its id with another and got a new one: dsc_[0-9a-f]{16} -> dsc_[0-9a-f]{16}\n$/);
    // Positive control above (each case's line is there); none of them names a table.
    expect(lines).toHaveLength(3);
    for (const line of lines) expect(line).not.toMatch(/_kunde/);
  });
});
