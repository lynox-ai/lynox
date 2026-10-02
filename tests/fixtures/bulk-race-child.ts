/**
 * One side of the forced bulk race (`src/core/bulk-undo-race.test.ts`): a separate engine
 * process that approves or resumes one bulk run on a shared engine.db. With `pause`, it stops
 * right after the ledger's family check and waits for a gate file — so the other process acts
 * inside exactly the window between the check and this one's write.
 *
 *   tsx tests/fixtures/bulk-race-child.ts <engine.db> <approve|resume> <runId> <gateDir> <pause|go>
 *
 * Prints one JSON line: the ledger's answer, or `{ "error": "<message>" }` if it threw.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EngineDb } from '../../src/core/engine-db.js';
import { BulkLedger } from '../../src/core/bulk-ledger.js';

const [dbPath, action, runId, gateDir, mode] = process.argv.slice(2) as [string, string, string, string, string];
const engineDb = new EngineDb(dbPath, 'test-vault-key');
const ledger = new BulkLedger(engineDb);

if (mode === 'pause') {
  const proto = BulkLedger.prototype as unknown as { writeBlocked: (run: unknown) => unknown };
  const original = proto.writeBlocked;
  const tick = new Int32Array(new SharedArrayBuffer(4));
  proto.writeBlocked = function (this: unknown, run: unknown): unknown {
    const verdict = original.call(this, run);
    writeFileSync(join(gateDir, 'checked'), '');
    const until = Date.now() + 20_000;
    while (!existsSync(join(gateDir, 'go'))) {
      if (Date.now() > until) throw new Error('gate never opened');
      Atomics.wait(tick, 0, 0, 10);
    }
    return verdict;
  };
}

writeFileSync(join(gateDir, `${action}-started`), '');
try {
  const checksum = ledger.computeChecksum(runId)!;
  const out = action === 'approve'
    ? ledger.approve(runId, { checksum })
    : ledger.resume(runId, { checksum, maxTargets: 4 });
  process.stdout.write(`${JSON.stringify(out.ok ? { ok: true } : { ok: false, reason: out.reason })}\n`);
} catch (err) {
  process.stdout.write(`${JSON.stringify({ error: err instanceof Error ? err.message : String(err) })}\n`);
} finally {
  engineDb.close();
}
