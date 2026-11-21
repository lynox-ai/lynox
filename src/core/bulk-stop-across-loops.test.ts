import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { OWNER_PRINCIPAL } from './request-principal.js';
import { EngineDb } from './engine-db.js';
import { BulkLedger, BULK_HALT_REASONS, type BulkLease, type PlannedTarget } from './bulk-ledger.js';
import { BulkWriterHalt, runBulkEffect, type BulkEffectOutcome, type TargetWriter } from './bulk-apply.js';
import { TriggerStore } from './trigger-store.js';

/**
 * A bulk run under two loops on one engine.db, each over its own connection, as two engine
 * processes would run it: loop B took the run's lease first, loop A takes it over once B's lease
 * lapsed. Every record B makes holds its lease in the same statement, so after the takeover B
 * records nothing and ends `displaced`. The owner's stop is a mark in the ledger, which reaches a
 * loop wherever it runs. A loop whose lease lapsed with nobody taking over writes on as before.
 */

let dir: string;
let engA: EngineDb;
let engB: EngineDb;
let ledA: BulkLedger;
let ledB: BulkLedger;
let trigA: TriggerStore;
let trigB: TriggerStore;

const FUTURE = (): string => new Date(Date.now() + 15 * 60_000).toISOString();
const NOW = (): string => new Date().toISOString();

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'lynox-bulk-two-loops-')));
  const path = join(dir, 'engine.db');
  engA = new EngineDb(path, 'test-vault-key');
  engB = new EngineDb(path, 'test-vault-key');
  ledA = new BulkLedger(engA, null);
  ledB = new BulkLedger(engB, null);
  trigA = new TriggerStore(engA);
  trigB = new TriggerStore(engB);
});

afterEach(() => {
  engA.close();
  engB.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A recorded, approved run of in-memory targets k000…: before v<i>, after w<i>. */
function approvedRun(n: number, opts: { atomic?: boolean; now?: number } = {}): { runId: string; initial: Record<string, string>; tid: string } {
  const initial: Record<string, string> = {};
  const targets: PlannedTarget[] = [];
  for (let i = 0; i < n; i++) {
    const key = `k${String(i).padStart(3, '0')}`;
    initial[key] = `v${String(i)}`;
    targets.push({ key, before: { absent: false, value: `v${String(i)}` }, after: `w${String(i)}` });
  }
  const s = ledA.recordDryRun({ createdBy: 't', principal: OWNER_PRINCIPAL, targetSystem: 'workspace', scope: 'mem', targets, atomic: opts.atomic });
  const out = ledA.approve(s.id, { checksum: ledA.computeChecksum(s.id)!, ...(opts.now !== undefined ? { now: opts.now } : {}) });
  if (!out.ok) throw new Error(`approve refused: ${out.reason}`);
  return { runId: s.id, initial, tid: out.triggerId };
}

/** Loop B takes the run's lease, as the tick of its process does before running it. */
function bTakesLease(tid: string): BulkLease {
  expect(trigB.claimLease(tid, 'B', FUTURE(), NOW())).toBe('claimed');
  return { triggerId: tid, holder: 'B' };
}

/** B's lease lapses and A takes it over: the step a second engine process takes. */
function aTakesOver(tid: string): BulkLease {
  engA.getDb().prepare('UPDATE triggers SET lease_until = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), tid);
  expect(trigA.claimLease(tid, 'A', FUTURE(), NOW())).not.toBe('held');
  expect(trigA.leaseOf(tid)!.holder).toBe('A');
  return { triggerId: tid, holder: 'A' };
}

/** An in-memory target system. `fail`: keys whose write throws; `halt`: keys whose write halts. */
function memory(initial: Record<string, string>, opts: { fail?: Set<string>; halt?: Set<string>; markup?: Set<string> } = {}): { writer: TargetWriter; state: Map<string, string>; writes: string[] } {
  const state = new Map(Object.entries(initial));
  const writes: string[] = [];
  return {
    state, writes,
    writer: {
      async read(key) {
        return state.has(key) ? { absent: false, value: state.get(key)! } : { absent: true };
      },
      async write(key, after) {
        writes.push(key);
        if (opts.halt?.has(key) === true) throw new BulkWriterHalt(BULK_HALT_REASONS.contract);
        if (opts.fail?.has(key) === true) throw new Error('boom');
        if (after.absent) state.delete(key);
        else state.set(key, after.value as string);
        if (opts.markup?.has(key) === true) return { result: 'ok', actual: { value: after.absent ? null : after.value, estimated: false }, hostAddedMarkup: true };
        return 'ok';
      },
    },
  };
}

type LedgerHooks = Partial<Record<keyof BulkLedger, (args: unknown[]) => void>>;

/** B's ledger with a hook run right before the named methods, so a takeover lands exactly there.
 *  Calls a method makes on itself go through the hooks too. Counts every call by name. */
function hooked(ledger: BulkLedger, hooks: LedgerHooks): { ledger: BulkLedger; calls: Map<string, number> } {
  const calls = new Map<string, number>();
  const proxy = new Proxy(ledger, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== 'function' || typeof prop !== 'string') return value;
      return (...args: unknown[]): unknown => {
        calls.set(prop, (calls.get(prop) ?? 0) + 1);
        hooks[prop as keyof BulkLedger]?.(args);
        return Reflect.apply(value as (...a: unknown[]) => unknown, receiver, args);
      };
    },
  });
  return { ledger: proxy, calls };
}

/** Run once through `once`: the hook fires on its first matching call only. */
function once(fn: (args: unknown[]) => boolean | void): (args: unknown[]) => void {
  let done = false;
  return (args) => {
    if (done) return;
    if (fn(args) === false) return;
    done = true;
  };
}

function runB(runId: string, writer: TargetWriter, ledger: BulkLedger, lease: BulkLease | null, extra: { effect?: 'bulk_apply' | 'bulk_undo'; claimHeartbeatMs?: number } = {}): Promise<BulkEffectOutcome> {
  return runBulkEffect(runId, extra.effect ?? 'bulk_apply', {
    ledger, writerFor: () => writer, trailFor: () => null,
    ...(lease !== null ? { lease } : {}),
    ...(extra.claimHeartbeatMs !== undefined ? { claimHeartbeatMs: extra.claimHeartbeatMs } : {}),
  });
}

const target = (runId: string, seq: number) => engA.getDb().prepare(
  'SELECT claimed_at, applied_at, error, write_sent, unknown_sends, undone_at FROM bulk_targets WHERE run_id = ? AND seq = ?',
).get(runId, seq) as { claimed_at: string | null; applied_at: string | null; error: string | null; write_sent: number; unknown_sends: number; undone_at: string | null };
const runRow = (runId: string) => engA.getDb().prepare('SELECT phase, halt_reason, targets_applied, targets_failed, stop_requested_at FROM bulk_runs WHERE id = ?')
  .get(runId) as { phase: string; halt_reason: string | null; targets_applied: number; targets_failed: number; stop_requested_at: string | null };

describe('every record of a displaced loop holds the run lease (one write each)', () => {
  it('setPhase: a loop displaced before the run starts writing leaves it approved and ends displaced', async () => {
    const { runId, initial, tid } = approvedRun(2);
    const lease = bTakesLease(tid);
    const m = memory(initial);
    const h = hooked(ledB, { setPhase: once(() => { aTakesOver(tid); }) });
    expect((await runB(runId, m.writer, h.ledger, lease)).status).toBe('displaced');
    expect(runRow(runId).phase).toBe('approved');
    expect(m.writes).toEqual([]);
  });

  it('claimTarget: a loop displaced at a claim takes no target, makes no further claim, and ends displaced', async () => {
    const { runId, initial, tid } = approvedRun(3);
    const lease = bTakesLease(tid);
    const m = memory(initial);
    const h = hooked(ledB, { claimTarget: once(() => { aTakesOver(tid); }) });
    expect((await runB(runId, m.writer, h.ledger, lease)).status).toBe('displaced');
    expect(h.calls.get('claimTarget')).toBe(1);
    expect(target(runId, 0).claimed_at).toBeNull();
    expect(m.writes).toEqual([]);
  });

  it('claimTarget, both lost: a target another loop holds AND a lost lease reads as the lease — the loop ends', async () => {
    const { runId, initial, tid } = approvedRun(3);
    const lease = bTakesLease(tid);
    const m = memory(initial);
    const h = hooked(ledB, {
      claimTarget: once(() => {
        // Another loop holds target 0 (a fresh claim), and the run's lease is taken over.
        engA.getDb().prepare('UPDATE bulk_targets SET claimed_at = ? WHERE run_id = ? AND seq = 0').run(NOW(), runId);
        aTakesOver(tid);
      }),
    });
    expect((await runB(runId, m.writer, h.ledger, lease)).status).toBe('displaced');
    expect(h.calls.get('claimTarget')).toBe(1);
    expect(m.writes).toEqual([]);
  });

  it('markSent: a loop displaced before its send marks nothing and sends nothing', async () => {
    const { runId, initial, tid } = approvedRun(2);
    const lease = bTakesLease(tid);
    const m = memory(initial);
    const h = hooked(ledB, { markSent: once(() => { aTakesOver(tid); }) });
    expect((await runB(runId, m.writer, h.ledger, lease)).status).toBe('displaced');
    expect(target(runId, 0).write_sent).toBe(0);
    expect(m.writes).toEqual([]);
    // The send's lost lease ends the loop: it goes on to no other target.
    expect(h.calls.get('claimTarget')).toBe(1);
  });

  it('renewClaim: the claim heartbeat fires during a write, finds the lease gone, does not renew, and the loop ends displaced', async () => {
    const { runId, initial, tid } = approvedRun(2);
    const lease = bTakesLease(tid);
    const inner = memory(initial);
    // A writer that reports its own sends and never calls `onSend`: no `markSent`, so the heartbeat
    // is the only renewal of the claim, and the write lasts several beats.
    const writer: TargetWriter = {
      reportsSend: true,
      read: (k) => inner.writer.read(k, null),
      async write(k, a) { await sleep(60); return inner.writer.write(k, a); },
    };
    let claimedAt = 0;
    const h = hooked(ledB, {
      claimTarget: (args) => { claimedAt = args[2] as number; },
      renewClaim: once(() => { aTakesOver(tid); }),
    });
    expect((await runB(runId, writer, h.ledger, lease, { claimHeartbeatMs: 5 })).status).toBe('displaced');
    expect(h.calls.get('renewClaim')).toBeGreaterThanOrEqual(1);
    // Still the time of B's claim: no renewal landed after the takeover, and nothing was recorded.
    expect(target(runId, 0).claimed_at).toBe(new Date(claimedAt).toISOString());
    expect(target(runId, 0).applied_at).toBeNull();
    // The heartbeat's lost lease ends the loop once the write returns: no record is even tried.
    expect(h.calls.get('recordApplied')).toBeUndefined();
  });

  it('recordApplied: a loop displaced while its write ran records nothing of it (the one write in flight lands)', async () => {
    const { runId, initial, tid } = approvedRun(2);
    const lease = bTakesLease(tid);
    const m = memory(initial);
    const h = hooked(ledB, { recordApplied: once(() => { aTakesOver(tid); }) });
    expect((await runB(runId, m.writer, h.ledger, lease)).status).toBe('displaced');
    expect(m.writes).toEqual(['k000']);
    expect(target(runId, 0).applied_at).toBeNull();
    expect(runRow(runId).targets_applied).toBe(0);
  });

  it('recordFailed: a loop displaced at a failed write records no failure', async () => {
    const { runId, initial, tid } = approvedRun(2);
    const lease = bTakesLease(tid);
    const m = memory(initial, { fail: new Set(['k000']) });
    const h = hooked(ledB, { recordFailed: once(() => { aTakesOver(tid); }) });
    expect((await runB(runId, m.writer, h.ledger, lease)).status).toBe('displaced');
    expect(target(runId, 0).error).toBeNull();
    expect(runRow(runId).targets_failed).toBe(0);
  });

  it('markRefused: a loop displaced at a local write that threw books no answer to its send', async () => {
    const { runId, initial, tid } = approvedRun(2);
    const lease = bTakesLease(tid);
    const m = memory(initial, { fail: new Set(['k000']) });
    const h = hooked(ledB, { markRefused: once(() => { aTakesOver(tid); }) });
    expect((await runB(runId, m.writer, h.ledger, lease)).status).toBe('displaced');
    // The send stays counted as one without a clear answer.
    expect(target(runId, 0).unknown_sends).toBe(1);
  });

  it('releaseClaim: a loop displaced at a writer halt gives no claim back and halts nothing', async () => {
    const { runId, initial, tid } = approvedRun(2);
    const lease = bTakesLease(tid);
    const m = memory(initial, { halt: new Set(['k000']) });
    const h = hooked(ledB, { releaseClaim: once(() => { aTakesOver(tid); }) });
    expect((await runB(runId, m.writer, h.ledger, lease)).status).toBe('displaced');
    expect(target(runId, 0).claimed_at).not.toBeNull();
    expect(runRow(runId).halt_reason).toBeNull();
  });

  it('halt: a loop displaced at an entry halt (window expired) halts nothing', async () => {
    const { runId, initial, tid } = approvedRun(2, { now: Date.now() - 10 * 24 * 60 * 60_000 });
    const lease = bTakesLease(tid);
    const m = memory(initial);
    const h = hooked(ledB, { halt: once(() => { aTakesOver(tid); }) });
    expect((await runB(runId, m.writer, h.ledger, lease)).status).toBe('displaced');
    expect(runRow(runId).halt_reason).toBeNull();
  });

  it('haltIfWriting: a loop displaced after another loop took its target halts nothing', async () => {
    const { runId, initial, tid } = approvedRun(2);
    const lease = bTakesLease(tid);
    const m = memory(initial, { markup: new Set(['k000']) });
    const h = hooked(ledB, {
      // Another loop holds the target now (its own claim), so the record misses on the claim…
      recordApplied: once(() => { engA.getDb().prepare('UPDATE bulk_targets SET claimed_at = ? WHERE run_id = ? AND seq = 0').run('2000-01-01T00:00:00.000Z', runId); }),
      // …and the halt for the markup is taken after the lease went.
      haltIfWriting: once(() => { aTakesOver(tid); }),
    });
    expect((await runB(runId, m.writer, h.ledger, lease)).status).toBe('displaced');
    expect(h.calls.get('haltIfWriting')).toBe(1);
    expect(runRow(runId).halt_reason).toBeNull();
  });

  it('finish: a loop displaced at the run\'s end leaves it writing', async () => {
    const { runId, initial, tid } = approvedRun(1);
    const lease = bTakesLease(tid);
    const m = memory(initial);
    const h = hooked(ledB, { finish: once(() => { aTakesOver(tid); }) });
    expect((await runB(runId, m.writer, h.ledger, lease)).status).toBe('displaced');
    expect(runRow(runId).phase).toBe('writing');
    expect(target(runId, 0).applied_at).not.toBeNull();
  });

  it('recordUnrecordedSettled: a rollback displaced at its first record settles nothing and restores nothing', async () => {
    const { runId, initial, tid } = approvedRun(2, { atomic: true });
    const lease = bTakesLease(tid);
    const m = memory(initial, { fail: new Set(['k001']) });
    const h = hooked(ledB, { recordUnrecordedSettled: once(() => { aTakesOver(tid); }) });
    expect((await runB(runId, m.writer, h.ledger, lease)).status).toBe('displaced');
    expect(target(runId, 1).undone_at).toBeNull();
    // k000 is still written: the displaced rollback restored nothing.
    expect(m.state.get('k000')).toBe('w0');
    expect(runRow(runId).phase).toBe('writing');
  });

  it('recordRolledBack: a rollback displaced at a restored target records it not taken back and does not end the run', async () => {
    const { runId, initial, tid } = approvedRun(2, { atomic: true });
    const lease = bTakesLease(tid);
    const m = memory(initial, { fail: new Set(['k001']) });
    const h = hooked(ledB, { recordRolledBack: once(() => { aTakesOver(tid); }) });
    expect((await runB(runId, m.writer, h.ledger, lease)).status).toBe('displaced');
    // The restore in flight landed (the named rest); its record did not.
    expect(m.state.get('k000')).toBe('v0');
    expect(target(runId, 0).undone_at).toBeNull();
    expect(runRow(runId).phase).toBe('writing');
  });

  it('a rollback displaced between its read and its restore sends no restore: the holder\'s value stands', async () => {
    const { runId, initial, tid } = approvedRun(2, { atomic: true });
    const lease = bTakesLease(tid);
    const m = memory(initial, { fail: new Set(['k001']) });
    let k000Reads = 0;
    const writer: TargetWriter = {
      async read(k, f) {
        const cur = await m.writer.read(k, f);
        // The rollback's read of k000 (its second): right after it, A takes the lease over and writes the target.
        if (k === 'k000' && ++k000Reads === 2) { aTakesOver(tid); m.state.set('k000', 'a0'); }
        return cur;
      },
      write: (k, a) => m.writer.write(k, a),
    };
    expect((await runB(runId, writer, ledB, lease)).status).toBe('displaced');
    expect(k000Reads).toBe(2);
    // The run's two sends, and no restore of k000.
    expect(m.writes).toEqual(['k000', 'k001']);
    expect(m.state.get('k000')).toBe('a0');
    expect(target(runId, 0).undone_at).toBeNull();
    expect(runRow(runId).phase).toBe('writing');
  });

  it('setPhase at a rollback\'s end: a rollback displaced there does not end the run aborted', async () => {
    const { runId, initial, tid } = approvedRun(2, { atomic: true });
    const lease = bTakesLease(tid);
    const m = memory(initial, { fail: new Set(['k001']) });
    const h = hooked(ledB, { setPhase: once((args) => (args[2] === 'aborted' ? (aTakesOver(tid), true) : false)) });
    expect((await runB(runId, m.writer, h.ledger, lease)).status).toBe('displaced');
    expect(runRow(runId)).toMatchObject({ phase: 'writing', halt_reason: null });
    expect(target(runId, 0).undone_at).not.toBeNull();
  });
});

describe('an end a displaced loop only READ is not reported', () => {
  it('another loop ended the run: the displaced loop ends displaced, not done', async () => {
    const { runId, initial, tid } = approvedRun(2);
    const lease = bTakesLease(tid);
    const m = memory(initial);
    let tops = 0;
    const h = hooked(ledB, {
      getRunForApply: () => {
        // The read at the top of the second target: by then A has the lease and closed the run.
        if (++tops !== 3) return;
        const leaseA = aTakesOver(tid);
        const run = ledA.getRunForApply(runId)!;
        expect(ledA.claimTarget(runId, 1, Date.now(), leaseA)).toBe(true);
        expect(ledA.recordApplied(run, 1, 'ok', Date.now(), null, null, false, false, null, leaseA)).toBe(true);
        expect(ledA.finish(run, leaseA)).toBe(true);
      },
    });
    expect((await runB(runId, m.writer, h.ledger, lease)).status).toBe('displaced');
    expect(runRow(runId).phase).toBe('done');
  });

  it('another loop halted the run: the displaced loop ends displaced, not halted', async () => {
    const { runId, initial, tid } = approvedRun(2);
    const lease = bTakesLease(tid);
    const m = memory(initial);
    let tops = 0;
    const h = hooked(ledB, {
      getRunForApply: () => {
        if (++tops !== 3) return;
        const leaseA = aTakesOver(tid);
        expect(ledA.halt(runId, BULK_HALT_REASONS.timeBudget, leaseA)).toBe(true);
      },
    });
    expect((await runB(runId, m.writer, h.ledger, lease)).status).toBe('displaced');
    expect(runRow(runId).halt_reason).toBe(BULK_HALT_REASONS.timeBudget);
  });

  it('control: a loop that still holds its lease reports a halt it read as the other loop\'s', async () => {
    const { runId, initial, tid } = approvedRun(2);
    const lease = bTakesLease(tid);
    const m = memory(initial);
    let tops = 0;
    const h = hooked(ledB, {
      getRunForApply: () => {
        if (++tops !== 3) return;
        // A loop without the fence (an older engine) halts the run; B keeps its lease.
        ledA.halt(runId, BULK_HALT_REASONS.timeBudget);
      },
    });
    const out = await runB(runId, m.writer, h.ledger, lease);
    expect(out.status).toBe('halted');
  });
});

describe('the fence is keyed on the trigger the loop EXECUTES', () => {
  it('an undo writes the source run\'s rows under its own trigger, whoever holds the source\'s', async () => {
    const { runId, initial } = approvedRun(2);
    const m = memory(initial);
    expect((await runB(runId, m.writer, ledB, null)).status).toBe('done');
    // The source's trigger is held by someone else: an undo keyed on it would be fenced out.
    engA.getDb().prepare('UPDATE triggers SET lease_holder = ?, lease_until = ? WHERE id = ?').run('X', FUTURE(), `bulk-${runId}`);
    const undo = ledA.planUndo(runId);
    if (!undo.ok) throw new Error(undo.reason);
    const approved = ledA.approve(undo.status.id, { checksum: ledA.computeChecksum(undo.status.id)! });
    if (!approved.ok) throw new Error(approved.reason);
    const lease = bTakesLease(approved.triggerId);
    expect((await runB(undo.status.id, m.writer, ledB, lease, { effect: 'bulk_undo' })).status).toBe('done');
    expect(runRow(runId).phase).toBe('undone');
    expect(target(runId, 0).undone_at).not.toBeNull();
    expect(m.state.get('k000')).toBe('v0');
  });

  it('a loop runs under the trigger it was given, not one it derives from the run', async () => {
    const { runId, initial, tid } = approvedRun(2);
    // The run's own trigger is held by someone else; the loop executes another trigger, which it holds.
    engA.getDb().prepare('UPDATE triggers SET lease_holder = ?, lease_until = ? WHERE id = ?').run('X', FUTURE(), tid);
    const other = trigB.armBulkEffect({ runId: 'exec-other', effect: 'bulk_apply', title: 'x', nextRunAt: NOW() });
    expect(trigB.claimLease(other, 'B', FUTURE(), NOW())).toBe('claimed');
    const m = memory(initial);
    expect((await runB(runId, m.writer, ledB, { triggerId: other, holder: 'B' })).status).toBe('done');
    expect(runRow(runId).phase).toBe('done');
  });
});

describe('one loop whose lease lapsed with nobody taking over: as before', () => {
  it('writes every target, ends done, and every record lands', async () => {
    const { runId, initial, tid } = approvedRun(3);
    const lease = bTakesLease(tid);
    // Lapsed long ago; no other process claimed it.
    engA.getDb().prepare('UPDATE triggers SET lease_until = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', tid);
    const m = memory(initial);
    expect((await runB(runId, m.writer, ledB, lease)).status).toBe('done');
    expect(runRow(runId)).toMatchObject({ phase: 'done', targets_applied: 3, halt_reason: null });
    expect([...m.state.values()]).toEqual(['w0', 'w1', 'w2']);
  });

  it('an atomic run that fails rolls back and ends aborted', async () => {
    const { runId, initial, tid } = approvedRun(3, { atomic: true });
    const lease = bTakesLease(tid);
    engA.getDb().prepare('UPDATE triggers SET lease_until = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', tid);
    const m = memory(initial, { fail: new Set(['k002']) });
    expect((await runB(runId, m.writer, ledB, lease)).status).toBe('aborted');
    expect(runRow(runId)).toMatchObject({ phase: 'aborted', halt_reason: BULK_HALT_REASONS.atomicRolledBack });
    expect([...m.state.values()]).toEqual(['v0', 'v1', 'v2']);
  });
});

describe('the owner\'s stop as a mark in the ledger', () => {
  it('a stop recorded through another connection (no loop there) stops the loop between two targets: halted where it stood', async () => {
    const { runId, initial, tid } = approvedRun(3);
    const lease = bTakesLease(tid);
    const m = memory(initial);
    const writer: TargetWriter = { read: (k) => m.writer.read(k, null), async write(k, a) { const r = await m.writer.write(k, a); if (k === 'k000') expect(ledA.requestStop(runId)).toBe(true); return r; } };
    const out = await runB(runId, writer, ledB, lease);
    expect(out.status).toBe('stopped');
    expect(runRow(runId)).toMatchObject({ halt_reason: BULK_HALT_REASONS.stoppedByOwner, targets_applied: 1 });
    expect(m.writes).toEqual(['k000']);
  });

  it('an atomic run stopped between two targets rolls back what it wrote and ends aborted', async () => {
    const { runId, initial, tid } = approvedRun(3, { atomic: true });
    const lease = bTakesLease(tid);
    const m = memory(initial);
    const writer: TargetWriter = { read: (k) => m.writer.read(k, null), async write(k, a) { const r = await m.writer.write(k, a); if (k === 'k001') ledA.requestStop(runId); return r; } };
    const out = await runB(runId, writer, ledB, lease);
    expect(out.status).toBe('stopped');
    expect(runRow(runId)).toMatchObject({ phase: 'aborted', halt_reason: BULK_HALT_REASONS.atomicStoppedRolledBack });
    expect([...m.state.values()]).toEqual(['v0', 'v1', 'v2']);
  });

  it('an undo stopped between two targets is halted where it stood', async () => {
    const { runId, initial } = approvedRun(3);
    const m = memory(initial);
    expect((await runB(runId, m.writer, ledB, null)).status).toBe('done');
    const undo = ledA.planUndo(runId);
    if (!undo.ok) throw new Error(undo.reason);
    const approved = ledA.approve(undo.status.id, { checksum: ledA.computeChecksum(undo.status.id)! });
    if (!approved.ok) throw new Error(approved.reason);
    const lease = bTakesLease(approved.triggerId);
    let n = 0;
    const writer: TargetWriter = { read: (k) => m.writer.read(k, null), async write(k, a) { const r = await m.writer.write(k, a); if (++n === 1) ledA.requestStop(undo.status.id); return r; } };
    expect((await runB(undo.status.id, writer, ledB, lease, { effect: 'bulk_undo' })).status).toBe('stopped');
    expect(runRow(undo.status.id)).toMatchObject({ halt_reason: BULK_HALT_REASONS.stoppedByOwner, targets_applied: 1 });
  });

  it('a stop on an approved run, before its first target: the run writes nothing and is halted; an atomic one is halted too, not rolled back', async () => {
    for (const atomic of [false, true]) {
      const { runId, initial, tid } = approvedRun(2, { atomic });
      expect(ledA.requestStop(runId)).toBe(true);
      const lease = bTakesLease(tid);
      const m = memory(initial);
      expect((await runB(runId, m.writer, ledB, lease)).status).toBe('stopped');
      expect(m.writes).toEqual([]);
      expect(runRow(runId)).toMatchObject({ phase: 'writing', halt_reason: BULK_HALT_REASONS.stoppedByOwner });
    }
  });

  it('a stop during the last target\'s write comes too late: the run ends done, as before', async () => {
    const { runId, initial, tid } = approvedRun(2);
    const lease = bTakesLease(tid);
    const m = memory(initial);
    const writer: TargetWriter = { read: (k) => m.writer.read(k, null), async write(k, a) { const r = await m.writer.write(k, a); if (k === 'k001') ledA.requestStop(runId); return r; } };
    expect((await runB(runId, writer, ledB, lease)).status).toBe('done');
    expect(runRow(runId).phase).toBe('done');
  });

  it('after the last target, with targets another loop holds: the stop is read and the run is halted, not left pending', async () => {
    const { runId, initial, tid } = approvedRun(3);
    const lease = bTakesLease(tid);
    // Target 2 is held by another loop (a fresh claim).
    engA.getDb().prepare('UPDATE bulk_targets SET claimed_at = ? WHERE run_id = ? AND seq = 2').run(new Date(Date.now() + 60_000).toISOString(), runId);
    const m = memory(initial);
    const writer: TargetWriter = { read: (k) => m.writer.read(k, null), async write(k, a) { const r = await m.writer.write(k, a); if (k === 'k001') ledA.requestStop(runId); return r; } };
    expect((await runB(runId, writer, ledB, lease)).status).toBe('stopped');
    expect(runRow(runId).halt_reason).toBe(BULK_HALT_REASONS.stoppedByOwner);
  });

  it('a stop is recorded only on a run approved or writing, unhalted and not stopped already', async () => {
    const { runId } = approvedRun(2);
    // Approved (not yet writing): taken.
    expect(ledA.requestStop(runId)).toBe(true);
    expect(runRow(runId).stop_requested_at).not.toBeNull();
    // Stopped already: not again.
    expect(ledA.requestStop(runId)).toBe(false);
    const halted = approvedRun(2).runId;
    ledA.halt(halted, BULK_HALT_REASONS.timeBudget);
    expect(ledA.requestStop(halted)).toBe(false);
    expect(ledA.isStopRequested(halted)).toBe(false);
    const planned = ledA.recordDryRun({ createdBy: 't', principal: OWNER_PRINCIPAL, targetSystem: 'workspace', scope: 'mem', targets: [{ key: 'x', before: { absent: true }, after: 'y' }] });
    expect(ledA.requestStop(planned.id)).toBe(false);
    expect(ledA.isStopRequested(planned.id)).toBe(false);
    // Ended: done (no halt reason) and aborted.
    const done = approvedRun(1);
    expect((await runB(done.runId, memory(done.initial).writer, ledB, null)).status).toBe('done');
    expect(runRow(done.runId)).toMatchObject({ phase: 'done', halt_reason: null });
    expect(ledA.requestStop(done.runId)).toBe(false);
    expect(ledA.isStopRequested(done.runId)).toBe(false);
    const aborted = approvedRun(2, { atomic: true });
    expect((await runB(aborted.runId, memory(aborted.initial, { fail: new Set(['k001']) }).writer, ledB, null)).status).toBe('aborted');
    expect(runRow(aborted.runId).phase).toBe('aborted');
    expect(ledA.requestStop(aborted.runId)).toBe(false);
    expect(ledA.isStopRequested(aborted.runId)).toBe(false);
  });

  it('a stop with `arm` makes the run\'s trigger due now', () => {
    const { runId, tid } = approvedRun(2);
    engA.getDb().prepare(`UPDATE triggers SET status = 'completed', next_run_at = NULL WHERE id = ?`).run(tid);
    expect(trigA.getDue().map((t) => t.id)).not.toContain(tid);
    expect(ledA.requestStop(runId, { arm: true })).toBe(true);
    expect(trigA.getDue().map((t) => t.id)).toContain(tid);
  });

  it('a resume clears the mark with the halt, and the resumed run writes to its end', async () => {
    const { runId, initial, tid } = approvedRun(2);
    ledA.requestStop(runId);
    const lease = bTakesLease(tid);
    const m = memory(initial);
    expect((await runB(runId, m.writer, ledB, lease)).status).toBe('stopped');
    const resumed = ledA.resume(runId, { checksum: ledA.computeChecksum(runId)! });
    if (!resumed.ok) throw new Error(resumed.reason);
    expect(runRow(runId)).toMatchObject({ halt_reason: null, stop_requested_at: null });
    expect((await runB(runId, m.writer, ledB, lease)).status).toBe('done');
    expect([...m.state.values()]).toEqual(['w0', 'w1']);
  });

  it('a stop mark, then an expired window: the run halts as expired, an atomic one is not rolled back, and a resume clears the mark', async () => {
    const { runId, initial, tid } = approvedRun(3, { atomic: true });
    const m = memory(initial);
    // An earlier pass wrote target 0; then the stop and the window's end, before the next tick.
    const run = ledA.getRunForApply(runId)!;
    ledA.setPhase(runId, ['approved'], 'writing');
    expect(ledA.claimTarget(runId, 0)).toBe(true);
    m.state.set('k000', 'w0');
    expect(ledA.recordApplied(run, 0, 'ok')).toBe(true);
    expect(ledA.requestStop(runId)).toBe(true);
    engA.getDb().prepare('UPDATE bulk_runs SET expires_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', runId);
    const lease = bTakesLease(tid);
    // The entry checks run in their order: the window before the stop.
    expect((await runB(runId, m.writer, ledB, lease)).status).toBe('refused');
    expect(runRow(runId)).toMatchObject({ halt_reason: BULK_HALT_REASONS.expired, phase: 'writing' });
    expect(m.state.get('k000')).toBe('w0');
    expect(m.writes).toEqual([]);
    const resumed = ledA.resume(runId, { checksum: ledA.computeChecksum(runId)! });
    if (!resumed.ok) throw new Error(resumed.reason);
    expect(runRow(runId)).toMatchObject({ halt_reason: null, stop_requested_at: null });
  });

  it('a stop mark, then a checksum that no longer matches: the run halts on the checksum and nothing is rolled back', async () => {
    const { runId, initial, tid } = approvedRun(2, { atomic: true });
    ledA.requestStop(runId);
    engA.getDb().prepare('UPDATE bulk_runs SET approval_checksum = ? WHERE id = ?').run('not-the-checksum', runId);
    const lease = bTakesLease(tid);
    const m = memory(initial);
    expect((await runB(runId, m.writer, ledB, lease)).status).toBe('refused');
    expect(runRow(runId)).toMatchObject({ halt_reason: BULK_HALT_REASONS.checksum, phase: 'approved' });
    expect(runRow(runId).stop_requested_at).not.toBeNull();
    expect(m.writes).toEqual([]);
  });

  it('a stop mark on a run a loop then halted for another reason: the halt stands, and the resume clears the mark', async () => {
    const { runId, initial, tid } = approvedRun(4);
    const lease = bTakesLease(tid);
    const m = memory(initial, { fail: new Set(['k000']) });
    // The stop arrives while the failing write runs; the failure's halt comes before the next read of the stop.
    const writer: TargetWriter = { read: (k) => m.writer.read(k, null), async write(k, a) { if (k === 'k000') expect(ledA.requestStop(runId)).toBe(true); return m.writer.write(k, a); } };
    expect((await runB(runId, writer, ledB, lease)).status).toBe('halted');
    expect(runRow(runId).halt_reason).toBe(BULK_HALT_REASONS.failureRate);
    expect(runRow(runId).stop_requested_at).not.toBeNull();
    const resumed = ledA.resume(runId, { checksum: ledA.computeChecksum(runId)! });
    if (!resumed.ok) throw new Error(resumed.reason);
    expect(runRow(runId).stop_requested_at).toBeNull();
  });
});
