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
    expect(h.readWorkflowRunClaim('wf-1', 'k-1')?.startedAt).not.toBeNull();
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
      expect(h.readWorkflowRunClaim('wf-1', 'k-1')?.startedAt).not.toBeNull();
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
      const h = make();
      h.claimWorkflowRun('wf-1', 'k-1', 'run-a');
      h.markWorkflowRunStarted('run-a');
      seedRun(h, 'run-a', 'failed');
      const first = h.restartWorkflowRunClaim('wf-1', 'k-1', 'run-a', 'run-b');
      const second = h.restartWorkflowRunClaim('wf-1', 'k-1', 'run-a', 'run-c');
      expect([first, second]).toEqual([true, false]);
      expect(h.readWorkflowRunClaim('wf-1', 'k-1')?.runId).toBe('run-b');
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
    expect(after.readWorkflowRunClaim('wf-1', 'k-1')?.startedAt).not.toBeNull();
    expect(after.sweepUnstartedWorkflowRunClaims()).toBe(0);
    expect(after.readWorkflowRunClaim('wf-1', 'k-1')).not.toBeNull();
  });
});
