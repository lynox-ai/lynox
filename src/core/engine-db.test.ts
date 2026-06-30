import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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

  it('creates the database and stamps schema_version v1', () => {
    const e = createEngineDb();
    const row = e.getDb().prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number };
    expect(row.v).toBe(1);
    e.close();
  });

  it('creates every baseline table', () => {
    const e = createEngineDb();
    const expected = [
      'subjects', 'people', 'organizations', 'engagements', 'products', 'services',
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

  it('keeps thread/run references SOFT (no FK) in S0', () => {
    const e = createEngineDb();
    const db = e.getDb();
    db.prepare("INSERT INTO subjects (id, kind, name) VALUES ('s', 'person', 'X')").run();
    // source_run_id (history.db) + source_thread_id (pre-S2) are bare TEXT — arbitrary values accepted.
    expect(() =>
      db.prepare("INSERT INTO memories (id, text, namespace, scope_type, scope_id, source_run_id, source_thread_id) VALUES ('m','t','knowledge','global','','run-does-not-exist','thread-does-not-exist')").run(),
    ).not.toThrow();
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
    expect(row.v).toBe(1);
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

  it('recovers from a corrupt database file by renaming it aside and recreating', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-engine-'));
    tmpDirs.push(dir);
    const path = join(dir, 'engine.db');
    // Not a valid SQLite file — integrity_check (or open) must fail.
    writeFileSync(path, 'this is not a sqlite database, it is garbage bytes');

    const e = new EngineDb(path, '');           // must not throw
    // A .corrupt-* sidecar of the original was created.
    expect(readdirSync(dir).some(f => f.startsWith('engine.db.corrupt-'))).toBe(true);
    // The fresh DB is usable and stamped v1.
    expect((e.getDb().prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number }).v).toBe(1);
    e.close();
  });
});
