import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngineDb } from '../core/engine-db.js';
import { setDataDir } from '../core/config.js';
import { SubjectStore } from '../core/subject-store.js';
import { DataStore } from '../core/data-store.js';
import { MemoryGraphStore } from '../core/memory-graph-store.js';
import { planArchive, applyArchive, rollback, parseArgs, planPersonSubsetPairs, doMerge, rollbackMergeFile, main, planOrphans, SWEEP_REFERENCE_PARTITION, readThreadAnchorIds } from './subject-sweep.js';
import Database from 'better-sqlite3';
import { subjectReferenceCoverage, makeSubjectExternalRefs } from '../core/subject-store.js';
import type { SubjectExternalRefs } from '../core/subject-store.js';
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

  it('planPersonSubsetPairs excludes a generational-suffix pair (father not reported under son)', () => {
    const { engine, subs } = make();
    subs.createSubject({ kind: 'person', name: 'John Smith Jr' });
    subs.createSubject({ kind: 'person', name: 'John Smith' });
    // "John Smith" ⊂ {john, smith, jr} by raw tokens, but Jr is identity-bearing → NOT a pair.
    expect(planPersonSubsetPairs(engine)).toHaveLength(0);
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


describe('subject-sweep — a refused rollback must reach a SCRIPT, not just a reader', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
    process.exitCode = undefined;
    delete process.env['LYNOX_DATA_DIR'];
  });

  it('exits non-zero when the merge ledger cannot be reversed here', () => {
    // A ledger from an instance this data dir has never seen. Before the exit-code fix
    // this printed `FAILED: …` on stdout and exited 0, so `--rollback=… && echo OK`
    // printed OK for a reversal that never happened — the same class of silent success
    // the guard in rollbackMerge exists to end.
    const dir = mkdtempSync(join(tmpdir(), 'lynox-sweep-exit-'));
    dirs.push(dir);
    new EngineDb(join(dir, 'engine.db'), '').close();

    const foreign = {
      version: 1, phase: 'merge' as const, createdAt: new Date().toISOString(),
      entry: {
        dupId: 'aaaaaaaa-0000-4000-8000-000000000001',
        canonicalId: 'aaaaaaaa-0000-4000-8000-000000000002',
        kind: 'organization', ownerUserId: 'default',
        dupArchivedAtWas: null, dupMergedIntoWas: null,
        canonicalAliasesWas: '[]', canonicalParentWasDup: false,
        repoints: [], memorySubjects: { dupRows: [], canonicalMemoryIdsBefore: [] },
        cooccurrences: [], detail: null,
      },
      dataStore: [], threadAnchors: [], applied: true,
    };
    const ledgerPath = join(dir, 'foreign-merge.json');
    writeFileSync(ledgerPath, JSON.stringify(foreign), 'utf-8');

    const argv = process.argv;
    process.argv = ['node', 'subject-sweep', `--rollback=${ledgerPath}`, `--data-dir=${dir}`];
    try { main(); } finally { process.argv = argv; setDataDir(null); }

    expect(process.exitCode, 'a refused rollback exited 0 — a script cannot see it').toBe(1);
  });
});

/**
 * DEF-subject-sweep-oracle-duplicate — the sweep's guardrail list and the reference oracle
 * must stay COMPLETE against each other without being collapsed into each other. The two
 * answer different questions (see `SWEEP_REFERENCE_PARTITION`), so the guard is a partition,
 * not a delegation.
 */
describe('subject-sweep — reference-oracle coverage', () => {
  const dirs: string[] = [];
  const engines: EngineDb[] = [];
  afterEach(() => {
    for (const e of engines) { try { e.close(); } catch { /* */ } }
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    engines.length = 0; dirs.length = 0;
  });
  function make(): { engine: EngineDb; subs: SubjectStore; mg: MemoryGraphStore } {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-sweep-cov-')); dirs.push(dir);
    const engine = new EngineDb(join(dir, 'engine.db'), ''); engines.push(engine);
    return { engine, subs: new SubjectStore(engine), mg: new MemoryGraphStore(engine) };
  }

  it('every column the reference oracle counts is classified by the sweep partition', () => {
    const counted = subjectReferenceCoverage().counted;
    const classified = new Set([
      ...Object.keys(SWEEP_REFERENCE_PARTITION.probed),
      ...Object.keys(SWEEP_REFERENCE_PARTITION.memoryAxis),
      ...Object.keys(SWEEP_REFERENCE_PARTITION.viaLiveStore),
    ]);
    // A new table with a subject_id lands in REPOINT_TARGETS (→ `counted`) and must be
    // classified here before it can be silently invisible to the archive phase.
    expect(counted.filter(c => !classified.has(c)).sort()).toEqual([]);
    // …and the partition must not name columns the oracle does not count (a stale entry
    // would make the check above pass for a column nobody probes any more).
    expect([...classified].filter(c => !counted.includes(c)).sort()).toEqual([]);
  });

  it.each([
    ['a durable-knowledge entry', (db: ReturnType<EngineDb['getDb']>, id: string): void => {
      db.prepare("INSERT INTO knowledge_entries (id, subject_id, text) VALUES ('k1', ?, 'x')").run(id);
    }, 'referenced-by-knowledge_entries'],
    ['a real relationship edge', (db: ReturnType<EngineDb['getDb']>, id: string): void => {
      const other = 'other-subject';
      db.prepare("INSERT INTO subjects (id, kind, name) VALUES (?, 'organization', 'Meridian AG')").run(other);
      db.prepare("INSERT INTO relationships (id, from_subject_id, to_subject_id, kind) VALUES ('r1', ?, ?, 'works_for')").run(id, other);
    }, 'referenced-by-relationships'],
    ['a merge redirect pointing at it', (db: ReturnType<EngineDb['getDb']>, id: string): void => {
      db.prepare("INSERT INTO subjects (id, kind, name, merged_into, archived_at) VALUES ('shell', 'person', 'Shell', ?, datetime('now'))").run(id);
    }, 'merge-target'],
  ])('a junk-NAMED subject that %s is blocked, not archived', (_what, hold, reason) => {
    const { engine, subs } = make();
    const junk = subs.createSubject({ kind: 'person', name: 'data' });   // isCleanupTarget
    hold(engine.getDb(), junk);
    const plan = planArchive(engine, new Set());
    expect(plan.archive.map(a => a.id)).not.toContain(junk);
    expect(plan.blocked.find(b => b.id === junk)?.reason).toBe(reason);
  });

  it('a self-loop relationship is NOT a holder — it is merge residue, not a live edge', () => {
    const { engine, subs } = make();
    const junk = subs.createSubject({ kind: 'person', name: 'data' });
    engine.getDb().prepare("INSERT INTO relationships (id, from_subject_id, to_subject_id, kind) VALUES ('r1', ?, ?, 'partner_of')").run(junk, junk);
    expect(planArchive(engine, new Set()).archive.map(a => a.id)).toContain(junk);
  });

  /**
   * The REGRESSION this whole partition exists for. The register prescribed delegating
   * `blockReason` to `SubjectStore.referenceReason` wholesale ("archivable = unreferenced AND
   * isCleanupTarget"). Junk subjects are minted BY memories, so the memory axis holds nearly
   * every candidate — under that delegation the archive phase would block itself and quietly
   * do nothing. This pins the opposite: the memory axis must NOT block.
   */
  it('the memory axis does NOT block the archive — a junk subject held only by memories is archived', () => {
    const { engine, subs, mg } = make();
    const junk = subs.createSubject({ kind: 'person', name: 'data' });
    mg.upsertStub({ id: 'm1', text: 'a fact', namespace: 'knowledge', scopeType: 'context', scopeId: 'c1', subjectId: junk });
    mg.linkSubjects('m1', [junk]);
    const store = new SubjectStore(engine);
    // The reference oracle DOES call it held — that is correct for its own question…
    expect(store.referenceReason(junk, { isThreadAnchor: () => false, hasRecords: () => false })).toBe('referenced-by-memory_subjects');
    // …and the archive phase archives it anyway, because that is the phase's entire purpose.
    expect(planArchive(engine, new Set()).archive.map(a => a.id)).toContain(junk);
  });
});

/**
 * DEF-orphan-subjects-prod-backlog — the standing backlog no at-erase reap can reach.
 * The phase reports over `SubjectStore.referenceReason` BY IMPORT; these tests pin that it
 * really is that oracle's answer (not a re-derived one) and that the cross-DB seam is honoured.
 */
describe('subject-sweep — orphan phase (report)', () => {
  const dirs: string[] = [];
  const engines: EngineDb[] = [];
  afterEach(() => {
    for (const e of engines) { try { e.close(); } catch { /* */ } }
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    engines.length = 0; dirs.length = 0;
  });
  function make(): { engine: EngineDb; subs: SubjectStore; mg: MemoryGraphStore } {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-sweep-orph-')); dirs.push(dir);
    const engine = new EngineDb(join(dir, 'engine.db'), ''); engines.push(engine);
    return { engine, subs: new SubjectStore(engine), mg: new MemoryGraphStore(engine) };
  }
  const NONE: SubjectExternalRefs = { isThreadAnchor: () => false, hasRecords: () => false };

  it('lists a subject nothing holds and omits one a memory link holds', () => {
    const { engine, subs, mg } = make();
    const orphan = subs.createSubject({ kind: 'organization', name: 'Meridian AG' });
    const held = subs.createSubject({ kind: 'organization', name: 'Nordberg GmbH' });
    mg.upsertStub({ id: 'm1', text: 'a fact', namespace: 'knowledge', scopeType: 'context', scopeId: 'c1' });
    mg.linkSubjects('m1', [held]);
    const rows = planOrphans(engine, NONE);
    expect(rows.map(r => r.id)).toEqual([orphan]);
    expect(rows[0]).toMatchObject({ kind: 'organization', name: 'Meridian AG', archivedAt: null, mergedInto: null });
    expect(rows[0]!.createdAt).toBeTruthy();     // the "age" the operator decides on
  });

  it('an ARCHIVED subject is still an orphan — archiving does not remove the plaintext name', () => {
    const { engine, subs } = make();
    const arch = subs.createSubject({ kind: 'person', name: 'Petra Muster' });
    engine.getDb().prepare("UPDATE subjects SET archived_at = datetime('now') WHERE id = ?").run(arch);
    const rows = planOrphans(engine, NONE);
    expect(rows.map(r => r.id)).toEqual([arch]);
    expect(rows[0]!.archivedAt).not.toBeNull();
  });

  it.each([
    ['a history.db thread anchor', (id: string): SubjectExternalRefs => ({ isThreadAnchor: x => x === id, hasRecords: () => false })],
    ['a datastore.db record', (id: string): SubjectExternalRefs => ({ isThreadAnchor: () => false, hasRecords: x => x === id })],
  ])('%s keeps a subject OUT of the orphan report (the cross-DB seam is consulted)', (_what, mk) => {
    const { engine, subs } = make();
    const s = subs.createSubject({ kind: 'organization', name: 'Meridian AG' });
    expect(planOrphans(engine, NONE).map(r => r.id)).toEqual([s]);   // orphan without the anchor…
    expect(planOrphans(engine, mk(s))).toEqual([]);                   // …held with it
  });

  it('a merge shell is reported WITH its redirect rather than silently filtered', () => {
    const { engine, subs } = make();
    const canon = subs.createSubject({ kind: 'organization', name: 'Schmidt GmbH' });
    const shell = subs.createSubject({ kind: 'organization', name: 'Schmidt' });
    engine.getDb().prepare("UPDATE subjects SET merged_into = ?, archived_at = datetime('now') WHERE id = ?").run(canon, shell);
    const rows = planOrphans(engine, NONE);
    // The canonical is held by the shell's redirect ('merge-target'); the shell itself is unheld.
    expect(rows.map(r => r.id)).toEqual([shell]);
    expect(rows[0]!.mergedInto).toBe(canon);
  });
});

/**
 * The fail-closed rule of the shared factory: an unanswerable probe means "referenced",
 * and a MISSING store means the caller must not reap at all.
 */
describe('subject-sweep — the shared external-refs factory', () => {
  it('returns null when either live store is missing (the sweep must then refuse, not degrade)', () => {
    const threads = { listBySubjectId: () => [] };
    const records = { hasRecordsForSubject: () => false };
    expect(makeSubjectExternalRefs(null, records)).toBeNull();
    expect(makeSubjectExternalRefs(threads, null)).toBeNull();
    expect(makeSubjectExternalRefs(threads, records)).not.toBeNull();
  });

  it('a probe that THROWS answers "referenced" and reports once — never "unreferenced"', () => {
    const seen: string[] = [];
    const ext = makeSubjectExternalRefs(
      { listBySubjectId: () => { throw new Error('pre-v46 history.db'); } },
      { hasRecordsForSubject: () => { throw new Error('locked datastore'); } },
      (probe) => { seen.push(probe); },
    )!;
    expect(ext.isThreadAnchor('s1')).toBe(true);
    expect(ext.hasRecords('s1')).toBe(true);
    expect(seen).toEqual(['thread-anchor', 'record']);
  });
});

/**
 * The `viaLiveStore` class has a dependency the other two do not: it is answered from
 * history.db. A swallowed read error there reads as "nothing is anchored" and would let the
 * archive phase take a subject a live thread still holds — so it must fail CLOSED, matching
 * `makeSubjectExternalRefs` on the same axis.
 */
describe('subject-sweep — the thread-anchor probe fails closed', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs.length = 0; });
  function tmp(): string { const d = mkdtempSync(join(tmpdir(), 'lynox-anchor-')); dirs.push(d); return d; }

  it('an ABSENT history.db is an ANSWER (no threads, no anchors) — empty set, not null', () => {
    expect(readThreadAnchorIds(join(tmp(), 'history.db'))).toEqual(new Set());
  });

  it('a pre-v46 schema without the column is an ANSWER — the feature could not anchor anything', () => {
    const dir = tmp();
    const p = join(dir, 'history.db');
    const db = new Database(p);
    db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY)');   // no primary_subject_id
    db.close();
    expect(readThreadAnchorIds(p)).toEqual(new Set());
  });

  it('an UNREADABLE history.db is NOT an answer — null, so the caller refuses', () => {
    const dir = tmp();
    const p = join(dir, 'history.db');
    writeFileSync(p, 'this is not a sqlite database at all');
    expect(readThreadAnchorIds(p)).toBeNull();
  });

  it('a real anchor is still read back (the probe is not merely refusing everything)', () => {
    const dir = tmp();
    const p = join(dir, 'history.db');
    const db = new Database(p);
    db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, primary_subject_id TEXT)");
    db.prepare("INSERT INTO threads (id, primary_subject_id) VALUES ('t1', 's-anchor')").run();
    db.prepare("INSERT INTO threads (id, primary_subject_id) VALUES ('t2', NULL)").run();
    db.close();
    expect(readThreadAnchorIds(p)).toEqual(new Set(['s-anchor']));
  });

  it('every classified column carries a non-empty reason, exceptions included', () => {
    for (const cls of [SWEEP_REFERENCE_PARTITION.probed, SWEEP_REFERENCE_PARTITION.memoryAxis, SWEEP_REFERENCE_PARTITION.viaLiveStore]) {
      for (const [col, why] of Object.entries(cls)) {
        expect(why.trim().length, `${col} has no stated reason`).toBeGreaterThan(10);
      }
    }
  });
});

/**
 * The refusal must reach a SCRIPT, not just a human reading the terminal — the same lesson the
 * rollback path already carries. An operator running `subject-sweep && echo OK` must not see OK
 * when the sweep could not tell whether a thread still holds a subject.
 */
describe('subject-sweep — main() refuses when the anchor answer is missing', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
    process.exitCode = undefined;
    setDataDir(null);
  });

  it('exits non-zero on an unreadable history.db instead of archiving blind', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-sweep-anchor-main-')); dirs.push(dir);
    new EngineDb(join(dir, 'engine.db'), '').close();
    writeFileSync(join(dir, 'history.db'), 'not a sqlite file');   // exists, unreadable

    const argv = process.argv;
    process.argv = ['node', 'subject-sweep', `--data-dir=${dir}`];
    try { main(); } finally { process.argv = argv; }

    expect(process.exitCode, 'a blind archive run exited 0 — a script cannot see it').toBe(1);
  });

  it('a readable (empty) history.db lets the dry-run proceed — the guard is not refusing everything', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-sweep-anchor-ok-')); dirs.push(dir);
    new EngineDb(join(dir, 'engine.db'), '').close();
    const hdb = new Database(join(dir, 'history.db'));
    hdb.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, primary_subject_id TEXT)');
    hdb.close();

    const argv = process.argv;
    process.argv = ['node', 'subject-sweep', `--data-dir=${dir}`];
    try { main(); } finally { process.argv = argv; }

    expect(process.exitCode).toBeUndefined();
  });
});

/**
 * The orphan report's own fail-closed branch. An empty list and an unanswerable oracle look
 * identical on stdout, so the refusal has to be an exit code, not a sentence.
 */
describe('subject-sweep — --orphans refuses without both live stores', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0; process.exitCode = undefined; setDataDir(null);
  });
  function run(dir: string): void {
    const argv = process.argv;
    process.argv = ['node', 'subject-sweep', '--orphans', `--data-dir=${dir}`];
    try { main(); } finally { process.argv = argv; }
  }

  it('exits non-zero when datastore.db is absent instead of printing an empty list', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-orph-nods-')); dirs.push(dir);
    new EngineDb(join(dir, 'engine.db'), '').close();
    const hdb = new Database(join(dir, 'history.db'));
    hdb.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, primary_subject_id TEXT)');
    hdb.close();
    // no datastore.db → the record probe cannot answer → the report must not run
    run(dir);
    expect(process.exitCode, 'an unanswerable orphan report exited 0 — indistinguishable from "nothing is orphaned"').toBe(1);
  });

  it('with BOTH stores present the report runs (the branch is not refusing everything)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-orph-ok-')); dirs.push(dir);
    new EngineDb(join(dir, 'engine.db'), '').close();
    const hdb = new Database(join(dir, 'history.db'));
    hdb.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, primary_subject_id TEXT)');
    hdb.close();
    new DataStore(join(dir, 'datastore.db')).close();
    run(dir);
    expect(process.exitCode).toBeUndefined();
  });

  it('--orphans --apply refuses: the delete phase is not built', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-orph-apply-')); dirs.push(dir);
    new EngineDb(join(dir, 'engine.db'), '').close();
    const argv = process.argv;
    process.argv = ['node', 'subject-sweep', '--orphans', '--apply', `--data-dir=${dir}`];
    try { main(); } finally { process.argv = argv; }
    expect(process.exitCode, 'a not-yet-built apply must not exit 0').toBe(2);
  });
});
