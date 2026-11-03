import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OWNER_PRINCIPAL } from './request-principal.js';
import { EngineDb } from './engine-db.js';
import { BulkLedger } from './bulk-ledger.js';
import { runBulkEffect, workspaceWriter } from './bulk-apply.js';
import { setTenantWorkspace, clearTenantWorkspace } from './workspace.js';
import { bulkPlanTool, bulkStatusTool } from '../tools/builtin/bulk.js';
import type { IAgent } from '../types/index.js';

/**
 * Taking a target out of a previewed run before approving it (PRD shopify-preset §20.2 item 4):
 * the ledger's one definition of a writing target leaves it out, the checksum carries the mark
 * only where there is one, and a deselect is a compare-and-set on the checksum the owner saw.
 */

let dir: string;
let ws: string;
let engineDb: EngineDb;
let ledger: BulkLedger;

function agent(): IAgent {
  return { toolContext: { bulkLedger: ledger }, currentThreadId: 'thread-1', principal: OWNER_PRINCIPAL } as unknown as IAgent;
}

async function planFiles(rows: { target: string; after: string }[], atomic = false): Promise<string> {
  writeFileSync(join(ws, 'src.json'), JSON.stringify(rows));
  const out = await bulkPlanTool.handler({ target_system: 'workspace', source_file: 'src.json', atomic }, agent());
  const m = /Bulk run ([0-9a-f-]{36})/.exec(out);
  if (!m) throw new Error(`no run id in: ${out}`);
  return m[1]!;
}

const three = [{ target: 'a.txt', after: 'new a' }, { target: 'b.txt', after: 'new b' }, { target: 'c.txt', after: 'new c' }];

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'lynox-bulk-deselect-')));
  ws = join(dir, 'workspace');
  mkdirSync(ws);
  setTenantWorkspace(ws);
  for (const f of ['a.txt', 'b.txt', 'c.txt']) writeFileSync(join(ws, f), `old ${f}`);
  engineDb = new EngineDb(join(dir, 'engine.db'), 'test-vault-key');
  ledger = new BulkLedger(engineDb);
});

afterEach(() => {
  clearTenantWorkspace();
  engineDb.close();
  rmSync(dir, { recursive: true, force: true });
});

const effectDeps = () => ({ ledger, trailFor: () => null, writerFor: () => workspaceWriter() });
const seqOf = (id: string, key: string): number => ledger.getPreview(id).find((t) => t.key.endsWith(key))!.seq;
const file = (f: string): string => readFileSync(join(ws, f), 'utf8');

describe('a deselected target', () => {
  it('is not written: a run of three with one taken out writes exactly two, and the third stays as it was', async () => {
    const id = await planFiles(three);
    const out = ledger.deselectTarget(id, seqOf(id, 'b.txt'), { checksum: ledger.computeChecksum(id)! });
    expect(out.ok).toBe(true);
    // The run's writing set is two: a cap of three is more than it holds, and the apply loop's
    // selection leaves the deselected target out before any claim is tried.
    expect(ledger.approve(id, { checksum: ledger.computeChecksum(id)!, maxTargets: 3 })).toEqual({ ok: false, reason: 'bad_max_targets' });
    expect(ledger.approve(id, { checksum: ledger.computeChecksum(id)! }).ok).toBe(true);
    expect(ledger.listPending(id)).not.toContain(seqOf(id, 'b.txt'));
    await runBulkEffect(id, 'bulk_apply', effectDeps());
    expect([file('a.txt'), file('b.txt'), file('c.txt')]).toEqual(['new a', 'old b.txt', 'new c']);
    expect(ledger.getStatus(id)!.applied).toBe(2);
  });

  it('changes the checksum, so an approval with the one seen before the deselect is refused', async () => {
    const id = await planFiles(three);
    const seen = ledger.computeChecksum(id)!;
    const out = ledger.deselectTarget(id, seqOf(id, 'b.txt'), { checksum: seen });
    expect(out).toMatchObject({ ok: true });
    expect(ledger.approve(id, { checksum: seen })).toEqual({ ok: false, reason: 'checksum' });
    expect(ledger.approve(id, { checksum: (out as { checksum: string }).checksum }).ok).toBe(true);
  });

  it('cannot be claimed for writing', async () => {
    const id = await planFiles(three);
    const b = seqOf(id, 'b.txt');
    ledger.deselectTarget(id, b, { checksum: ledger.computeChecksum(id)! });
    expect(ledger.claimTarget(id, b)).toBe(false);
    expect(ledger.claimTarget(id, seqOf(id, 'a.txt'))).toBe(true);
  });

  it('is counted on its own, not as an update, in the status and in bulk_status', async () => {
    const id = await planFiles(three);
    ledger.deselectTarget(id, seqOf(id, 'b.txt'), { checksum: ledger.computeChecksum(id)! });
    const s = ledger.getStatus(id)!;
    expect([s.changes.update, s.deselected]).toEqual([2, 1]);
    expect(await bulkStatusTool.handler({ run_id: id }, agent())).toContain('update 2, create 0, unchanged 0, invalid 0, taken out by the owner 1.');
  });

  it('is marked in the preview, and only that target, so the page can show it taken out', async () => {
    const id = await planFiles(three);
    ledger.deselectTarget(id, seqOf(id, 'b.txt'), { checksum: ledger.computeChecksum(id)! });
    expect(ledger.getPreview(id).map((t) => [t.key.slice(-5), t.deselected])).toEqual([['a.txt', false], ['b.txt', true], ['c.txt', false]]);
  });

  it('leaves every other target\'s after-state byte for byte, and arms nothing', async () => {
    const id = await planFiles(three);
    const raw = (): unknown[] => (engineDb.getDb().prepare('SELECT seq, after_planned FROM bulk_targets WHERE run_id = ? ORDER BY seq').all(id) as { seq: number; after_planned: string }[])
      .map((r) => [r.seq, engineDb.dec(r.after_planned)]);
    const before = raw();
    ledger.deselectTarget(id, seqOf(id, 'b.txt'), { checksum: ledger.computeChecksum(id)! });
    expect(raw()).toEqual(before);
    expect(ledger.getStatus(id)!.phase).toBe('previewed');
    expect(engineDb.getDb().prepare('SELECT COUNT(*) AS n FROM triggers').get()).toEqual({ n: 0 });
  });

  it('comes back with a reselect, and the run writes all three', async () => {
    const id = await planFiles(three);
    const b = seqOf(id, 'b.txt');
    const off = ledger.deselectTarget(id, b, { checksum: ledger.computeChecksum(id)! }) as { checksum: string };
    const on = ledger.reselectTarget(id, b, { checksum: off.checksum });
    expect(on.ok).toBe(true);
    expect(ledger.approve(id, { checksum: ledger.computeChecksum(id)! }).ok).toBe(true);
    await runBulkEffect(id, 'bulk_apply', effectDeps());
    expect([file('a.txt'), file('b.txt'), file('c.txt')]).toEqual(['new a', 'new b', 'new c']);
  });
});

describe('what a deselect refuses', () => {
  it('a checksum other than the current one (two views), and nothing moves', async () => {
    const id = await planFiles(three);
    const seen = ledger.computeChecksum(id)!;
    ledger.deselectTarget(id, seqOf(id, 'a.txt'), { checksum: seen });
    expect(ledger.deselectTarget(id, seqOf(id, 'b.txt'), { checksum: seen })).toEqual({ ok: false, reason: 'checksum' });
    expect(ledger.getStatus(id)!.deselected).toBe(1);
  });

  it('a target that does not write, one already out, and a reselect of one that is in', async () => {
    writeFileSync(join(ws, 'c.txt'), 'new c');
    const id = await planFiles(three);
    const c = seqOf(id, 'c.txt');
    expect(ledger.deselectTarget(id, c, { checksum: ledger.computeChecksum(id)! })).toEqual({ ok: false, reason: 'not_writing' });
    const a = seqOf(id, 'a.txt');
    expect(ledger.reselectTarget(id, a, { checksum: ledger.computeChecksum(id)! })).toEqual({ ok: false, reason: 'not_writing' });
    ledger.deselectTarget(id, a, { checksum: ledger.computeChecksum(id)! });
    expect(ledger.deselectTarget(id, a, { checksum: ledger.computeChecksum(id)! })).toEqual({ ok: false, reason: 'not_writing' });
  });

  it('a run that is no longer previewed', async () => {
    const id = await planFiles(three);
    expect(ledger.approve(id, { checksum: ledger.computeChecksum(id)! }).ok).toBe(true);
    expect(ledger.deselectTarget(id, seqOf(id, 'a.txt'), { checksum: ledger.computeChecksum(id)! })).toEqual({ ok: false, reason: 'wrong_phase' });
  });

  it('a target of an atomic run\'s undo, which restores all or nothing', async () => {
    const id = await planFiles(three, true);
    expect(ledger.approve(id, { checksum: ledger.computeChecksum(id)! }).ok).toBe(true);
    await runBulkEffect(id, 'bulk_apply', effectDeps());
    const undo = ledger.planUndo(id);
    if (!undo.ok) throw new Error(undo.reason);
    const undoId = undo.status.id;
    const seq = ledger.getPreview(undoId)[0]!.seq;
    expect(ledger.deselectTarget(undoId, seq, { checksum: ledger.computeChecksum(undoId)! })).toEqual({ ok: false, reason: 'atomic_undo' });
  });
});

describe('the checksum of a run without a deselected target', () => {
  it('is the one the formula gave before deselecting existed, so a run approved then still matches', async () => {
    const id = await planFiles(three);
    const db = engineDb.getDb();
    const run = db.prepare('SELECT * FROM bulk_runs WHERE id = ?').get(id) as Record<string, string | number | null>;
    const rows = db.prepare('SELECT seq, target_key, change, before, after_planned FROM bulk_targets WHERE run_id = ? ORDER BY seq').all(id) as { seq: number; target_key: string; change: string; before: string | null; after_planned: string | null }[];
    // The parts of `computeChecksum` for a local run as they were before the mark: no contract,
    // list or judge, and per target seq, key, change, before and after.
    const parts = ['bulk-approval-v1', String(run['kind']), String(run['target_system']), String(run['target_collection'] ?? ''), String(run['atomic']), String(run['source_run_id'] ?? ''), String(run['rule_hash'])];
    for (const r of rows) parts.push(String(r.seq), engineDb.dec(r.target_key), r.change, r.before === null ? '' : engineDb.dec(r.before), r.after_planned === null ? '' : engineDb.dec(r.after_planned));
    expect(run['contract_json']).toBeNull();
    expect(ledger.computeChecksum(id)).toBe(engineDb.keyedHash(parts));
  });
});
