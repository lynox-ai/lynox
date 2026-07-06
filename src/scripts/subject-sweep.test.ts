import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngineDb } from '../core/engine-db.js';
import { SubjectStore } from '../core/subject-store.js';
import { DataStore } from '../core/data-store.js';
import { MemoryGraphStore } from '../core/memory-graph-store.js';
import { planArchive, applyArchive, rollback, parseArgs, planPersonSubsetPairs, doMerge, rollbackMergeFile } from './subject-sweep.js';
import type { MergeLedgerFile } from './subject-sweep.js';
import { readFileSync } from 'node:fs';

/**
 * Slice-1 garbage-sweep (archive phase): soft-archive `isCleanupTarget` junk subjects
 * + NULL the primaries pointing at them, reversibly, with guardrails that skip
 * (never archive) anything a human should look at.
 */
describe('subject-sweep — archive phase', () => {
  const dirs: string[] = [];
  const engines: EngineDb[] = [];
  afterEach(() => {
    for (const e of engines) { try { e.close(); } catch { /* */ } }
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    engines.length = 0; dirs.length = 0;
  });
  function make(): { engine: EngineDb; subs: SubjectStore; mg: MemoryGraphStore } {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-sweep-')); dirs.push(dir);
    const engine = new EngineDb(join(dir, 'engine.db'), ''); engines.push(engine);
    return { engine, subs: new SubjectStore(engine), mg: new MemoryGraphStore(engine) };
  }

  it('archives isCleanupTarget subjects, keeps real ones, reports escaped-slash', () => {
    const { engine, subs } = make();
    const junk1 = subs.createSubject({ kind: 'person', name: 'data' });          // isCleanupTarget
    const junk2 = subs.createSubject({ kind: 'engagement', name: 'tag/headline' }); // slash fragment → isCleanupTarget
    const real = subs.createSubject({ kind: 'organization', name: 'Meridian AG' });
    subs.createSubject({ kind: 'engagement', name: 'Google I/O' });               // slash but NOT junk (escaped)

    const plan = planArchive(engine, new Set());
    const archivedIds = new Set(plan.archive.map(a => a.id));
    expect(archivedIds).toEqual(new Set([junk1, junk2]));
    expect(archivedIds.has(real)).toBe(false);
    expect(plan.escapedSlash.map(s => s.name)).toEqual(['Google I/O']);

    const ledger = applyArchive(engine, plan);
    expect(ledger.archived).toHaveLength(2);
    // archived subjects vanish from listSubjects; real one stays.
    expect(subs.listSubjects().map(s => s.name).sort()).toEqual(['Google I/O', 'Meridian AG']);
    // idempotent: a re-plan finds nothing.
    expect(planArchive(engine, new Set()).archive).toHaveLength(0);
  });

  it('archives junk-SHAPED person subjects isCleanupTarget misses — but only for kind=person', () => {
    const { engine, subs } = make();
    const acr = subs.createSubject({ kind: 'person', name: 'CSV' });        // acronym → junk person
    const low = subs.createSubject({ kind: 'person', name: 'target' });     // lowercase → junk person (never a stopword)
    const realPerson = subs.createSubject({ kind: 'person', name: 'Grace Hopper' });
    const orgSameShape = subs.createSubject({ kind: 'organization', name: 'CSV' }); // same shape, NOT person → kept
    const plan = planArchive(engine, new Set());
    expect(new Set(plan.archive.map(a => a.id))).toEqual(new Set([acr, low]));
    expect(plan.archive.map(a => a.id)).not.toContain(realPerson);
    expect(plan.archive.map(a => a.id)).not.toContain(orgSameShape);
  });

  it('NULLs a memory primary pointing at junk (ranking fix) and rollback restores it', () => {
    const { engine, subs, mg } = make();
    const junk = subs.createSubject({ kind: 'person', name: 'confirmation' });
    mg.upsertStub({ id: 'm1', text: 'a real fact', namespace: 'knowledge', scopeType: 'context', scopeId: 'c1', subjectId: junk });
    expect(mg.getStub('m1')!.subject_id).toBe(junk);

    const ledger = applyArchive(engine, planArchive(engine, new Set()));
    expect(ledger.primaryNulled).toEqual([{ memoryId: 'm1', oldSubjectId: junk }]);
    expect(mg.getStub('m1')!.subject_id).toBeNull();              // memory kept, primary NULLed
    expect(engine.getDb().prepare('SELECT is_active FROM memories WHERE id=?').get('m1')).toMatchObject({ is_active: 1 }); // memory NOT deleted

    const r = rollback(engine, ledger);
    expect(r.collisions).toHaveLength(0);
    expect(mg.getStub('m1')!.subject_id).toBe(junk);             // fully restored
    expect(subs.listSubjects({ kind: 'person' }).map(s => s.id)).toContain(junk); // un-archived
  });

  it('guardrails: never archives a junk-named subject that a human should review', () => {
    const { engine, subs } = make();
    const db = engine.getDb();
    const self = subs.createSubject({ kind: 'person', name: 'data', isSelf: true });
    const parent = subs.createSubject({ kind: 'organization', name: 'launch' });
    subs.createSubject({ kind: 'engagement', name: 'Real Project', parentId: parent });
    const taskRef = subs.createSubject({ kind: 'person', name: 'notification' });
    db.prepare("INSERT INTO tasks (id, title, status, subject_id) VALUES ('t1','x','open',?)").run(taskRef);
    const assigneeRef = subs.createSubject({ kind: 'person', name: 'owner' });   // partial-OR: assignee only
    db.prepare("INSERT INTO tasks (id, title, status, assignee_subject_id) VALUES ('t2','x','open',?)").run(assigneeRef);
    const engRef = subs.createSubject({ kind: 'person', name: 'communication' });
    const engRow = subs.createSubject({ kind: 'engagement', name: 'Real Engagement' });
    db.prepare("INSERT INTO engagements (subject_id, client_subject_id) VALUES (?, ?)").run(engRow, engRef);
    const trigRef = subs.createSubject({ kind: 'person', name: 'work' });
    db.prepare("INSERT INTO triggers (id, title, subject_id) VALUES ('tr1','x',?)").run(trigRef);
    const connRef = subs.createSubject({ kind: 'person', name: 'estimates' });
    db.prepare("INSERT INTO connections (id, kind, name, subject_id) VALUES ('cn1','api','x',?)").run(connRef);
    const artRef = subs.createSubject({ kind: 'person', name: 'page' });
    db.prepare("INSERT INTO artifacts (id, type, subject_id) VALUES ('af1','doc',?)").run(artRef);
    const withEmail = subs.createSubject({ kind: 'person', name: 'input' });
    db.prepare("INSERT INTO people (subject_id, email) VALUES (?, 'x@y.z')").run(withEmail);
    const withPhone = subs.createSubject({ kind: 'person', name: 'before' });   // partial-OR: phone only (junk name)
    db.prepare("INSERT INTO people (subject_id, phone) VALUES (?, '+41…')").run(withPhone);
    const orgDetail = subs.createSubject({ kind: 'organization', name: 'identifying' });
    db.prepare("INSERT INTO organizations (subject_id, domain) VALUES (?, 'x.com')").run(orgDetail);
    const prodDetail = subs.createSubject({ kind: 'product', name: 'service' });
    db.prepare("INSERT INTO products (subject_id, sku) VALUES (?, 'SKU1')").run(prodDetail);
    const svcDetail = subs.createSubject({ kind: 'service', name: 'deployment' });
    db.prepare("INSERT INTO services (subject_id, hourly_rate_cents) VALUES (?, 100)").run(svcDetail);
    const anchor = subs.createSubject({ kind: 'person', name: 'segment' });
    const clean = subs.createSubject({ kind: 'person', name: 'testimonials' });   // SHOULD archive

    const plan = planArchive(engine, new Set([anchor]));
    expect(plan.archive.map(a => a.id)).toEqual([clean]);
    const reasons = Object.fromEntries(plan.blocked.map(b => [b.id, b.reason]));
    expect(reasons[self]).toBe('is_self');
    expect(reasons[parent]).toBe('has-children');
    expect(reasons[taskRef]).toBe('referenced-by-task');
    expect(reasons[assigneeRef]).toBe('referenced-by-task');
    expect(reasons[engRef]).toBe('referenced-by-engagement');
    expect(reasons[trigRef]).toBe('referenced-by-trigger');
    expect(reasons[connRef]).toBe('referenced-by-connection');
    expect(reasons[artRef]).toBe('referenced-by-artifact');
    expect(reasons[withEmail]).toBe('has-contact-detail');
    expect(reasons[withPhone]).toBe('has-contact-detail');
    expect(reasons[orgDetail]).toBe('has-org-detail');
    expect(reasons[prodDetail]).toBe('has-product-detail');
    expect(reasons[svcDetail]).toBe('has-service-detail');
    expect(reasons[anchor]).toBe('thread-anchor');
  });

  it('rollback reports a UNIQUE collision and skips that subject\'s primary-restore', () => {
    const { engine, subs, mg } = make();
    const junk = subs.findOrCreate({ kind: 'person', name: 'data' }).id;   // name-deduped kind
    mg.upsertStub({ id: 'm1', text: 't', namespace: 'knowledge', scopeType: 'context', scopeId: 'c1', subjectId: junk });
    const ledger = applyArchive(engine, planArchive(engine, new Set()));
    // Someone mints a NEW active 'data' person after the archive → un-archiving now collides.
    subs.findOrCreate({ kind: 'person', name: 'data' });
    const r = rollback(engine, ledger);
    expect(r.restored).toBe(0);
    expect(r.collisions).toHaveLength(1);
    // The memory primary is NOT restored onto the still-archived subject.
    expect(mg.getStub('m1')!.subject_id).toBeNull();
    engine.close();
  });

  it('parseArgs', () => {
    expect(parseArgs(['--apply', '--json'])).toMatchObject({ apply: true, json: true });
    expect(parseArgs(['--data-dir=/x', '--rollback=/y.json'])).toMatchObject({ dataDir: '/x', rollback: '/y.json' });
    expect(parseArgs(['--merge=dup1:canon2'])).toMatchObject({ merge: 'dup1:canon2' });
  });
});

describe('subject-sweep — slice 2 (person subset merge, CONFIRM class)', () => {
  const dirs: string[] = [];
  const engines: EngineDb[] = [];
  afterEach(() => {
    for (const e of engines) { try { e.close(); } catch { /* */ } }
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    engines.length = 0; dirs.length = 0;
  });
  function make(): { dir: string; engine: EngineDb; subs: SubjectStore } {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-sweep2-')); dirs.push(dir);
    const engine = new EngineDb(join(dir, 'engine.db'), ''); engines.push(engine);
    return { dir, engine, subs: new SubjectStore(engine) };
  }

  it('planPersonSubsetPairs reports the unambiguous subset, per-owner, skipping ambiguous', () => {
    const { engine, subs } = make();
    subs.createSubject({ kind: 'person', name: 'Dr. Ada Lovelace' });
    const ada = subs.createSubject({ kind: 'person', name: 'Ada' });
    // ambiguous: "Alan" under two → NOT reported.
    subs.createSubject({ kind: 'person', name: 'Alan Turing' });
    subs.createSubject({ kind: 'person', name: 'Alan Kay' });
    subs.createSubject({ kind: 'person', name: 'Alan' });
    // different owner → never paired across owners.
    subs.createSubject({ kind: 'person', name: 'Grace Hopper', ownerUserId: 'tenant-2' });
    subs.createSubject({ kind: 'person', name: 'Grace', ownerUserId: 'tenant-1' });

    const pairs = planPersonSubsetPairs(engine);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ dupId: ada, dupName: 'Ada', canonicalName: 'Dr. Ada Lovelace' });
  });

  it('doMerge executes + persists a merge ledger; --rollback reverses it (both stores)', () => {
    const { dir, engine, subs } = make();
    const dup = subs.createSubject({ kind: 'person', name: 'Ada' });
    const canon = subs.createSubject({ kind: 'person', name: 'Dr. Ada Lovelace' });
    engine.getDb().prepare('INSERT INTO memories (id, text, namespace, subject_id, scope_type, scope_id) VALUES (?,?,?,?,?,?)').run('m1', 'x', 'knowledge', dup, 'global', 'g');

    const r = doMerge(engine, dir, dup, canon);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(subs.getSubject(dup)!.merged_into).toBe(canon);
    expect(engine.getDb().prepare('SELECT subject_id FROM memories WHERE id=?').get('m1')).toMatchObject({ subject_id: canon });

    const file = JSON.parse(readFileSync(r.ledgerPath, 'utf8')) as MergeLedgerFile;
    expect(file.phase).toBe('merge');
    const rb = rollbackMergeFile(engine, dir, file);
    expect(rb.ok).toBe(true);
    expect(subs.getSubject(dup)!.merged_into).toBeNull();
    expect(subs.getSubject(dup)!.archived_at).toBeNull();
    expect(engine.getDb().prepare('SELECT subject_id FROM memories WHERE id=?').get('m1')).toMatchObject({ subject_id: dup });
  });

  it('doMerge refuses an invalid pair (cross-kind) without mutating', () => {
    const { dir, engine, subs } = make();
    const person = subs.createSubject({ kind: 'person', name: 'Ada' });
    const org = subs.createSubject({ kind: 'organization', name: 'Acme' });
    const r = doMerge(engine, dir, person, org);
    expect(r.ok).toBe(false);
    expect(subs.getSubject(person)!.merged_into).toBeNull();   // untouched
  });

  it('doMerge repoints datastore.db subject cells + --rollback reverses BOTH stores', () => {
    const { dir, engine, subs } = make();
    const dup = subs.createSubject({ kind: 'person', name: 'Ada' });
    const canon = subs.createSubject({ kind: 'person', name: 'Dr. Ada Lovelace' });
    // A datastore.db carrying a subject cell = dup (the Record-on-spine follow-through target).
    const ds = new DataStore(join(dir, 'datastore.db'));
    ds.createCollection({ name: 'invoices', scope: { type: 'global', id: 'g' }, columns: [{ name: 'client', type: 'subject', subjectKind: 'person' }] });
    ds.insertRecords({ collection: 'invoices', records: [{ client: dup }] });
    ds.close();

    const r = doMerge(engine, dir, dup, canon);
    expect(r.ok && r.dataStoreRows).toBe(1);
    const ds2 = new DataStore(join(dir, 'datastore.db'));
    expect(ds2.queryRecords({ collection: 'invoices' }).rows[0]!['client']).toBe(canon);
    ds2.close();

    if (!r.ok) return;
    const file = JSON.parse(readFileSync(r.ledgerPath, 'utf8')) as MergeLedgerFile;
    expect(file.dataStore).toHaveLength(1);
    rollbackMergeFile(engine, dir, file);
    const ds3 = new DataStore(join(dir, 'datastore.db'));
    expect(ds3.queryRecords({ collection: 'invoices' }).rows[0]!['client']).toBe(dup);   // reversed
    ds3.close();
  });
});
