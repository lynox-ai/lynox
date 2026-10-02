import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngineDb } from './engine-db.js';
import { SubjectStore } from './subject-store.js';
import { DataStore } from './data-store.js';
import { RunHistory } from './run-history.js';
import { ThreadStore } from './thread-store.js';
import { runMerge, rollbackMergeRun, pruneExpiredLedgers, listMergeRuns, rollbackMergeById, readMergeLedger, LEDGER_RETENTION_DAYS, type MergeLedgerFile } from './subject-merge-runner.js';

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
    const a = store.createSubject({ kind: 'organization', name: 'Northwind AG' });
    const b = store.createSubject({ kind: 'organization', name: 'Northwind' });
    const c = store.createSubject({ kind: 'organization', name: 'Northwind Group' });

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

  // The ledger's data-store records name a collection and a column, and the rollback builds
  // its statements from those names. One that is not a subject column is refused before the
  // ENGINE side moves — the data store's own refusal would come only after it.
  it('rollback REFUSES a ledger naming a non-subject data-store column, and changes nothing', () => {
    const { dir, store, threadStore } = setup();
    const dup = store.createSubject({ kind: 'organization', name: 'Iota GmbH' });
    const canon = store.createSubject({ kind: 'organization', name: 'Iota' });
    const ds = new DataStore(join(dir, 'datastore.db'));
    try {
      ds.createCollection({ name: 'invoices', scope: { type: 'global', id: 'g' }, columns: [
        { name: 'client', type: 'subject', subjectKind: 'organization' },
        { name: 'note', type: 'string' },
      ] });
      // `note` holds the canonical's id as plain text: a reversal that wrote it would change it.
      ds.insertRecords({ collection: 'invoices', records: [{ client: dup, note: canon }] });
      expect(runMerge(store, ds, threadStore, dir, dup, canon).ok).toBe(true);
      const led = readLedger(dir);
      const forged: MergeLedgerFile = { ...led, dataStore: [...led.dataStore, { collection: 'invoices', column: 'note', ids: [1] }] };

      const res = rollbackMergeRun(store, ds, threadStore, forged);
      expect(res.ok).toBe(false);
      expect(res.reason).toMatch(/not a subject column/i);
      // The partial-rollback fallback also carries the data store's refusal text, so it is this
      // line and the engine assert below that tell the runner's own pre-check apart from it.
      expect(res.reason).not.toMatch(/partial/i);
      expect(store.getSubject(dup)?.merged_into).toBe(canon);                       // engine still merged
      const row = ds.queryRecords({ collection: 'invoices' }).rows[0]!;
      expect(row['client']).toBe(canon);
      expect(row['note']).toBe(canon);
    } finally {
      ds.close();
    }
  });

  it('rollback skips a data-store record whose collection was dropped since, and reverses the rest', () => {
    const { dir, store, threadStore } = setup();
    const dup = store.createSubject({ kind: 'organization', name: 'Kappa GmbH' });
    const canon = store.createSubject({ kind: 'organization', name: 'Kappa' });
    const ds = new DataStore(join(dir, 'datastore.db'));
    try {
      const subjectCol = [{ name: 'client', type: 'subject' as const, subjectKind: 'organization' }];
      ds.createCollection({ name: 'invoices', scope: { type: 'global', id: 'g' }, columns: subjectCol });
      ds.createCollection({ name: 'quotes', scope: { type: 'global', id: 'g' }, columns: subjectCol });
      ds.insertRecords({ collection: 'invoices', records: [{ client: dup }] });
      ds.insertRecords({ collection: 'quotes', records: [{ client: dup }] });
      expect(runMerge(store, ds, threadStore, dir, dup, canon).ok).toBe(true);
      expect(readLedger(dir).dataStore.map(r => r.collection).sort()).toEqual(['invoices', 'quotes']);
      ds.dropCollection('quotes');

      expect(rollbackMergeRun(store, ds, threadStore, readLedger(dir))).toEqual({ ok: true });
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
  /**
   * A ledger with a CANONICAL name, aged by its own createdAt.
   *
   * The name matters as much as the content: `pruneExpiredLedgers` filters with
   * `isMergeLedgerFileName`, the writer's own definition, so a fixture called `merge-old.json`
   * is not a ledger at all and would be spared for the wrong reason — a fixture that cannot
   * be deleted turns every deletion test green by accident.
   */
  let seq = 0;
  const ledgerNamed = (daysOld: number): { name: string; createdAt: string } => {
    const createdAt = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000).toISOString();
    seq += 1;
    return { name: `merge-${createdAt.replace(/[:.]/g, '-')}-fix${String(seq).padStart(3, '0')}.json`, createdAt };
  };
  /** Writes a real ledger; returns its file name. */
  const ledgerAged = (dir: string, daysOld: number): string => {
    const { name, createdAt } = ledgerNamed(daysOld);
    writeFileSync(join(dir, name), JSON.stringify({ version: 1, phase: 'merge', createdAt }));
    return name;
  };
  /** Writes a file with an arbitrary name — for the near-miss cases. */
  const ledger = (dir: string, name: string, daysOld: number, extra: object = {}): string => {
    const p = join(dir, name);
    const createdAt = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000).toISOString();
    writeFileSync(p, JSON.stringify({ version: 1, phase: 'merge', createdAt, ...extra }));
    return p;
  };
  const now = (): string => new Date().toISOString();

  it('deletes a ledger past the window and keeps one inside it', () => {
    const d = sweeps();
    const old = ledgerAged(d, LEDGER_RETENTION_DAYS + 5);
    const recent = ledgerAged(d, LEDGER_RETENTION_DAYS - 5);
    pruneExpiredLedgers(d, now());
    expect(readdirSync(d)).toEqual([recent]);
    expect(readdirSync(d)).not.toContain(old);
  });

  it('⭐ ages by createdAt, NOT mtime — a restore must not reset the retention clock', () => {
    // The defect this exists for: copies do not preserve mtime, so `copyFileSync` in a backup
    // restore and `writeFileSync` in a migration import both give every ledger a fresh full
    // window. Aging by mtime meant the two operations that SPREAD this personal data also
    // renewed its only bound. Here the file is written now (fresh mtime) but declares an
    // ancient createdAt — exactly a restored ledger — and must still be collected.
    const d = sweeps();
    const restored = ledgerAged(d, LEDGER_RETENTION_DAYS + 30);
    const newer = ledgerAged(d, 1);   // so the floor below does not spare the restored one
    pruneExpiredLedgers(d, now());
    expect(readdirSync(d)).toEqual([newer]);
    expect(readdirSync(d)).not.toContain(restored);
  });

  it('⭐ never deletes the newest ledger, whatever the clock says', () => {
    // One forward clock jump would otherwise unlink every reversal record in a single pass,
    // irreversibly. `pruneBackups` carries the same rail for the same reason.
    const d = sweeps();
    ledgerAged(d, LEDGER_RETENTION_DAYS + 100);
    const newer = ledgerAged(d, LEDGER_RETENTION_DAYS + 50);
    pruneExpiredLedgers(d, now());
    // Both are far past the window; the newer of the two survives regardless.
    expect(readdirSync(d)).toEqual([newer]);
  });

  it('spares a ledger sitting EXACTLY on the cutoff — the window is inclusive', () => {
    // Two earlier versions of this test could not tell `>=` from `>`: one sat 86 seconds off
    // the boundary, the next one second. Both let the off-by-one survive, while the test name
    // claimed to pin inclusivity. Real-clock fixtures cannot hit the boundary — milliseconds
    // pass between writing and pruning — so the CLOCK is passed in instead: `nowIso` is
    // constructed so that cutoff lands byte-exactly on this ledger's createdAt.
    const d = sweeps();
    const createdAt = '2026-01-01T00:00:00.000Z';
    const edge = `merge-${createdAt.replace(/[:.]/g, '-')}-edge01.json`;
    writeFileSync(join(d, edge), JSON.stringify({ version: 1, createdAt }));
    // …plus a newer one, or the never-delete-the-newest floor would spare it for free and
    // this test would pass for the wrong reason.
    const newestAt = '2026-02-01T00:00:00.000Z';
    const newest = `merge-${newestAt.replace(/[:.]/g, '-')}-new001.json`;
    writeFileSync(join(d, newest), JSON.stringify({ version: 1, createdAt: newestAt }));

    const exactlyAtCutoff = new Date(
      Date.parse(createdAt) + LEDGER_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    pruneExpiredLedgers(d, exactlyAtCutoff);

    expect(readdirSync(d).sort()).toEqual([edge, newest].sort());
  });

  it('deletes a ledger one millisecond past the cutoff — the boundary is real, not decorative', () => {
    // The other half: without this, "inclusive" could be satisfied by never deleting anything.
    const d = sweeps();
    const createdAt = '2026-01-01T00:00:00.000Z';
    const edge = `merge-${createdAt.replace(/[:.]/g, '-')}-edge02.json`;
    writeFileSync(join(d, edge), JSON.stringify({ version: 1, createdAt }));
    const newestAt = '2026-02-01T00:00:00.000Z';
    const newest = `merge-${newestAt.replace(/[:.]/g, '-')}-new002.json`;
    writeFileSync(join(d, newest), JSON.stringify({ version: 1, createdAt: newestAt }));

    const oneMsPast = new Date(
      Date.parse(createdAt) + LEDGER_RETENTION_DAYS * 24 * 60 * 60 * 1000 + 1).toISOString();
    pruneExpiredLedgers(d, oneMsPast);

    expect(readdirSync(d)).toEqual([newest]);
  });

  it('keeps a ledger whose createdAt is unreadable — unreadable is not expired', () => {
    // The failure direction that matters: this function deletes the only record that makes a
    // merge reversible, so "kept too long" is recoverable and "deleted too early" is not.
    const d = sweeps();
    writeFileSync(join(d, 'merge-corrupt.json'), 'not json at all');
    writeFileSync(join(d, 'merge-nodate.json'), JSON.stringify({ version: 1 }));
    const newest = ledgerAged(d, 0);
    pruneExpiredLedgers(d, now());
    expect(readdirSync(d).sort()).toEqual(['merge-corrupt.json', 'merge-nodate.json', newest].sort());
  });

  it('⭐ deletes only names runMerge itself writes — the canonical predicate, not a lookalike', () => {
    // `sweeps/` is not exclusively ours, and the first version rolled its own filter
    // (`startsWith('merge-') && endsWith('.json')`) while claiming it touched nothing it did
    // not write. It would have deleted `merge-plan-notes.json`. The earlier version of THIS
    // test probed only `archive-*` and `*.json.bak`, so it passed straight over the gap —
    // the near-miss is the case that matters, not the obvious one.
    const d = sweeps();
    const real = `merge-${new Date(Date.now() - (LEDGER_RETENTION_DAYS + 5) * 864e5)
      .toISOString().replace(/[:.]/g, '-')}-abc123.json`;
    ledger(d, real, LEDGER_RETENTION_DAYS + 5);
    ledger(d, `merge-${new Date().toISOString().replace(/[:.]/g, '-')}-zzz999.json`, 0);
    // Near-misses: every one of these starts with `merge-` and ends with `.json`.
    ledger(d, 'merge-plan-notes.json', LEDGER_RETENTION_DAYS + 5);
    ledger(d, 'merge-backup.json', LEDGER_RETENTION_DAYS + 5);
    ledger(d, 'archive-old.json', LEDGER_RETENTION_DAYS + 5);
    writeFileSync(join(d, 'notes.txt'), 'x');

    pruneExpiredLedgers(d, now());

    const left = readdirSync(d);
    expect(left, 'the real expired ledger must be gone').not.toContain(real);
    expect(left).toContain('merge-plan-notes.json');
    expect(left).toContain('merge-backup.json');
    expect(left).toContain('archive-old.json');
    expect(left).toContain('notes.txt');
  });

  it('survives a missing directory instead of failing the merge', () => {
    expect(() => pruneExpiredLedgers(join(tmpdir(), 'nope-' + String(Date.now())), now())).not.toThrow();
  });

  it('a REAL runMerge prunes — retention is wired, not merely exported', () => {
    // Registering is not wiring: delete the call in runMerge and only this test goes red.
    const dir = mkdtempSync(join(tmpdir(), 'lynox-prune-'));
    dirs.push(dir);
    const engine = new EngineDb(join(dir, 'engine.db'), '');
    const history = new RunHistory(join(dir, 'history.db'));
    try {
      const store = new SubjectStore(engine);
      const threadStore = new ThreadStore(history.getDb());
      mkdirSync(join(dir, 'sweeps'), { recursive: true });
      const ancient = ledgerAged(join(dir, 'sweeps'), LEDGER_RETENTION_DAYS + 30);

      const dup = store.createSubject({ kind: 'organization', name: 'Gamma GmbH' });
      const canon = store.createSubject({ kind: 'organization', name: 'Gamma' });
      expect(runMerge(store, null, threadStore, dir, dup, canon).ok).toBe(true);

      const left = readdirSync(join(dir, 'sweeps'));
      expect(left).not.toContain(ancient);                // the old one is gone…
      expect(left).toHaveLength(1);                       // …and this merge's ledger is not
    } finally {
      try { engine.close(); } catch { /* noop */ }
      try { history.close(); } catch { /* noop */ }
    }
  });
});

describe('the owner\'s view of merges, and taking one back by id (PRD bulk-changes-reversible §3.7, form B)', () => {
  const dirs: string[] = [];
  const closers: Array<() => void> = [];
  const EMAIL = 'zxq-ada@example.invalid';
  const PHONE = '+41 00 000 00 00';
  const DOMAIN = 'zxq-domain.example.invalid';
  const VAT = 'CHE-000.000.000';

  // No vault key: the detail rows sit in the ledger as plaintext. The view must not depend
  // on encryption to keep them out.
  function setup(): { dir: string; sweeps: string; store: SubjectStore; threadStore: ThreadStore } {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-mergeview-'));
    dirs.push(dir);
    const engine = new EngineDb(join(dir, 'engine.db'), '');
    const history = new RunHistory(join(dir, 'history.db'));
    closers.push(() => { try { engine.close(); } catch { /* noop */ } try { history.close(); } catch { /* noop */ } });
    return { dir, sweeps: join(dir, 'sweeps'), store: new SubjectStore(engine), threadStore: new ThreadStore(history.getDb()) };
  }

  afterEach(() => {
    for (const c of closers) c();
    closers.length = 0;
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  function mergePeople(s: ReturnType<typeof setup>): { dup: string; canon: string; id: string } {
    const dup = s.store.createSubject({ kind: 'person', name: 'Ada L.' });
    const canon = s.store.createSubject({ kind: 'person', name: 'Ada Lovelace' });
    s.store.setPersonDetail(dup, { email: EMAIL, phone: PHONE });
    s.store.setPersonDetail(canon, { role: 'founder' });
    const r = runMerge(s.store, null, s.threadStore, s.dir, dup, canon);
    if (!r.ok) throw new Error(r.reason);
    const id = readdirSync(s.sweeps).find((n) => n.startsWith('merge-'))!.slice(0, -'.json'.length);
    return { dup, canon, id };
  }

  it('lists a merge by names, counts and state — never the detail rows the ledger holds for the rollback', () => {
    const s = setup();
    const { id } = mergePeople(s);
    // The positive control: the ledger on disk does carry them, in clear.
    const raw = readFileSync(join(s.sweeps, `${id}.json`), 'utf8');
    expect(raw).toContain(EMAIL);
    expect(raw).toContain(PHONE);

    const views = listMergeRuns(s.store, s.sweeps);
    expect(views).toEqual([{
      id, createdAt: expect.any(String) as string, kind: 'person', dupName: 'Ada L.', canonicalName: 'Ada Lovelace',
      applied: true, inEffect: true, superseded: false, dataStoreRows: 0, threadRows: 0,
    }]);
    expect(JSON.stringify(views)).not.toContain(EMAIL);
    expect(JSON.stringify(views)).not.toContain(PHONE);
  });

  it('keeps an organisation\'s domain and vat_id out too — the domain is stored in clear by design', () => {
    const s = setup();
    const dup = s.store.createSubject({ kind: 'organization', name: 'Zxq GmbH' });
    const canon = s.store.createSubject({ kind: 'organization', name: 'Zxq' });
    s.store.setOrganizationDetail(dup, { domain: DOMAIN, vat_id: VAT });
    const r = runMerge(s.store, null, s.threadStore, s.dir, dup, canon);
    expect(r.ok).toBe(true);
    expect(readFileSync(join(s.sweeps, readdirSync(s.sweeps)[0]!), 'utf8')).toContain(DOMAIN);
    const text = JSON.stringify(listMergeRuns(s.store, s.sweeps));
    expect(text).not.toContain(DOMAIN);
    expect(text).not.toContain(VAT);
  });

  it('takes a merge back by id once, and then says it is no longer in effect', () => {
    const s = setup();
    const { dup, id } = mergePeople(s);
    const back = rollbackMergeById(s.store, null, s.threadStore, s.sweeps, id);
    expect(back.ok).toBe(true);
    if (back.ok) expect(back.view.inEffect).toBe(false);
    expect(s.store.getSubject(dup)!.merged_into).toBeNull();
    expect(listMergeRuns(s.store, s.sweeps)[0]!.inEffect).toBe(false);
    expect(rollbackMergeById(s.store, null, s.threadStore, s.sweeps, id)).toEqual({ ok: false, reason: 'not_in_effect' });
  });

  it('refuses an id that is not a ledger name, a ledger that never applied, and an unreadable one', () => {
    const s = setup();
    const { id } = mergePeople(s);
    for (const bad of ['../engine', 'merge-x', `${id}/../${id}`, '']) {
      expect(rollbackMergeById(s.store, null, null, s.sweeps, bad)).toEqual({ ok: false, reason: 'not_found' });
    }
    // A real, valid ledger outside the sweeps directory is not reachable by a path-shaped id.
    writeFileSync(join(s.dir, 'evil.json'), readFileSync(join(s.sweeps, `${id}.json`), 'utf8'));
    expect(readMergeLedger(s.sweeps, '../evil')).toBeNull();
    expect(readMergeLedger(s.sweeps, id)).not.toBeNull();
    const led = JSON.parse(readFileSync(join(s.sweeps, `${id}.json`), 'utf8')) as MergeLedgerFile;
    writeFileSync(join(s.sweeps, `${id}.json`), JSON.stringify({ ...led, applied: false }));
    expect(rollbackMergeById(s.store, null, null, s.sweeps, id)).toEqual({ ok: false, reason: 'not_applied' });
    expect(listMergeRuns(s.store, s.sweeps)[0]!.applied).toBe(false);
    writeFileSync(join(s.sweeps, `${id}.json`), '{not json');
    expect(listMergeRuns(s.store, s.sweeps)).toEqual([]);
    expect(rollbackMergeById(s.store, null, null, s.sweeps, id)).toEqual({ ok: false, reason: 'not_found' });
  });

  it('lists nothing for an instance that never merged, and newest first otherwise', () => {
    const s = setup();
    expect(listMergeRuns(s.store, s.sweeps)).toEqual([]);
    mkdirSync(s.sweeps, { recursive: true });
    writeFileSync(join(s.sweeps, 'notes.json'), '{}');
    expect(listMergeRuns(s.store, s.sweeps)).toEqual([]);
    const a = s.store.createSubject({ kind: 'organization', name: 'Old A' });
    const b = s.store.createSubject({ kind: 'organization', name: 'Old B' });
    runMerge(s.store, null, null, s.dir, a, b);
    const c = s.store.createSubject({ kind: 'organization', name: 'New C' });
    const d = s.store.createSubject({ kind: 'organization', name: 'New D' });
    runMerge(s.store, null, null, s.dir, c, d);
    const names = listMergeRuns(s.store, s.sweeps).map((v) => v.dupName);
    expect(names).toEqual(['New C', 'Old A']);
  });
});

function anchorThread(threadStore: ThreadStore, threadId: string, subjectId: string): void {
  threadStore.createThread(threadId);
  threadStore.updateThread(threadId, { primary_subject_id: subjectId });
}

describe('what refuses a merge rollback, and why', () => {
  const dirs: string[] = [];
  const closers: Array<() => void> = [];
  function setup(): { dir: string; sweeps: string; store: SubjectStore; threadStore: ThreadStore } {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-mergerefuse-'));
    dirs.push(dir);
    const engine = new EngineDb(join(dir, 'engine.db'), '');
    const history = new RunHistory(join(dir, 'history.db'));
    closers.push(() => { try { engine.close(); } catch { /* noop */ } try { history.close(); } catch { /* noop */ } });
    return { dir, sweeps: join(dir, 'sweeps'), store: new SubjectStore(engine), threadStore: new ThreadStore(history.getDb()) };
  }
  afterEach(() => {
    for (const c of closers) c();
    closers.length = 0;
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });
  const ledgerIds = (sweeps: string): string[] => readdirSync(sweeps).filter((n) => n.startsWith('merge-')).map((n) => n.slice(0, -5)).sort();

  it('lets only the newest ledger of a pair take it back — an older one would write a stale before-image', () => {
    const s = setup();
    const a = s.store.createSubject({ kind: 'organization', name: 'Pair A' });
    const b = s.store.createSubject({ kind: 'organization', name: 'Pair B' });
    expect(runMerge(s.store, null, null, s.dir, a, b).ok).toBe(true);
    const [first] = ledgerIds(s.sweeps);
    expect(rollbackMergeById(s.store, null, null, s.sweeps, first!).ok).toBe(true);
    expect(runMerge(s.store, null, null, s.dir, a, b).ok).toBe(true);
    const second = ledgerIds(s.sweeps).find((x) => x !== first)!;
    // Make the order certain even within one millisecond: the older ledger gets an older name.
    const oldName = 'merge-2000-01-01T00-00-00-000Z-old1';
    renameSync(join(s.sweeps, `${first!}.json`), join(s.sweeps, `${oldName}.json`));
    const firstId = oldName;
    // createdAt inside a file does not decide "newest": changing it does not promote the old one.
    const older = JSON.parse(readFileSync(join(s.sweeps, `${firstId}.json`), 'utf8')) as MergeLedgerFile;
    writeFileSync(join(s.sweeps, `${firstId}.json`), JSON.stringify({ ...older, createdAt: '2999-01-01T00:00:00.000Z' }));
    const byId = new Map(listMergeRuns(s.store, s.sweeps).map((v) => [v.id, v]));
    expect([byId.get(firstId)!.superseded, byId.get(firstId)!.inEffect]).toEqual([true, false]);
    expect([byId.get(second)!.superseded, byId.get(second)!.inEffect]).toEqual([false, true]);
    expect(rollbackMergeById(s.store, null, null, s.sweeps, firstId)).toEqual({ ok: false, reason: 'superseded' });
    // A newer ledger that never applied still supersedes: the older before-image is stale either way.
    const newer = JSON.parse(readFileSync(join(s.sweeps, `${second}.json`), 'utf8')) as MergeLedgerFile;
    writeFileSync(join(s.sweeps, `${second}.json`), JSON.stringify({ ...newer, applied: false }));
    expect(rollbackMergeById(s.store, null, null, s.sweeps, firstId)).toEqual({ ok: false, reason: 'superseded' });
    writeFileSync(join(s.sweeps, `${second}.json`), JSON.stringify(newer));
    expect(rollbackMergeById(s.store, null, null, s.sweeps, second).ok).toBe(true);
  });

  it('refuses a merge whose entries are gone, and one merged elsewhere since', () => {
    const s = setup();
    const a = s.store.createSubject({ kind: 'organization', name: 'Gone A' });
    const b = s.store.createSubject({ kind: 'organization', name: 'Gone B' });
    expect(runMerge(s.store, null, null, s.dir, a, b).ok).toBe(true);
    const [id] = ledgerIds(s.sweeps);
    const led = JSON.parse(readFileSync(join(s.sweeps, `${id!}.json`), 'utf8')) as MergeLedgerFile;
    writeFileSync(join(s.sweeps, `${id!}.json`), JSON.stringify({ ...led, entry: { ...led.entry, canonicalId: 'no-such-subject' } }));
    expect(listMergeRuns(s.store, s.sweeps)[0]!.inEffect).toBe(false);
    expect(rollbackMergeById(s.store, null, null, s.sweeps, id!)).toEqual({ ok: false, reason: 'missing' });
    writeFileSync(join(s.sweeps, `${id!}.json`), JSON.stringify({ ...led, entry: { ...led.entry, dupId: 'no-such-subject' } }));
    expect(rollbackMergeById(s.store, null, null, s.sweeps, id!)).toEqual({ ok: false, reason: 'missing' });
    writeFileSync(join(s.sweeps, `${id!}.json`), JSON.stringify(led));
    const c = s.store.createSubject({ kind: 'organization', name: 'Gone C' });
    expect(rollbackMergeById(s.store, null, null, s.sweeps, id!).ok).toBe(true);
    expect(runMerge(s.store, null, null, s.dir, a, c).ok).toBe(true);
    expect(rollbackMergeById(s.store, null, null, s.sweeps, id!)).toEqual({ ok: false, reason: 'not_in_effect' });
  });

  it('refuses to reverse only the contact graph when the moved conversation links cannot be reached', () => {
    const s = setup();
    const a = s.store.createSubject({ kind: 'organization', name: 'Link A' });
    const b = s.store.createSubject({ kind: 'organization', name: 'Link B' });
    anchorThread(s.threadStore, 'tl', a);
    expect(runMerge(s.store, null, s.threadStore, s.dir, a, b).ok).toBe(true);
    const [id] = ledgerIds(s.sweeps);
    expect(listMergeRuns(s.store, s.sweeps)[0]!.threadRows).toBe(1);
    expect(rollbackMergeById(s.store, null, null, s.sweeps, id!)).toEqual({ ok: false, reason: 'unavailable' });
    expect(s.store.getSubject(a)!.merged_into).toBe(b);
    // With the store it goes through, and the link is back on the merged-away entry.
    expect(rollbackMergeById(s.store, null, s.threadStore, s.sweeps, id!).ok).toBe(true);
    expect(s.threadStore.getThread('tl')!.primary_subject_id).toBe(a);
  });

  it('refuses the same way when moved data rows cannot be reached', () => {
    const s = setup();
    const a = s.store.createSubject({ kind: 'organization', name: 'Rows A' });
    const b = s.store.createSubject({ kind: 'organization', name: 'Rows B' });
    expect(runMerge(s.store, null, null, s.dir, a, b).ok).toBe(true);
    const [id] = ledgerIds(s.sweeps);
    const led = JSON.parse(readFileSync(join(s.sweeps, `${id!}.json`), 'utf8')) as MergeLedgerFile;
    const moved = [{ collection: 'deals', column: 'org', ids: ['r1'] }] as unknown as MergeLedgerFile['dataStore'];
    writeFileSync(join(s.sweeps, `${id!}.json`), JSON.stringify({ ...led, dataStore: moved }));
    expect(listMergeRuns(s.store, s.sweeps)[0]!.dataStoreRows).toBe(1);
    expect(rollbackMergeById(s.store, null, null, s.sweeps, id!)).toEqual({ ok: false, reason: 'unavailable' });
    expect(s.store.getSubject(a)!.merged_into).toBe(b);
  });

  it('calls a split result partial, and a store refusal failed', () => {
    const s = setup();
    const a = s.store.createSubject({ kind: 'organization', name: 'Split A' });
    const b = s.store.createSubject({ kind: 'organization', name: 'Split B' });
    anchorThread(s.threadStore, 'ts', a);
    expect(runMerge(s.store, null, s.threadStore, s.dir, a, b).ok).toBe(true);
    const [id] = ledgerIds(s.sweeps);
    const broken = { restorePrimarySubject: () => { throw new Error('busy'); } } as unknown as ThreadStore;
    expect(rollbackMergeById(s.store, null, broken, s.sweeps, id!)).toEqual({ ok: false, reason: 'partial' });

    const c = s.store.createSubject({ kind: 'organization', name: 'Fail C' });
    const d = s.store.createSubject({ kind: 'organization', name: 'Fail D' });
    expect(runMerge(s.store, null, null, s.dir, c, d).ok).toBe(true);
    const failId = ledgerIds(s.sweeps).find((x) => x !== id)!;
    // A new entry has taken the merged-away name since: bringing the old one back would
    // make two active entries of one name, which the store refuses.
    s.store.createSubject({ kind: 'organization', name: 'Fail C' });
    expect(rollbackMergeById(s.store, null, null, s.sweeps, failId)).toEqual({ ok: false, reason: 'failed' });
    expect(s.store.getSubject(c)!.merged_into).toBe(d);
  });

  it('leaves out a ledger whose shape is broken instead of failing the whole list', () => {
    const s = setup();
    const a = s.store.createSubject({ kind: 'organization', name: 'Shape A' });
    const b = s.store.createSubject({ kind: 'organization', name: 'Shape B' });
    expect(runMerge(s.store, null, null, s.dir, a, b).ok).toBe(true);
    const [id] = ledgerIds(s.sweeps);
    const led = JSON.parse(readFileSync(join(s.sweeps, `${id!}.json`), 'utf8')) as MergeLedgerFile;
    const clone = 'merge-2001-01-01T00-00-00-000Z-zzzz.json';
    writeFileSync(join(s.sweeps, clone), JSON.stringify({ ...led, dataStore: [{ table: 'x' }] }));
    writeFileSync(join(s.sweeps, 'merge-2002-01-01T00-00-00-000Z-yyyy.json'), JSON.stringify({ phase: 'merge' }));
    const { dupId: _drop, ...noDup } = led.entry;
    writeFileSync(join(s.sweeps, 'merge-2003-01-01T00-00-00-000Z-xxxx.json'), JSON.stringify({ ...led, entry: noDup }));
    expect(listMergeRuns(s.store, s.sweeps).map((v) => v.id)).toEqual([id]);
  });

  it('reads a ledger from before the applied flag as applied, and needs the canonical row for inEffect', () => {
    const s = setup();
    const a = s.store.createSubject({ kind: 'organization', name: 'Legacy A' });
    const b = s.store.createSubject({ kind: 'organization', name: 'Legacy B' });
    expect(runMerge(s.store, null, null, s.dir, a, b).ok).toBe(true);
    const [id] = ledgerIds(s.sweeps);
    const { applied: _a, ...legacy } = JSON.parse(readFileSync(join(s.sweeps, `${id!}.json`), 'utf8')) as MergeLedgerFile;
    writeFileSync(join(s.sweeps, `${id!}.json`), JSON.stringify(legacy));
    expect(listMergeRuns(s.store, s.sweeps)[0]!.applied).toBe(true);
    // The canonical row gone while the duplicate still redirects onto it: not in effect.
    const raw = (s.store as unknown as { db: { pragma: (q: string) => void; prepare: (q: string) => { run: (...a: unknown[]) => void } } }).db;
    raw.pragma('foreign_keys = OFF');
    raw.prepare('DELETE FROM subjects WHERE id = ?').run(b);
    expect(s.store.getSubject(a)!.merged_into).toBe(b);
    expect(listMergeRuns(s.store, s.sweeps)[0]!.inEffect).toBe(false);
  });
});

