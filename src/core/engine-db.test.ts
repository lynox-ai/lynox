import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngineDb } from './engine-db.js';

describe('EngineDb (Foundation Rework v2 — S0 baseline)', () => {
  const tmpDirs: string[] = [];

  function createEngineDb(key?: string): EngineDb {
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
    // Same lower(name)+kind+owner → rejected.
    expect(() =>
      db.prepare("INSERT INTO subjects (id, kind, name) VALUES ('s2', 'organization', 'acme industries')").run(),
    ).toThrow();
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
    const e1 = new EngineDb(path);
    e1.getDb().prepare("INSERT INTO subjects (id, kind, name) VALUES ('keep', 'person', 'Keep')").run();
    e1.close();

    const e2 = new EngineDb(path);
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
});
