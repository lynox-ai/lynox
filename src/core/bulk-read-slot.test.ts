import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngineDb } from './engine-db.js';
import { BulkLedger, BULK_HALT_REASONS } from './bulk-ledger.js';
import { OWNER_PRINCIPAL } from './request-principal.js';
import { mintBulkContract } from './bulk-external.js';
import { parseListSource } from './bulk-list.js';
import { TriggerStore, bulkPreviewTriggerId } from './trigger-store.js';
import type { CapabilityContract } from '../types/capability-contract.js';

/**
 * The one-external-read slot is held by a run that is `planned` and not halted. A run whose
 * read trigger is gone, or ended without moving it, used to hold that slot for good: no
 * trigger would read it, and only a halted run can be resumed. It is now halted as
 * `unavailable` where the slot is counted and where its status is read — and only when its
 * trigger will not fire again, as the tick decides that.
 */

const HOST = 'shop.example.com';
const url = (i: number): string => `https://${HOST}/products/${String(i)}`;

let dir: string;
let engineDb: EngineDb;
let ledger: BulkLedger;
let triggers: TriggerStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lynox-bulk-slot-'));
  engineDb = new EngineDb(join(dir, 'engine.db'), 'test-vault-key');
  ledger = new BulkLedger(engineDb);
  triggers = new TriggerStore(engineDb);
});
afterEach(() => {
  engineDb.close();
  rmSync(dir, { recursive: true, force: true });
});

function plan(): ReturnType<BulkLedger['recordExternalPlan']> {
  return ledger.recordExternalPlan({
    createdBy: 't', principal: OWNER_PRINCIPAL, host: HOST,
    targets: [{ key: url(1), after: { price: '1' } }], contract: mintBulkContract(HOST, [url(1)], 'PUT'),
  });
}

function planId(): string {
  const out = plan();
  if (!out.ok) throw new Error(out.reason);
  return out.status.id;
}

/** A planned run, started: unhalted, its read trigger armed and due. */
function started(): string {
  const id = planId();
  const res = ledger.resumePreview(id);
  if (!res.ok) throw new Error(res.reason);
  return id;
}

/** The run's halt reason as stored — read past `getStatus`, which may halt it. */
function storedHalt(id: string): string | null {
  return (engineDb.getDb().prepare('SELECT halt_reason FROM bulk_runs WHERE id = ?').get(id) as { halt_reason: string | null }).halt_reason;
}

const readContract: CapabilityContract = {
  version: 1, origin: 'reviewed', grantedTools: ['http_request'], httpMethods: ['GET'],
  hostPatterns: [HOST], pathPatterns: ['/wp-json/wc/v3/products'], paramConstraints: {},
};

describe('a run left reading with no trigger', () => {
  it('is halted when the next external plan counts the slot, and that plan goes through', () => {
    const stuck = started();
    triggers.remove(bulkPreviewTriggerId(stuck));
    expect(storedHalt(stuck)).toBeNull();
    expect(plan().ok).toBe(true);
    expect(storedHalt(stuck)).toBe(BULK_HALT_REASONS.unavailable);
  });

  it('is halted when a list plan counts the slot', () => {
    const stuck = started();
    triggers.remove(bulkPreviewTriggerId(stuck));
    const source = parseListSource(HOST, { path: '/wp-json/wc/v3/products', filters: { category: '12' }, after: { status: 'draft' } }, 'PUT', () => null);
    const out = ledger.recordExternalListPlan({ createdBy: 't', principal: OWNER_PRINCIPAL, host: HOST, source, readContract });
    expect(out.ok).toBe(true);
    expect(storedHalt(stuck)).toBe(BULK_HALT_REASONS.unavailable);
  });

  it('is halted when another run is started, and that start goes through', () => {
    const other = planId();
    const stuck = started();
    triggers.remove(bulkPreviewTriggerId(stuck));
    expect(ledger.resumePreview(other).ok).toBe(true);
    expect(storedHalt(stuck)).toBe(BULK_HALT_REASONS.unavailable);
  });

  it('is halted when its status is read', () => {
    const stuck = started();
    triggers.remove(bulkPreviewTriggerId(stuck));
    expect(ledger.getStatus(stuck)!.haltReason).toBe(BULK_HALT_REASONS.unavailable);
    expect(storedHalt(stuck)).toBe(BULK_HALT_REASONS.unavailable);
  });

  it('can be started again by its owner, which re-arms its trigger', () => {
    const stuck = started();
    triggers.remove(bulkPreviewTriggerId(stuck));
    const res = ledger.resumePreview(stuck);
    expect(res.ok).toBe(true);
    expect(storedHalt(stuck)).toBeNull();
    expect(triggers.isLive(bulkPreviewTriggerId(stuck))).toBe(true);
  });

  it('is halted when its trigger ended without moving it — completed, or failed with no retry', () => {
    const done = started();
    triggers.updateFields(bulkPreviewTriggerId(done), { status: 'completed' });
    triggers.updateRunResult(bulkPreviewTriggerId(done), { lastRunAt: new Date().toISOString(), lastRunResult: 'x', lastRunStatus: 'success', nextRunAt: null });
    expect(ledger.getStatus(done)!.haltReason).toBe(BULK_HALT_REASONS.unavailable);

    const failed = started();
    triggers.updateFields(bulkPreviewTriggerId(failed), { status: 'failed' });
    expect(ledger.getStatus(failed)!.haltReason).toBe(BULK_HALT_REASONS.unavailable);
  });

  it('keeps a reason it was already halted with, and leaves a run past its read alone', () => {
    const stopped = started();
    ledger.haltPreview(stopped, BULK_HALT_REASONS.stoppedByOwner);
    triggers.remove(bulkPreviewTriggerId(stopped));
    expect(ledger.getStatus(stopped)!.haltReason).toBe(BULK_HALT_REASONS.stoppedByOwner);
    // Halting twice is the same as once.
    const stuck = started();
    triggers.remove(bulkPreviewTriggerId(stuck));
    ledger.getStatus(stuck);
    expect(ledger.getStatus(stuck)!.haltReason).toBe(BULK_HALT_REASONS.unavailable);
  });
});

describe('a run whose trigger will still fire is left reading', () => {
  it('when the trigger is re-armed for later', () => {
    const reading = started();
    triggers.updateFields(bulkPreviewTriggerId(reading), { status: 'open', nextRunAt: new Date(Date.now() + 30_000).toISOString() });
    expect(ledger.getStatus(reading)!.haltReason).toBeNull();
    expect(plan()).toEqual({ ok: false, reason: 'external_in_progress' });
    expect(storedHalt(reading)).toBeNull();
  });

  it('while a run of it holds a live lease, though it has recorded an end; once the lease lapses, it is halted', () => {
    // The worker records a pause, then re-arms for it: between the two writes the trigger
    // reads as ended. Its lease is live until after the re-arm, which is what says it is not.
    const reading = started();
    const id = bulkPreviewTriggerId(reading);
    const now = Date.now();
    expect(triggers.claimLease(id, 'worker', new Date(now + 60_000).toISOString(), new Date(now).toISOString())).toBe('claimed');
    triggers.updateFields(id, { status: 'completed' });
    triggers.updateRunResult(id, { lastRunAt: new Date().toISOString(), lastRunResult: 'x', lastRunStatus: 'success', nextRunAt: null });
    expect(ledger.getStatus(reading)!.haltReason).toBeNull();
    expect(plan()).toEqual({ ok: false, reason: 'external_in_progress' });

    // The holder died there: its lease runs out, and nothing will re-arm the trigger.
    engineDb.getDb().prepare('UPDATE triggers SET lease_until = ? WHERE id = ?').run(new Date(now - 1).toISOString(), id);
    expect(ledger.getStatus(reading)!.haltReason).toBe(BULK_HALT_REASONS.unavailable);
  });
});
