import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { EngineDb } from './engine-db.js';
import { BulkLedger, type PlannedTarget } from './bulk-ledger.js';
import { runBulkEffect, type TargetWriter } from './bulk-apply.js';

/**
 * A run and an undo of it must never both be armed to write. The unit tests show each
 * refusal in turn; this one forces the race they cannot: two engine processes on one
 * engine.db, one approving or resuming and stopped right after its check, the other acting
 * inside that window. Whatever the order, at most one of the family may write afterwards.
 */

vi.setConfig({ testTimeout: 60_000 });

const CHILD = join(import.meta.dirname, '..', '..', 'tests', 'fixtures', 'bulk-race-child.ts');

let dir: string;
let engineDb: EngineDb;
let ledger: BulkLedger;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'lynox-bulk-race-')));
  engineDb = new EngineDb(join(dir, 'engine.db'), 'test-vault-key');
  ledger = new BulkLedger(engineDb);
});

afterEach(() => {
  engineDb.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Four in-memory targets, halted after two; and a previewed undo of those two. */
async function haltedRunWithUndo(): Promise<{ runId: string; undoId: string }> {
  const targets: PlannedTarget[] = [];
  const state = new Map<string, string>();
  for (let i = 0; i < 4; i++) {
    targets.push({ key: `k${String(i)}`, before: { absent: false, value: `v${String(i)}` }, after: `w${String(i)}` });
    state.set(`k${String(i)}`, `v${String(i)}`);
  }
  const runId = ledger.recordDryRun({ createdBy: 't', targetSystem: 'workspace', scope: 'mem', targets }).id;
  const approved = ledger.approve(runId, { checksum: ledger.computeChecksum(runId)!, maxTargets: 2 });
  if (!approved.ok) throw new Error(approved.reason);
  const writer: TargetWriter = {
    read: async (k) => ({ absent: false, value: state.get(k)! }),
    write: async (k, a) => { state.set(k, a.absent ? '' : String(a.value)); return 'ok'; },
  };
  expect((await runBulkEffect(runId, 'bulk_apply', { ledger, writerFor: () => writer })).status).toBe('halted');
  const undo = ledger.planUndo(runId);
  if (!undo.ok) throw new Error(undo.reason);
  return { runId, undoId: undo.status.id };
}

type Answer = { ok: true } | { ok: false; reason: string } | { error: string };

function child(action: 'approve' | 'resume', runId: string, gate: string, mode: 'pause' | 'go'): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--import', 'tsx', CHILD, join(dir, 'engine.db'), action, runId, gate, mode], {
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    });
    let out = '';
    let err = '';
    p.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    p.stderr.on('data', (d: Buffer) => { err += d.toString(); });
    p.on('error', reject);
    p.on('close', () => {
      const line = out.trim().split('\n').pop() ?? '';
      try { resolve(JSON.parse(line) as Answer); } catch { reject(new Error(`no answer from ${action}: ${out} ${err}`)); }
    });
  });
}

async function until(path: string, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (!existsSync(path)) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${path}`);
    await sleep(20);
  }
}

/** Runs of the family that may write: approved or writing, not halted. */
function armed(runId: string, undoId: string): string[] {
  return (engineDb.getDb().prepare(
    `SELECT id FROM bulk_runs WHERE id IN (?, ?) AND phase IN ('approved','writing') AND halt_reason IS NULL ORDER BY id`,
  ).all(runId, undoId) as { id: string }[]).map((r) => r.id);
}

describe('a run and its undo, raced from two engine processes', () => {
  for (const paused of ['approve', 'resume'] as const) {
    it(`at most one is armed when the ${paused === 'approve' ? 'undo\'s approval' : 'run\'s resume'} is held between check and write`, async () => {
      const { runId, undoId } = await haltedRunWithUndo();
      const gate = join(dir, `gate-${paused}`);
      mkdirSync(gate);
      const other = paused === 'approve' ? 'resume' : 'approve';
      const idOf = (a: 'approve' | 'resume'): string => (a === 'approve' ? undoId : runId);

      const first = child(paused, idOf(paused), gate, 'pause');
      await until(join(gate, 'checked'));
      const second = child(other, idOf(other), gate, 'go');
      await until(join(gate, `${other}-started`));
      // The second is now inside its own call (it writes the file right before it). Give it
      // ample time to reach the lock or the write: if it reached neither before the gate opens,
      // the first commits first and the test proves nothing — it would pass for any code.
      await sleep(1500);
      writeFileSync(join(gate, 'go'), '');
      const [a, b] = await Promise.all([first, second]);

      // The invariant, read from the database both processes wrote.
      expect(armed(runId, undoId).length).toBeLessThanOrEqual(1);
      // And both answered as the product does — a refusal, never a lock error.
      expect([a, b].filter((x) => 'error' in x)).toEqual([]);
      expect([a, b].filter((x) => 'ok' in x && x.ok).length).toBe(1);
      expect(a).toEqual({ ok: true });
      expect(b).toEqual({ ok: false, reason: other === 'resume' ? 'undo_open' : 'source_running' });
    });
  }
});
