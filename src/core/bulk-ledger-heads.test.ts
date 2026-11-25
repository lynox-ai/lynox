import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngineDb } from './engine-db.js';
import { BulkLedger, BULK_CLAIM_STALE_MS, BULK_HEADS, type BulkHead } from './bulk-ledger.js';

/**
 * The head counts of a run's status: every target in exactly one class, in rank order. Each row
 * here is a target as the ledger leaves it; the rows that belong to two classes at once decide
 * the order between those two.
 */

let dir: string;
let engineDb: EngineDb;
let ledger: BulkLedger;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'lynox-bulk-heads-')));
  engineDb = new EngineDb(join(dir, 'engine.db'), 'test-vault-key');
  ledger = new BulkLedger(engineDb, null);
});

afterEach(() => {
  engineDb.close();
  rmSync(dir, { recursive: true, force: true });
});

const AT = '2026-11-19T00:00:00.000Z';
/** A status read while a claim made at {@link AT} is still live. */
const LIVE = Date.parse(AT) + 1_000;

interface Row {
  change?: 'update' | 'create' | 'delete' | 'unchanged' | 'invalid';
  deselected?: boolean;
  applied?: boolean;
  undone?: boolean;
  error?: string;
  unknownSends?: number;
  claimed?: boolean;
  /** The run sent its write (`write_sent`). */
  sent?: boolean;
  /** Failed in at least one pass (`failed_once`). */
  failedOnce?: boolean;
  /** Found already holding its planned value (`found_unsent`). */
  found?: boolean;
}

/** A run of the given targets, its counters as the rows say. */
function run(targetSystem: string, rows: Row[]): string {
  const id = `run-${targetSystem}-${String(rows.length)}-${String(Math.random()).slice(2)}`;
  const db = engineDb.getDb();
  db.prepare(`INSERT INTO bulk_runs (id, rule_hash, target_system, undo, phase, targets_total, targets_applied)
    VALUES (?, 'fixture', ?, 'restorable', 'aborted', ?, ?)`).run(id, targetSystem, rows.length, rows.filter((r) => r.applied).length);
  rows.forEach((r, seq) => {
    db.prepare(`INSERT INTO bulk_targets (run_id, seq, target_key, change, deselected_at, applied_at, undone_at, error, unknown_sends, claimed_at, write_sent, failed_once, found_unsent)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, seq, engineDb.enc(`k${String(seq)}`), r.change ?? 'update', r.deselected ? AT : null, r.applied ? AT : null,
      r.undone ? AT : null, r.error ?? null, r.unknownSends ?? 0, r.claimed ? AT : null, r.sent ? 1 : 0, r.failedOnce ? 1 : 0, r.found ? 1 : 0,
    );
  });
  return id;
}

/** The one class each single target of `rows` lands in, read at `now`. */
function classes(targetSystem: string, rows: Row[], now?: number): BulkHead[] {
  return rows.map((r) => {
    const heads = ledger.getStatus(run(targetSystem, [r]), now)!.heads;
    const hit = BULK_HEADS.filter((h) => heads[h] === 1);
    expect(hit, JSON.stringify(r)).toHaveLength(1);
    return hit[0]!;
  });
}

const EXTERNAL = 'http:shop.example.com';
const LOCAL = 'workspace';

describe('the head counts of a run', () => {
  it('puts a target in each class', () => {
    expect(classes(EXTERNAL, [
      { deselected: true },
      { change: 'invalid', error: 'redirect' },
      { change: 'unchanged' },
      { applied: true, undone: true },
      { applied: true },
      { undone: true },
      { error: 'conflict' },
      { unknownSends: 1 },
      { error: 'write_failed' },
      {},
    ])).toEqual(BULK_HEADS);
  });

  it('a created and a deleted target count like an updated one', () => {
    expect(classes(LOCAL, [{ change: 'create', applied: true }, { change: 'delete', error: 'write_failed' }, { change: 'create' }]))
      .toEqual(['written', 'failed', 'open']);
  });

  it('a target in two classes counts in the higher one', () => {
    expect(classes(EXTERNAL, [
      // A target its write landed on and a second loop found in conflict.
      { applied: true, error: 'conflict' },
      // Taken back and in conflict: the undo took it back.
      { applied: true, undone: true, error: 'conflict' },
      // A send that got no clear answer and then a conflict.
      { error: 'conflict', unknownSends: 1 },
      // A timeout before a resume: its failure and the unclear send both stand.
      { error: 'write_failed', unknownSends: 1 },
      // Taken back by an external undo after a send that failed: the old value is back.
      { error: 'write_failed', undone: true },
      { error: 'conflict', undone: true },
      // An invalid target keeps its plan-time reason in the error column.
      { change: 'invalid', error: 'conflict' },
      // A target written and with an unclear earlier send.
      { applied: true, unknownSends: 1 },
      // Two the ledger does not reach today (only a writing target is taken out or written); the
      // rank decides them if it ever does.
      { deselected: true, change: 'invalid', error: 'redirect' },
      { change: 'unchanged', applied: true, undone: true },
    ])).toEqual(['written', 'takenBack', 'conflict', 'unclear', 'settled', 'settled', 'invalid', 'written', 'deselected', 'unchanged']);
  });

  it('a target taken back counts so whether or not the error of its failed send still stands', () => {
    // The same state reached two ways: right after the undo the source's send error stands; a
    // resume before the undo would have cleared it. Both hold the old value.
    for (const system of [EXTERNAL, LOCAL]) {
      expect(classes(system, [{ sent: true, error: 'write_failed', undone: true }, { sent: true, undone: true }, { sent: true, error: 'write_failed', unknownSends: 1, undone: true }]))
        .toEqual(['settled', 'settled', 'settled']);
    }
  });

  it('an unclear send counts so on an external run only; a local one with a failure is failed', () => {
    expect(classes(LOCAL, [{ error: 'write_failed', unknownSends: 1 }, { unknownSends: 1 }])).toEqual(['failed', 'open']);
    expect(classes(EXTERNAL, [{ error: 'write_failed', unknownSends: 1 }, { unknownSends: 1 }])).toEqual(['unclear', 'unclear']);
  });

  it('a target found already holding its value and never sent to is unchanged, not written', () => {
    expect(classes(EXTERNAL, [
      { applied: true, found: true },
      // Sent to and then found so: a loop that died wrote it, so it was written.
      { applied: true, found: true, sent: true },
      { applied: true },
      // Taken back ranks first, as before.
      { applied: true, found: true, undone: true },
    ])).toEqual(['unchanged', 'written', 'written', 'takenBack']);
    expect(classes(LOCAL, [{ applied: true, found: true }])).toEqual(['unchanged']);
  });

  it('a target a live loop holds is not unclear: its answer may still come', () => {
    expect(classes(EXTERNAL, [{ unknownSends: 1, claimed: true }, { unknownSends: 1, claimed: true, error: 'write_failed' }], LIVE))
      .toEqual(['open', 'failed']);
  });

  describe('a claim a loop that died left', () => {
    const at = Date.parse(AT);
    const held: Row = { sent: true, unknownSends: 1, claimed: true };
    it('is stale past the claim bound: its target is unclear, in the head and the banner count', () => {
      const id = run(EXTERNAL, [held]);
      const s = ledger.getStatus(id, at + BULK_CLAIM_STALE_MS + 1)!;
      expect(s.heads.unclear).toBe(1);
      expect(s.heads.open).toBe(0);
      expect(s.sentUnknown).toBe(1);
    });
    it('is live up to the bound itself, as a claim is to the claim of a second loop', () => {
      const id = run(EXTERNAL, [held]);
      for (const now of [at + BULK_CLAIM_STALE_MS - 1, at + BULK_CLAIM_STALE_MS]) {
        const s = ledger.getStatus(id, now)!;
        expect(s.heads.unclear, String(now - at)).toBe(0);
        expect(s.heads.open, String(now - at)).toBe(1);
        expect(s.sentUnknown, String(now - at)).toBe(0);
        // The same bound a second loop's claim reads: it may take the target only once stale.
        expect(ledger.claimTarget(id, 0, now), String(now - at)).toBe(false);
      }
      expect(ledger.claimTarget(id, 0, at + BULK_CLAIM_STALE_MS + 1)).toBe(true);
    });
    it('the pass count reads the same stale bound as the head', () => {
      // A built state, not one a pass leaves (recording a failure gives the claim back): it pins
      // only that the pass count binds the bound where the head does.
      const id = run(EXTERNAL, [{ ...held, error: 'write_failed', failedOnce: true }]);
      expect(ledger.getStatus(id, LIVE)!.passUnclear).toBe(0);
      expect(ledger.getStatus(id, at + BULK_CLAIM_STALE_MS + 1)!.passUnclear).toBe(1);
    });
    it('leaves a local run without unclear targets, stale or not', () => {
      expect(classes(LOCAL, [held], at + BULK_CLAIM_STALE_MS + 1)).toEqual(['open']);
    });
  });

  it('every target of a mixed run counts once: the classes sum to the total, none negative', () => {
    const rows: Row[] = [
      { deselected: true }, { deselected: true }, { change: 'invalid', error: 'redirect' }, { change: 'unchanged' },
      { applied: true }, { applied: true, error: 'conflict' }, { applied: true, undone: true }, { error: 'conflict' },
      { error: 'write_failed', unknownSends: 1 }, { error: 'write_failed' }, { error: 'secret' }, { undone: true }, {}, {},
    ];
    const s = ledger.getStatus(run(EXTERNAL, rows))!;
    expect(s.heads).toEqual({
      deselected: 2, invalid: 1, unchanged: 1, takenBack: 1, written: 2, conflict: 1, unclear: 1, failed: 2, settled: 1, open: 2,
    });
    expect(Object.values(s.heads).reduce((a, b) => a + b, 0)).toBe(s.total);
    expect(Object.values(s.heads).every((n) => n >= 0)).toBe(true);
    // The counts beside them overlap where the heads do not.
    expect([s.failed, s.sentUnknown, s.conflicts]).toEqual([3, 1, 2]);
  });

  it('a run without targets has every class at zero', () => {
    expect(ledger.getStatus(run(LOCAL, []))!.heads).toEqual(Object.fromEntries(BULK_HEADS.map((h) => [h, 0])));
  });
});

describe('the unclear sends a halt names', () => {
  // A timeout is recorded as a failure (`write_failed`, `failed_once`) and leaves the send unclear.
  const timedOut: Row = { sent: true, unknownSends: 1, error: 'write_failed', failedOnce: true };
  const refused: Row = { sent: true, error: 'write_failed', failedOnce: true };

  it('counts a target whose send is unclear now and that this pass recorded as failed', () => {
    const s = ledger.getStatus(run(EXTERNAL, [timedOut, refused, { applied: true, failedOnce: true }]))!;
    expect(s.passUnclear).toBe(1);
    expect(s.heads.failed).toBe(1);
    expect(s.heads.unclear).toBe(1);
    // Failed once counts every target that failed in a pass, an unclear one included.
    expect(s.failedOnce).toBe(3);
  });

  it('leaves out an unclear target no failure of this pass names', () => {
    // Left unclear by an earlier pass: a resume cleared its error, or this pass only read it.
    const s = ledger.getStatus(run(EXTERNAL, [
      { sent: true, unknownSends: 1, failedOnce: true },
      { sent: true, unknownSends: 1, error: 'sent_unknown', failedOnce: true },
    ]))!;
    expect(s.passUnclear).toBe(0);
    expect(s.heads.unclear).toBe(2);
  });

  it('reads unclear off the same predicate as the head: a local run has no unclear target', () => {
    const s = ledger.getStatus(run(LOCAL, [timedOut, refused]))!;
    expect(s.heads.unclear).toBe(0);
    expect(s.passUnclear).toBe(0);
    expect(s.heads.failed).toBe(2);
  });
});

