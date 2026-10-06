import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';
import { EngineDb } from './engine-db.js';
import { SubjectStore, personNameTokens, isProperTokenSubset, isPersonSubsetSafe, personTokenKey, isRepointTarget } from './subject-store.js';
import { DataStore } from './data-store.js';

/**
 * PR-C dedup mechanism: SubjectStore.mergeSubjects / resolveActiveSubject /
 * resolvePersonSubject + DataStore.repointSubjectId. The primitives are additive +
 * unwired (like S1a shipped SubjectStore) — the write-path wiring + operator surfaces
 * land in PR-C2. These tests hold the two load-bearing guarantees: repoint
 * COMPLETENESS (a merge loses no reference → no orphaned data) and byte-for-byte
 * REVERSIBILITY (rollback restores the exact pre-merge state).
 */
describe('SubjectStore.mergeSubjects (PR-C dedup)', () => {
  const tmpDirs: string[] = [];

  function makeStore(key = ''): { store: SubjectStore; engine: EngineDb; db: Database.Database } {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-merge-'));
    tmpDirs.push(dir);
    const engine = new EngineDb(join(dir, 'engine.db'), key);
    return { store: new SubjectStore(engine), engine, db: engine.getDb() };
  }

  afterEach(() => {
    for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  // ── migration v7 ────────────────────────────────────────────────

  it('migration v7 adds merged_into (schema at latest version)', () => {
    const { db, engine } = makeStore();
    const v = (db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v;
    expect(v).toBe(18); // v18 (bulk_targets.write_sent) is the latest migration
    const cols = (db.prepare("PRAGMA table_info('subjects')").all() as Array<{ name: string }>).map(c => c.name);
    expect(cols).toContain('merged_into');
    engine.close();
  });

  // ── planMerge validation (M4 over-merge guards) ─────────────────

  it('planMerge refuses cross-kind, cross-owner, self, unknown, and already-merged', () => {
    const { store, engine } = makeStore();
    const p1 = store.createSubject({ kind: 'person', name: 'Alice' });
    const p2 = store.createSubject({ kind: 'person', name: 'Alicia' });
    const org = store.createSubject({ kind: 'organization', name: 'Acme' });
    const otherOwner = store.createSubject({ kind: 'person', name: 'Bob', ownerUserId: 'tenant-2' });
    const self = store.findOrCreateSelfPerson();

    expect(store.planMerge(p1, p1)).toMatchObject({ ok: false });                 // self
    expect(store.planMerge('nope', p1)).toMatchObject({ ok: false });             // unknown dup
    expect(store.planMerge(p1, 'nope')).toMatchObject({ ok: false });             // unknown canonical
    expect(store.planMerge(p1, org)).toMatchObject({ ok: false });                // kind mismatch
    expect(store.planMerge(otherOwner, p1)).toMatchObject({ ok: false });         // owner mismatch (NEVER cross owner)
    expect(store.planMerge(self, p1)).toMatchObject({ ok: false });               // operator self
    expect(store.planMerge(p1, self)).toMatchObject({ ok: false });               // into operator self

    store.mergeSubjects(p2, p1);                                                    // p2 → p1
    expect(store.planMerge(p2, p1)).toMatchObject({ ok: false });                 // dup already merged
    expect(store.planMerge(p1, p2)).toMatchObject({ ok: false });                 // canonical (p2) itself merged away
    const archived = store.createSubject({ kind: 'person', name: 'Archie' });
    store.archiveSubject(archived);
    expect(store.planMerge(p1, archived)).toMatchObject({ ok: false });           // canonical archived
    engine.close();
  });

  // ── repoint completeness (no orphaned reference) ────────────────

  it('mergeSubjects repoints EVERY subject FK dup→canonical + archives dup + sets merged_into', () => {
    const { store, engine, db } = makeStore();
    const dup = store.createSubject({ kind: 'person', name: 'Ada' });
    const canon = store.createSubject({ kind: 'person', name: 'Dr. Ada Lovelace' });
    const other = store.createSubject({ kind: 'organization', name: 'Acme' });
    const engSubj = store.createSubject({ kind: 'engagement', name: 'Website' });
    const engSubj2 = store.createSubject({ kind: 'engagement', name: 'Redesign' });
    const child = store.createSubject({ kind: 'engagement', name: 'Child Proj', parentId: dup });

    db.prepare('INSERT INTO memories (id, text, namespace, subject_id, scope_type, scope_id) VALUES (?,?,?,?,?,?)').run('m1', 'x', 'knowledge', dup, 'global', 'g');
    db.prepare('INSERT INTO memory_subjects (memory_id, subject_id) VALUES (?,?)').run('m1', dup);
    db.prepare('INSERT INTO tasks (id, title, subject_id, assignee_subject_id) VALUES (?,?,?,?)').run('t1', 'Task', dup, dup);
    db.prepare('INSERT INTO triggers (id, title, subject_id) VALUES (?,?,?)').run('tr1', 'Trig', dup);
    db.prepare('INSERT INTO connections (id, kind, name, subject_id) VALUES (?,?,?,?)').run('c1', 'api', 'Conn', dup);
    db.prepare('INSERT INTO artifacts (id, subject_id, type) VALUES (?,?,?)').run('a1', dup, 'doc');
    db.prepare('INSERT INTO threads (id, primary_subject_id) VALUES (?,?)').run('th1', dup);
    db.prepare('INSERT INTO relationships (id, from_subject_id, to_subject_id, kind) VALUES (?,?,?,?)').run('r1', dup, other, 'works_for');
    db.prepare('INSERT INTO relationships (id, from_subject_id, to_subject_id, kind) VALUES (?,?,?,?)').run('r2', other, dup, 'employs');
    db.prepare('INSERT INTO engagements (subject_id, provider_subject_id, client_subject_id) VALUES (?,?,?)').run(engSubj, dup, other);
    db.prepare('INSERT INTO engagements (subject_id, provider_subject_id, client_subject_id) VALUES (?,?,?)').run(engSubj2, other, dup);
    db.prepare('INSERT INTO subject_cooccurrences (subject_a_id, subject_b_id, count, last_seen_at) VALUES (?,?,?,?)').run(dup, other, 3, '2026-01-01');

    const res = store.mergeSubjects(dup, canon);
    expect(res.ok).toBe(true);

    const val = (sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as Record<string, unknown>);
    expect(val('SELECT subject_id FROM memories WHERE id=?', 'm1').subject_id).toBe(canon);
    expect(db.prepare('SELECT subject_id FROM memory_subjects WHERE memory_id=?').get('m1')).toMatchObject({ subject_id: canon });
    expect(val('SELECT subject_id, assignee_subject_id FROM tasks WHERE id=?', 't1')).toMatchObject({ subject_id: canon, assignee_subject_id: canon });
    expect(val('SELECT subject_id FROM triggers WHERE id=?', 'tr1').subject_id).toBe(canon);
    expect(val('SELECT subject_id FROM connections WHERE id=?', 'c1').subject_id).toBe(canon);
    expect(val('SELECT subject_id FROM artifacts WHERE id=?', 'a1').subject_id).toBe(canon);
    expect(val('SELECT primary_subject_id FROM threads WHERE id=?', 'th1').primary_subject_id).toBe(canon);
    expect(val('SELECT from_subject_id FROM relationships WHERE id=?', 'r1').from_subject_id).toBe(canon);
    expect(val('SELECT to_subject_id FROM relationships WHERE id=?', 'r2').to_subject_id).toBe(canon);
    expect(val('SELECT provider_subject_id FROM engagements WHERE subject_id=?', engSubj).provider_subject_id).toBe(canon);
    expect(val('SELECT client_subject_id FROM engagements WHERE subject_id=?', engSubj2).client_subject_id).toBe(canon);
    expect(val('SELECT parent_id FROM subjects WHERE id=?', child).parent_id).toBe(canon);
    // dup's derived co-occurrence dropped; dup archived + redirected; aliases unioned.
    expect(db.prepare('SELECT COUNT(*) c FROM subject_cooccurrences WHERE subject_a_id=? OR subject_b_id=?').get(dup, dup)).toMatchObject({ c: 0 });
    const dupRow = store.getSubject(dup)!;
    expect(dupRow.archived_at).not.toBeNull();
    expect(dupRow.merged_into).toBe(canon);
    expect(JSON.parse(store.getSubject(canon)!.aliases)).toContain('Ada');
    engine.close();
  });

  it('memory_subjects repoint is collision-safe (memory mentioning BOTH) + drops the dup link', () => {
    const { store, engine, db } = makeStore();
    const dup = store.createSubject({ kind: 'person', name: 'Ada' });
    const canon = store.createSubject({ kind: 'person', name: 'Dr. Ada Lovelace' });
    db.prepare('INSERT INTO memories (id, text, namespace, scope_type, scope_id) VALUES (?,?,?,?,?)').run('m1', 'x', 'knowledge', 'global', 'g');
    db.prepare('INSERT INTO memory_subjects (memory_id, subject_id) VALUES (?,?)').run('m1', dup);
    db.prepare('INSERT INTO memory_subjects (memory_id, subject_id) VALUES (?,?)').run('m1', canon);

    store.mergeSubjects(dup, canon);
    const links = db.prepare('SELECT subject_id FROM memory_subjects WHERE memory_id=?').all('m1') as Array<{ subject_id: string }>;
    expect(links).toHaveLength(1);
    expect(links[0]!.subject_id).toBe(canon);
    engine.close();
  });

  // ── detail COALESCE-merge (canonical wins, dup fills nulls) ──────

  it('merges person detail: canonical wins on conflict, dup fills nulls (encrypted at rest)', () => {
    const { store, engine } = makeStore('vault-key-123');
    const dup = store.createSubject({ kind: 'person', name: 'Ada' });
    const canon = store.createSubject({ kind: 'person', name: 'Dr. Ada Lovelace' });
    store.setPersonDetail(canon, { email: 'canon@x.com', role: 'CEO' });
    store.setPersonDetail(dup, { email: 'dup@x.com', phone: '+41 79 000' });

    store.mergeSubjects(dup, canon);
    const d = store.getPersonDetail(canon)!;
    expect(d.email).toBe('canon@x.com');   // canonical wins
    expect(d.phone).toBe('+41 79 000');    // dup fills the null
    expect(d.role).toBe('CEO');
    expect(store.getPersonDetail(dup)).toBeNull();   // dup detail deleted
    engine.close();
  });

  it('repoints detail when canonical has none (dup detail moves over) + reverses on rollback', () => {
    const { store, engine } = makeStore();
    const dup = store.createSubject({ kind: 'person', name: 'Ada' });
    const canon = store.createSubject({ kind: 'person', name: 'Dr. Ada Lovelace' });
    store.setPersonDetail(dup, { email: 'dup@x.com' });
    const res = store.mergeSubjects(dup, canon);
    expect(res.ok).toBe(true);
    expect(store.getPersonDetail(canon)?.email).toBe('dup@x.com');
    expect(store.getPersonDetail(dup)).toBeNull();
    // rollback the detail-repoint branch: detail moves back to dup, canonical null again.
    if (res.ok) store.rollbackMerge(res.entry);
    expect(store.getPersonDetail(dup)?.email).toBe('dup@x.com');
    expect(store.getPersonDetail(canon)).toBeNull();
    engine.close();
  });

  it('merge detail: a money (amount, currency) pair moves together — no cross-currency stitch', () => {
    const { store, engine, db } = makeStore();
    const canon = store.createSubject({ kind: 'product', name: 'Widget' });
    const dup = store.createSubject({ kind: 'product', name: 'Widget v2' });
    // Canonical has a currency but NO price; the dup has a EUR price. A per-column COALESCE
    // would fill the price from the dup but keep the canonical's stale USD → 5000 "USD".
    db.prepare("INSERT INTO products (subject_id, price_cents, currency) VALUES (?, NULL, 'USD')").run(canon);
    db.prepare("INSERT INTO products (subject_id, price_cents, currency) VALUES (?, 5000, 'EUR')").run(dup);

    store.mergeSubjects(dup, canon);

    const row = db.prepare('SELECT price_cents, currency FROM products WHERE subject_id = ?').get(canon) as { price_cents: number; currency: string };
    expect(row.price_cents).toBe(5000);   // amount filled from the dup…
    expect(row.currency).toBe('EUR');     // …and its currency came WITH it, not the stale USD
    engine.close();
  });

  it('memory_subjects rollback keeps canonical’s PRE-existing link (split-back only drops merge-added)', () => {
    const { store, engine, db } = makeStore();
    const dup = store.createSubject({ kind: 'person', name: 'Ada' });
    const canon = store.createSubject({ kind: 'person', name: 'Dr. Ada Lovelace' });
    db.prepare('INSERT INTO memories (id, text, namespace, scope_type, scope_id) VALUES (?,?,?,?,?)').run('m1', 'x', 'knowledge', 'global', 'g');
    db.prepare('INSERT INTO memory_subjects (memory_id, subject_id) VALUES (?,?)').run('m1', dup);
    db.prepare('INSERT INTO memory_subjects (memory_id, subject_id) VALUES (?,?)').run('m1', canon);   // canonical PRE-linked

    const res = store.mergeSubjects(dup, canon);
    expect(res.ok).toBe(true);
    if (res.ok) store.rollbackMerge(res.entry);
    // dup link restored AND canonical's own pre-existing link survives (not dropped as merge-added).
    const links = (db.prepare('SELECT subject_id FROM memory_subjects WHERE memory_id=?').all('m1') as Array<{ subject_id: string }>).map(r => r.subject_id).sort();
    expect(links).toEqual([canon, dup].sort());
    engine.close();
  });

  // ── resolveActiveSubject (redirect chaser) ──────────────────────

  it('resolveActiveSubject follows the redirect chain to the terminal active subject', () => {
    const { store, engine } = makeStore();
    const a = store.createSubject({ kind: 'person', name: 'Bri' });
    const b = store.createSubject({ kind: 'person', name: 'Ada' });
    const c = store.createSubject({ kind: 'person', name: 'Dr. Ada Lovelace' });
    store.mergeSubjects(b, c);   // b → c
    store.mergeSubjects(a, c);   // a → c
    expect(store.resolveActiveSubject(a)).toBe(c);
    expect(store.resolveActiveSubject(b)).toBe(c);
    expect(store.resolveActiveSubject(c)).toBe(c);
    expect(store.resolveActiveSubject('unknown')).toBe('unknown');
    engine.close();
  });

  it('resolveActiveSubject terminates on a cycle (does not hang)', () => {
    const { store, engine, db } = makeStore();
    const x = store.createSubject({ kind: 'person', name: 'X' });
    const y = store.createSubject({ kind: 'person', name: 'Y' });
    // Force a 2-cycle via raw UPDATE (mergeSubjects can never create one; both ids are
    // real so the merged_into FK holds — a dangling redirect is structurally impossible,
    // since the FK is ON DELETE SET NULL, which is why the code's !next branch is a
    // belt-and-braces guard rather than a reachable path).
    db.prepare('UPDATE subjects SET merged_into = ? WHERE id = ?').run(y, x);
    db.prepare('UPDATE subjects SET merged_into = ? WHERE id = ?').run(x, y);
    expect(() => store.resolveActiveSubject(x)).not.toThrow();
    expect([x, y]).toContain(store.resolveActiveSubject(x));   // terminates via the visited-set
    engine.close();
  });

  // ── self-parent guard ───────────────────────────────────────────

  it('nulls a self-parent when canonical.parent_id was the dup, and restores it on rollback', () => {
    const { store, engine } = makeStore();
    const dup = store.createSubject({ kind: 'organization', name: 'Acme Group' });
    const canon = store.createSubject({ kind: 'organization', name: 'Acme GmbH', parentId: dup });
    const res = store.mergeSubjects(dup, canon);
    expect(res.ok).toBe(true);
    expect(store.getSubject(canon)!.parent_id).toBeNull();   // no self-parent
    if (res.ok) store.rollbackMerge(res.entry);
    expect(store.getSubject(canon)!.parent_id).toBe(dup);    // restored
    engine.close();
  });

  // ── full reversibility (the standing constraint) ────────────────

  it('rollbackMerge restores the EXACT pre-merge state across every table', () => {
    const { store, engine, db } = makeStore('vault-key-xyz');
    const dup = store.createSubject({ kind: 'person', name: 'Ada' });
    const canon = store.createSubject({ kind: 'person', name: 'Dr. Ada Lovelace' });
    const other = store.createSubject({ kind: 'organization', name: 'Acme' });
    store.setPersonDetail(canon, { email: 'canon@x.com' });
    store.setPersonDetail(dup, { phone: '123' });
    db.prepare('INSERT INTO memories (id, text, namespace, subject_id, scope_type, scope_id) VALUES (?,?,?,?,?,?)').run('m1', 'x', 'knowledge', dup, 'global', 'g');
    db.prepare('INSERT INTO memory_subjects (memory_id, subject_id) VALUES (?,?)').run('m1', dup);
    db.prepare('INSERT INTO tasks (id, title, subject_id) VALUES (?,?,?)').run('t1', 'T', dup);
    db.prepare('INSERT INTO relationships (id, from_subject_id, to_subject_id, kind) VALUES (?,?,?,?)').run('r1', dup, other, 'works_for');
    db.prepare('INSERT INTO subject_cooccurrences (subject_a_id, subject_b_id, count, last_seen_at) VALUES (?,?,?,?)').run(dup, other, 5, '2026-02-02');
    const aliasesBefore = store.getSubject(canon)!.aliases;

    const res = store.mergeSubjects(dup, canon);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const rb = store.rollbackMerge(res.entry);
    expect(rb.ok).toBe(true);

    const g = (sql: string, ...a: unknown[]) => db.prepare(sql).get(...a) as Record<string, unknown>;
    expect(g('SELECT subject_id FROM memories WHERE id=?', 'm1').subject_id).toBe(dup);
    expect(g('SELECT subject_id FROM memory_subjects WHERE memory_id=?', 'm1').subject_id).toBe(dup);
    expect(db.prepare('SELECT COUNT(*) c FROM memory_subjects WHERE subject_id=?').get(canon)).toMatchObject({ c: 0 });
    expect(g('SELECT subject_id FROM tasks WHERE id=?', 't1').subject_id).toBe(dup);
    expect(g('SELECT from_subject_id FROM relationships WHERE id=?', 'r1').from_subject_id).toBe(dup);
    expect(db.prepare('SELECT count FROM subject_cooccurrences WHERE subject_a_id=? AND subject_b_id=?').get(dup, other)).toMatchObject({ count: 5 });
    const dupRow = store.getSubject(dup)!;
    expect(dupRow.archived_at).toBeNull();       // un-archived
    expect(dupRow.merged_into).toBeNull();        // un-redirected
    expect(store.getSubject(canon)!.aliases).toBe(aliasesBefore);   // exact aliases restored
    expect(store.getPersonDetail(canon)?.email).toBe('canon@x.com');
    expect(store.getPersonDetail(canon)?.phone).toBeUndefined();     // dup's phone not left behind
    expect(store.getPersonDetail(dup)?.phone).toBe('123');           // dup detail restored
    engine.close();
  });

  // ── ledger repoints are held to the list a merge makes ─────────

  it('isRepointTarget accepts exactly the repoints planMerge records', () => {
    expect(isRepointTarget({ table: 'tasks', pkCol: 'id', column: 'assignee_subject_id' })).toBe(true);
    expect(isRepointTarget({ table: 'engagements', pkCol: 'subject_id', column: 'client_subject_id' })).toBe(true);
    expect(isRepointTarget({ table: 'engagements', pkCol: 'id', column: 'client_subject_id' })).toBe(false); // wrong key column
    expect(isRepointTarget({ table: 'memories', pkCol: 'id', column: 'scope_id' })).toBe(false);
    expect(isRepointTarget({ table: ['tasks'], pkCol: 'id', column: 'subject_id' })).toBe(false);
  });

  it('rollbackMerge REFUSES a ledger naming a repoint outside that list, and changes nothing', () => {
    const { store, engine, db } = makeStore();
    const dup = store.createSubject({ kind: 'person', name: 'Ada' });
    const canon = store.createSubject({ kind: 'person', name: 'Dr. Ada Lovelace' });
    db.prepare('INSERT INTO tasks (id, title, subject_id) VALUES (?,?,?)').run('t1', 'T', dup);
    // A real column whose value is the canonical's id, so a reversal that wrote it would change it.
    db.prepare('INSERT INTO memories (id, text, namespace, scope_type, scope_id) VALUES (?,?,?,?,?)').run('m1', 'x', 'knowledge', 'global', canon);
    const res = store.mergeSubjects(dup, canon);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const forged = { ...res.entry, repoints: [...res.entry.repoints, { table: 'memories', pkCol: 'id', column: 'scope_id', pks: ['m1'] }] };

    const rb = store.rollbackMerge(forged);
    expect(rb.ok).toBe(false);
    expect(rb.reason).toMatch(/never moves/);
    const g = (sql: string, ...a: unknown[]) => db.prepare(sql).get(...a) as Record<string, unknown>;
    expect(g('SELECT scope_id FROM memories WHERE id=?', 'm1').scope_id).toBe(canon);
    expect(g('SELECT subject_id FROM tasks WHERE id=?', 't1').subject_id).toBe(canon);   // the real repoint stays too
    expect(store.getSubject(dup)!.merged_into).toBe(canon);
    engine.close();
  });

  it('rollbackMerge REFUSES a ledger whose kind is not the entry\'s own, and changes nothing', () => {
    const { store, engine, db } = makeStore();
    const dup = store.createSubject({ kind: 'person', name: 'Ada' });
    const canon = store.createSubject({ kind: 'person', name: 'Dr. Ada Lovelace' });
    db.prepare('INSERT INTO tasks (id, title, subject_id) VALUES (?,?,?)').run('t1', 'T', dup);
    const res = store.mergeSubjects(dup, canon);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const rb = store.rollbackMerge({ ...res.entry, kind: 'organization' });
    expect(rb.ok).toBe(false);
    expect(rb.reason).toMatch(/names the kind organization, but the entry is a person/);
    expect((db.prepare('SELECT subject_id FROM tasks WHERE id=?').get('t1') as { subject_id: string }).subject_id).toBe(canon);
    expect(store.getSubject(dup)!.merged_into).toBe(canon);
    engine.close();
  });

  it('executeMerge REFUSES an entry whose kind is not the subjects\' kind, before any write', () => {
    const { store, engine, db } = makeStore();
    const dup = store.createSubject({ kind: 'person', name: 'Ada' });
    const canon = store.createSubject({ kind: 'person', name: 'Dr. Ada Lovelace' });
    db.prepare('INSERT INTO tasks (id, title, subject_id) VALUES (?,?,?)').run('t1', 'T', dup);
    const plan = store.planMerge(dup, canon);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;

    expect(() => store.executeMerge({ ...plan.entry, kind: 'organization' })).toThrow(/kind \(organization\) is not the subjects' kind \(person\)/);
    expect((db.prepare('SELECT subject_id FROM tasks WHERE id=?').get('t1') as { subject_id: string }).subject_id).toBe(dup);
    expect(store.getSubject(dup)!.merged_into).toBeNull();
    engine.close();
  });

  it('executeMerge REFUSES an entry naming a repoint outside that list, before any write', () => {
    const { store, engine, db } = makeStore();
    const dup = store.createSubject({ kind: 'person', name: 'Ada' });
    const canon = store.createSubject({ kind: 'person', name: 'Dr. Ada Lovelace' });
    db.prepare('INSERT INTO tasks (id, title, subject_id) VALUES (?,?,?)').run('t1', 'T', dup);
    db.prepare('INSERT INTO memories (id, text, namespace, scope_type, scope_id) VALUES (?,?,?,?,?)').run('m1', 'x', 'knowledge', 'global', dup);
    const plan = store.planMerge(dup, canon);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const forged = { ...plan.entry, repoints: [...plan.entry.repoints, { table: 'memories', pkCol: 'id', column: 'scope_id', pks: ['m1'] }] };

    expect(() => store.executeMerge(forged)).toThrow(/never moves/);
    const g = (sql: string, ...a: unknown[]) => db.prepare(sql).get(...a) as Record<string, unknown>;
    expect(g('SELECT scope_id FROM memories WHERE id=?', 'm1').scope_id).toBe(dup);
    expect(g('SELECT subject_id FROM tasks WHERE id=?', 't1').subject_id).toBe(dup);
    expect(store.getSubject(dup)!.merged_into).toBeNull();
    engine.close();
  });

  // ── resolvePersonSubject (write-time subset dedup) ──────────────

  it('resolvePersonSubject: exact→canonical, alias→alias, unambiguous subset→alias, ambiguous→new', () => {
    const { store, engine } = makeStore();
    const ada = store.findOrCreate({ kind: 'person', name: 'Dr. Ada Lovelace', aliases: ['A. Lovelace'] }).id;

    expect(store.resolvePersonSubject('Dr. Ada Lovelace')).toMatchObject({ id: ada, resolved: 'canonical', created: false });
    expect(store.resolvePersonSubject('A. Lovelace')).toMatchObject({ id: ada, resolved: 'alias', created: false });
    // "Ada" ⊂ {ada, lovelace} — exactly one superset → fold in as alias.
    const sub = store.resolvePersonSubject('Ada');
    expect(sub).toMatchObject({ id: ada, resolved: 'subset', created: false });
    expect(JSON.parse(store.getSubject(ada)!.aliases)).toContain('Ada');

    // ambiguity → never guess → new subject.
    store.findOrCreate({ kind: 'person', name: 'Alan Turing' });
    store.findOrCreate({ kind: 'person', name: 'Alan Kay' });
    const amb = store.resolvePersonSubject('Alan');
    expect(amb.created).toBe(true);
    expect(amb.resolved).toBe('created');
    engine.close();
  });

  it('resolvePersonSubject scopes the subset search to the owner', () => {
    const { store, engine } = makeStore();
    store.findOrCreate({ kind: 'person', name: 'Dr. Ada Lovelace', ownerUserId: 'tenant-1' });
    // Different owner → no superset visible → fresh subject in tenant-2.
    const r = store.resolvePersonSubject('Ada', { ownerUserId: 'tenant-2' });
    expect(r.created).toBe(true);
    engine.close();
  });

  it('resolvePersonSubject: a title-only variant with EQUAL content tokens folds in (no dup)', () => {
    const { store, engine } = makeStore();
    const ada = store.findOrCreate({ kind: 'person', name: 'Ada Lovelace' }).id;
    // "Dr. Ada Lovelace" strips to the same content tokens as "Ada Lovelace"; exact/normalized
    // miss the honorific and the STRICT subset scan rejects an equal set — pre-fix this minted
    // a permanent duplicate. Now it folds in as an alias.
    const r = store.resolvePersonSubject('Dr. Ada Lovelace');
    expect(r).toMatchObject({ id: ada, created: false });
    expect(JSON.parse(store.getSubject(ada)!.aliases)).toContain('Dr. Ada Lovelace');
    engine.close();
  });

  it('resolvePersonSubject: a generational suffix is identity-bearing (father not folded into son)', () => {
    const { store, engine } = makeStore();
    const jr = store.findOrCreate({ kind: 'person', name: 'John Smith Jr' }).id;
    // "John Smith" ⊂ {john, smith, jr} by raw tokens, but Jr is a different generation → must
    // NOT fold; mint a fresh distinct subject.
    const r = store.resolvePersonSubject('John Smith');
    expect(r.created).toBe(true);
    expect(r.id).not.toBe(jr);
    engine.close();
  });

  // ── token helpers ────────────────────────────────────────────────

  it('personNameTokens strips titles + punctuation; isProperTokenSubset is strict', () => {
    expect(personNameTokens('Dr. Ada Lovelace')).toEqual(['ada', 'lovelace']);
    expect(personNameTokens('Herr Alan')).toEqual(['alan']);
    expect(isProperTokenSubset(['ada'], ['ada', 'lovelace'])).toBe(true);
    expect(isProperTokenSubset(['ada', 'lovelace'], ['ada', 'lovelace'])).toBe(false);   // not strict
    expect(isProperTokenSubset(['anna'], ['ada', 'lovelace'])).toBe(false);
    expect(isProperTokenSubset([], ['x'])).toBe(false);
  });

  it('isPersonSubsetSafe rejects a generational-suffix difference; personTokenKey ignores titles', () => {
    // A plain name is a safe subset of the same name + a middle/first token…
    expect(isPersonSubsetSafe(['john', 'smith'], ['john', 'q', 'smith'])).toBe(true);
    // …but NOT when the extra token is a generational suffix (father vs son).
    expect(isPersonSubsetSafe(['john', 'smith'], ['john', 'smith', 'jr'])).toBe(false);
    expect(isPersonSubsetSafe(['john', 'smith'], ['john', 'smith', 'iii'])).toBe(false);
    // personTokenKey is title-insensitive + order-insensitive.
    expect(personTokenKey('Dr. Ada Lovelace')).toBe('ada lovelace');
    expect(personTokenKey('Ada Lovelace')).toBe(personTokenKey('Lovelace, Ada'));
  });
});

// ── DataStore cross-DB repoint ─────────────────────────────────────

describe('DataStore.repointSubjectId (Record-on-spine merge follow-through)', () => {
  const tmpDirs: string[] = [];
  function makeDs(): DataStore {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-ds-merge-'));
    tmpDirs.push(dir);
    return new DataStore(join(dir, 'datastore.db'));
  }
  afterEach(() => {
    for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  it('repoints every subject-column cell old→new and reverses via rollbackRepoint', () => {
    const ds = makeDs();
    ds.createCollection({
      name: 'invoices',
      scope: { type: 'global', id: 'g' },
      columns: [
        { name: 'client', type: 'subject', subjectKind: 'organization' },
        { name: 'vendor', type: 'subject', subjectKind: 'organization' },
        { name: 'amount', type: 'number' },
      ],
    });
    ds.insertRecords({ collection: 'invoices', records: [
      { client: 'old-id', vendor: 'x', amount: 10 },
      { client: 'other', vendor: 'old-id', amount: 20 },
      { client: 'other', vendor: 'other', amount: 30 },
    ] });
    // A 2nd collection with NO subject column — exercises the skip branch + multi-collection walk.
    ds.createCollection({ name: 'notes', scope: { type: 'global', id: 'g' }, columns: [{ name: 'body', type: 'string' }] });
    ds.insertRecords({ collection: 'notes', records: [{ body: 'old-id' }] });   // literal string, NOT a subject cell

    const rec = ds.repointSubjectId('old-id', 'new-id');
    expect(rec.every(r => r.collection === 'invoices')).toBe(true);   // notes untouched (no subject column)
    expect(ds.queryRecords({ collection: 'notes' }).rows[0]!['body']).toBe('old-id');
    const rows = () => ds.queryRecords({ collection: 'invoices' }).rows;
    expect(rows().filter(r => r['client'] === 'new-id' || r['vendor'] === 'new-id')).toHaveLength(2);
    expect(rows().some(r => r['client'] === 'old-id' || r['vendor'] === 'old-id')).toBe(false);

    ds.rollbackRepoint('old-id', 'new-id', rec);
    expect(rows().filter(r => r['client'] === 'old-id' || r['vendor'] === 'old-id')).toHaveLength(2);
    expect(rows().some(r => r['client'] === 'new-id' || r['vendor'] === 'new-id')).toBe(false);
  });

  it('rollbackRepoint REFUSES a record naming a non-subject column, and changes nothing', () => {
    const ds = makeDs();
    ds.createCollection({ name: 'invoices', scope: { type: 'global', id: 'g' }, columns: [
      { name: 'client', type: 'subject', subjectKind: 'organization' },
      { name: 'note', type: 'string' },
    ] });
    ds.insertRecords({ collection: 'invoices', records: [{ client: 'new-id', note: 'new-id' }] });

    expect(ds.repointRecordState({ collection: 'invoices', column: 'client' })).toBe('ok');
    expect(ds.repointRecordState({ collection: 'invoices', column: 'note' })).toBe('foreign');
    expect(ds.repointRecordState({ collection: 'nope', column: 'client' })).toBe('gone');
    expect(ds.repointRecordState({ collection: 'invoices', column: 'vendor' })).toBe('gone');   // not in the schema
    expect(ds.repointRecordState({ collection: 'invoices', column: '_id' })).toBe('gone');      // system column: skipped, never written
    expect(ds.repointRecordState({ collection: 1, column: 'client' })).toBe('foreign');

    expect(() => ds.rollbackRepoint('old-id', 'new-id', [
      { collection: 'invoices', column: 'client', ids: [1] },
      { collection: 'invoices', column: 'note', ids: [1] },
    ])).toThrow(/not a subject column/);
    const row = ds.queryRecords({ collection: 'invoices' }).rows[0]!;
    expect(row['client']).toBe('new-id');
    expect(row['note']).toBe('new-id');
  });

  it('rollbackRepoint skips a record with nothing left to move back and reverses the rest', () => {
    const ds = makeDs();
    ds.createCollection({ name: 'invoices', scope: { type: 'global', id: 'g' }, columns: [
      { name: 'client', type: 'subject', subjectKind: 'organization' },
    ] });
    ds.insertRecords({ collection: 'invoices', records: [{ client: 'new-id' }] });
    ds.rollbackRepoint('old-id', 'new-id', [
      { collection: 'quotes', column: 'client', ids: [1] },      // collection dropped since
      { collection: 'invoices', column: 'vendor', ids: [1] },    // column no longer in the schema
      { collection: 'invoices', column: 'client', ids: [1] },
    ]);
    expect(ds.queryRecords({ collection: 'invoices' }).rows[0]!['client']).toBe('old-id');
  });
});

/**
 * What a rollback must leave alone. Two shapes the reversal used to overwrite: a merge whose
 * canonical has itself been merged since (the chain A→B→C), and the canonical's own aliases
 * and detail columns edited AFTER the merge — the before-image went back over them.
 */
describe('SubjectStore.rollbackMerge — a chain, and edits made after the merge', () => {
  const tmpDirs: string[] = [];
  function makeStore(key = ''): { store: SubjectStore; engine: EngineDb; db: Database.Database } {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-merge-after-'));
    tmpDirs.push(dir);
    const engine = new EngineDb(join(dir, 'engine.db'), key);
    return { store: new SubjectStore(engine), engine, db: engine.getDb() };
  }
  afterEach(() => {
    for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
    tmpDirs.length = 0;
  });
  const aliasesOf = (store: SubjectStore, id: string): string[] => JSON.parse(store.getSubject(id)!.aliases) as string[];

  it('refuses to reverse a merge whose canonical has itself been merged since, and changes nothing', () => {
    const { store, engine } = makeStore();
    const a = store.createSubject({ kind: 'organization', name: 'Acme GmbH' });
    const b = store.createSubject({ kind: 'organization', name: 'Acme' });
    const c = store.createSubject({ kind: 'organization', name: 'ACME Holding' });
    const ab = store.mergeSubjects(a, b);
    const bc = store.mergeSubjects(b, c);
    expect(ab.ok && bc.ok).toBe(true);
    if (!ab.ok || !bc.ok) return;
    const before = { a: store.getSubject(a)!, b: store.getSubject(b)!, c: store.getSubject(c)! };

    const back = store.rollbackMerge(ab.entry);
    expect(back.ok).toBe(false);
    expect(back.reason).toMatch(/merged into .*Reverse that newer merge first/);
    expect({ a: store.getSubject(a)!, b: store.getSubject(b)!, c: store.getSubject(c)! }).toEqual(before);

    // In order, both reverse cleanly.
    expect(store.rollbackMerge(bc.entry).ok).toBe(true);
    expect(store.rollbackMerge(ab.entry).ok).toBe(true);
    for (const id of [a, b, c]) expect(store.getSubject(id)!.merged_into).toBeNull();
    engine.close();
  });

  it('keeps a surface form the canonical learned after the merge; without one the before-image goes back verbatim', () => {
    const { store, engine } = makeStore();
    const a = store.createSubject({ kind: 'organization', name: 'Acme GmbH' });
    const b = store.createSubject({ kind: 'organization', name: 'Acme', aliases: ['acme.com'] });
    const bAliasesBefore = store.getSubject(b)!.aliases;
    const ab = store.mergeSubjects(a, b);
    expect(ab.ok).toBe(true);
    if (!ab.ok) return;
    expect(aliasesOf(store, b)).toEqual(['acme.com', 'Acme GmbH']);
    // A later mention in new forms folds into the canonical — learned after the merge (the
    // lower-case name is a new form too: the list dedupes against itself, not the name).
    const fold = store.findOrCreate({ kind: 'organization', name: 'acme', aliases: ['Acme Holding'] });
    expect(fold).toEqual({ ambiguous: false, id: b, created: false });
    expect(aliasesOf(store, b)).toEqual(['acme.com', 'Acme GmbH', 'acme', 'Acme Holding']);

    expect(store.rollbackMerge(ab.entry).ok).toBe(true);
    expect(aliasesOf(store, b)).toEqual(['acme.com', 'acme', 'Acme Holding']);   // the merge's addition gone, the learned forms kept
    expect(store.getSubject(a)!.merged_into).toBeNull();

    // Positive control: a pair nothing touched after the merge restores the stored string byte for byte.
    const d = store.createSubject({ kind: 'organization', name: 'Beta AG' });
    const e = store.createSubject({ kind: 'organization', name: 'Beta', aliases: ['beta.ch'] });
    const eAliasesBefore = store.getSubject(e)!.aliases;
    const de = store.mergeSubjects(d, e);
    expect(de.ok).toBe(true);
    if (!de.ok) return;
    expect(store.rollbackMerge(de.entry).ok).toBe(true);
    expect(store.getSubject(e)!.aliases).toBe(eAliasesBefore);
    expect(bAliasesBefore).toBe('["acme.com"]');
    engine.close();
  });

  it('keeps a detail column edited after the merge, restores the rest, and re-inserts the dup row', () => {
    const { store, engine } = makeStore('vault-key-123');
    const dup = store.createSubject({ kind: 'person', name: 'Ada' });
    const canon = store.createSubject({ kind: 'person', name: 'Dr. Ada Lovelace' });
    store.setPersonDetail(canon, { email: 'canon@x.com', role: 'CEO' });
    store.setPersonDetail(dup, { email: 'dup@x.com', phone: '+41 79 000' });
    const res = store.mergeSubjects(dup, canon);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(store.getPersonDetail(canon)!.phone).toBe('+41 79 000');   // filled from the dup
    // The owner corrects the phone after the merge.
    store.setPersonDetail(canon, { email: 'canon@x.com', phone: '+41 79 999', role: 'CEO' });

    expect(store.rollbackMerge(res.entry).ok).toBe(true);
    const c = store.getPersonDetail(canon)!;
    expect(c.phone).toBe('+41 79 999');
    expect(c.email).toBe('canon@x.com');
    expect(c.role).toBe('CEO');
    const d = store.getPersonDetail(dup)!;
    expect(d.email).toBe('dup@x.com');
    expect(d.phone).toBe('+41 79 000');
    engine.close();
  });

  it('positive control: with no edit after the merge the filled column goes back to empty', () => {
    const { store, engine } = makeStore('vault-key-123');
    const dup = store.createSubject({ kind: 'person', name: 'Ada' });
    const canon = store.createSubject({ kind: 'person', name: 'Dr. Ada Lovelace' });
    store.setPersonDetail(canon, { email: 'canon@x.com', role: 'CEO' });
    store.setPersonDetail(dup, { email: 'dup@x.com', phone: '+41 79 000' });
    const res = store.mergeSubjects(dup, canon);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(store.rollbackMerge(res.entry).ok).toBe(true);
    expect(store.getPersonDetail(canon)!.phone ?? null).toBeNull();
    expect(store.getPersonDetail(canon)!.email).toBe('canon@x.com');
    expect(store.getPersonDetail(dup)!.phone).toBe('+41 79 000');
    engine.close();
  });

  it('a moved-over detail row edited after the merge stays on the canonical; the dup gets its own row back', () => {
    const { store, engine } = makeStore('vault-key-123');
    const dup = store.createSubject({ kind: 'person', name: 'Ada' });
    const canon = store.createSubject({ kind: 'person', name: 'Dr. Ada Lovelace' });
    store.setPersonDetail(dup, { email: 'dup@x.com' });
    const res = store.mergeSubjects(dup, canon);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(store.getPersonDetail(canon)!.email).toBe('dup@x.com');
    store.setPersonDetail(canon, { email: 'new@x.com' });

    expect(store.rollbackMerge(res.entry).ok).toBe(true);
    expect(store.getPersonDetail(canon)!.email).toBe('new@x.com');
    expect(store.getPersonDetail(dup)!.email).toBe('dup@x.com');
    engine.close();
  });

  it('a moved-over row with ONE column edited since: the canonical keeps that column only, the dup gets its row back', () => {
    const { store, engine } = makeStore('vault-key-123');
    const dup = store.createSubject({ kind: 'person', name: 'Ada' });
    const canon = store.createSubject({ kind: 'person', name: 'Dr. Ada Lovelace' });
    store.setPersonDetail(dup, { email: 'dup@x.com', phone: '+41 79 000' });
    const res = store.mergeSubjects(dup, canon);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    store.setPersonDetail(canon, { role: 'CEO' });   // the only edit; email + phone are still the dup's

    expect(store.rollbackMerge(res.entry).ok).toBe(true);
    const c = store.getPersonDetail(canon)!;
    expect(c.role).toBe('CEO');
    expect(c.email ?? null).toBeNull();             // the dup's contact data is not left on the canonical
    expect(c.phone ?? null).toBeNull();
    const d = store.getPersonDetail(dup)!;
    expect(d.email).toBe('dup@x.com');
    expect(d.phone).toBe('+41 79 000');
    engine.close();
  });

  it('a value re-saved unchanged after the merge is not an edit: the filled column goes back to empty', () => {
    // email/phone are encrypted with a fresh IV per write — the same plaintext saved again is a
    // different stored string, and a comparison on the stored value would call that an edit.
    const { store, engine } = makeStore('vault-key-123');
    const dup = store.createSubject({ kind: 'person', name: 'Ada' });
    const canon = store.createSubject({ kind: 'person', name: 'Dr. Ada Lovelace' });
    store.setPersonDetail(canon, { email: 'canon@x.com' });
    store.setPersonDetail(dup, { email: 'dup@x.com', phone: '+41 79 000' });
    const res = store.mergeSubjects(dup, canon);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    store.setPersonDetail(canon, { phone: '+41 79 000' });   // re-asserts the value the merge filled in

    expect(store.rollbackMerge(res.entry).ok).toBe(true);
    expect(store.getPersonDetail(canon)!.phone ?? null).toBeNull();
    expect(store.getPersonDetail(canon)!.email).toBe('canon@x.com');
    expect(store.getPersonDetail(dup)!.phone).toBe('+41 79 000');
    engine.close();
  });

  it('two merges into one canonical, reversed oldest first, leave nothing of either dup on it', () => {
    const { store, engine } = makeStore('vault-key-123');
    const a = store.createSubject({ kind: 'person', name: 'A. Lovelace' });
    const x = store.createSubject({ kind: 'person', name: 'Ada L.' });
    const b = store.createSubject({ kind: 'person', name: 'Ada Lovelace' });
    store.setPersonDetail(a, { email: 'a@x.com' });
    store.setPersonDetail(x, { phone: '+41 79 999' });
    const ab = store.mergeSubjects(a, b);   // A's row moves over (B had none)
    const xb = store.mergeSubjects(x, b);   // X's phone fills B's empty column
    expect(ab.ok && xb.ok).toBe(true);
    if (!ab.ok || !xb.ok) return;
    expect(store.getPersonDetail(b)).toMatchObject({ email: 'a@x.com', phone: '+41 79 999' });

    expect(store.rollbackMerge(ab.entry).ok).toBe(true);
    expect(store.rollbackMerge(xb.entry).ok).toBe(true);
    expect(store.getPersonDetail(a)!.email).toBe('a@x.com');
    expect(store.getPersonDetail(x)!.phone).toBe('+41 79 999');
    const bNow = store.getPersonDetail(b);
    expect(bNow?.email ?? null).toBeNull();
    expect(bNow?.phone ?? null).toBeNull();
    expect(bNow?.role ?? null).toBeNull();
    engine.close();
  });

  it('a chain of three reversed in the middle is refused at both older ledgers', () => {
    const { store, engine } = makeStore();
    const a = store.createSubject({ kind: 'organization', name: 'Acme GmbH' });
    const b = store.createSubject({ kind: 'organization', name: 'Acme' });
    const c = store.createSubject({ kind: 'organization', name: 'ACME Holding' });
    const d = store.createSubject({ kind: 'organization', name: 'ACME Group' });
    const ab = store.mergeSubjects(a, b);
    const bc = store.mergeSubjects(b, c);
    const cd = store.mergeSubjects(c, d);
    expect(ab.ok && bc.ok && cd.ok).toBe(true);
    if (!ab.ok || !bc.ok || !cd.ok) return;
    expect(store.rollbackMerge(bc.entry).ok).toBe(false);   // C is merged into D
    expect(store.rollbackMerge(ab.entry).ok).toBe(false);   // B is merged into C
    expect(store.getSubject(a)!.merged_into).toBe(b);
    expect(store.getSubject(b)!.merged_into).toBe(c);
    expect(store.getSubject(c)!.merged_into).toBe(d);
    expect(store.rollbackMerge(cd.entry).ok).toBe(true);
    expect(store.rollbackMerge(bc.entry).ok).toBe(true);
    expect(store.rollbackMerge(ab.entry).ok).toBe(true);
    engine.close();
  });

  it('a money pair edited after the merge is kept as one — the currency does not go back alone', () => {
    const { store, engine, db } = makeStore();
    const canon = store.createSubject({ kind: 'product', name: 'Widget' });
    const dup = store.createSubject({ kind: 'product', name: 'Widget v2' });
    db.prepare('INSERT INTO products (subject_id, price_cents, currency) VALUES (?, NULL, NULL)').run(canon);
    db.prepare("INSERT INTO products (subject_id, price_cents, currency) VALUES (?, 5000, 'EUR')").run(dup);
    const res = store.mergeSubjects(dup, canon);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const row = (id: string): { price_cents: number | null; currency: string | null } | undefined =>
      db.prepare('SELECT price_cents, currency FROM products WHERE subject_id = ?').get(id) as { price_cents: number | null; currency: string | null } | undefined;
    expect(row(canon)).toEqual({ price_cents: 5000, currency: 'EUR' });
    // The owner re-prices after the merge; the currency column is untouched by that edit.
    db.prepare('UPDATE products SET price_cents = 6000 WHERE subject_id = ?').run(canon);

    expect(store.rollbackMerge(res.entry).ok).toBe(true);
    expect(row(canon)).toEqual({ price_cents: 6000, currency: 'EUR' });
    expect(row(dup)).toEqual({ price_cents: 5000, currency: 'EUR' });
    engine.close();
  });
});
