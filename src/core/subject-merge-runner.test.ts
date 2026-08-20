import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readdirSync, readFileSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngineDb } from './engine-db.js';
import { SubjectStore } from './subject-store.js';
import { DataStore } from './data-store.js';
import { RunHistory } from './run-history.js';
import { ThreadStore } from './thread-store.js';
import { runMerge, rollbackMergeRun, pruneExpiredLedgers, LEDGER_RETENTION_DAYS, type MergeLedgerFile } from './subject-merge-runner.js';

/**
 * The subject spine spans THREE SQLite files: engine.db (SubjectStore), datastore.db
 * (DataStore cells) and history.db (ThreadStore anchors). A merge must repoint all three
 * — the LIVE thread anchor is in history.db (engine.db's `threads` is an empty mirror),
 * so a merge that only touches engine.db/datastore leaves a thread anchored to the
 * now-archived dup. These tests hold: the history.db anchor IS repointed + captured, the
 * ledger's applied-stamp guards rollback against a crashed merge, and rollback reverses it.
 */
describe('runMerge — three-store repoint + crash-safe ledger', () => {
  const dirs: string[] = [];
  const closers: Array<() => void> = [];

  function setup(): { dir: string; store: SubjectStore; threadStore: ThreadStore } {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-runmerge-'));
    dirs.push(dir);
    const engine = new EngineDb(join(dir, 'engine.db'), '');
    const history = new RunHistory(join(dir, 'history.db')); // migrates history.db → threads.primary_subject_id (v46)
    closers.push(() => { try { engine.close(); } catch { /* noop */ } try { history.close(); } catch { /* noop */ } });
    return { dir, store: new SubjectStore(engine), threadStore: new ThreadStore(history.getDb()) };
  }

  afterEach(() => {
    for (const c of closers) c();
    closers.length = 0;
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  const readLedger = (dir: string): MergeLedgerFile => {
    const f = readdirSync(join(dir, 'sweeps')).find(n => n.startsWith('merge-'))!;
    return JSON.parse(readFileSync(join(dir, 'sweeps', f), 'utf8')) as MergeLedgerFile;
  };

  const anchor = (threadStore: ThreadStore, threadId: string, subjectId: string): void => {
    threadStore.createThread(threadId);
    threadStore.updateThread(threadId, { primary_subject_id: subjectId });
  };

  it('repoints the history.db thread anchor dup→canonical, records it, stamps applied:true', () => {
    const { dir, store, threadStore } = setup();
    const dup = store.createSubject({ kind: 'organization', name: 'Acme GmbH' });
    const canon = store.createSubject({ kind: 'organization', name: 'Acme' });
    anchor(threadStore, 't1', dup);

    const r = runMerge(store, null, threadStore, dir, dup, canon);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.threadRows).toBe(1);
    // The LIVE anchor now points at the canonical, not the archived dup.
    expect(threadStore.getThread('t1')!.primary_subject_id).toBe(canon);
    const led = readLedger(dir);
    expect(led.threadAnchors).toEqual(['t1']);
    expect(led.applied).toBe(true);
  });

  it('rollback restores the thread anchor back to the dup', () => {
    const { dir, store, threadStore } = setup();
    const dup = store.createSubject({ kind: 'organization', name: 'Beta AG' });
    const canon = store.createSubject({ kind: 'organization', name: 'Beta' });
    anchor(threadStore, 't2', dup);
    expect(runMerge(store, null, threadStore, dir, dup, canon).ok).toBe(true);
    expect(threadStore.getThread('t2')!.primary_subject_id).toBe(canon);

    const back = rollbackMergeRun(store, null, threadStore, readLedger(dir));
    expect(back.ok).toBe(true);
    expect(threadStore.getThread('t2')!.primary_subject_id).toBe(dup);
  });

  // A rollback whose UPDATEs match nothing is indistinguishable from one that worked:
  // SQLite reports "0 rows changed" the same way it reports success, so the whole
  // reversal used to walk through, commit, and return {ok:true} on an instance that had
  // never seen these subjects. The operator CLI then printed `un-merged <id> ← <id>` and
  // the user was told an undo had happened that had not.
  //
  // Reachable two ways, and the second needs no second machine at all: a migrated ledger,
  // and — because `restoreBackup` is ADDITIVE — a ledger written after a backup, which
  // survives the restore of the older engine.db and outlives the ids it names.
  it('rollback REFUSES a ledger whose subjects are not on this instance', () => {
    const source = setup();
    const dup = source.store.createSubject({ kind: 'organization', name: 'Kessler AG' });
    const canon = source.store.createSubject({ kind: 'organization', name: 'Kessler' });
    expect(runMerge(source.store, null, source.threadStore, source.dir, dup, canon).ok).toBe(true);
    const ledger = readLedger(source.dir);

    // A different instance: same code, none of these rows.
    const elsewhere = setup();
    expect(elsewhere.store.getSubject(dup)).toBeFalsy();

    const res = rollbackMergeRun(elsewhere.store, null, elsewhere.threadStore, ledger);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/cannot reverse this merge here/i);
    expect(res.reason).toMatch(/merged-away entry/i);
    // And it must not have half-reversed anything on the way to finding out.
    expect(elsewhere.store.getSubject(dup)).toBeFalsy();
    expect(elsewhere.store.getSubject(canon)).toBeFalsy();
  });

  // The case a presence check waves through, and it CORRUPTS rather than no-ops: merge
  // A→B, reverse it, merge A→C, then replay the FIRST ledger. Both rows exist, so
  // "do these rows exist" passes — and the reversal un-archives A while C still holds A's
  // aliases. Reported as a successful undo. Found by an adversarial round on this very PR,
  // which is why the predicate is `merged_into === canonicalId` and not row presence.
  it('rollback REFUSES a stale ledger after the entry was merged somewhere else', () => {
    const { dir, store, threadStore } = setup();
    const a = store.createSubject({ kind: 'organization', name: 'Aurelva AG' });
    const b = store.createSubject({ kind: 'organization', name: 'Aurelva' });
    const c = store.createSubject({ kind: 'organization', name: 'Aurelva Group' });

    expect(runMerge(store, null, threadStore, dir, a, b).ok).toBe(true);
    const staleLedger = readLedger(dir);
    expect(rollbackMergeRun(store, null, threadStore, staleLedger).ok).toBe(true);

    // A is live again and now folded into a DIFFERENT canonical.
    expect(runMerge(store, null, threadStore, dir, a, c).ok).toBe(true);
    expect(store.getSubject(a)?.merged_into).toBe(c);

    const res = rollbackMergeRun(store, null, threadStore, staleLedger);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/not in effect/i);
    // And the graph is untouched — the corruption this refusal prevents.
    expect(store.getSubject(a)?.merged_into).toBe(c);
    expect(store.getSubject(a)?.archived_at).toBeTruthy();
  });

  it('rollback REFUSES the same ledger twice — the second is not a second undo', () => {
    const { dir, store, threadStore } = setup();
    const dup = store.createSubject({ kind: 'organization', name: 'Brunner AG' });
    const canon = store.createSubject({ kind: 'organization', name: 'Brunner' });
    expect(runMerge(store, null, threadStore, dir, dup, canon).ok).toBe(true);
    const ledger = readLedger(dir);

    expect(rollbackMergeRun(store, null, threadStore, ledger).ok).toBe(true);
    const second = rollbackMergeRun(store, null, threadStore, ledger);
    expect(second.ok).toBe(false);
    expect(second.reason).toMatch(/already been reversed/i);
  });

  it('rollback REFUSES a ledger naming the same entry on both sides', () => {
    const { dir, store, threadStore } = setup();
    const dup = store.createSubject({ kind: 'organization', name: 'Cordis AG' });
    const canon = store.createSubject({ kind: 'organization', name: 'Cordis' });
    expect(runMerge(store, null, threadStore, dir, dup, canon).ok).toBe(true);
    const led = readLedger(dir);
    // An operator-supplied ledger file is arbitrary JSON; `planMerge`'s self-merge refusal
    // never runs on this path.
    const selfLedger = { ...led, entry: { ...led.entry, canonicalId: led.entry.dupId } };

    const res = rollbackMergeRun(store, null, threadStore, selfLedger);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/same entry on both sides/i);
  });

  it('rollback REFUSES when only the canonical is missing, and says which side', () => {
    const source = setup();
    const dup = source.store.createSubject({ kind: 'organization', name: 'Hallberg AG' });
    const canon = source.store.createSubject({ kind: 'organization', name: 'Hallberg' });
    expect(runMerge(source.store, null, source.threadStore, source.dir, dup, canon).ok).toBe(true);
    const ledger = readLedger(source.dir);

    // Only the dup survives — a partial-overlap instance, which a naive "does the dup
    // exist?" check would wave through into a reversal that cannot restore the aliases.
    const partial = setup();
    partial.store.createSubject({ id: dup, kind: 'organization', name: 'Hallberg AG' });

    const res = rollbackMergeRun(partial.store, null, partial.threadStore, ledger);
    expect(res.ok).toBe(false);
    // Names the side that is actually missing. Without the second clause this assert
    // would also pass when BOTH are gone — i.e. when the fixture failed to plant the dup
    // and the test was silently exercising the case above instead of this one.
    expect(res.reason).toMatch(/the entry it was merged into is not/i);
    expect(res.reason).not.toMatch(/merged-away entry/i);
  });

  it('rollback REFUSES a ledger that never finished applying (crash mid-run)', () => {
    const { dir, store, threadStore } = setup();
    const dup = store.createSubject({ kind: 'organization', name: 'Gamma GmbH' });
    const canon = store.createSubject({ kind: 'organization', name: 'Gamma' });
    expect(runMerge(store, null, threadStore, dir, dup, canon).ok).toBe(true);
    // A crash between the before-image write and the applied-stamp leaves applied:false.
    const unapplied: MergeLedgerFile = { ...readLedger(dir), applied: false };
    const res = rollbackMergeRun(store, null, threadStore, unapplied);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/not marked applied/i);
  });

  it('a pre-fix ledger (no applied / no threadAnchors fields) still reverses the engine side', () => {
    const { dir, store, threadStore } = setup();
    const dup = store.createSubject({ kind: 'person', name: 'Dana Scully' });
    const canon = store.createSubject({ kind: 'person', name: 'Dana' });
    expect(runMerge(store, null, threadStore, dir, dup, canon).ok).toBe(true);
    const led = readLedger(dir);
    // Mimic a ledger written by the pre-fix runner (no applied / threadAnchors keys).
    const legacy = { version: led.version, phase: led.phase, createdAt: led.createdAt, entry: led.entry, dataStore: led.dataStore } as MergeLedgerFile;
    const back = rollbackMergeRun(store, null, threadStore, legacy);
    expect(back.ok).toBe(true);
    expect(store.getSubject(dup)?.merged_into ?? null).toBeNull(); // dup un-merged
  });

  it('repoints datastore.db subject cells too, records the count, and rollback restores them', () => {
    const { dir, store, threadStore } = setup();
    const dup = store.createSubject({ kind: 'organization', name: 'Delta Co' });
    const canon = store.createSubject({ kind: 'organization', name: 'Delta' });
    const ds = new DataStore(join(dir, 'datastore.db'));
    try {
      ds.createCollection({ name: 'invoices', scope: { type: 'global', id: 'g' }, columns: [
        { name: 'client', type: 'subject', subjectKind: 'organization' },
        { name: 'amount', type: 'number' },
      ] });
      ds.insertRecords({ collection: 'invoices', records: [{ client: dup, amount: 100 }] });

      const r = runMerge(store, ds, threadStore, dir, dup, canon);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.dataStoreRows).toBe(1);
      expect(ds.queryRecords({ collection: 'invoices' }).rows[0]!['client']).toBe(canon);

      expect(rollbackMergeRun(store, ds, threadStore, readLedger(dir)).ok).toBe(true);
      expect(ds.queryRecords({ collection: 'invoices' }).rows[0]!['client']).toBe(dup);
    } finally {
      ds.close();
    }
  });

  it('rollback aborts engine-first: an engine failure leaves the datastore + thread untouched', () => {
    const { dir, store, threadStore } = setup();
    const dup = store.createSubject({ kind: 'organization', name: 'Zeta AG' });
    const canon = store.createSubject({ kind: 'organization', name: 'Zeta' });
    anchor(threadStore, 't-z', dup);
    const ds = new DataStore(join(dir, 'datastore.db'));
    try {
      ds.createCollection({ name: 'c', scope: { type: 'global', id: 'g' }, columns: [{ name: 'org', type: 'subject', subjectKind: 'organization' }] });
      ds.insertRecords({ collection: 'c', records: [{ org: dup }] });
      expect(runMerge(store, ds, threadStore, dir, dup, canon).ok).toBe(true);
      expect(ds.queryRecords({ collection: 'c' }).rows[0]!['org']).toBe(canon);          // satellites on canonical
      expect(threadStore.getThread('t-z')!.primary_subject_id).toBe(canon);

      // Force the ENGINE reversal to fail (in prod: a memory_subjects UNIQUE collision).
      const spy = vi.spyOn(store, 'rollbackMerge').mockReturnValue({ ok: false, reason: 'collision' });
      const res = rollbackMergeRun(store, ds, threadStore, readLedger(dir));
      expect(res.ok).toBe(false);
      // Engine-first abort → the satellites were NOT half-reversed; both stay on canonical.
      expect(ds.queryRecords({ collection: 'c' }).rows[0]!['org']).toBe(canon);
      expect(threadStore.getThread('t-z')!.primary_subject_id).toBe(canon);
      spy.mockRestore();
    } finally {
      ds.close();
    }
  });
});

/**
 * Retention on the ledger directory.
 *
 * Before this, nothing in the tree ever deleted a merge ledger, so `sweeps/` grew for the
 * lifetime of an instance — and since core#1243 declares it `{ backup: true, migrate: true }`,
 * every entry also travels into every backup and every tenant migration. Each ledger embeds
 * the full detail row of both subjects: email and phone for people, domain and vat_id for
 * organizations. These pin the two ways a retention sweep goes wrong — it spares nothing, or
 * it deletes something it did not write.
 */
describe('pruneExpiredLedgers — bounded retention on personal data', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs.length = 0; });

  const sweeps = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'sweeps-'));
    dirs.push(d);
    return d;
  };
  const age = (dir: string, name: string, daysOld: number): string => {
    const p = join(dir, name);
    writeFileSync(p, '{}');
    const t = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000);
    utimesSync(p, t, t);
    return p;
  };
  const now = (): string => new Date().toISOString();

  it('deletes a ledger past the window and keeps one inside it', () => {
    const d = sweeps();
    age(d, 'merge-old.json', LEDGER_RETENTION_DAYS + 5);
    age(d, 'merge-recent.json', LEDGER_RETENTION_DAYS - 5);
    pruneExpiredLedgers(d, now());
    expect(readdirSync(d).sort()).toEqual(['merge-recent.json']);
  });

  it('spares a ledger exactly ON the boundary — the window is inclusive', () => {
    // A merge one minute short of the cutoff must not vanish; off-by-one here silently
    // shortens everyone's undo window.
    const d = sweeps();
    age(d, 'merge-edge.json', LEDGER_RETENTION_DAYS - 0.001);
    pruneExpiredLedgers(d, now());
    expect(readdirSync(d)).toEqual(['merge-edge.json']);
  });

  it('touches ONLY merge-*.json — it must not delete what it did not write', () => {
    // `sweeps/` is not exclusively ours: the sweep CLI and future tooling write here too.
    // A retention pass that widened its filter would be a silent data-loss bug.
    const d = sweeps();
    age(d, 'merge-old.json', LEDGER_RETENTION_DAYS + 5);
    age(d, 'archive-old.json', LEDGER_RETENTION_DAYS + 5);
    age(d, 'merge-old.json.bak', LEDGER_RETENTION_DAYS + 5);
    age(d, 'notes.txt', LEDGER_RETENTION_DAYS + 5);
    pruneExpiredLedgers(d, now());
    expect(readdirSync(d).sort()).toEqual(['archive-old.json', 'merge-old.json.bak', 'notes.txt']);
  });

  it('uses mtime, not the filename timestamp — a rollback rewrites the file', () => {
    // The name carries the CREATION time. A ledger created 100 days ago and rolled back
    // yesterday is actively in use; deleting it by its name would destroy live state.
    const d = sweeps();
    const p = join(d, `merge-${new Date(Date.now() - 100 * 864e5).toISOString().replace(/[:.]/g, '-')}-abc123.json`);
    writeFileSync(p, '{}');
    pruneExpiredLedgers(d, now());
    expect(readdirSync(d)).toHaveLength(1);
  });

  it('survives a missing directory instead of failing the merge', () => {
    // Retention runs inside runMerge. A cleanup that throws would fail a merge that
    // already succeeded — the cure being worse than the disease.
    expect(() => pruneExpiredLedgers(join(tmpdir(), 'does-not-exist-' + String(Date.now())), now())).not.toThrow();
  });

  it('a REAL runMerge prunes — retention is wired, not merely exported', () => {
    // The failure this catches, and the reason it drives a real merge instead of calling
    // pruneExpiredLedgers directly: a correct retention function that nothing ever invokes.
    // Registering is not wiring. Delete the call in runMerge and only this test goes red.
    const dir = mkdtempSync(join(tmpdir(), 'lynox-prune-'));
    dirs.push(dir);
    const engine = new EngineDb(join(dir, 'engine.db'), '');
    const history = new RunHistory(join(dir, 'history.db'));
    try {
      const store = new SubjectStore(engine);
      const threadStore = new ThreadStore(history.getDb());
      mkdirSync(join(dir, 'sweeps'), { recursive: true });
      age(join(dir, 'sweeps'), 'merge-ancient.json', LEDGER_RETENTION_DAYS + 30);

      const dup = store.createSubject({ kind: 'organization', name: 'Gamma GmbH' });
      const canon = store.createSubject({ kind: 'organization', name: 'Gamma' });
      expect(runMerge(store, null, threadStore, dir, dup, canon).ok).toBe(true);

      const left = readdirSync(join(dir, 'sweeps'));
      expect(left).not.toContain('merge-ancient.json');   // the old one is gone…
      expect(left).toHaveLength(1);                       // …and this merge's ledger is not
    } finally {
      try { engine.close(); } catch { /* noop */ }
      try { history.close(); } catch { /* noop */ }
    }
  });
});
