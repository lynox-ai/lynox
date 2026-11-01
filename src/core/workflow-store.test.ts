import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { EngineDb } from './engine-db.js';
import { WorkflowStore } from './workflow-store.js';
import { CP_ADMIN_PRINCIPAL, OWNER_PRINCIPAL, type RequestPrincipal } from './request-principal.js';
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
    store.upsert({ id: 'wf1', name: 'Weekly report', description: 'send report', definitionJson: def, isTemplate: true }, null);
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
    store.upsert({ id: 'wf-bf', name: 'N', description: '', definitionJson: '{}', isTemplate: false }, null,
      { createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z' });
    expect(ts('wf-bf')).toEqual({ created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z' });

    // live-mirror path: no ts → both default to datetime('now') (space form, not the ISO sentinel).
    store.upsert({ id: 'wf-now', name: 'N', description: '', definitionJson: '{}', isTemplate: false }, null);
    const now = ts('wf-now');
    expect(now.created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(now.updated_at).toBe(now.created_at);

    // re-save without ts: created_at preserved, updated_at bumped (unchanged S3a invariant).
    store.upsert({ id: 'wf-bf', name: 'N2', description: '', definitionJson: '{}', isTemplate: false }, null);
    const after = ts('wf-bf');
    expect(after.created_at).toBe('2025-01-01T00:00:00Z');
    expect(after.updated_at).not.toBe('2025-01-01T00:00:00Z');

    // re-upsert WITH ts on conflict restores updated_at to the legacy ts (the
    // backfill-idempotency path — a regression to datetime('now') would fail here).
    store.upsert({ id: 'wf-bf', name: 'N3', description: '', definitionJson: '{}', isTemplate: false }, null,
      { createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z' });
    expect(ts('wf-bf').updated_at).toBe('2025-01-01T00:00:00Z');
  });

  it('upsert is idempotent by id and preserves created_at across a re-save', () => {
    const { store, engine } = make();
    store.upsert({ id: 'wf1', name: 'v1', definitionJson: '{"id":"wf1","name":"v1"}', isTemplate: false }, null);
    // Pin created_at to a distinctive sentinel BEFORE the re-save. Without this
    // both upserts land in the same wall-clock second, so a regression to
    // INSERT OR REPLACE (which re-defaults created_at to datetime('now')) would
    // still yield an identical second-granularity timestamp and the assertion
    // below could not fail — the sentinel makes it actually guard the invariant.
    engine.getDb().prepare("UPDATE workflows SET created_at = '2000-01-01 00:00:00' WHERE id = 'wf1'").run();
    store.upsert({ id: 'wf1', name: 'v2', definitionJson: '{"id":"wf1","name":"v2"}', isTemplate: true }, null);
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
    store.upsert({ id: 'wf1', name: 'Title', definitionJson: def, isTemplate: false }, null);
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
    store.upsert({ id: 'wf1', name: 'Old', definitionJson: JSON.stringify({ id: 'wf1', name: 'Old', goal: 'g' }), isTemplate: true }, null);
    expect(store.rename('wf1', 'New', null)).toBe(true);
    const got = store.get('wf1')!;
    expect(got.name).toBe('New');
    expect((JSON.parse(got.definitionJson) as { name: string }).name).toBe('New');
    expect((JSON.parse(got.definitionJson) as { goal: string }).goal).toBe('g');
  });

  it('rename lands on one row: the exact id, else the only one it is a prefix of, else none', () => {
    const { store } = make();
    store.upsert({ id: 'abc-1', name: 'Old', definitionJson: JSON.stringify({ id: 'abc-1', name: 'Old' }), isTemplate: true }, null);
    store.upsert({ id: 'abc-2', name: 'Old', definitionJson: JSON.stringify({ id: 'abc-2', name: 'Old' }), isTemplate: true }, null);
    expect(store.rename('abc', 'New', null)).toBe(false); // a prefix of two names neither
    expect(store.get('abc-1')!.name).toBe('Old');
    expect(store.get('abc-2')!.name).toBe('Old');
    expect(store.rename('abc-2', 'New', null)).toBe(true);
    expect(store.rename('abc-', 'X', null)).toBe(false); // still a prefix of two
    store.remove('abc-1');
    expect(store.rename('abc', 'Short', null)).toBe(true); // now a prefix of one
    expect(store.get('abc-2')!.name).toBe('Short');
  });

  it('rename returns false for an unknown id', () => {
    const { store } = make();
    expect(store.rename('nope', 'X', null)).toBe(false);
  });

  it('setConfirmedAt stamps definition_json.$.confirmedAt', () => {
    const { store } = make();
    store.upsert({ id: 'wf1', name: 'W', definitionJson: JSON.stringify({ id: 'wf1', name: 'W' }), isTemplate: true }, null);
    expect(store.setConfirmedAt('wf1', '2026-07-01T00:00:00Z')).toBe(true);
    expect((JSON.parse(store.get('wf1')!.definitionJson) as { confirmedAt: string }).confirmedAt).toBe('2026-07-01T00:00:00Z');
  });

  it('remove deletes by exact id and by an unambiguous prefix', () => {
    const { store } = make();
    store.upsert({ id: 'abcdef-1234', name: 'W', definitionJson: '{}', isTemplate: false }, null);
    expect(store.remove('abcdef')).toBe(true); // prefix of one row
    expect(store.get('abcdef-1234')).toBeUndefined();
  });

  // A write names one workflow. An id that is a prefix of another (`wf-a` of `wf-ab`, the latter
  // possibly another mandate's) must not carry the write onto it.
  describe('a write on wf-a leaves wf-ab alone', () => {
    function two() {
      const m = make();
      for (const id of ['wf-a', 'wf-ab']) {
        m.store.upsert({ id, name: id, definitionJson: JSON.stringify({ id, name: id }), isTemplate: true }, null);
      }
      return m.store;
    }
    const ab = (store: WorkflowStore) => store.list().find((w) => w.id === 'wf-ab')!;

    it('confirming', () => {
      const store = two();
      expect(store.setConfirmedAt('wf-a', '2026-11-01T00:00:00Z')).toBe(true);
      expect((JSON.parse(ab(store).definitionJson) as { confirmedAt?: string }).confirmedAt).toBeUndefined();
      const a = store.list().find((w) => w.id === 'wf-a')!;
      expect((JSON.parse(a.definitionJson) as { confirmedAt?: string }).confirmedAt).toBe('2026-11-01T00:00:00Z');
    });

    it('renaming, by the owner', () => {
      const store = two();
      expect(store.rename('wf-a', 'New', null)).toBe(true);
      expect(ab(store).name).toBe('wf-ab');
      expect(store.list().find((w) => w.id === 'wf-a')!.name).toBe('New');
    });

    it('renaming, by a mandate, which also marks the row it renames', () => {
      const store = two();
      const eva: RequestPrincipal = { kind: 'mandate', email: 'eva@firm.example', mandateId: 'grant-eva' };
      expect(store.rename('wf-a', 'New', eva)).toBe(true);
      expect(ab(store).name).toBe('wf-ab');
      expect(store.authorship('wf-ab')!.mandateEditor).toBeNull();
      expect(store.authorship('wf-a')!.mandateEditor).not.toBeNull();
    });

    it('deleting', () => {
      const store = two();
      expect(store.remove('wf-a')).toBe(true);
      expect(store.list().map((w) => w.id)).toEqual(['wf-ab']);
    });
  });

  it('a prefix of two names neither: confirming and deleting write nothing', () => {
    const { store } = make();
    for (const id of ['wf-ab', 'wf-ac']) store.upsert({ id, name: id, definitionJson: JSON.stringify({ id, name: id }), isTemplate: true }, null);
    expect(store.setConfirmedAt('wf-a', '2026-11-01T00:00:00Z')).toBe(false);
    expect(store.remove('wf-a')).toBe(false);
    expect(store.list().map((w) => w.id).sort()).toEqual(['wf-ab', 'wf-ac']);
    for (const w of store.list()) expect((JSON.parse(w.definitionJson) as { confirmedAt?: string }).confirmedAt).toBeUndefined();
    expect(store.setConfirmedAt('wf-ab', '2026-11-01T00:00:00Z')).toBe(true);   // the exact id still writes
  });

  it('reads the exact id before a longer one it is a prefix of', () => {
    const { store } = make();
    // Inserted longer-first, so an unordered LIMIT 1 would tend to answer with it.
    for (const id of ['wf-ab', 'wf-a']) store.upsert({ id, name: id, definitionJson: '{}', isTemplate: true }, null);
    expect(store.get('wf-a')!.id).toBe('wf-a');
  });

  it('LIKE metacharacters in an id are escaped — a "%" id does NOT wipe the table', () => {
    const { store } = make();
    store.upsert({ id: 'wf1', name: 'A', definitionJson: '{}', isTemplate: false }, null);
    store.upsert({ id: 'wf2', name: 'B', definitionJson: '{}', isTemplate: false }, null);
    // Without ESCAPE, remove('%') → LIKE '%%' would delete every row.
    expect(store.remove('%')).toBe(false);
    expect(store.list()).toHaveLength(2);
  });

  it('an empty id is guarded — it never prefix-matches (would collapse to the "%" wildcard)', () => {
    const { store } = make();
    store.upsert({ id: 'wf1', name: 'A', definitionJson: '{}', isTemplate: false }, null);
    store.upsert({ id: 'wf2', name: 'B', definitionJson: '{}', isTemplate: false }, null);
    // likePrefix('') would be a bare '%' → match ALL rows; every prefix method
    // must short-circuit an empty id to a no-match instead of a table-wipe.
    expect(store.remove('')).toBe(false);
    expect(store.rename('', 'X', null)).toBe(false);
    expect(store.setConfirmedAt('', '2026-07-01T00:00:00Z')).toBe(false);
    expect(store.get('')).toBeUndefined();
    expect(store.list()).toHaveLength(2);
  });

  it('dropExecuted deletes only by EXACT id (never a prefix sibling)', () => {
    const { store } = make();
    store.upsert({ id: 'run-1', name: 'A', definitionJson: '{}', isTemplate: false }, null);
    store.upsert({ id: 'run-12', name: 'B', definitionJson: '{}', isTemplate: false }, null);
    expect(store.dropExecuted('run-1')).toBe(true);
    // Only the exact 'run-1' is gone; the prefix sibling 'run-12' survives.
    // (get() is prefix-matching like legacy getPlannedPipeline, so assert via list.)
    const remaining = store.list();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.id).toBe('run-12');
  });

  it('list orders most-recently-touched first (updated_at DESC, matches legacy started_at)', () => {
    const { store, engine } = make();
    store.upsert({ id: 'a', name: 'A', definitionJson: '{}', isTemplate: true }, null);
    store.upsert({ id: 'b', name: 'B', definitionJson: '{}', isTemplate: false }, null);
    // A re-saved workflow must float to the top (legacy resets started_at via
    // INSERT OR REPLACE; the mirror bumps updated_at). Force a distinct updated_at
    // (via the shared connection) so the assertion isn't a second-granularity tie.
    engine.getDb().prepare("UPDATE workflows SET updated_at = datetime('now','+1 second') WHERE id = 'a'").run();
    expect(store.list().map(w => w.id)).toEqual(['a', 'b']);
  });

  it('rename does NOT reorder the list (updated_at untouched — matches legacy started_at, transparent cutover)', () => {
    const { store, engine } = make();
    store.upsert({ id: 'a', name: 'A', definitionJson: '{"name":"A"}', isTemplate: true }, null);
    // Force 'a' older so 'b' sorts first deterministically.
    engine.getDb().prepare("UPDATE workflows SET updated_at = datetime('now','-10 seconds') WHERE id = 'a'").run();
    store.upsert({ id: 'b', name: 'B', definitionJson: '{"name":"B"}', isTemplate: true }, null);
    expect(store.list().map(w => w.id)).toEqual(['b', 'a']);
    // A rename must NOT float 'a' above 'b' (legacy leaves started_at untouched).
    store.rename('a', 'A2', null);
    expect(store.list().map(w => w.id)).toEqual(['b', 'a']);
  });

  describe('migrateContentSchema (Move 1 — content-schema versioning)', () => {
    it('stamps a legacy row (no schema_version) to the current version, content otherwise preserved', () => {
      const { store } = make();
      const legacy = JSON.stringify({ id: 'wf1', name: 'W', goal: 'g', steps: [] });
      store.upsert({ id: 'wf1', name: 'W', definitionJson: legacy, isTemplate: true }, null);
      expect(store.migrateContentSchema(migratePipelineBlob)).toEqual({ scanned: 1, migrated: 1 });
      const def = JSON.parse(store.get('wf1')!.definitionJson) as Record<string, unknown>;
      expect(def['schema_version']).toBe(CURRENT_PIPELINE_SCHEMA_VERSION);
      expect(def['goal']).toBe('g');
    });

    it('is idempotent — a second pass migrates 0', () => {
      const { store } = make();
      store.upsert({ id: 'wf1', name: 'W', definitionJson: JSON.stringify({ id: 'wf1' }), isTemplate: false }, null);
      expect(store.migrateContentSchema(migratePipelineBlob).migrated).toBe(1);
      expect(store.migrateContentSchema(migratePipelineBlob)).toEqual({ scanned: 1, migrated: 0 });
    });

    it('preserves updated_at (a migration is not a re-save — must not reorder the library)', () => {
      const { store, engine } = make();
      store.upsert({ id: 'wf1', name: 'W', definitionJson: JSON.stringify({ id: 'wf1' }), isTemplate: false }, null);
      engine.getDb().prepare("UPDATE workflows SET updated_at = '2000-01-01 00:00:00' WHERE id = 'wf1'").run();
      store.migrateContentSchema(migratePipelineBlob);
      const row = engine.getDb().prepare('SELECT updated_at FROM workflows WHERE id = ?').get('wf1') as { updated_at: string };
      expect(row.updated_at).toBe('2000-01-01 00:00:00');
    });

    it('migrates only rows that need it — the post-crash resume property (mixed legacy + current)', () => {
      const { store } = make();
      store.upsert({ id: 'legacy', name: 'L', definitionJson: JSON.stringify({ id: 'legacy' }), isTemplate: false }, null);
      store.upsert({ id: 'current', name: 'C', definitionJson: JSON.stringify({ id: 'current', schema_version: CURRENT_PIPELINE_SCHEMA_VERSION }), isTemplate: false }, null);
      // A crash mid-migration leaves some rows stamped and some not; a re-run must
      // touch ONLY the unstamped ones. The per-blob version gate gives this for free.
      expect(store.migrateContentSchema(migratePipelineBlob)).toEqual({ scanned: 2, migrated: 1 });
    });

    it('leaves a malformed row untouched (skipped, not counted, no throw)', () => {
      const { store } = make();
      store.upsert({ id: 'bad', name: 'B', definitionJson: 'not json {', isTemplate: false }, null);
      expect(() => store.migrateContentSchema(migratePipelineBlob)).not.toThrow();
      expect(store.migrateContentSchema(migratePipelineBlob).migrated).toBe(0);
      expect(store.get('bad')!.definitionJson).toBe('not json {');
    });

    it('strips the legacy executionMode tombstone from a stored blob (v1b end-to-end)', () => {
      const { store } = make();
      store.upsert({ id: 'wf1', name: 'W', definitionJson: JSON.stringify({ id: 'wf1', executionMode: 'tracked' }), isTemplate: false }, null);
      expect(store.migrateContentSchema(migratePipelineBlob).migrated).toBe(1);
      const def = JSON.parse(store.get('wf1')!.definitionJson) as Record<string, unknown>;
      expect('executionMode' in def).toBe(false);
      expect(def['schema_version']).toBe(CURRENT_PIPELINE_SCHEMA_VERSION);
    });
  });
});

describe('WorkflowStore authorship (engine.db v45)', () => {
  const tmpDirs: string[] = [];
  const engines: EngineDb[] = [];
  const EVA: RequestPrincipal = { kind: 'mandate', email: 'eva@firm.example', mandateId: 'grant-eva' };
  const MAX: RequestPrincipal = { kind: 'mandate', email: 'max@firm.example', mandateId: 'grant-max' };
  const def = (id: string): string => JSON.stringify({ id, name: id, steps: [] });

  function make(): { store: WorkflowStore; db: Database.Database } {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-wf-auth-'));
    tmpDirs.push(dir);
    const engine = new EngineDb(join(dir, 'engine.db'), '');
    engines.push(engine);
    return { store: new WorkflowStore(engine), db: engine.getDb() };
  }
  function save(store: WorkflowStore, id: string, author: RequestPrincipal | null): void {
    store.upsert({ id, name: id, definitionJson: def(id), isTemplate: true }, author);
  }
  /** Moves a row's mandate edit into the past, so a write that sets it again is visible. */
  function ageEdit(db: Database.Database, id: string): void {
    db.prepare("UPDATE workflows SET mandate_edited_at = '2020-01-01 00:00:00' WHERE id = ?").run(id);
  }

  afterEach(() => {
    for (const e of engines) { try { e.close(); } catch { /* already closed */ } }
    engines.length = 0;
    for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  it('a save records the creating mandate with its grant; the owner, the engine and the CP admin record no mandate', () => {
    const { store } = make();
    save(store, 'by-eva', EVA);
    save(store, 'by-owner', OWNER_PRINCIPAL);
    save(store, 'by-engine', null);
    save(store, 'by-cp', CP_ADMIN_PRINCIPAL);
    expect(store.authorship('by-eva')).toMatchObject({ createdBy: 'mandate:eva@firm.example', createdMandateId: 'grant-eva', mandateEditor: null, mandateEditorId: null, mandateEditedAt: null });
    expect(store.authorship('by-owner')).toMatchObject({ createdBy: null, createdMandateId: null, mandateEditor: null });
    expect(store.authorship('by-engine')).toMatchObject({ createdBy: null, createdMandateId: null, mandateEditor: null });
    expect(store.authorship('by-cp')).toMatchObject({ createdBy: 'cp-admin', createdMandateId: null, mandateEditor: null });
  });

  it('a second mandate\'s save keeps the creator and created_at, and makes it the editor, with its grant and a time', () => {
    const { store, db } = make();
    save(store, 'wf', EVA);
    db.prepare("UPDATE workflows SET created_at = '2021-05-05 05:05:05' WHERE id = 'wf'").run();
    save(store, 'wf', MAX);
    const a = store.authorship('wf')!;
    expect(a).toMatchObject({ createdBy: 'mandate:eva@firm.example', createdMandateId: 'grant-eva', mandateEditor: 'mandate:max@firm.example', mandateEditorId: 'grant-max', createdAt: '2021-05-05 05:05:05' });
    expect(a.mandateEditedAt).not.toBeNull();
  });

  it('a mandate that changes the owner\'s workflow becomes its editor, never its creator', () => {
    const { store } = make();
    save(store, 'wf', OWNER_PRINCIPAL);
    save(store, 'wf', EVA);
    expect(store.authorship('wf')).toMatchObject({ createdBy: null, createdMandateId: null, mandateEditor: 'mandate:eva@firm.example', mandateEditorId: 'grant-eva' });
  });

  it('the owner\'s, the engine\'s and the CP admin\'s re-save leave the last mandate\'s edit where it is', () => {
    const { store, db } = make();
    save(store, 'wf', EVA);
    save(store, 'wf', MAX);
    ageEdit(db, 'wf');
    save(store, 'wf', OWNER_PRINCIPAL);
    save(store, 'wf', null);
    save(store, 'wf', CP_ADMIN_PRINCIPAL);
    expect(store.authorship('wf')).toMatchObject({ mandateEditor: 'mandate:max@firm.example', mandateEditorId: 'grant-max', mandateEditedAt: '2020-01-01 00:00:00' });
    // ...while a mandate's re-save moves the time on.
    save(store, 'wf', MAX);
    expect(store.authorship('wf')!.mandateEditedAt).not.toBe('2020-01-01 00:00:00');
  });

  it('a mandate without a grant id never inherits the previous editor\'s id', () => {
    const { store } = make();
    save(store, 'wf', EVA);
    save(store, 'wf', MAX);
    save(store, 'wf', { kind: 'mandate', email: 'eva@firm.example' });
    expect(store.authorship('wf')).toMatchObject({ mandateEditor: 'mandate:eva@firm.example', mandateEditorId: null });
  });

  it('a mandate\'s rename marks the row it renames; the owner\'s rename marks none; neither touches the creator', () => {
    const { store, db } = make();
    save(store, 'abc-1', OWNER_PRINCIPAL);
    save(store, 'abc-2', EVA);
    save(store, 'xyz', OWNER_PRINCIPAL);
    expect(store.rename('abc-2', 'Renamed', OWNER_PRINCIPAL)).toBe(true);
    expect(store.authorship('abc-2')!.mandateEditor).toBeNull();
    expect(store.rename('abc-1', 'Renamed again', MAX)).toBe(true);
    expect(store.authorship('abc-1')).toMatchObject({ mandateEditor: 'mandate:max@firm.example', mandateEditorId: 'grant-max' });
    expect(store.authorship('abc-1')!.mandateEditedAt).not.toBeNull();
    expect(store.authorship('abc-2')!.mandateEditor).toBeNull();
    expect(store.authorship('abc-1')!.createdBy).toBeNull();
    expect(store.authorship('abc-2')!.createdBy).toBe('mandate:eva@firm.example');
    expect(store.authorship('xyz')!.mandateEditor).toBeNull();
    expect((db.prepare("SELECT name FROM workflows WHERE id = 'abc-1'").get() as { name: string }).name).toBe('Renamed again');
    expect((db.prepare("SELECT name FROM workflows WHERE id = 'abc-2'").get() as { name: string }).name).toBe('Renamed');
  });

  it('the owner\'s stamps leave every authorship column', () => {
    const { store, db } = make();
    save(store, 'wf', EVA);
    save(store, 'wf', MAX);
    ageEdit(db, 'wf');
    const before = store.authorship('wf');
    expect(store.setConfirmedAt('wf', '2026-10-20T00:00:00.000Z')).toBe(true);
    expect(store.setReviewedGrant('wf', '{}', '{}', '2026-10-20T00:00:00.000Z')).toBe(true);
    expect(store.acceptReviewedGrant({
      grantId: 'g-1', workflowId: 'wf', contractJson: '{}', by: 'local', name: null, at: '2026-10-20T00:00:00.000Z',
      checksum: '0'.repeat(64), binding: 'keyed', triggerId: 't-1', cron: '0 9 * * 1', boundParamsJson: '{}', afterUntrusted: false,
    }, '{}', '2026-10-20T00:00:00.000Z')).toBe(true);
    expect(store.authorship('wf')).toEqual(before);
  });

  it('a copy carries the source\'s latest mandate mark, with the source\'s grant and time; its creator is the copier', () => {
    const { store, db } = make();
    // Source edited by a mandate: the editor wins over the creator.
    save(store, 'src-edited', EVA);
    save(store, 'src-edited', MAX);
    ageEdit(db, 'src-edited');
    store.upsertCopy({ id: 'copy-1', name: 'c', definitionJson: def('copy-1'), isTemplate: true }, OWNER_PRINCIPAL, 'src-edited');
    expect(store.authorship('copy-1')).toMatchObject({ createdBy: null, mandateEditor: 'mandate:max@firm.example', mandateEditorId: 'grant-max', mandateEditedAt: '2020-01-01 00:00:00' });
    // Source made by a mandate and never edited: its creator, with created_at.
    save(store, 'src-made', EVA);
    db.prepare("UPDATE workflows SET created_at = '2021-02-02 02:02:02' WHERE id = 'src-made'").run();
    store.upsertCopy({ id: 'copy-2', name: 'c', definitionJson: def('copy-2'), isTemplate: true }, MAX, 'src-made');
    expect(store.authorship('copy-2')).toMatchObject({ createdBy: 'mandate:max@firm.example', createdMandateId: 'grant-max', mandateEditor: 'mandate:eva@firm.example', mandateEditorId: 'grant-eva', mandateEditedAt: '2021-02-02 02:02:02' });
    // Source with no mandate (the owner's, or gone): the copy has no editor.
    save(store, 'src-owner', OWNER_PRINCIPAL);
    store.upsertCopy({ id: 'copy-3', name: 'c', definitionJson: def('copy-3'), isTemplate: true }, OWNER_PRINCIPAL, 'src-owner');
    store.upsertCopy({ id: 'copy-4', name: 'c', definitionJson: def('copy-4'), isTemplate: true }, OWNER_PRINCIPAL, 'src-gone');
    expect(store.authorship('copy-3')).toMatchObject({ mandateEditor: null, mandateEditorId: null, mandateEditedAt: null });
    expect(store.authorship('copy-4')).toMatchObject({ mandateEditor: null, mandateEditorId: null, mandateEditedAt: null });
  });

  it('refuses a write whose author is missing instead of reading it as the owner', () => {
    const { store } = make();
    const noAuthor = undefined as unknown as RequestPrincipal | null;
    expect(() => store.upsert({ id: 'wf', name: 'wf', definitionJson: def('wf'), isTemplate: true }, noAuthor)).toThrow(/without an author/);
    save(store, 'wf', OWNER_PRINCIPAL);
    expect(() => store.rename('wf', 'X', noAuthor)).toThrow(/without an author/);
    expect(store.authorship('missing')).toBeUndefined();
  });
});
