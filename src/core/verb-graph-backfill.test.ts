import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RunHistory } from './run-history.js';
import { EngineDb } from './engine-db.js';
import { TaskStore } from './task-store.js';
import { TriggerStore } from './trigger-store.js';
import { WorkflowStore } from './workflow-store.js';
import { VerbGraphBackfill } from './verb-graph-backfill.js';
import type Database from 'better-sqlite3';

/**
 * The verb-layer TASK backfill. Seeds legacy history.db tasks with the mirror OFF
 * (no setVerbGraph → legacy-only writes, the real pre-mirror state), then proves the
 * backfill relocates them into engine.db faithfully: mapped rows, FK re-link in
 * dependency order (incl. a child ordered before its parent), preserved timestamps,
 * and idempotent re-runs. (Workflow + trigger backfill — the B1 self-heal that
 * carries the pre-cutover automation surface forward — is covered in the sibling
 * describe below.)
 */
describe('VerbGraphBackfill — tasks (Foundation Rework v2)', () => {
  const tmpDirs: string[] = [];
  const engines: EngineDb[] = [];
  const histories: RunHistory[] = [];

  /** A RunHistory + EngineDb pair with NO task mirror (setVerbGraph never called) —
   *  so seeding writes ONLY the legacy `tasks` rows, exactly the pre-mirror state
   *  the backfill exists to relocate. */
  function make(): { history: RunHistory; engine: EngineDb } {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-tbf-'));
    tmpDirs.push(dir);
    const history = new RunHistory(join(dir, 'history.db'), 'vk');
    const engine = new EngineDb(join(dir, 'engine.db'), 'vk');
    histories.push(history);
    engines.push(engine);
    return { history, engine };
  }

  afterEach(() => {
    for (const e of engines) { try { e.close(); } catch { /* already closed */ } }
    for (const h of histories) { try { h.close(); } catch { /* already closed */ } }
    engines.length = 0;
    histories.length = 0;
    for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  const task = (over: { id?: string; title?: string; parentTaskId?: string; assignee?: string; tags?: string } = {}) => ({
    id: over.id ?? 'kk-1',
    title: over.title ?? 'Call the accountant',
    description: 'about the Q3 filing',
    status: 'open',
    priority: 'high',
    assignee: over.assignee,
    scopeType: 'project',
    scopeId: '',
    dueDate: '2026-07-10',
    tags: over.tags ?? '["finance"]',
    parentTaskId: over.parentTaskId,
  });

  const count = (engine: EngineDb): number =>
    (engine.getDb().prepare('SELECT COUNT(*) n FROM tasks').get() as { n: number }).n;

  it('backfills legacy tasks; engine.db starts empty, ends equal to legacy', () => {
    const { history, engine } = make();
    history.insertTask(task({ id: 'kk-1' }));
    history.insertTask(task({ id: 'kk-2', title: 'File the return' }));

    expect(count(engine)).toBe(0); // pre-mirror: engine.db empty

    const res = new VerbGraphBackfill(engine, history.getDb()).run();

    expect(res.tasks).toBe(2);
    expect(count(engine)).toBe(2);
  });

  it('maps the row + drops the free-text assignee', () => {
    const { history, engine } = make();
    history.insertTask(task({ id: 'kk-1', assignee: 'Britta', tags: '["finance"]' }));
    new VerbGraphBackfill(engine, history.getDb()).run();

    const mirror = new TaskStore(engine).get('kk-1');
    expect(mirror).toBeDefined();
    expect(mirror!.title).toBe('Call the accountant');
    expect(mirror!.status).toBe('open');
    expect(mirror!.tags).toBe('["finance"]');
    // assignee is legacy free-text with no engine.db string column → never relocated.
    const raw = engine.getDb().prepare("SELECT assignee_subject_id FROM tasks WHERE id = 'kk-1'")
      .get() as { assignee_subject_id: string | null };
    expect(raw.assignee_subject_id).toBeNull();
  });

  it('a child ordered BEFORE its parent re-links via the two-pass', () => {
    const { history, engine } = make();
    // Seed both, then force the adversarial scan order: child.created_at < parent.created_at,
    // so getAllTasks (ORDER BY created_at ASC) returns the child first and pass-1 NULLs its
    // parent link — only the pass-2 re-upsert can resolve it.
    history.insertTask(task({ id: 'parent', title: 'Parent' }));
    history.insertTask(task({ id: 'child', parentTaskId: 'parent' }));
    const hdb = history.getDb();
    hdb.prepare("UPDATE tasks SET created_at = '2026-01-01T00:00:00Z' WHERE id = 'child'").run();
    hdb.prepare("UPDATE tasks SET created_at = '2026-06-01T00:00:00Z' WHERE id = 'parent'").run();

    const res = new VerbGraphBackfill(engine, hdb).run();

    expect(new TaskStore(engine).get('child')!.parentTaskId).toBe('parent'); // resolved despite child-first
    expect(res.taskParentLinks).toBe(1);
  });

  it('a grandchild chain re-links at ANY depth via the single pass-2', () => {
    const { history, engine } = make();
    // grandparent → parent → grandchild, seeded so the SCAN order (created_at ASC) is
    // the WORST case — grandchild first, grandparent last — so pass-1 NULLs BOTH links
    // and only pass-2 (all rows now exist) can resolve the whole chain.
    history.insertTask(task({ id: 'gp', title: 'Grandparent' }));
    history.insertTask(task({ id: 'p', title: 'Parent', parentTaskId: 'gp' }));
    history.insertTask(task({ id: 'gc', title: 'Grandchild', parentTaskId: 'p' }));
    const hdb = history.getDb();
    hdb.prepare("UPDATE tasks SET created_at = '2026-01-01T00:00:00Z' WHERE id = 'gc'").run();
    hdb.prepare("UPDATE tasks SET created_at = '2026-03-01T00:00:00Z' WHERE id = 'p'").run();
    hdb.prepare("UPDATE tasks SET created_at = '2026-06-01T00:00:00Z' WHERE id = 'gp'").run();

    const res = new VerbGraphBackfill(engine, hdb).run();

    const store = new TaskStore(engine);
    expect(store.get('gc')!.parentTaskId).toBe('p');  // grandchild → parent
    expect(store.get('p')!.parentTaskId).toBe('gp');  // parent → grandparent
    expect(store.get('gp')!.parentTaskId).toBeNull(); // root
    expect(res.taskParentLinks).toBe(2);
  });

  // NB: legacy history.db `tasks` ENFORCES the parent_task_id FK (a legacy insert of a
  // task with a non-existent parent throws), so the backfill never meets a PERMANENTLY
  // dangling parent — the two-pass above always fully resolves. The transient NULL that
  // the FK-guard produces (a child scanned before its parent in pass-1) is exercised by
  // that test; the guard's unit behaviour is pinned in task-store.test.ts.

  it('preserves legacy timestamps so the post-cutover list order survives', () => {
    const { history, engine } = make();
    history.insertTask(task({ id: 'kk-1' }));
    history.getDb().prepare("UPDATE tasks SET created_at = '2025-05-05T05:05:05Z' WHERE id = 'kk-1'").run();

    new VerbGraphBackfill(engine, history.getDb()).run();

    expect(new TaskStore(engine).get('kk-1')!.createdAt).toBe('2025-05-05T05:05:05Z');
  });

  it('is idempotent: a re-run adds no duplicate rows and does NOT drift updated_at to now', () => {
    const { history, engine } = make();
    history.insertTask(task({ id: 'p' }));
    history.insertTask(task({ id: 'c', parentTaskId: 'p' }));
    // Pin a legacy created_at so the re-run's updated_at (= the same legacy ts, via the
    // with-ts CONFLICT path `updated_at = excluded.updated_at`) can be checked against a
    // known value — a regression to datetime('now') would drift it on EVERY re-run.
    history.getDb().prepare("UPDATE tasks SET created_at = '2025-09-09T09:09:09Z', updated_at = '2025-09-09T09:09:09Z' WHERE id = 'p'").run();
    const engUpdatedAt = () => (engine.getDb()
      .prepare("SELECT updated_at FROM tasks WHERE id = 'p'").get() as { updated_at: string }).updated_at;

    new VerbGraphBackfill(engine, history.getDb()).run();
    expect(engUpdatedAt()).toBe('2025-09-09T09:09:09Z'); // preserved on first apply
    const res2 = new VerbGraphBackfill(engine, history.getDb()).run();

    expect(res2.tasks).toBe(2);
    expect(count(engine)).toBe(2);
    expect(engUpdatedAt()).toBe('2025-09-09T09:09:09Z'); // re-run does NOT bump to now
    expect(new TaskStore(engine).get('c')!.parentTaskId).toBe('p'); // link stays resolved
  });

  it('empty legacy → zero counts, no throw', () => {
    const { history, engine } = make();
    const res = new VerbGraphBackfill(engine, history.getDb()).run();
    expect(res).toEqual({ workflows: 0, triggers: 0, tasks: 0, taskParentLinks: 0 });
  });

  it('resolveAssignee (cutover) resolves every backfilled task + seeds the self-person', () => {
    const { history, engine } = make();
    history.insertTask(task({ id: 'a', assignee: 'user' }));
    history.insertTask(task({ id: 'b', assignee: 'Sarah' }));
    history.insertTask(task({ id: 'c', assignee: 'user' }));

    new VerbGraphBackfill(engine, history.getDb()).run({ resolveAssignee: true });

    const store = new TaskStore(engine);
    expect(store.getRecord('a')?.assignee).toBe('user');
    expect(store.getRecord('b')?.assignee).toBe('Sarah');
    expect(store.getRecord('c')?.assignee).toBe('user');
    // one self-person (shared by a + c) + one 'Sarah'
    const self = engine.getDb().prepare("SELECT COUNT(*) n FROM subjects WHERE is_self=1").get() as { n: number };
    const people = engine.getDb().prepare("SELECT COUNT(*) n FROM subjects WHERE kind='person'").get() as { n: number };
    expect(self.n).toBe(1);
    expect(people.n).toBe(2);
  });

  it('WITHOUT resolveAssignee the backfill mints no subjects (flag-OFF stays subject-free)', () => {
    const { history, engine } = make();
    history.insertTask(task({ id: 'a', assignee: 'user' }));
    new VerbGraphBackfill(engine, history.getDb()).run();
    const n = engine.getDb().prepare('SELECT COUNT(*) n FROM subjects').get() as { n: number };
    expect(n.n).toBe(0);
    const raw = engine.getDb().prepare("SELECT assignee_subject_id sid FROM tasks WHERE id='a'").get() as { sid: string | null };
    expect(raw.sid).toBeNull();
  });
});

/**
 * B1 self-heal — the WORKFLOW + TRIGGER backfill. A v1.22.0→v2.0.0 tenant never
 * mirrored its pre-cutover verb defs into engine.db (the arc landed after v1.22.0),
 * and reads were cut to engine.db (S3f). mig v44 is now NON-destructive, so the
 * legacy `triggers` table + planned-pipeline rows survive as the backfill source;
 * the engine copies them at boot. These tests seed those legacy tables RAW (the real
 * pre-mirror shape — legacy `triggers` carries the pre-#850 `task_type`) and prove
 * the backfill relocates them with the source/effect axes correctly derived + the
 * trigger→workflow FK resolved.
 */
describe('VerbGraphBackfill — workflows + triggers (B1 self-heal)', () => {
  const tmpDirs: string[] = [];
  const engines: EngineDb[] = [];
  const histories: RunHistory[] = [];

  function make(): { history: RunHistory; engine: EngineDb } {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-vbf-'));
    tmpDirs.push(dir);
    const history = new RunHistory(join(dir, 'history.db'), 'vk');
    const engine = new EngineDb(join(dir, 'engine.db'), 'vk');
    histories.push(history);
    engines.push(engine);
    return { history, engine };
  }

  afterEach(() => {
    for (const e of engines) { try { e.close(); } catch { /* already closed */ } }
    for (const h of histories) { try { h.close(); } catch { /* already closed */ } }
    engines.length = 0; histories.length = 0;
    for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  /** Seed one RAW legacy `triggers` row (v42 schema — carries `task_type`). */
  function seedLegacyTrigger(db: Database.Database, over: {
    id: string; title?: string; task_type?: string; schedule_cron?: string | null;
    watch_config?: string | null; pipeline_id?: string | null; enabled?: number; created_at?: string;
  }): void {
    db.prepare(
      `INSERT INTO triggers (id, title, description, status, assignee, scope_type, scope_id,
        created_at, updated_at, schedule_cron, task_type, watch_config, pipeline_id, enabled)
       VALUES (@id, @title, '', 'open', 'lynox', 'project', '', @created_at, @created_at,
        @schedule_cron, @task_type, @watch_config, @pipeline_id, @enabled)`,
    ).run({
      id: over.id,
      title: over.title ?? 'A trigger',
      created_at: over.created_at ?? '2026-02-02T02:02:02Z',
      schedule_cron: over.schedule_cron ?? null,
      task_type: over.task_type ?? 'manual',
      watch_config: over.watch_config ?? null,
      pipeline_id: over.pipeline_id ?? null,
      enabled: over.enabled ?? 1,
    });
  }

  /** Seed one RAW legacy saved-workflow (`pipeline_runs status='planned'`). */
  function seedLegacyWorkflow(db: Database.Database, id: string, name: string): void {
    db.prepare(
      `INSERT INTO pipeline_runs (id, manifest_name, status, manifest_json, step_count, started_at)
       VALUES (?, ?, 'planned', ?, 2, '2026-01-01T00:00:00Z')`,
    ).run(id, name, JSON.stringify({ name, goal: 'do the thing', steps: [{}, {}] }));
  }

  it('relocates legacy workflows + triggers into engine.db with counts', () => {
    const { history, engine } = make();
    const hdb = history.getDb();
    seedLegacyWorkflow(hdb, 'wf-1', 'Weekly report');
    seedLegacyTrigger(hdb, { id: 'tr-1', schedule_cron: '0 9 * * 1', pipeline_id: 'wf-1' });

    expect(new WorkflowStore(engine).get('wf-1')).toBeUndefined(); // engine.db empty pre-backfill

    const res = new VerbGraphBackfill(engine, hdb).run();

    expect(res.workflows).toBe(1);
    expect(res.triggers).toBe(1);
    const wf = new WorkflowStore(engine).get('wf-1');
    expect(wf?.name).toBe('Weekly report');
    expect(new TriggerStore(engine).get('tr-1')).toBeDefined();
  });

  it('derives source/effect from the legacy task_type (the #850 remap twin)', () => {
    const { history, engine } = make();
    const hdb = history.getDb();
    seedLegacyWorkflow(hdb, 'wf-x', 'WF');
    // backup → cron/backup ; reminder → cron/notify ; cron+pipeline → cron/run_workflow ;
    // watch → watch/run_agent ; bare manual → manual/run_agent
    seedLegacyTrigger(hdb, { id: 't-backup', task_type: 'backup' });
    seedLegacyTrigger(hdb, { id: 't-reminder', task_type: 'reminder' });
    seedLegacyTrigger(hdb, { id: 't-wf', task_type: 'manual', schedule_cron: '0 9 * * *', pipeline_id: 'wf-x' });
    seedLegacyTrigger(hdb, { id: 't-watch', task_type: 'manual', watch_config: '{"url":"https://x"}' });
    seedLegacyTrigger(hdb, { id: 't-manual', task_type: 'manual' });
    // task_type='pipeline' with a NULL pipeline_id — the v3-migration edge: MUST derive
    // run_workflow (safe skip), NOT run_agent (an autonomous money run of the title).
    seedLegacyTrigger(hdb, { id: 't-pipe-noid', task_type: 'pipeline' });

    new VerbGraphBackfill(engine, hdb).run();

    const se = (id: string) => engine.getDb()
      .prepare('SELECT source, effect FROM triggers WHERE id = ?').get(id) as { source: string; effect: string };
    expect(se('t-backup')).toEqual({ source: 'cron', effect: 'backup' });
    expect(se('t-reminder')).toEqual({ source: 'cron', effect: 'notify' });
    expect(se('t-wf')).toEqual({ source: 'cron', effect: 'run_workflow' });
    expect(se('t-watch')).toEqual({ source: 'watch', effect: 'run_agent' });
    expect(se('t-manual')).toEqual({ source: 'manual', effect: 'run_agent' });
    expect(se('t-pipe-noid').effect).toBe('run_workflow'); // NOT run_agent — matches v3 migration
  });

  it('resolves the trigger→workflow FK when the workflow exists (order: workflows first)', () => {
    const { history, engine } = make();
    const hdb = history.getDb();
    seedLegacyWorkflow(hdb, 'wf-2', 'Target');
    seedLegacyTrigger(hdb, { id: 'tr-2', pipeline_id: 'wf-2' });

    new VerbGraphBackfill(engine, hdb).run();

    const row = engine.getDb().prepare("SELECT target_workflow_id FROM triggers WHERE id='tr-2'")
      .get() as { target_workflow_id: string | null };
    expect(row.target_workflow_id).toBe('wf-2'); // FK resolved, not NULLed
  });

  it('NULLs an orphan trigger→workflow link (FK-guard) instead of throwing', () => {
    const { history, engine } = make();
    const hdb = history.getDb();
    seedLegacyTrigger(hdb, { id: 'tr-orphan', pipeline_id: 'wf-missing' }); // no such workflow

    expect(() => new VerbGraphBackfill(engine, hdb).run()).not.toThrow();

    const row = engine.getDb().prepare("SELECT target_workflow_id FROM triggers WHERE id='tr-orphan'")
      .get() as { target_workflow_id: string | null };
    expect(row.target_workflow_id).toBeNull();
  });

  it('is idempotent: re-run adds no duplicate workflow/trigger rows', () => {
    const { history, engine } = make();
    const hdb = history.getDb();
    seedLegacyWorkflow(hdb, 'wf-3', 'Once');
    seedLegacyTrigger(hdb, { id: 'tr-3', schedule_cron: '0 8 * * *' });

    new VerbGraphBackfill(engine, hdb).run();
    const res2 = new VerbGraphBackfill(engine, hdb).run();

    expect(res2.workflows).toBe(1);
    expect(res2.triggers).toBe(1);
    const wfN = engine.getDb().prepare('SELECT COUNT(*) n FROM workflows').get() as { n: number };
    const trN = engine.getDb().prepare('SELECT COUNT(*) n FROM triggers').get() as { n: number };
    expect(wfN.n).toBe(1);
    expect(trN.n).toBe(1);
  });

  it('mig v44 is NON-destructive: the legacy triggers table survives RunHistory construction (C1-4)', () => {
    const { history } = make();
    // The whole B1 fix rests on this: opening RunHistory (which migrates to v44) must
    // NOT drop the legacy `triggers` table — else the backfill has no source and even
    // a dry-run would destroy the data it means to preserve.
    const exists = history.getDb()
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='triggers'").get();
    expect(exists).toBeDefined();
  });

  it('the boot marker gates the backfill exactly-once — a post-upgrade DELETE is NOT resurrected', () => {
    // Mirrors the engine.ts boot gate `if (!engineDb.isVerbBackfillDone())`. The
    // legacy `triggers` rows stay dormant (v44 non-destructive), so WITHOUT the
    // exactly-once marker a definition the user deletes after the upgrade would be
    // re-created from legacy on the very next boot. The marker prevents that.
    const { history, engine } = make();
    const hdb = history.getDb();
    seedLegacyTrigger(hdb, { id: 'tr-keep' });
    seedLegacyTrigger(hdb, { id: 'tr-del' });

    // First boot: marker unset → backfill runs → mark done.
    expect(engine.isVerbBackfillDone()).toBe(false);
    if (!engine.isVerbBackfillDone()) {
      new VerbGraphBackfill(engine, hdb).run();
      engine.markVerbBackfillDone();
    }
    expect(engine.isVerbBackfillDone()).toBe(true);
    const store = new TriggerStore(engine);
    expect(store.get('tr-del')).toBeDefined();

    // User deletes a trigger post-upgrade (engine.db is now authoritative).
    expect(store.remove('tr-del')).toBe(true);

    // Second boot: marker is SET → the gate skips the backfill → the legacy row is
    // NOT replayed. Simulate the exact gate.
    if (!engine.isVerbBackfillDone()) {
      new VerbGraphBackfill(engine, hdb).run(); // must NOT execute
    }
    expect(new TriggerStore(engine).get('tr-del')).toBeUndefined(); // stays deleted
    expect(new TriggerStore(engine).get('tr-keep')).toBeDefined();  // untouched
  });
});
