import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RunHistory } from './run-history.js';

/**
 * The run claim for `POST /api/workflows/:id/run` (PRD idempotency-bulk-first §3.1).
 *
 * What is provable here is the STATE SPACE, on a real `history.db` rather than a double:
 * the claim's two observable facts are "does a row exist" and "is `started_at` set", and
 * every answer the route gives is a function of those two. A mock would prove that the
 * route CALLS something; only real rows prove that a repeat is refused and that a paid
 * run is never silently released.
 *
 * The asymmetry is the whole point and each half has its own test below: a claim that
 * spent nothing may be dropped, a claim that spent something may NOT — not by the request's
 * own cleanup and not by the boot sweep — because a refusal before the run and a crash
 * after it reach the route in the same shape. `started_at` is what tells them apart, which
 * is why it is a column and not a return value.
 */
describe('workflow run claim — the state space on a real history.db', () => {
  const dirs: string[] = [];
  const histories: RunHistory[] = [];

  function make(): RunHistory {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-runclaim-'));
    dirs.push(dir);
    const h = new RunHistory(join(dir, 'history.db'));
    histories.push(h);
    return h;
  }

  /** A `pipeline_runs` row in a given status — what the route reads the claim's state from. */
  function seedRun(h: RunHistory, id: string, status: string): void {
    h.getDb().prepare(
      `INSERT INTO pipeline_runs (id, manifest_name, status, manifest_json) VALUES (?, 'wf', ?, '{}')`,
    ).run(id, status);
  }

  afterEach(() => {
    for (const h of histories.splice(0)) { try { h.close(); } catch { /* already closed */ } }
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('v55 creates the table with the key on (workflow_id, key) and NOT on run_id', () => {
    const h = make();
    const cols = (h.getDb().prepare('PRAGMA table_info(workflow_run_claims)').all() as { name: string }[])
      .map(c => c.name);
    expect(cols).toEqual(expect.arrayContaining(['workflow_id', 'key', 'run_id', 'started_at']));
    // `created_at` exists so a bounded sweep could be written without a migration, and
    // NOTHING reads it — a started claim is permanent until that decision is taken (PRD
    // §3.2 point 6). Asserted here so the column is not mistaken for dead weight and
    // dropped, and so its absence from every query is a stated fact rather than an
    // oversight somebody has to rediscover.
    expect(cols).toContain('created_at');
    // The primary key IS the refusal, and it must not span run_id: a restart swaps that
    // column, so an index over all three would make every restart a fresh claim and a
    // repeated call would never be refused. `pk` > 0 marks a key member.
    const pk = (h.getDb().prepare('PRAGMA table_info(workflow_run_claims)').all() as { name: string; pk: number }[])
      .filter(c => c.pk > 0).map(c => c.name).sort();
    expect(pk).toEqual(['key', 'workflow_id']);
  });

  it('the second call with the same key is refused, and the first keeps its run id', () => {
    const h = make();
    expect(h.claimWorkflowRun('wf-1', 'k-1', 'run-a')).toBe(true);
    expect(h.claimWorkflowRun('wf-1', 'k-1', 'run-b')).toBe(false);
    expect(h.readWorkflowRunClaim('wf-1', 'k-1')).toEqual({ runId: 'run-a', startedAt: null });
  });

  it('two claims cannot share a run id — the index makes it a property, not a convention', () => {
    // `markWorkflowRunStarted` is keyed on `run_id` ALONE, so with a non-unique index one
    // stamp would set `started_at` on two claims at once (measured on a probe: two rows
    // stamped by one call). Every producer mints a fresh UUID, so this cannot happen today
    // — which is exactly why it needs to be the table's property rather than the single
    // writer's habit, and why a violation has to be a loud error.
    //
    // ⚠ This passes on a FRESH database either way, so it does not by itself prove the
    // index is unique on a database that ran v55 before v56 existed — the migration's own
    // comment carries that reasoning, and the next test is the one that drives the upgrade.
    const h = make();
    expect(h.claimWorkflowRun('wf-1', 'k-1', 'run-shared')).toBe(true);
    expect(() => h.claimWorkflowRun('wf-2', 'k-2', 'run-shared')).toThrow(/UNIQUE|constraint/i);
    // and the first claim is untouched by the refused insert
    expect(h.readWorkflowRunClaim('wf-1', 'k-1')).toEqual({ runId: 'run-shared', startedAt: null });
    expect(h.readWorkflowRunClaim('wf-2', 'k-2')).toBeNull();
  });

  it('an UPGRADED database gets the unique index too, and its duplicates are repaired', () => {
    // The hole the first attempt left: it edited v55 in place, so a database that had
    // already run v55 kept a non-unique index — `schema_version` reads 55, the migration
    // never re-runs, and `CREATE UNIQUE INDEX IF NOT EXISTS` sees the existing name and
    // does nothing. A fresh-database test cannot see that, so this one builds the old
    // state by hand and reopens it with the current code.
    const dir = mkdtempSync(join(tmpdir(), 'lynox-claim-upgrade-'));
    dirs.push(dir);
    const path = join(dir, 'history.db');
    const before = new RunHistory(path);
    // Put the database back into the shape v55 alone left: a non-unique index, two claims
    // sharing a run id, and the version pinned so v56 is the only thing that can run.
    before.getDb().exec('DROP INDEX IF EXISTS idx_workflow_run_claims_run');
    before.getDb().exec('CREATE INDEX idx_workflow_run_claims_run ON workflow_run_claims(run_id)');
    before.getDb().prepare('INSERT INTO workflow_run_claims (workflow_id, key, run_id) VALUES (?, ?, ?)').run('wf-1', 'k-1', 'run-shared');
    before.getDb().prepare('INSERT INTO workflow_run_claims (workflow_id, key, run_id) VALUES (?, ?, ?)').run('wf-2', 'k-2', 'run-shared');
    before.getDb().exec('DELETE FROM schema_version WHERE version > 55');
    // Fixture guard: the damage really is present before the upgrade.
    before.markWorkflowRunStarted('run-shared');
    expect(before.readWorkflowRunClaim('wf-1', 'k-1')?.startedAt, 'fixture guard').not.toBeNull();
    expect(before.readWorkflowRunClaim('wf-2', 'k-2')?.startedAt, 'ONE stamp hit TWO claims').not.toBeNull();
    before.close();

    const after = new RunHistory(path);
    histories.push(after);
    const idx = (after.getDb().prepare('PRAGMA index_list(workflow_run_claims)').all() as Array<{ name: string; unique: number }>)
      .find(i => i.name === 'idx_workflow_run_claims_run');
    expect(idx?.unique, 'the upgrade has to make it unique').toBe(1);
    // The duplicate is repaired, the earlier row kept.
    expect(after.readWorkflowRunClaim('wf-1', 'k-1')).not.toBeNull();
    expect(after.readWorkflowRunClaim('wf-2', 'k-2')).toBeNull();
    // And a new duplicate is now refused outright.
    expect(() => after.claimWorkflowRun('wf-3', 'k-3', 'run-shared')).toThrow(/UNIQUE|constraint/i);
  });

  it('the upgrade keeps the row that holds the SPEND, not the earliest one', () => {
    // ⚠ The repair's tie-break was `MIN(rowid)`, and a duplicate can be asymmetric: the
    // earlier row unstarted, the LATER one carrying `started_at`. Keeping the earliest then
    // destroys the only record that money was spent, and that key's owner pays again on the
    // next click — this delivery's own damage, caused by its own repair.
    const dir = mkdtempSync(join(tmpdir(), 'lynox-claim-tiebreak-'));
    dirs.push(dir);
    const path = join(dir, 'history.db');
    const before = new RunHistory(path);
    before.getDb().exec('DROP INDEX IF EXISTS idx_workflow_run_claims_run');
    before.getDb().exec('CREATE INDEX idx_workflow_run_claims_run ON workflow_run_claims(run_id)');
    const ins = before.getDb().prepare('INSERT INTO workflow_run_claims (workflow_id, key, run_id, started_at) VALUES (?, ?, ?, ?)');
    ins.run('wf-early', 'k-early', 'run-shared', null);   // earlier rowid, nothing spent
    ins.run('wf-late', 'k-late', 'run-shared', '2026-10-07T00:00:00.000Z'); // later rowid, PAID
    before.getDb().exec('DELETE FROM schema_version WHERE version > 55');
    before.close();

    const after = new RunHistory(path);
    histories.push(after);
    expect(after.readWorkflowRunClaim('wf-late', 'k-late'),
      'the paid claim is the one that must survive').not.toBeNull();
    expect(after.readWorkflowRunClaim('wf-late', 'k-late')!.startedAt).not.toBeNull();
    expect(after.readWorkflowRunClaim('wf-early', 'k-early'),
      'and the unstarted one is the one that goes').toBeNull();
  });

  it('a different key on the same workflow is a different claim', () => {
    const h = make();
    expect(h.claimWorkflowRun('wf-1', 'k-1', 'run-a')).toBe(true);
    expect(h.claimWorkflowRun('wf-1', 'k-2', 'run-b')).toBe(true);
    expect(h.claimWorkflowRun('wf-2', 'k-1', 'run-c')).toBe(true);
  });

  it('a claim that spent NOTHING is released by its own request', () => {
    const h = make();
    h.claimWorkflowRun('wf-1', 'k-1', 'run-a');
    expect(h.releaseUnstartedWorkflowRunClaim('wf-1', 'k-1', 'run-a')).toBe(true);
    expect(h.readWorkflowRunClaim('wf-1', 'k-1')).toBeNull();
    // Released means a legitimate second attempt gets through — a refusal before the run
    // must not burn the key, or a user who tops up their credit can never retry.
    expect(h.claimWorkflowRun('wf-1', 'k-1', 'run-b')).toBe(true);
  });

  it('a claim that SPENT something is not released, by the request or the sweep', () => {
    const h = make();
    h.claimWorkflowRun('wf-1', 'k-1', 'run-a');
    h.markWorkflowRunStarted('run-a');
    // ⚠ Row FIRST, then the field. `expect(undefined).not.toBeNull()` PASSES, so
    // `expect(row?.startedAt).not.toBeNull()` alone is satisfied by a row that is not
    // there — the opposite of what it looks like it checks.
    expect(h.readWorkflowRunClaim('wf-1', 'k-1')).not.toBeNull();
    expect(h.readWorkflowRunClaim('wf-1', 'k-1')!.startedAt).not.toBeNull();
    // Both release paths must decline. This is the half that keeps a paid crash from
    // handing out a second run.
    expect(h.releaseUnstartedWorkflowRunClaim('wf-1', 'k-1', 'run-a')).toBe(false);
    expect(h.sweepUnstartedWorkflowRunClaims()).toBe(0);
    expect(h.readWorkflowRunClaim('wf-1', 'k-1')).not.toBeNull();
  });

  it('the boot sweep drops unstarted claims and leaves started ones standing', () => {
    const h = make();
    h.claimWorkflowRun('wf-1', 'nothing-spent', 'run-a');
    h.claimWorkflowRun('wf-1', 'spent', 'run-b');
    h.markWorkflowRunStarted('run-b');
    expect(h.sweepUnstartedWorkflowRunClaims()).toBe(1);
    expect(h.readWorkflowRunClaim('wf-1', 'nothing-spent')).toBeNull();
    expect(h.readWorkflowRunClaim('wf-1', 'spent')).not.toBeNull();
  });

  it('markWorkflowRunStarted is a no-op for a run no claim points at', () => {
    const h = make();
    // A cron or chat-driven run holds no claim; the hook still fires for it.
    expect(() => h.markWorkflowRunStarted('run-nobody')).not.toThrow();
    expect(h.readWorkflowRunClaim('wf-1', 'k-1')).toBeNull();
  });

  it('markWorkflowRunStarted does not move an already-set stamp', () => {
    // The first version of this test called the hook twice and compared the two stamps —
    // and a mutant that drops the `started_at IS NULL` guard SURVIVED it, because both
    // calls land in the same millisecond and `toISOString()` returns the same string. The
    // test asserted nothing. Seeding a distinguishable earlier value is what gives the
    // assertion something to see (memory/fb_probe_vs_survivor.md).
    const h = make();
    h.claimWorkflowRun('wf-1', 'k-1', 'run-a');
    const seeded = '2020-01-01T00:00:00.000Z';
    h.getDb().prepare('UPDATE workflow_run_claims SET started_at = ? WHERE run_id = ?').run(seeded, 'run-a');
    h.markWorkflowRunStarted('run-a');
    expect(h.readWorkflowRunClaim('wf-1', 'k-1')?.startedAt).toBe(seeded);
  });

  describe('the restart, and what is deliberately NOT restartable', () => {
    it('restarts a claim whose run FAILED, onto a new run id', () => {
      const h = make();
      h.claimWorkflowRun('wf-1', 'k-1', 'run-a');
      h.markWorkflowRunStarted('run-a');
      seedRun(h, 'run-a', 'failed');
      expect(h.restartWorkflowRunClaim('wf-1', 'k-1', 'run-a', 'run-b')).toBe(true);
      expect(h.readWorkflowRunClaim('wf-1', 'k-1')).toEqual({ runId: 'run-b', startedAt: null });
    });

    it('restarts a claim whose run was INTERRUPTED', () => {
      const h = make();
      h.claimWorkflowRun('wf-1', 'k-1', 'run-a');
      h.markWorkflowRunStarted('run-a');
      seedRun(h, 'run-a', 'interrupted');
      expect(h.restartWorkflowRunClaim('wf-1', 'k-1', 'run-a', 'run-b')).toBe(true);
    });

    it('REFUSES to restart a claim with no run row at all — the SQLITE_BUSY case', () => {
      // ⚠ This witness asserted the OPPOSITE in its first version, and the method was
      // written to satisfy it: the subquery was wrapped in `COALESCE(..., 'interrupted')`
      // so a row-less claim would restart, on the argument that otherwise a client holding
      // the key hangs at 409 forever.
      //
      // The argument was right about the hang and wrong about the remedy. The run spent
      // money and its fire-and-forget insert was swallowed — so a run that DIED and one
      // that is STILL SPENDING arrive here in the same shape, and restarting is a second
      // paid run in the second case. The hang is prevented where the key lives instead:
      // the route answers `run_outcome_unknown`, the view discards the key, and the next
      // click is a new attempt a person chose. Decided with the orchestrator, 2026-10-07.
      //
      // The mutant this kills is "put COALESCE back".
      const h = make();
      h.claimWorkflowRun('wf-1', 'k-1', 'run-a');
      h.markWorkflowRunStarted('run-a');
      expect(h.readWorkflowRunClaim('wf-1', 'k-1')).not.toBeNull();
      expect(h.readWorkflowRunClaim('wf-1', 'k-1')!.startedAt).not.toBeNull();
      expect(h.restartWorkflowRunClaim('wf-1', 'k-1', 'run-a', 'run-b')).toBe(false);
      // and the claim is untouched: still the old run, still marked as having spent
      expect(h.readWorkflowRunClaim('wf-1', 'k-1')).toEqual({ runId: 'run-a', startedAt: expect.any(String) });
    });

    it('refuses to restart a RUNNING run', () => {
      const h = make();
      h.claimWorkflowRun('wf-1', 'k-1', 'run-a');
      h.markWorkflowRunStarted('run-a');
      seedRun(h, 'run-a', 'running');
      expect(h.restartWorkflowRunClaim('wf-1', 'k-1', 'run-a', 'run-b')).toBe(false);
      expect(h.readWorkflowRunClaim('wf-1', 'k-1')?.runId).toBe('run-a');
    });

    it('refuses to restart a COMPLETED run', () => {
      const h = make();
      h.claimWorkflowRun('wf-1', 'k-1', 'run-a');
      h.markWorkflowRunStarted('run-a');
      seedRun(h, 'run-a', 'completed');
      expect(h.restartWorkflowRunClaim('wf-1', 'k-1', 'run-a', 'run-b')).toBe(false);
    });

    it('refuses to restart a claim that never spent anything — that one is released', () => {
      // ⚠ The first version of this witness seeded no run row, and a mutant that DELETED
      // the `started_at IS NOT NULL` precondition survived it: with no row the status
      // subquery is NULL and refuses on its own, so the guard under test contributed
      // nothing to the outcome. The fixture has to make the two conditions separable —
      // hence a `failed` row beside an UNSTARTED claim, which is the only combination in
      // which `started_at` is the deciding term (memory/fb_probe_vs_survivor.md).
      //
      // The production path should not produce that combination: the run row is inserted
      // after `onRunStart` fires, so a row implies a stamp. The guard exists for the case
      // where that stops being true, and a guard whose claim no test can falsify is a
      // guard nobody can rely on.
      const h = make();
      h.claimWorkflowRun('wf-1', 'k-1', 'run-a');
      seedRun(h, 'run-a', 'failed');
      expect(h.readWorkflowRunClaim('wf-1', 'k-1')?.startedAt, 'fixture guard').toBeNull();
      expect(h.restartWorkflowRunClaim('wf-1', 'k-1', 'run-a', 'run-b')).toBe(false);
      expect(h.readWorkflowRunClaim('wf-1', 'k-1')?.runId).toBe('run-a');
      // and it is the RELEASE that applies to it, which is the whole point of refusing
      expect(h.releaseUnstartedWorkflowRunClaim('wf-1', 'k-1', 'run-a')).toBe(true);
    });

    it('only ONE of two concurrent retries wins the restart', () => {
      // ⚠ This witnesses the OUTCOME, and it is overdetermined: after the first restart
      // `started_at` is NULL *and* `run_id` is 'run-b', so two independent terms each make
      // the second call false. Which one did the work is invisible here — the separable
      // case is the next test.
      const h = make();
      h.claimWorkflowRun('wf-1', 'k-1', 'run-a');
      h.markWorkflowRunStarted('run-a');
      seedRun(h, 'run-a', 'failed');
      const first = h.restartWorkflowRunClaim('wf-1', 'k-1', 'run-a', 'run-b');
      const second = h.restartWorkflowRunClaim('wf-1', 'k-1', 'run-a', 'run-c');
      expect([first, second]).toEqual([true, false]);
      expect(h.readWorkflowRunClaim('wf-1', 'k-1')?.runId).toBe('run-b');
    });

    it('a LATE retry holding the stale run id cannot swap a live run away', () => {
      // The term `run_id = ?` on its own, with every other condition satisfied — a mutant
      // dropping it survived the whole file until this case existed.
      //
      // The reachable damage: the restarted run `run-b` is live and spending, and a request
      // that read the claim before the swap still holds `run-a`. `started_at IS NOT NULL` is
      // true (run-b started) and the status subquery still reads run-a's `failed`, so only
      // the run-id term stands between that late call and swapping a paying run's claim
      // away — which hands out a second paid run.
      const h = make();
      h.claimWorkflowRun('wf-1', 'k-1', 'run-a');
      h.markWorkflowRunStarted('run-a');
      seedRun(h, 'run-a', 'failed');
      expect(h.restartWorkflowRunClaim('wf-1', 'k-1', 'run-a', 'run-b')).toBe(true);
      h.markWorkflowRunStarted('run-b');
      // Fixture guard: the two OTHER conditions are satisfied, so only the run id can refuse.
      expect(h.readWorkflowRunClaim('wf-1', 'k-1')!.startedAt).not.toBeNull();
      expect(h.getPipelineRun('run-a')?.status).toBe('failed');
      expect(h.restartWorkflowRunClaim('wf-1', 'k-1', 'run-a', 'run-c')).toBe(false);
      expect(h.readWorkflowRunClaim('wf-1', 'k-1')!.runId).toBe('run-b');
    });

    it('a release holding the stale run id cannot drop another attempt\'s claim', () => {
      // The same term in `releaseUnstartedWorkflowRunClaim`, and the same gap: its only
      // `false` expectation elsewhere has `started_at` set, so that guard decides it alone.
      // Here the claim is UNSTARTED — `started_at IS NULL` is satisfied — and the run id is
      // the only thing that may refuse.
      const h = make();
      h.claimWorkflowRun('wf-1', 'k-1', 'run-a');
      h.markWorkflowRunStarted('run-a');
      seedRun(h, 'run-a', 'failed');
      h.restartWorkflowRunClaim('wf-1', 'k-1', 'run-a', 'run-b');
      expect(h.readWorkflowRunClaim('wf-1', 'k-1')!.startedAt).toBeNull();
      expect(h.releaseUnstartedWorkflowRunClaim('wf-1', 'k-1', 'run-a')).toBe(false);
      expect(h.readWorkflowRunClaim('wf-1', 'k-1')).not.toBeNull();
      // and the owner of the current id still can
      expect(h.releaseUnstartedWorkflowRunClaim('wf-1', 'k-1', 'run-b')).toBe(true);
    });

    it('a restarted claim can be released again if the new attempt spends nothing', () => {
      const h = make();
      h.claimWorkflowRun('wf-1', 'k-1', 'run-a');
      h.markWorkflowRunStarted('run-a');
      seedRun(h, 'run-a', 'failed');
      h.restartWorkflowRunClaim('wf-1', 'k-1', 'run-a', 'run-b');
      // The restart clears started_at, so the new attempt starts from "nothing spent".
      expect(h.releaseUnstartedWorkflowRunClaim('wf-1', 'k-1', 'run-b')).toBe(true);
    });
  });

  it('a database reset takes the claims with it, like every other table', () => {
    // `resetDatabase` keeps a hand-maintained table list — the kind every new table has to
    // remember to join, and v55 did not. A claim left behind by a wipe that took
    // `pipeline_runs` has `started_at` set and no run row, which the route reads as "it may
    // still be running": a sentence that is false about a run the reset destroyed.
    // No production caller today, so this is the witness that keeps it true anyway.
    // ⚠ This test needed a stub table for one revision: `resetDatabase`'s list named
    // `memory_embeddings`, dropped by v19, and `DELETE FROM` a missing table throws — so
    // the method never reached any later entry and adding one was a line that could not
    // run. The dead name is gone from the list, so the method works and the stub is not
    // needed. Kept as a note because the next person to add a table will be reading this.
    const h = make();
    h.claimWorkflowRun('wf-1', 'spent', 'run-a');
    h.markWorkflowRunStarted('run-a');
    h.claimWorkflowRun('wf-1', 'unspent', 'run-b');
    h.resetDatabase();
    expect(h.readWorkflowRunClaim('wf-1', 'spent')).toBeNull();
    expect(h.readWorkflowRunClaim('wf-1', 'unspent')).toBeNull();
  });

  it('survives a restart of the process: a started claim is still there', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-runclaim-boot-'));
    dirs.push(dir);
    const before = new RunHistory(join(dir, 'history.db'));
    before.claimWorkflowRun('wf-1', 'k-1', 'run-a');
    before.markWorkflowRunStarted('run-a');
    before.close();

    const after = new RunHistory(join(dir, 'history.db'));
    histories.push(after);
    // The discriminator is persisted, which is the reason it is a column: a process that
    // dies between the run's start and its answer leaves no return value behind.
    expect(after.readWorkflowRunClaim('wf-1', 'k-1')).not.toBeNull();
    expect(after.readWorkflowRunClaim('wf-1', 'k-1')!.startedAt).not.toBeNull();
    expect(after.sweepUnstartedWorkflowRunClaims()).toBe(0);
    expect(after.readWorkflowRunClaim('wf-1', 'k-1')).not.toBeNull();
  });
});
