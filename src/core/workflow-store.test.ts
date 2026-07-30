import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { EngineDb } from './engine-db.js';
import { WorkflowStore } from './workflow-store.js';
import { migratePipelineBlob, CURRENT_PIPELINE_SCHEMA_VERSION } from './pipeline-schema-migration.js';

describe('WorkflowStore (Foundation Rework v2 — S3a)', () => {
  const tmpDirs: string[] = [];
  const engines: EngineDb[] = [];

  function make(key = ''): { store: WorkflowStore; engine: EngineDb; path: string } {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-wf-'));
    tmpDirs.push(dir);
    const path = join(dir, 'engine.db');
    const engine = new EngineDb(path, key);
    engines.push(engine);
    return { store: new WorkflowStore(engine), engine, path };
  }

  afterEach(() => {
    // Close in afterEach (not at test-body end) so a mid-test throw still releases
    // the sqlite handle before rmSync — no leaked -wal/-shm or "database is locked".
    for (const e of engines) { try { e.close(); } catch { /* already closed */ } }
    engines.length = 0;
    for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  it('upsert → get round-trips the definition and maps is_template', () => {
    const { store } = make();
    const def = JSON.stringify({ id: 'wf1', name: 'Weekly report', goal: 'send report', template: true });
    store.upsert({ id: 'wf1', name: 'Weekly report', description: 'send report', definitionJson: def, isTemplate: true });
    const got = store.get('wf1');
    expect(got?.name).toBe('Weekly report');
    expect(got?.description).toBe('send report');
    expect(got?.isTemplate).toBe(true);
    expect(got?.definitionJson).toBe(def);
  });

  it('upsert ts (S3d backfill) preserves timestamps; no-ts still defaults to now + bumps on re-save', () => {
    const { store, engine } = make();
    const ts = (id: string) => engine.getDb()
      .prepare('SELECT created_at, updated_at FROM workflows WHERE id = ?')
      .get(id) as { created_at: string; updated_at: string };

    // backfill path: explicit legacy timestamps land verbatim on both columns.
    store.upsert({ id: 'wf-bf', name: 'N', description: '', definitionJson: '{}', isTemplate: false },
      { createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z' });
    expect(ts('wf-bf')).toEqual({ created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z' });

    // live-mirror path: no ts → both default to datetime('now') (space form, not the ISO sentinel).
    store.upsert({ id: 'wf-now', name: 'N', description: '', definitionJson: '{}', isTemplate: false });
    const now = ts('wf-now');
    expect(now.created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(now.updated_at).toBe(now.created_at);

    // re-save without ts: created_at preserved, updated_at bumped (unchanged S3a invariant).
    store.upsert({ id: 'wf-bf', name: 'N2', description: '', definitionJson: '{}', isTemplate: false });
    const after = ts('wf-bf');
    expect(after.created_at).toBe('2025-01-01T00:00:00Z');
    expect(after.updated_at).not.toBe('2025-01-01T00:00:00Z');

    // re-upsert WITH ts on conflict restores updated_at to the legacy ts (the
    // backfill-idempotency path — a regression to datetime('now') would fail here).
    store.upsert({ id: 'wf-bf', name: 'N3', description: '', definitionJson: '{}', isTemplate: false },
      { createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z' });
    expect(ts('wf-bf').updated_at).toBe('2025-01-01T00:00:00Z');
  });

  it('upsert is idempotent by id and preserves created_at across a re-save', () => {
    const { store, engine } = make();
    store.upsert({ id: 'wf1', name: 'v1', definitionJson: '{"id":"wf1","name":"v1"}', isTemplate: false });
    // Pin created_at to a distinctive sentinel BEFORE the re-save. Without this
    // both upserts land in the same wall-clock second, so a regression to
    // INSERT OR REPLACE (which re-defaults created_at to datetime('now')) would
    // still yield an identical second-granularity timestamp and the assertion
    // below could not fail — the sentinel makes it actually guard the invariant.
    engine.getDb().prepare("UPDATE workflows SET created_at = '2000-01-01 00:00:00' WHERE id = 'wf1'").run();
    store.upsert({ id: 'wf1', name: 'v2', definitionJson: '{"id":"wf1","name":"v2"}', isTemplate: true });
    expect(store.list()).toHaveLength(1);
    const after = store.get('wf1')!;
    expect(after.name).toBe('v2');
    expect(after.isTemplate).toBe(true);
    // ON CONFLICT DO UPDATE preserves created_at; INSERT OR REPLACE would re-default it.
    expect(after.createdAt).toBe('2000-01-01 00:00:00');
  });

  it('stores definition_json PLAINTEXT on disk (faithful to legacy manifest_json; at-rest enc deferred)', () => {
    const { store, engine, path } = make('a-vault-key-for-testing');
    const def = '{"goal":"email john@acme.com"}';
    store.upsert({ id: 'wf1', name: 'Title', definitionJson: def, isTemplate: false });
    expect(store.get('wf1')?.definitionJson).toBe(def);
    engine.close();
    // On-disk: definition_json is the exact plaintext (documents the deliberate
    // S3a choice — a future hardening slice encrypts legacy + engine.db together).
    const raw = new Database(path, { readonly: true });
    const row = raw.prepare('SELECT definition_json FROM workflows WHERE id = ?').get('wf1') as { definition_json: string };
    raw.close();
    expect(row.definition_json).toBe(def);
  });

  it('rename patches both the name column and definition_json.$.name (json_set, untouched fields survive)', () => {
    const { store } = make();
    store.upsert({ id: 'wf1', name: 'Old', definitionJson: JSON.stringify({ id: 'wf1', name: 'Old', goal: 'g' }), isTemplate: true });
    expect(store.rename('wf1', 'New')).toBe(true);
    const got = store.get('wf1')!;
    expect(got.name).toBe('New');
    expect((JSON.parse(got.definitionJson) as { name: string }).name).toBe('New');
    expect((JSON.parse(got.definitionJson) as { goal: string }).goal).toBe('g');
  });

  it('rename patches ALL prefix matches (mirrors legacy unbounded UPDATE)', () => {
    const { store } = make();
    store.upsert({ id: 'abc-1', name: 'Old', definitionJson: JSON.stringify({ id: 'abc-1', name: 'Old' }), isTemplate: true });
    store.upsert({ id: 'abc-2', name: 'Old', definitionJson: JSON.stringify({ id: 'abc-2', name: 'Old' }), isTemplate: true });
    expect(store.rename('abc', 'New')).toBe(true); // short prefix hits both
    expect(store.get('abc-1')!.name).toBe('New');
    expect(store.get('abc-2')!.name).toBe('New');
  });

  it('rename returns false for an unknown id', () => {
    const { store } = make();
    expect(store.rename('nope', 'X')).toBe(false);
  });

  it('setConfirmedAt stamps definition_json.$.confirmedAt', () => {
    const { store } = make();
    store.upsert({ id: 'wf1', name: 'W', definitionJson: JSON.stringify({ id: 'wf1', name: 'W' }), isTemplate: true });
    expect(store.setConfirmedAt('wf1', '2026-07-01T00:00:00Z')).toBe(true);
    expect((JSON.parse(store.get('wf1')!.definitionJson) as { confirmedAt: string }).confirmedAt).toBe('2026-07-01T00:00:00Z');
  });

  it('remove deletes by exact id and by prefix (mirrors deletePlannedPipeline)', () => {
    const { store } = make();
    store.upsert({ id: 'abcdef-1234', name: 'W', definitionJson: '{}', isTemplate: false });
    expect(store.remove('abcdef')).toBe(true); // prefix match
    expect(store.get('abcdef-1234')).toBeUndefined();
  });

  it('LIKE metacharacters in an id are escaped — a "%" id does NOT wipe the table', () => {
    const { store } = make();
    store.upsert({ id: 'wf1', name: 'A', definitionJson: '{}', isTemplate: false });
    store.upsert({ id: 'wf2', name: 'B', definitionJson: '{}', isTemplate: false });
    // Without ESCAPE, remove('%') → LIKE '%%' would delete every row.
    expect(store.remove('%')).toBe(false);
    expect(store.list()).toHaveLength(2);
  });

  it('an empty id is guarded — it never prefix-matches (would collapse to the "%" wildcard)', () => {
    const { store } = make();
    store.upsert({ id: 'wf1', name: 'A', definitionJson: '{}', isTemplate: false });
    store.upsert({ id: 'wf2', name: 'B', definitionJson: '{}', isTemplate: false });
    // likePrefix('') would be a bare '%' → match ALL rows; every prefix method
    // must short-circuit an empty id to a no-match instead of a table-wipe.
    expect(store.remove('')).toBe(false);
    expect(store.rename('', 'X')).toBe(false);
    expect(store.setConfirmedAt('', '2026-07-01T00:00:00Z')).toBe(false);
    expect(store.get('')).toBeUndefined();
    expect(store.list()).toHaveLength(2);
  });

  it('dropExecuted deletes only by EXACT id (never a prefix sibling)', () => {
    const { store } = make();
    store.upsert({ id: 'run-1', name: 'A', definitionJson: '{}', isTemplate: false });
    store.upsert({ id: 'run-12', name: 'B', definitionJson: '{}', isTemplate: false });
    expect(store.dropExecuted('run-1')).toBe(true);
    // Only the exact 'run-1' is gone; the prefix sibling 'run-12' survives.
    // (get() is prefix-matching like legacy getPlannedPipeline, so assert via list.)
    const remaining = store.list();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.id).toBe('run-12');
  });

  it('list orders most-recently-touched first (updated_at DESC, matches legacy started_at)', () => {
    const { store, engine } = make();
    store.upsert({ id: 'a', name: 'A', definitionJson: '{}', isTemplate: true });
    store.upsert({ id: 'b', name: 'B', definitionJson: '{}', isTemplate: false });
    // A re-saved workflow must float to the top (legacy resets started_at via
    // INSERT OR REPLACE; the mirror bumps updated_at). Force a distinct updated_at
    // (via the shared connection) so the assertion isn't a second-granularity tie.
    engine.getDb().prepare("UPDATE workflows SET updated_at = datetime('now','+1 second') WHERE id = 'a'").run();
    expect(store.list().map(w => w.id)).toEqual(['a', 'b']);
  });

  it('rename does NOT reorder the list (updated_at untouched — matches legacy started_at, transparent cutover)', () => {
    const { store, engine } = make();
    store.upsert({ id: 'a', name: 'A', definitionJson: '{"name":"A"}', isTemplate: true });
    // Force 'a' older so 'b' sorts first deterministically.
    engine.getDb().prepare("UPDATE workflows SET updated_at = datetime('now','-10 seconds') WHERE id = 'a'").run();
    store.upsert({ id: 'b', name: 'B', definitionJson: '{"name":"B"}', isTemplate: true });
    expect(store.list().map(w => w.id)).toEqual(['b', 'a']);
    // A rename must NOT float 'a' above 'b' (legacy leaves started_at untouched).
    store.rename('a', 'A2');
    expect(store.list().map(w => w.id)).toEqual(['b', 'a']);
  });

  describe('migrateContentSchema (Move 1 — content-schema versioning)', () => {
    it('stamps a legacy row (no schema_version) to the current version, content otherwise preserved', () => {
      const { store } = make();
      const legacy = JSON.stringify({ id: 'wf1', name: 'W', goal: 'g', steps: [] });
      store.upsert({ id: 'wf1', name: 'W', definitionJson: legacy, isTemplate: true });
      expect(store.migrateContentSchema(migratePipelineBlob)).toEqual({ scanned: 1, migrated: 1 });
      const def = JSON.parse(store.get('wf1')!.definitionJson) as Record<string, unknown>;
      expect(def['schema_version']).toBe(CURRENT_PIPELINE_SCHEMA_VERSION);
      expect(def['goal']).toBe('g');
    });

    it('is idempotent — a second pass migrates 0', () => {
      const { store } = make();
      store.upsert({ id: 'wf1', name: 'W', definitionJson: JSON.stringify({ id: 'wf1' }), isTemplate: false });
      expect(store.migrateContentSchema(migratePipelineBlob).migrated).toBe(1);
      expect(store.migrateContentSchema(migratePipelineBlob)).toEqual({ scanned: 1, migrated: 0 });
    });

    it('preserves updated_at (a migration is not a re-save — must not reorder the library)', () => {
      const { store, engine } = make();
      store.upsert({ id: 'wf1', name: 'W', definitionJson: JSON.stringify({ id: 'wf1' }), isTemplate: false });
      engine.getDb().prepare("UPDATE workflows SET updated_at = '2000-01-01 00:00:00' WHERE id = 'wf1'").run();
      store.migrateContentSchema(migratePipelineBlob);
      const row = engine.getDb().prepare('SELECT updated_at FROM workflows WHERE id = ?').get('wf1') as { updated_at: string };
      expect(row.updated_at).toBe('2000-01-01 00:00:00');
    });

    it('migrates only rows that need it — the post-crash resume property (mixed legacy + current)', () => {
      const { store } = make();
      store.upsert({ id: 'legacy', name: 'L', definitionJson: JSON.stringify({ id: 'legacy' }), isTemplate: false });
      store.upsert({ id: 'current', name: 'C', definitionJson: JSON.stringify({ id: 'current', schema_version: CURRENT_PIPELINE_SCHEMA_VERSION }), isTemplate: false });
      // A crash mid-migration leaves some rows stamped and some not; a re-run must
      // touch ONLY the unstamped ones. The per-blob version gate gives this for free.
      expect(store.migrateContentSchema(migratePipelineBlob)).toEqual({ scanned: 2, migrated: 1 });
    });

    it('leaves a malformed row untouched (skipped, not counted, no throw)', () => {
      const { store } = make();
      store.upsert({ id: 'bad', name: 'B', definitionJson: 'not json {', isTemplate: false });
      expect(() => store.migrateContentSchema(migratePipelineBlob)).not.toThrow();
      expect(store.migrateContentSchema(migratePipelineBlob).migrated).toBe(0);
      expect(store.get('bad')!.definitionJson).toBe('not json {');
    });

    it('strips the legacy executionMode tombstone from a stored blob (v1b end-to-end)', () => {
      const { store } = make();
      store.upsert({ id: 'wf1', name: 'W', definitionJson: JSON.stringify({ id: 'wf1', executionMode: 'tracked' }), isTemplate: false });
      expect(store.migrateContentSchema(migratePipelineBlob).migrated).toBe(1);
      const def = JSON.parse(store.get('wf1')!.definitionJson) as Record<string, unknown>;
      expect('executionMode' in def).toBe(false);
      expect(def['schema_version']).toBe(CURRENT_PIPELINE_SCHEMA_VERSION);
    });
  });
});
