import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngineDb } from './engine-db.js';
import {
  BulkLedger, BULK_HALT_REASONS, BULK_OWNER_THREADS_SINCE, plannerHasEnded, type BulkOwnership, type PlannedTarget,
} from './bulk-ledger.js';
import { mintBulkContract } from './bulk-external.js';
import { TriggerStore, bulkPreviewTriggerId } from './trigger-store.js';
import { OWNER_PRINCIPAL, type RequestPrincipal } from './request-principal.js';

/**
 * A bulk run the owner has not approved ends with its planner's grant (PRD
 * customer-granted-operator-access §3.13 B7), and every run says who planned it, so that a run
 * without a planner can only be one from before engine.db v31.
 */
const HOST = 'shop.example.com';
const GRANT: RequestPrincipal = { kind: 'mandate', email: 'helper@example.invalid', mandateId: 'grant-1' };
const OTHER: RequestPrincipal = { kind: 'mandate', email: 'other@example.invalid', mandateId: 'grant-2' };

let dir: string;
let engineDb: EngineDb;
let ledger: BulkLedger;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'lynox-bulk-mandate-')));
  engineDb = new EngineDb(join(dir, 'engine.db'), 'test-vault-key');
  ledger = new BulkLedger(engineDb);
});

afterEach(() => {
  engineDb.close();
  rmSync(dir, { recursive: true, force: true });
});

const local = (n: number): PlannedTarget[] =>
  Array.from({ length: n }, (_, i) => ({ key: `/ws/${String(i)}.md`, before: { absent: false, value: 'old' }, after: 'new' }));

function dryRun(principal: RequestPrincipal, createdBy = 'thread-1'): string {
  return ledger.recordDryRun({ createdBy, principal, targetSystem: 'workspace', scope: 'w', targets: local(2) }).id;
}

function externalPlan(principal: RequestPrincipal): string {
  const key = `https://${HOST}/products/1`;
  const out = ledger.recordExternalPlan({
    createdBy: 'thread-1', principal, host: HOST, targets: [{ key, after: { price: '1.00' } }], contract: mintBulkContract(HOST, [key]),
  });
  if (!out.ok) throw new Error(out.reason);
  return out.status.id;
}

const row = (id: string): { phase: string; halt_reason: string | null; principal: string | null; mandate_id: string | null } =>
  engineDb.getDb().prepare('SELECT phase, halt_reason, principal, mandate_id FROM bulk_runs WHERE id = ?').get(id) as never;

const ownership = (live: readonly string[] = [], threads: Record<string, string | null> = {}, threadsKnown = true): BulkOwnership => ({
  isLive: (id) => live.includes(id),
  threadCreator: (id) => threads[id],
  threadsKnown,
});

describe('who planned a bulk run (engine.db v31)', () => {
  it('every way a run is written records its planner, and a mandate its grant', () => {
    const mine = dryRun(GRANT);
    const ext = externalPlan(GRANT);
    const owners = dryRun(OWNER_PRINCIPAL);
    expect(row(mine)).toMatchObject({ principal: 'mandate:helper@example.invalid', mandate_id: 'grant-1' });
    expect(row(ext)).toMatchObject({ principal: 'mandate:helper@example.invalid', mandate_id: 'grant-1' });
    expect(row(owners)).toMatchObject({ principal: 'owner', mandate_id: null });
  });

  it('an undo is the owner\'s, whoever planned the run it takes back', () => {
    const id = dryRun(OWNER_PRINCIPAL);
    // Applied and stopped, so there is something to take back.
    engineDb.getDb().prepare(`UPDATE bulk_runs SET phase = 'done' WHERE id = ?`).run(id);
    engineDb.getDb().prepare(`UPDATE bulk_targets SET applied_at = datetime('now') WHERE run_id = ?`).run(id);
    const undo = ledger.planUndo(id);
    if (!undo.ok) throw new Error(undo.reason);
    expect(row(undo.status.id)).toMatchObject({ principal: 'owner', mandate_id: null });
  });

  it('no run written since v31 leaves its planner empty', () => {
    dryRun(GRANT);
    externalPlan(OWNER_PRINCIPAL);
    const undoSource = dryRun(OWNER_PRINCIPAL);
    engineDb.getDb().prepare(`UPDATE bulk_runs SET phase = 'done' WHERE id = ?`).run(undoSource);
    engineDb.getDb().prepare(`UPDATE bulk_targets SET applied_at = datetime('now') WHERE run_id = ?`).run(undoSource);
    expect(ledger.planUndo(undoSource).ok).toBe(true);
    expect(engineDb.getDb().prepare('SELECT COUNT(*) AS n FROM bulk_runs WHERE principal IS NULL').get()).toEqual({ n: 0 });
  });
});

describe('whose run has ended', () => {
  const NEW = '2026-10-13 08:00:00';
  const OLD = '2026-10-12 09:33:19';
  const legacy = (over: Partial<{ created_by: string | null; created_at: string }>) =>
    ({ principal: null, mandate_id: null, created_by: 'thread-1', created_at: NEW, ...over });

  it('the owner\'s run never; a mandate\'s while its grant lives', () => {
    const own = ownership(['grant-1']);
    expect(plannerHasEnded({ principal: 'owner', mandate_id: null, created_by: 't', created_at: OLD }, own)).toBe(false);
    expect(plannerHasEnded({ principal: 'mandate:helper@example.invalid', mandate_id: 'grant-1', created_by: 't', created_at: NEW }, own)).toBe(false);
    expect(plannerHasEnded({ principal: 'mandate:other@example.invalid', mandate_id: 'grant-2', created_by: 't', created_at: NEW }, own)).toBe(true);
    expect(plannerHasEnded({ principal: 'mandate:helper@example.invalid', mandate_id: null, created_by: 't', created_at: NEW }, own)).toBe(true);
  });

  it('a planner tag that is neither the owner\'s nor a mandate\'s counts as ended', () => {
    expect(plannerHasEnded({ principal: 'member:someone@example.invalid', mandate_id: null, created_by: 't', created_at: NEW }, ownership(['grant-1']))).toBe(true);
  });

  it('a run from before v31 in the owner\'s conversation, planned after H2c, stays', () => {
    expect(plannerHasEnded(legacy({}), ownership([], { 'thread-1': 'owner' }))).toBe(false);
  });

  it('a run from before v31 in the owner\'s conversation, planned before H2c was released, ends', () => {
    // On the boundary itself: not after it.
    expect(BULK_OWNER_THREADS_SINCE).toBe(OLD);
    expect(plannerHasEnded(legacy({ created_at: OLD }), ownership([], { 'thread-1': 'owner' }))).toBe(true);
    expect(plannerHasEnded(legacy({ created_at: '2026-10-01 00:00:00' }), ownership([], { 'thread-1': 'owner' }))).toBe(true);
  });

  it('a run from before v31 in a mandate\'s conversation ends', () => {
    expect(plannerHasEnded(legacy({}), ownership(['grant-1'], { 'thread-1': 'mandate:helper@example.invalid' }))).toBe(true);
  });

  it('a run from before v31 whose conversation is unknown, or records nobody, ends', () => {
    expect(plannerHasEnded(legacy({}), ownership([], {}))).toBe(true);
    expect(plannerHasEnded(legacy({}), ownership([], { 'thread-1': null }))).toBe(true);
    expect(plannerHasEnded(legacy({ created_by: null }), ownership([], { 'thread-1': 'owner' }))).toBe(true);
  });
});

describe('ending the runs of an ended grant', () => {
  it('withdraws an unapproved run of an ended grant, and only that', () => {
    const ended = dryRun(GRANT);
    const live = dryRun(OTHER);
    const owners = dryRun(OWNER_PRINCIPAL);
    const approved = dryRun(GRANT);
    const ok = ledger.approve(approved, { checksum: ledger.computeChecksum(approved)!, maxTargets: 1 });
    if (!ok.ok) throw new Error(ok.reason);

    expect(ledger.expireEndedPlanners(ownership(['grant-2']))).toBe(1);
    expect(row(ended)).toMatchObject({ phase: 'aborted', halt_reason: BULK_HALT_REASONS.mandateEnded });
    expect(row(live).phase).toBe('previewed');
    expect(row(owners).phase).toBe('previewed');
    // Approved is the owner's act: the run stays.
    expect(row(approved).phase).toBe('approved');
    // A withdrawn run cannot be approved afterwards.
    expect(ledger.approve(ended, { checksum: 'x' })).toEqual({ ok: false, reason: 'wrong_phase' });
  });

  it('withdraws a planned external run and removes its preview trigger', () => {
    const id = externalPlan(GRANT);
    expect(ledger.resumePreview(id).ok).toBe(true);
    const triggers = new TriggerStore(engineDb);
    expect(triggers.get(bulkPreviewTriggerId(id))).toBeDefined();
    expect(ledger.endIfPlannerEnded(id, ownership())).toBe(true);
    expect(row(id).phase).toBe('aborted');
    expect(triggers.get(bulkPreviewTriggerId(id))).toBeUndefined();
  });

  it('leaves an approved run of an ended grant as approved, at the route\'s check too', () => {
    const id = dryRun(GRANT);
    const ok = ledger.approve(id, { checksum: ledger.computeChecksum(id)!, maxTargets: 1 });
    if (!ok.ok) throw new Error(ok.reason);
    expect(ledger.endIfPlannerEnded(id, ownership())).toBe(false);
    expect(row(id).phase).toBe('approved');
  });

  it('while the conversations cannot be read, refuses a run from before v31 and leaves it for a later sweep', () => {
    const legacy = dryRun(OWNER_PRINCIPAL, 'owner-thread');
    const mine = dryRun(GRANT);
    engineDb.getDb().prepare(`UPDATE bulk_runs SET principal = NULL, created_at = '2026-10-13 08:00:00' WHERE id = ?`).run(legacy);
    const blind = ownership([], {}, false);
    expect(ledger.expireEndedPlanners(blind)).toBe(1);
    expect(row(legacy).phase).toBe('previewed');
    expect(row(mine).phase).toBe('aborted');
    expect(ledger.endIfPlannerEnded(legacy, blind)).toBe(true);
    expect(row(legacy).phase).toBe('previewed');
    // Once they can be read again, the owner's conversation keeps it.
    expect(ledger.expireEndedPlanners(ownership([], { 'owner-thread': 'owner' }))).toBe(0);
    expect(ledger.endIfPlannerEnded(legacy, ownership([], { 'owner-thread': 'owner' }))).toBe(false);
  });

  it('leaves a live grant\'s run to be started', () => {
    const id = externalPlan(GRANT);
    expect(ledger.endIfPlannerEnded(id, ownership(['grant-1']))).toBe(false);
    expect(ledger.resumePreview(id).ok).toBe(true);
  });
});
