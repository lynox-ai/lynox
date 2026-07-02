import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { EngineDb } from './engine-db.js';

describe('EngineDb (Foundation Rework v2 — S0 baseline)', () => {
  const tmpDirs: string[] = [];

  // Default the key to '' so a no-key case is hermetic: without this, EngineDb
  // falls back to the ambient process.env.LYNOX_VAULT_KEY, which a dev/CI shell
  // running the engine often has set — flipping isEncrypted and failing the
  // passthrough assertions. Pass an explicit key for the encryption case.
  function createEngineDb(key = ''): EngineDb {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-engine-'));
    tmpDirs.push(dir);
    return new EngineDb(join(dir, 'engine.db'), key);
  }

  afterEach(() => {
    for (const dir of tmpDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tmpDirs.length = 0;
  });

  it('creates the database and stamps schema_version v3', () => {
    const e = createEngineDb();
    const row = e.getDb().prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number };
    expect(row.v).toBe(3); // v1 baseline + v2 (idx_triggers_next_run) + v3 (effect column)
    // v2's DDL ran in the same txn as its version stamp: the money-path index exists.
    const idx = e.getDb().prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_triggers_next_run'",
    ).get() as { name: string } | undefined;
    expect(idx?.name).toBe('idx_triggers_next_run');
    // v3 added the `effect` column (fresh install gets it via the migration loop).
    const cols = e.getDb().prepare("SELECT name FROM pragma_table_info('triggers')").all() as Array<{ name: string }>;
    expect(cols.map(c => c.name)).toContain('effect');
    e.close();
  });

  it('v3 migration remaps legacy verbatim task_type → clean (source, effect), EXHAUSTIVELY', () => {
    // The money-critical remap (RU1): every pre-v3 row (which held the legacy
    // task_type VERBATIM in `source`, no `effect` column) must land on an explicit
    // (source, effect) — never lean on the DEFAULT so a missed backup/reminder can't
    // strand at the money-spending default. Build a v2 DB with legacy rows, then let
    // EngineDb apply v3 and assert row-by-row (the unit twin of the staging walk).
    const dir = mkdtempSync(join(tmpdir(), 'lynox-mig3-'));
    tmpDirs.push(dir);
    const dbPath = join(dir, 'engine.db');
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
      INSERT INTO schema_version (version) VALUES (2);
      CREATE TABLE triggers (id TEXT PRIMARY KEY, source TEXT NOT NULL, condition_json TEXT NOT NULL DEFAULT '{}', target_workflow_id TEXT);
    `);
    const seed = raw.prepare('INSERT INTO triggers (id, source, condition_json, target_workflow_id) VALUES (?, ?, ?, ?)');
    seed.run('r-backup', 'backup', '{}', null);
    seed.run('r-reminder', 'reminder', '{}', null);
    seed.run('r-pipe-cron', 'pipeline', JSON.stringify({ schedule_cron: '0 9 * * *' }), 'wf-a');
    seed.run('r-pipe-watch', 'pipeline', JSON.stringify({ watch_config: '{"url":"x"}' }), 'wf-b');
    seed.run('r-pipe-bare', 'pipeline', '{}', 'wf-c');
    seed.run('r-watch', 'watch', JSON.stringify({ watch_config: '{"url":"y"}' }), null);
    // The REAL legacy value written by createScheduled is 'scheduled' (NOT 'standard'
    // — that was a phantom the first cut mis-seeded, letting a wrong constant pass CI):
    seed.run('r-sched-cron', 'scheduled', JSON.stringify({ schedule_cron: '0 8 * * *' }), null);
    seed.run('r-sched-bare', 'scheduled', '{}', null);
    seed.run('r-manual', 'manual', '{}', null);
    // A legacy row that bound a workflow WITHOUT source='pipeline' (a raw create) — the
    // migration must still route it to run_workflow (the legacy `|| pipeline_id` guard),
    // NOT run_agent (which would be an autonomous money run of the title):
    seed.run('r-bound-manual', 'manual', '{}', 'wf-d');
    seed.run('r-bound-sched', 'scheduled', JSON.stringify({ schedule_cron: '0 7 * * *' }), 'wf-e');
    // A backup/reminder with a stray target must NOT be flipped to run_workflow by
    // the guard (`AND source NOT IN ('backup','reminder')` on the target-bound UPDATE):
    seed.run('r-backup-bound', 'backup', '{}', 'wf-f');
    seed.run('r-reminder-bound', 'reminder', '{}', 'wf-g');
    seed.run('r-weird', 'zzz-unexpected', '{}', null);   // an unknown value must fail safe
    seed.run('r-corrupt', 'scheduled', 'not-json', null); // malformed condition_json → json_valid guard
    raw.close();

    const e = new EngineDb(dbPath, '');
    const rows = e.getDb().prepare('SELECT id, source, effect FROM triggers').all() as Array<{ id: string; source: string; effect: string }>;
    const byId = Object.fromEntries(rows.map(r => [r.id, { source: r.source, effect: r.effect }]));
    // Money-boundary rows (deterministic — must NEVER become a run_* effect):
    expect(byId['r-backup']).toEqual({ source: 'cron', effect: 'backup' });
    expect(byId['r-reminder']).toEqual({ source: 'cron', effect: 'notify' });
    expect(byId['r-backup-bound']).toEqual({ source: 'cron', effect: 'backup' }); // stray target ignored
    expect(byId['r-reminder-bound']).toEqual({ source: 'cron', effect: 'notify' }); // stray target ignored
    // Workflow rows (run_workflow) — source derived from the condition:
    expect(byId['r-pipe-cron']).toEqual({ source: 'cron', effect: 'run_workflow' });
    expect(byId['r-pipe-watch']).toEqual({ source: 'watch', effect: 'run_workflow' });
    expect(byId['r-pipe-bare']).toEqual({ source: 'manual', effect: 'run_workflow' });
    // Target-bound-but-not-pipeline rows → run_workflow (the `|| pipeline_id` guard):
    expect(byId['r-bound-manual']).toEqual({ source: 'manual', effect: 'run_workflow' });
    expect(byId['r-bound-sched']).toEqual({ source: 'cron', effect: 'run_workflow' });
    // Agent rows (run_agent):
    expect(byId['r-watch']).toEqual({ source: 'watch', effect: 'run_agent' });
    expect(byId['r-sched-cron']).toEqual({ source: 'cron', effect: 'run_agent' });  // 'scheduled' → cron
    expect(byId['r-sched-bare']).toEqual({ source: 'manual', effect: 'run_agent' });
    expect(byId['r-manual']).toEqual({ source: 'manual', effect: 'run_agent' });
    // Unknown source → manual (fires nothing until edited); effect run_agent.
    expect(byId['r-weird']).toEqual({ source: 'manual', effect: 'run_agent' });
    // Malformed condition_json is tolerated by the json_valid guard → manual.
    expect(byId['r-corrupt']).toEqual({ source: 'manual', effect: 'run_agent' });
    // NO row is left on a non-clean source or an empty effect.
    for (const r of rows) {
      expect(['cron', 'watch', 'webhook', 'inbox_event', 'manual']).toContain(r.source);
      expect(['run_workflow', 'run_agent', 'backup', 'notify']).toContain(r.effect);
    }
    e.close();
  });

  it('creates every baseline table', () => {
    const e = createEngineDb();
    const expected = [
      'subjects', 'people', 'organizations', 'engagements', 'products', 'services',
      'threads', 'thread_messages', 'pending_prompts',
      'memories', 'memory_subjects', 'subject_cooccurrences', 'supersedes', 'relationships',
      'connections', 'artifacts', 'workflows', 'triggers', 'tasks', 'conflicts',
    ];
    const rows = e.getDb().prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    const present = new Set(rows.map(r => r.name));
    for (const t of expected) {
      expect(present.has(t), `table ${t} should exist`).toBe(true);
    }
    e.close();
  });

  it('enforces the canonical-UNIQUE dedup guard (case-insensitive), scoped to non-archived', () => {
    const e = createEngineDb();
    const db = e.getDb();
    db.prepare("INSERT INTO subjects (id, kind, name) VALUES ('s1', 'organization', 'Acme Industries')").run();
    // Same lower(name)+kind+owner → rejected by the canonical UNIQUE index.
    expect(() =>
      db.prepare("INSERT INTO subjects (id, kind, name) VALUES ('s2', 'organization', 'acme industries')").run(),
    ).toThrow(/UNIQUE/i);
    // A different kind is allowed (the unique key is (lower(name), kind, owner)).
    db.prepare("INSERT INTO subjects (id, kind, name) VALUES ('s3', 'product', 'Acme Industries')").run();
    // The guard now also covers product/service (catalogue identity = name): a
    // second same-name product is rejected (case-insensitive).
    expect(() =>
      db.prepare("INSERT INTO subjects (id, kind, name) VALUES ('s5', 'product', 'acme industries')").run(),
    ).toThrow(/UNIQUE/i);
    // engagement identity is provider×client×period (not name) and 'other' is
    // unstructured, so the guard excludes them: two same-named engagements coexist.
    db.prepare("INSERT INTO subjects (id, kind, name) VALUES ('e1', 'engagement', 'Website Redesign')").run();
    expect(() =>
      db.prepare("INSERT INTO subjects (id, kind, name) VALUES ('e2', 'engagement', 'Website Redesign')").run(),
    ).not.toThrow();
    // Archiving s1 frees the slot (partial index: WHERE archived_at IS NULL).
    db.prepare("UPDATE subjects SET archived_at = datetime('now') WHERE id = 's1'").run();
    expect(() =>
      db.prepare("INSERT INTO subjects (id, kind, name) VALUES ('s4', 'organization', 'Acme Industries')").run(),
    ).not.toThrow();
    e.close();
  });

  it('cascades on subject delete and SET NULL on memory.subject_id', () => {
    const e = createEngineDb();
    const db = e.getDb();
    db.prepare("INSERT INTO subjects (id, kind, name) VALUES ('cust', 'organization', 'Globex')").run();
    db.prepare("INSERT INTO subjects (id, kind, name) VALUES ('other', 'organization', 'Other')").run();
    db.prepare("INSERT INTO people (subject_id) VALUES ('cust')").run();
    db.prepare("INSERT INTO memories (id, text, namespace, scope_type, scope_id, subject_id) VALUES ('m1','hi','knowledge','global','','cust')").run();
    db.prepare("INSERT INTO memory_subjects (memory_id, subject_id) VALUES ('m1','cust')").run();
    db.prepare("INSERT INTO relationships (id, from_subject_id, to_subject_id, kind) VALUES ('r1','cust','other','customer_of')").run();

    db.prepare("DELETE FROM subjects WHERE id = 'cust'").run();

    // CASCADE: detail row, junction row, and edge are gone.
    expect(db.prepare("SELECT COUNT(*) c FROM people WHERE subject_id='cust'").get()).toMatchObject({ c: 0 });
    expect(db.prepare("SELECT COUNT(*) c FROM memory_subjects WHERE subject_id='cust'").get()).toMatchObject({ c: 0 });
    expect(db.prepare("SELECT COUNT(*) c FROM relationships WHERE id='r1'").get()).toMatchObject({ c: 0 });
    // SET NULL: the memory itself survives, detached.
    const mem = db.prepare("SELECT subject_id FROM memories WHERE id='m1'").get() as { subject_id: string | null };
    expect(mem.subject_id).toBeNull();
    e.close();
  });

  it('enforces real intra-file FKs (foreign_keys = ON)', () => {
    const e = createEngineDb();
    const db = e.getDb();
    expect(() =>
      db.prepare("INSERT INTO people (subject_id) VALUES ('ghost')").run(),
    ).toThrow(/FOREIGN KEY/i);
    e.close();
  });

  it('keeps source_run_id SOFT but enforces source_thread_id as a real FK', () => {
    const e = createEngineDb();
    const db = e.getDb();
    db.prepare("INSERT INTO subjects (id, kind, name) VALUES ('s', 'person', 'X')").run();
    // source_run_id → history.db runs: permanently SOFT, arbitrary value accepted.
    expect(() =>
      db.prepare("INSERT INTO memories (id, text, namespace, scope_type, scope_id, source_run_id) VALUES ('m1','t','knowledge','global','','run-does-not-exist')").run(),
    ).not.toThrow();
    // source_thread_id is now a REAL FK (the spine is in engine.db): a bad ref throws.
    expect(() =>
      db.prepare("INSERT INTO memories (id, text, namespace, scope_type, scope_id, source_thread_id) VALUES ('m2','t','knowledge','global','','thread-does-not-exist')").run(),
    ).toThrow(/FOREIGN KEY/i);
    // A real thread satisfies it, and deleting that thread SET NULLs the memory's ref.
    db.prepare("INSERT INTO threads (id) VALUES ('th1')").run();
    db.prepare("INSERT INTO memories (id, text, namespace, scope_type, scope_id, source_thread_id) VALUES ('m3','t','knowledge','global','','th1')").run();
    db.prepare("INSERT INTO artifacts (id, type, thread_id) VALUES ('a1','html','th1')").run();
    db.prepare("DELETE FROM threads WHERE id='th1'").run();
    expect((db.prepare("SELECT source_thread_id s FROM memories WHERE id='m3'").get() as { s: string | null }).s).toBeNull();
    expect((db.prepare("SELECT thread_id t FROM artifacts WHERE id='a1'").get() as { t: string | null }).t).toBeNull();
    e.close();
  });

  it('persists across reopen without re-migrating', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-engine-'));
    tmpDirs.push(dir);
    const path = join(dir, 'engine.db');
    const e1 = new EngineDb(path, '');
    e1.getDb().prepare("INSERT INTO subjects (id, kind, name) VALUES ('keep', 'person', 'Keep')").run();
    e1.close();

    const e2 = new EngineDb(path, '');
    const row = e2.getDb().prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number };
    expect(row.v).toBe(3); // no re-migration on reopen — stays at the latest applied
    expect(e2.getDb().prepare("SELECT name FROM subjects WHERE id='keep'").get()).toMatchObject({ name: 'Keep' });
    e2.close();
  });

  it('encrypts at rest when a vault key is present (D2 posture)', () => {
    const e = createEngineDb('test-vault-key-123');
    expect(e.isEncrypted).toBe(true);
    const cipher = e.enc('sensitive subject note');
    expect(cipher).toMatch(/^enc:/);
    expect(cipher).not.toContain('sensitive subject note');
    expect(e.dec(cipher)).toBe('sensitive subject note');
    e.close();
  });

  it('falls back to plaintext passthrough without a vault key', () => {
    const e = createEngineDb();
    expect(e.isEncrypted).toBe(false);
    expect(e.enc('plain')).toBe('plain');     // no key → stored as-is
    expect(e.dec('plain')).toBe('plain');     // non-prefixed → returned as-is
    e.close();
  });

  it('passes ciphertext through unchanged when the key is wrong (no throw, no leak)', () => {
    const a = createEngineDb('key-aaaaaaaaaaaaaaaa');
    const cipher = a.enc('secret');
    a.close();
    // A second instance with a DIFFERENT key cannot decrypt; it must return the
    // input unchanged (graceful), never throw and never surface plaintext.
    const b = createEngineDb('key-bbbbbbbbbbbbbbbb');
    expect(b.dec(cipher)).toBe(cipher);
    b.close();
  });

  it('cascades / SET NULLs across the verb layer, self-FKs and engagement parties', () => {
    const e = createEngineDb();
    const db = e.getDb();
    // subjects: a self-firm, a customer, an assignee, and a parent
    db.prepare("INSERT INTO subjects (id, kind, name, is_self) VALUES ('firm','organization','MyFirm',1)").run();
    db.prepare("INSERT INTO subjects (id, kind, name) VALUES ('client','organization','Client')").run();
    db.prepare("INSERT INTO subjects (id, kind, name) VALUES ('assignee','person','Assignee')").run();
    db.prepare("INSERT INTO subjects (id, kind, name) VALUES ('eng','engagement','Project')").run();
    db.prepare("INSERT INTO engagements (subject_id, provider_subject_id, client_subject_id) VALUES ('eng','firm','client')").run();
    // workflow → trigger → task chain
    db.prepare("INSERT INTO workflows (id, name, definition_json) VALUES ('wf','W','{}')").run();
    db.prepare("INSERT INTO triggers (id, title, target_workflow_id) VALUES ('tr','T','wf')").run();
    db.prepare("INSERT INTO tasks (id, title, assignee_subject_id, due_trigger_id) VALUES ('parent','P','assignee','tr')").run();
    db.prepare("INSERT INTO tasks (id, title, parent_task_id) VALUES ('child','C','parent')").run();

    // Deleting the workflow SET NULLs the trigger's target_workflow_id.
    db.prepare("DELETE FROM workflows WHERE id='wf'").run();
    expect((db.prepare("SELECT target_workflow_id t FROM triggers WHERE id='tr'").get() as { t: string | null }).t).toBeNull();
    // Deleting the trigger SET NULLs the task's due_trigger_id.
    db.prepare("DELETE FROM triggers WHERE id='tr'").run();
    expect((db.prepare("SELECT due_trigger_id t FROM tasks WHERE id='parent'").get() as { t: string | null }).t).toBeNull();
    // Deleting the assignee subject SET NULLs the task's assignee_subject_id.
    db.prepare("DELETE FROM subjects WHERE id='assignee'").run();
    expect((db.prepare("SELECT assignee_subject_id a FROM tasks WHERE id='parent'").get() as { a: string | null }).a).toBeNull();
    // Deleting the parent task SET NULLs the child's parent_task_id (self-FK).
    db.prepare("DELETE FROM tasks WHERE id='parent'").run();
    expect((db.prepare("SELECT parent_task_id p FROM tasks WHERE id='child'").get() as { p: string | null }).p).toBeNull();
    // Deleting the self-firm SET NULLs engagement.provider_subject_id (engagement survives).
    db.prepare("DELETE FROM subjects WHERE id='firm'").run();
    const eng = db.prepare("SELECT provider_subject_id pr, client_subject_id cl FROM engagements WHERE subject_id='eng'").get() as { pr: string | null; cl: string | null };
    expect(eng.pr).toBeNull();
    expect(eng.cl).toBe('client');
    e.close();
  });

  it('cascades supersedes / conflicts / cooccurrences on memory and subject delete', () => {
    const e = createEngineDb();
    const db = e.getDb();
    db.prepare("INSERT INTO subjects (id, kind, name) VALUES ('a','person','A')").run();
    db.prepare("INSERT INTO subjects (id, kind, name) VALUES ('b','person','B')").run();
    db.prepare("INSERT INTO memories (id, text, namespace, scope_type, scope_id) VALUES ('mNew','new','knowledge','global','')").run();
    db.prepare("INSERT INTO memories (id, text, namespace, scope_type, scope_id) VALUES ('mOld','old','knowledge','global','')").run();
    db.prepare("INSERT INTO supersedes (new_memory_id, old_memory_id, reason) VALUES ('mNew','mOld','update')").run();
    db.prepare("INSERT INTO conflicts (id, new_memory_id, old_memory_id, reason) VALUES ('c1','mNew','mOld','number_change')").run();
    db.prepare("INSERT INTO subject_cooccurrences (subject_a_id, subject_b_id) VALUES ('a','b')").run();

    // Deleting the OLD memory cascades into supersedes + conflicts (FK children).
    db.prepare("DELETE FROM memories WHERE id='mOld'").run();
    expect(db.prepare("SELECT COUNT(*) c FROM supersedes").get()).toMatchObject({ c: 0 });
    expect(db.prepare("SELECT COUNT(*) c FROM conflicts").get()).toMatchObject({ c: 0 });
    // Deleting subject 'b' (the trailing co-occurrence column) cascades the pair.
    db.prepare("DELETE FROM subjects WHERE id='b'").run();
    expect(db.prepare("SELECT COUNT(*) c FROM subject_cooccurrences").get()).toMatchObject({ c: 0 });
    e.close();
  });

  it('deleteAllData wipes every user table (GDPR Art. 17) but keeps the schema intact', () => {
    const e = createEngineDb('vault-key-for-wipe-test');
    const db = e.getDb();
    // Populate a representative slice spanning the FK graph: subjects + detail,
    // the thread spine, memories + junction + supersedes, edges, and the verb layer.
    db.prepare("INSERT INTO subjects (id, kind, name) VALUES ('s1','person','Alice')").run();
    db.prepare("INSERT INTO subjects (id, kind, name) VALUES ('s2','organization','Acme')").run();
    db.prepare(`INSERT INTO people (subject_id, email, phone) VALUES ('s1', ?, ?)`).run(e.enc('a@b.ch'), e.enc('+41'));
    db.prepare("INSERT INTO organizations (subject_id, domain) VALUES ('s2','acme.ch')").run();
    db.prepare("INSERT INTO threads (id, title) VALUES ('t1','Chat')").run();
    db.prepare("INSERT INTO thread_messages (thread_id, seq, role, content_json) VALUES ('t1',0,'user','{}')").run();
    db.prepare("INSERT INTO memories (id, text, namespace, scope_type, scope_id, subject_id, source_thread_id) VALUES ('m1',?,'knowledge','global','','s1','t1')").run(e.enc('secret note'));
    db.prepare("INSERT INTO memory_subjects (memory_id, subject_id) VALUES ('m1','s1')").run();
    db.prepare("INSERT INTO relationships (id, from_subject_id, to_subject_id, kind) VALUES ('r1','s1','s2','works_for')").run();
    db.prepare("INSERT INTO subject_cooccurrences (subject_a_id, subject_b_id) VALUES ('s1','s2')").run();
    db.prepare("INSERT INTO workflows (id, name, definition_json) VALUES ('wf','W','{}')").run();
    db.prepare("INSERT INTO triggers (id, title, target_workflow_id) VALUES ('tr','T','wf')").run();
    db.prepare("INSERT INTO tasks (id, title, due_trigger_id) VALUES ('tk','Todo','tr')").run();
    db.prepare("INSERT INTO connections (id, kind, name) VALUES ('cn','api','API')").run();
    db.prepare("INSERT INTO artifacts (id, type, thread_id) VALUES ('ar','html','t1')").run();

    // Sanity: the slice really populated rows, so "all empty after" is not vacuous
    // (a future no-op INSERT couldn't make the wipe assertion trivially green).
    expect((db.prepare("SELECT COUNT(*) c FROM subjects").get() as { c: number }).c).toBe(2);
    expect((db.prepare("SELECT COUNT(*) c FROM relationships").get() as { c: number }).c).toBe(1);
    expect((db.prepare("SELECT COUNT(*) c FROM memory_subjects").get() as { c: number }).c).toBe(1);
    expect((db.prepare("SELECT COUNT(*) c FROM tasks").get() as { c: number }).c).toBe(1);

    e.deleteAllData();

    // Every user table is empty — no PII left in any of them.
    const userTables = (db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name != 'schema_version' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[]).map(r => r.name);
    expect(userTables.length).toBeGreaterThan(15);
    for (const t of userTables) {
      const { c } = db.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as { c: number };
      expect(c, `table ${t} should be empty after wipe`).toBe(0);
    }
    // The schema itself survives — version stays at the latest, no re-migration on next open.
    expect((db.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number }).v).toBe(3);
    // And the DB is still usable (inserts work — the tables weren't dropped).
    expect(() =>
      db.prepare("INSERT INTO subjects (id, kind, name) VALUES ('s3','person','Bob')").run(),
    ).not.toThrow();
    e.close();
  });

  it('deleteAllData is idempotent on an already-empty database', () => {
    const e = createEngineDb();
    expect(() => { e.deleteAllData(); e.deleteAllData(); }).not.toThrow();
    expect((e.getDb().prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number }).v).toBe(3);
    e.close();
  });

  it('recovers from a corrupt database file by renaming it aside and recreating', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-engine-'));
    tmpDirs.push(dir);
    const path = join(dir, 'engine.db');
    // Not a valid SQLite file — integrity_check (or open) must fail.
    writeFileSync(path, 'this is not a sqlite database, it is garbage bytes');

    const e = new EngineDb(path, '');           // must not throw
    // A .corrupt-* sidecar of the original was created.
    expect(readdirSync(dir).some(f => f.startsWith('engine.db.corrupt-'))).toBe(true);
    // The fresh DB is usable and stamped at the latest schema version.
    expect((e.getDb().prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number }).v).toBe(3);
    e.close();
  });
});
