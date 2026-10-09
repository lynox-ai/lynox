import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LynoxConfig } from '../types/index.js';
import { Engine } from './engine.js';
import { reloadConfig } from './config.js';

/**
 * The engine hands out a store for mandate ends, on its own engine.db.
 *
 * Every HTTP test stubs `getMandateEnds`, so none of them sees whether `Engine.init` builds the
 * store at all. Without it every request records nothing and every later reader takes every
 * mandate as ended: closed, but the feature is dead without a signal. So this boots a real Engine.
 */
describe('Engine boot — mandate ends', () => {
  const dirs: string[] = [];
  const engines: Engine[] = [];
  const saved = new Map<string, string | undefined>();

  afterEach(async () => {
    for (const e of engines) { try { await e.shutdown(); } catch { /* best effort */ } }
    engines.length = 0;
    for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    saved.clear();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
    reloadConfig();
  });

  it('records a mandate\'s end in the engine\'s own engine.db', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-mandateendsboot-'));
    dirs.push(dir);
    saved.set('LYNOX_DATA_DIR', process.env['LYNOX_DATA_DIR']);
    process.env['LYNOX_DATA_DIR'] = dir;
    reloadConfig();
    const engine = new Engine({} as LynoxConfig);
    engines.push(engine);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      await engine.init();
    } finally {
      stderr.mockRestore();
    }

    const ends = engine.getMandateEnds();
    expect(ends).not.toBeNull();
    ends!.record({ kind: 'mandate', email: 'helper@example.invalid', mandateId: 'M-1', mandateExp: 2_000 }, 100);
    const db = (engine as unknown as { engineDb: { getDb(): import('better-sqlite3').Database } }).engineDb.getDb();
    expect(db.prepare('SELECT ends_at FROM mandate_ends WHERE mandate_id = ?').get('M-1')).toEqual({ ends_at: 2_000 });
    // The tools read the same record: `api_setup` names the connections that wait for the owner
    // from it, and a tool context without it would call every mandate ended.
    expect(engine.getToolContext().mandateEnds).toBe(ends);
    expect(engine.getToolContext().mandateEnds?.isLive('M-1', 1_000)).toBe(true);
  });
});
