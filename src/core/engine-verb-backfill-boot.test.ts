import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Engine } from './engine.js';
import { RunHistory } from './run-history.js';
import type { LynoxConfig } from '../types/index.js';

/**
 * B1 self-heal — the BOOT-WIRING integration proof. The unit tests
 * (`verb-graph-backfill.test.ts`) prove the backfill LOGIC; this proves the one thing
 * they can't: that a real {@link Engine.init} actually RUNS the backfill on the
 * upgrade boot. Seeds a v1.22.0-shaped data dir (a history.db at schema_version=43
 * with a legacy `triggers` row + a planned workflow-def, and NO engine.db), boots a
 * real Engine, and asserts the pre-cutover verb defs self-heal into engine.db + the
 * marker is set — the exact scenario a rafael/cat v1.22.0→v2.0.0 upgrade hits.
 *
 * Safe: `init()` does NOT start the WorkerLoop (a separate `startWorkerLoop()`), so a
 * migrated trigger never fires during the test; the seeded trigger is future-dated as
 * belt-and-suspenders.
 */
describe('Engine boot — verb-graph self-heal on a v1.22.0-shaped upgrade (B1)', () => {
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
  });

  /** Seed a v1.22.0-shaped history.db into a fresh data dir: build a REAL RunHistory
   *  (so every table a v1.22.0 tenant has exists — tasks/runs/pending_prompts/…), then
   *  raw-INSERT a legacy `triggers` row + a planned workflow-def into it (the pre-mirror
   *  state the boot backfill relocates). No engine.db exists yet, so on boot engine.db
   *  is fresh + the backfill marker is unset — exactly the first-boot-after-upgrade
   *  state a rafael/cat v1.22.0→v2.0.0 upgrade hits. */
  function seedV122DataDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-boot-'));
    dirs.push(dir);
    const seed = new RunHistory(join(dir, 'history.db'));
    const db = seed.getDb();
    db.prepare(
      `INSERT INTO triggers (id, title, description, status, assignee, scope_type, scope_id,
        created_at, updated_at, schedule_cron, next_run_at, task_type, pipeline_id, enabled)
       VALUES ('boot-trig','Weekly digest','','open','lynox','project','',
        '2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','0 9 * * 1','2099-01-01T00:00:00.000Z','scheduled','boot-wf',1)`,
    ).run();
    db.prepare(
      `INSERT INTO pipeline_runs (id, manifest_name, status, manifest_json, step_count)
       VALUES ('boot-wf','Digest WF','planned','{"name":"Digest WF","goal":"send it"}',1)`,
    ).run();
    seed.close();
    return dir;
  }

  it('boots a v1.22.0-shaped tenant and self-heals its triggers + workflows into engine.db', async () => {
    prevDataDir = process.env['LYNOX_DATA_DIR'];
    const dir = seedV122DataDir();
    process.env['LYNOX_DATA_DIR'] = dir;

    const engine = new Engine({} as LynoxConfig);
    engines.push(engine);
    await engine.init();

    const engineDb = engine.getEngineDb();
    expect(engineDb).not.toBeNull();
    const edb = engineDb!.getDb();

    // The legacy trigger + workflow-def self-healed into engine.db.
    expect((edb.prepare("SELECT COUNT(*) c FROM triggers WHERE id='boot-trig'").get() as { c: number }).c).toBe(1);
    expect((edb.prepare("SELECT COUNT(*) c FROM workflows WHERE id='boot-wf'").get() as { c: number }).c).toBe(1);
    // The trigger→workflow FK resolved (workflow backfilled first).
    expect((edb.prepare("SELECT target_workflow_id t FROM triggers WHERE id='boot-trig'").get() as { t: string | null }).t).toBe('boot-wf');
    // source/effect derived from the legacy scheduled+pipeline task_type.
    const se = edb.prepare("SELECT source, effect FROM triggers WHERE id='boot-trig'").get() as { source: string; effect: string };
    expect(se).toEqual({ source: 'cron', effect: 'run_workflow' });
    // The marker is set → a second boot won't re-run the backfill.
    expect(engineDb!.isVerbBackfillDone()).toBe(true);

    // v44 non-destructive: the legacy source rows are STILL in history.db (rollback net).
    const hdb = engine.getRunHistory()!.getDb();
    expect((hdb.prepare("SELECT COUNT(*) c FROM triggers WHERE id='boot-trig'").get() as { c: number }).c).toBe(1);
  });

  it('a fresh tenant with no legacy verb defs boots clean (marker set, no rows)', async () => {
    prevDataDir = process.env['LYNOX_DATA_DIR'];
    const dir = mkdtempSync(join(tmpdir(), 'lynox-boot-fresh-'));
    dirs.push(dir);
    process.env['LYNOX_DATA_DIR'] = dir;

    const engine = new Engine({} as LynoxConfig);
    engines.push(engine);
    await engine.init();

    const engineDb = engine.getEngineDb();
    expect(engineDb).not.toBeNull();
    // No legacy source → backfill is a no-op but the marker still flips (won't re-scan).
    expect(engineDb!.isVerbBackfillDone()).toBe(true);
    expect((engineDb!.getDb().prepare('SELECT COUNT(*) c FROM triggers').get() as { c: number }).c).toBe(0);
  });
});
