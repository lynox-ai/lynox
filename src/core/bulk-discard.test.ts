import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngineDb } from './engine-db.js';
import { BulkLedger, BULK_HALT_REASONS, BULK_JUDGED_RETENTION_MS, BULK_MAX_PREVIEWED_RUNS, type PlannedTarget } from './bulk-ledger.js';
import { mintBulkContract } from './bulk-external.js';
import { TriggerStore, bulkPreviewTriggerId } from './trigger-store.js';
import { OWNER_PRINCIPAL } from './request-principal.js';

/**
 * The owner discards a bulk run before approving it: the run ends as `aborted` with its own
 * reason, its read phase's trigger goes with it, and it can no longer be approved. An approved run
 * is the owner's act and is stopped, never discarded.
 */
const HOST = 'shop.example.com';

let dir: string;
let engineDb: EngineDb;
let ledger: BulkLedger;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'lynox-bulk-discard-')));
  engineDb = new EngineDb(join(dir, 'engine.db'), 'test-vault-key');
  ledger = new BulkLedger(engineDb, null);
});

afterEach(() => {
  engineDb.close();
  rmSync(dir, { recursive: true, force: true });
});

const local = (n: number): PlannedTarget[] =>
  Array.from({ length: n }, (_, i) => ({ key: `/ws/${String(i)}.md`, before: { absent: false, value: 'old' }, after: 'new' }));

function previewed(): string {
  return ledger.recordDryRun({ createdBy: 'thread-1', principal: OWNER_PRINCIPAL, targetSystem: 'workspace', scope: 'w', targets: local(2) }).id;
}

function externalPlan(): string {
  const key = `https://${HOST}/products/1`;
  const out = ledger.recordExternalPlan({
    createdBy: 'thread-1', principal: OWNER_PRINCIPAL, host: HOST, targets: [{ key, after: { price: '1.00' } }], contract: mintBulkContract(HOST, [key]),
  });
  if (!out.ok) throw new Error(out.reason);
  return out.status.id;
}

const row = (id: string): { phase: string; halt_reason: string | null } =>
  engineDb.getDb().prepare('SELECT phase, halt_reason FROM bulk_runs WHERE id = ?').get(id) as never;

describe('discarding a bulk run before its approval (discardRun)', () => {
  it('ends a previewed run as discarded, and an approval of it is refused afterwards', () => {
    const id = previewed();
    const checksum = ledger.computeChecksum(id)!;
    expect(row(id).phase).toBe('previewed');
    expect(ledger.discardRun(id)).toBe(true);
    expect(row(id)).toEqual({ phase: 'aborted', halt_reason: BULK_HALT_REASONS.discarded });
    expect(ledger.approve(id, { checksum })).toEqual({ ok: false, reason: 'wrong_phase' });
    // Once is enough: a second discard finds nothing before its approval.
    expect(ledger.discardRun(id)).toBe(false);
  });

  it('ends a planned external run that is reading, and removes its read trigger', () => {
    const id = externalPlan();
    expect(ledger.resumePreview(id).ok).toBe(true);
    const triggers = new TriggerStore(engineDb);
    expect(triggers.get(bulkPreviewTriggerId(id))).toBeDefined();
    expect(ledger.discardRun(id)).toBe(true);
    expect(row(id)).toEqual({ phase: 'aborted', halt_reason: BULK_HALT_REASONS.discarded });
    expect(triggers.get(bulkPreviewTriggerId(id))).toBeUndefined();
  });

  it('keeps the discard when a pass that was still reading halts the run afterwards', () => {
    const id = externalPlan();
    expect(ledger.resumePreview(id).ok).toBe(true);
    expect(ledger.discardRun(id)).toBe(true);
    // The read in flight fails after the discard, and its pass halts the run as it would have.
    ledger.halt(id, BULK_HALT_REASONS.consecutiveFailures);
    expect(row(id)).toEqual({ phase: 'aborted', halt_reason: BULK_HALT_REASONS.discarded });
    // The twin: a run that did not end is halted as before.
    const live = externalPlan();
    expect(ledger.resumePreview(live).ok).toBe(true);
    ledger.halt(live, BULK_HALT_REASONS.consecutiveFailures);
    expect(row(live).halt_reason).toBe(BULK_HALT_REASONS.consecutiveFailures);
  });

  it('leaves an approved run as it is, and a run that is not there', () => {
    const id = previewed();
    const ok = ledger.approve(id, { checksum: ledger.computeChecksum(id)!, maxTargets: 1 });
    if (!ok.ok) throw new Error(ok.reason);
    expect(ledger.discardRun(id)).toBe(false);
    expect(row(id).phase).toBe('approved');
    expect(ledger.discardRun('no-such-run')).toBe(false);
  });

  it('lets a later plan drop a discarded run, as it drops a superseded one, so the list does not keep it', () => {
    const id = previewed();
    expect(ledger.discardRun(id)).toBe(true);
    // The owner's plannings keep the newest runs up to the cap; the discarded one is the oldest.
    for (let i = 0; i < BULK_MAX_PREVIEWED_RUNS; i++) previewed();
    expect(row(id)).toBeUndefined();
  });

  it('deletes a discarded judged run with its before-images once the retention runs out', () => {
    const id = previewed();
    // A judged run that was started: its before-images went to a model.
    engineDb.getDb().prepare(`UPDATE bulk_runs SET judge_rule = 'r', cost_cap_usd = 1, judge_started_at = ? WHERE id = ?`)
      .run(new Date(0).toISOString(), id);
    expect(ledger.discardRun(id)).toBe(true);
    expect(ledger.expireStaleJudgedRuns(BULK_JUDGED_RETENTION_MS + 1)).toBe(1);
    expect(row(id)).toBeUndefined();
  });
});
