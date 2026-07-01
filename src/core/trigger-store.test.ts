import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngineDb } from './engine-db.js';
import { TriggerStore, triggerRecordToRow, type TriggerRow } from './trigger-store.js';
import type { TriggerRecord } from '../types/pipeline.js';

describe('TriggerStore (Foundation Rework v2 — S3b)', () => {
  const tmpDirs: string[] = [];
  const engines: EngineDb[] = [];

  function make(key = ''): { store: TriggerStore; engine: EngineDb } {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-trg-'));
    tmpDirs.push(dir);
    const engine = new EngineDb(join(dir, 'engine.db'), key);
    engines.push(engine);
    return { store: new TriggerStore(engine), engine };
  }

  /** Seed a workflows row so a trigger's target_workflow_id FK can resolve. */
  function seedWorkflow(engine: EngineDb, id: string): void {
    engine.getDb().prepare(
      "INSERT INTO workflows (id, name, definition_json) VALUES (?, ?, '{}')",
    ).run(id, 'W');
  }

  function baseRow(over: Partial<TriggerRow> = {}): TriggerRow {
    return {
      id: 't1',
      title: 'Daily report',
      description: 'send it',
      source: 'cron',
      conditionJson: JSON.stringify({ schedule_cron: '0 9 * * *', watch_config: null }),
      paramsJson: '{"tone":"brief"}',
      status: 'open',
      enabled: true,
      retryCount: 0,
      ...over,
    };
  }

  afterEach(() => {
    // Close in afterEach (not at test-body end) so a mid-test throw still releases
    // the sqlite handle before rmSync — no leaked -wal/-shm or "database is locked".
    for (const e of engines) { try { e.close(); } catch { /* already closed */ } }
    engines.length = 0;
    for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  it('upsert → get round-trips a trigger and maps enabled', () => {
    const { store } = make();
    store.upsert(baseRow());
    const got = store.get('t1');
    expect(got?.title).toBe('Daily report');
    expect(got?.source).toBe('cron');
    expect(got?.conditionJson).toBe(JSON.stringify({ schedule_cron: '0 9 * * *', watch_config: null }));
    expect(got?.paramsJson).toBe('{"tone":"brief"}');
    expect(got?.enabled).toBe(true);
    expect(got?.retryCount).toBe(0);
  });

  it('upsert ts (S3d backfill) preserves timestamps; no-ts defaults to now', () => {
    const { store, engine } = make();
    const ts = (id: string) => engine.getDb()
      .prepare('SELECT created_at, updated_at FROM triggers WHERE id = ?')
      .get(id) as { created_at: string; updated_at: string };

    store.upsert(baseRow({ id: 'bf' }), { createdAt: '2025-02-02T02:02:02Z', updatedAt: '2025-02-02T02:02:02Z' });
    expect(ts('bf')).toEqual({ created_at: '2025-02-02T02:02:02Z', updated_at: '2025-02-02T02:02:02Z' });

    store.upsert(baseRow({ id: 'nw' }));
    const now = ts('nw');
    expect(now.created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(now.updated_at).toBe(now.created_at);

    // conflict paths: a no-ts re-upsert bumps updated_at to now; a with-ts re-upsert
    // restores it to the legacy ts (the backfill-idempotency path).
    store.upsert(baseRow({ id: 'bf' }));
    expect(ts('bf').updated_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    store.upsert(baseRow({ id: 'bf' }), { createdAt: '2025-02-02T02:02:02Z', updatedAt: '2025-02-02T02:02:02Z' });
    expect(ts('bf').updated_at).toBe('2025-02-02T02:02:02Z');
  });

  it('upsert is idempotent by id and preserves created_at across a re-projection', () => {
    const { store, engine } = make();
    store.upsert(baseRow({ title: 'v1' }));
    // Pin created_at to a sentinel BEFORE the re-projection: without it both upserts
    // land in the same wall-clock second, so a regression to INSERT OR REPLACE
    // (which re-defaults created_at) would still yield an identical timestamp and
    // the assertion could not fail — the sentinel makes it guard the invariant.
    engine.getDb().prepare("UPDATE triggers SET created_at = '2000-01-01 00:00:00' WHERE id = 't1'").run();
    store.upsert(baseRow({ title: 'v2', enabled: false }));
    const after = store.get('t1')!;
    expect(after.title).toBe('v2');
    expect(after.enabled).toBe(false);
    // ON CONFLICT DO UPDATE preserves created_at; INSERT OR REPLACE would re-default it.
    expect(after.createdAt).toBe('2000-01-01 00:00:00');
    expect(store.list()).toHaveLength(1);
  });

  it('FK-guard: target_workflow_id is kept when the referenced workflow exists', () => {
    const { store, engine } = make();
    seedWorkflow(engine, 'wf-1');
    store.upsert(baseRow({ targetWorkflowId: 'wf-1' }));
    expect(store.get('t1')?.targetWorkflowId).toBe('wf-1');
  });

  it('FK-guard: an orphan target_workflow_id is stored NULL, not thrown (pre-flag orphan)', () => {
    const { store } = make();
    // engine.db enforces foreign_keys=ON, so a target pointing at a not-yet-mirrored
    // workflow would REJECT the insert. The guard nulls it instead of throwing, so
    // the mirror degrades gracefully (S3d backfill re-links in dependency order).
    expect(() => store.upsert(baseRow({ targetWorkflowId: 'ghost' }))).not.toThrow();
    expect(store.get('t1')?.targetWorkflowId).toBeNull();
  });

  it('remove deletes by EXACT id only (never a prefix sibling)', () => {
    const { store } = make();
    store.upsert(baseRow({ id: 'run-1' }));
    store.upsert(baseRow({ id: 'run-12' }));
    expect(store.remove('run-1')).toBe(true);
    expect(store.get('run-1')).toBeUndefined();
    expect(store.get('run-12')).toBeDefined(); // exact-id delete — the sibling survives
    expect(store.remove('')).toBe(false);       // empty-id no-op
  });

  it('list orders most-recently-touched first (updated_at DESC)', () => {
    const { store, engine } = make();
    store.upsert(baseRow({ id: 'a' }));
    store.upsert(baseRow({ id: 'b' }));
    // Force a distinct updated_at (via the shared connection) so it isn't a tie.
    engine.getDb().prepare("UPDATE triggers SET updated_at = datetime('now','+1 second') WHERE id = 'a'").run();
    expect(store.list().map(t => t.id)).toEqual(['a', 'b']);
  });

  it('re-projection does NOT clobber engine.db-only columns the mirror does not own', () => {
    const { store, engine } = make();
    store.upsert(baseRow());
    // Simulate a later slice (S3d/S4) populating a column S3b does not write.
    // last_run_id is a plain soft-ref (no FK), so no parent row is needed.
    engine.getDb().prepare("UPDATE triggers SET last_run_id = 'run-xyz' WHERE id = 't1'").run();
    store.upsert(baseRow({ title: 'changed' }));
    const raw = engine.getDb().prepare("SELECT last_run_id FROM triggers WHERE id = 't1'").get() as { last_run_id: string | null };
    expect(raw.last_run_id).toBe('run-xyz'); // untouched by the mirror upsert
  });
});

describe('triggerRecordToRow (legacy → engine.db mapping)', () => {
  function rec(over: Partial<TriggerRecord> = {}): TriggerRecord {
    return {
      id: 't1', title: 'T', description: 'd', status: 'open', assignee: 'lynox',
      scope_type: 'project', scope_id: 'proj-1', created_at: 'now', updated_at: 'now',
      ...over,
    };
  }

  it('maps a scheduled pipeline trigger faithfully', () => {
    const row = triggerRecordToRow(rec({
      task_type: 'pipeline', schedule_cron: '0 9 * * *',
      pipeline_id: 'wf-9', pipeline_params: '{"x":1}', next_run_at: '2026-07-02',
      enabled: 1, retry_count: 2,
    }));
    expect(row.source).toBe('pipeline');       // task_type preserved VERBATIM
    expect(row.targetWorkflowId).toBe('wf-9');  // pipeline_id → target_workflow_id (candidate)
    expect(row.paramsJson).toBe('{"x":1}');     // pipeline_params → params_json
    expect(row.nextRunAt).toBe('2026-07-02');
    expect(row.enabled).toBe(true);
    expect(row.retryCount).toBe(2);
    // scope fields relocate verbatim (they carry the customer-scoping axis at S3d;
    // StoredTrigger omits them, so assert on the mapper output directly).
    expect(row.scopeType).toBe('project');
    expect(row.scopeId).toBe('proj-1');
    // condition_json carries both raw legacy columns (round-trippable at S3d)
    expect(JSON.parse(row.conditionJson)).toEqual({ schedule_cron: '0 9 * * *', watch_config: null });
  });

  it('round-trips watch_config as a RAW string (byte-identical at S3d, no re-encode)', () => {
    const wc = '{"url":"https://x.test","selector":".price"}';
    const row = triggerRecordToRow(rec({ task_type: 'watch', watch_config: wc }));
    expect(row.source).toBe('watch');
    expect(JSON.parse(row.conditionJson).watch_config).toBe(wc);
  });

  it('absent task_type → manual; absent enabled → enabled; absent params → {}; absent pipeline_id → null', () => {
    const row = triggerRecordToRow(rec({}));
    expect(row.source).toBe('manual');
    expect(row.enabled).toBe(true);       // undefined !== 0
    expect(row.paramsJson).toBe('{}');
    expect(row.targetWorkflowId).toBeNull();
    expect(row.retryCount).toBe(0);
  });

  it('enabled=0 maps to false (the cron kill-switch)', () => {
    expect(triggerRecordToRow(rec({ enabled: 0 })).enabled).toBe(false);
  });
});
