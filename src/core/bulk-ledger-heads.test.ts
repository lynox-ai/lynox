import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngineDb } from './engine-db.js';
import { BulkLedger, BULK_HEADS, type BulkHead } from './bulk-ledger.js';

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
}

/** A run of the given targets, its counters as the rows say. */
function run(targetSystem: string, rows: Row[]): string {
  const id = `run-${targetSystem}-${String(rows.length)}-${String(Math.random()).slice(2)}`;
  const db = engineDb.getDb();
  db.prepare(`INSERT INTO bulk_runs (id, rule_hash, target_system, undo, phase, targets_total, targets_applied)
    VALUES (?, 'fixture', ?, 'restorable', 'aborted', ?, ?)`).run(id, targetSystem, rows.length, rows.filter((r) => r.applied).length);
  rows.forEach((r, seq) => {
    db.prepare(`INSERT INTO bulk_targets (run_id, seq, target_key, change, deselected_at, applied_at, undone_at, error, unknown_sends, claimed_at, write_sent)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, seq, engineDb.enc(`k${String(seq)}`), r.change ?? 'update', r.deselected ? AT : null, r.applied ? AT : null,
      r.undone ? AT : null, r.error ?? null, r.unknownSends ?? 0, r.claimed ? AT : null, r.sent ? 1 : 0,
    );
  });
  return id;
}

/** The one class each single target of `rows` lands in. */
function classes(targetSystem: string, rows: Row[]): BulkHead[] {
  return rows.map((r) => {
    const heads = ledger.getStatus(run(targetSystem, [r]))!.heads;
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

  it('a target a loop holds is not unclear: its answer may still come', () => {
    expect(classes(EXTERNAL, [{ unknownSends: 1, claimed: true }, { unknownSends: 1, claimed: true, error: 'write_failed' }]))
      .toEqual(['open', 'failed']);
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
