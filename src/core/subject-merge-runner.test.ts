import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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
