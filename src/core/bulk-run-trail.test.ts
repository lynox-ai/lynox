import { describe, it, expect } from 'vitest';
import { bulkRunTrail } from './worker-loop.js';
import { namedTarget, newCorrelationId, type AuditEntry } from './audit-log.js';
import { externalHostOf, type BulkRunForApply } from './bulk-ledger.js';
import { OWNER_PRINCIPAL, type RequestPrincipal } from './request-principal.js';

// PRD customer-granted-operator-access §3.9: a bulk run a delegated session planned writes outside
// the instance as the owner's, on the owner's approval; the trail names who planned it.
const tools = { namedTarget, newCorrelationId, externalHostOf };
const HELPER: RequestPrincipal = { kind: 'mandate', email: 'helper@example.invalid', mandateId: 'grant-1' };

function run(over: Partial<BulkRunForApply> = {}): BulkRunForApply {
  return {
    id: 'run-1', kind: 'apply', targetSystem: 'http:shop.example.com', targetCollection: null, atomic: false,
    phase: 'approved', approvalChecksum: 'c', maxTargets: null, expiresAt: null, applied: 0, failed: 0,
    haltReason: null, sourceRunId: null, contractJson: '{}', delegatedPlanner: HELPER, ...over,
  };
}
function log(): { rows: AuditEntry[]; record: (e: AuditEntry) => void } {
  const rows: AuditEntry[] = [];
  return { rows, record: (e) => { rows.push(e); } };
}

describe('bulkRunTrail', () => {
  it('writes a row before and after for a delegated session\'s external run, naming planner, approver and host', () => {
    const l = log();
    const t = bulkRunTrail(run(), l as never, tools)!;
    t.begin();
    t.end('done', 3, 1, false);
    expect(l.rows.map((r) => [r.principal, r.action, r.target, r.phase, r.runId])).toEqual([
      [HELPER, 'bulk:apply', 'host=shop.example.com approved_by=owner', 'attempt', 'run-1'],
      [HELPER, 'bulk:apply', 'host=shop.example.com approved_by=owner outcome=done written=3 failed=1', 'done', 'run-1'],
    ]);
    expect(l.rows[0]!.correlationId).toBe(l.rows[1]!.correlationId);
  });

  it.each([
    ['pending', 'returned'], ['halted', 'failed'], ['stopped', 'failed'], ['aborted', 'failed'], ['refused', 'failed'], ['error', 'failed'],
  ] as const)('ends a call that ended %s with phase %s, and says how', (outcome, phase) => {
    const l = log();
    bulkRunTrail(run(), l as never, tools)!.end(outcome, 0, 0, false);
    expect(l.rows[0]).toMatchObject({ phase, target: `host=shop.example.com approved_by=owner outcome=${outcome} written=0 failed=0` });
  });

  it('says a halt was planned when the call stopped where its approval told it to, and says nothing otherwise', () => {
    const l = log();
    bulkRunTrail(run(), l as never, tools)!.end('halted', 4, 0, true);
    bulkRunTrail(run(), l as never, tools)!.end('halted', 4, 1, false);
    expect(l.rows.map((r) => r.target)).toEqual([
      'host=shop.example.com approved_by=owner outcome=halted written=4 failed=0 planned=yes',
      'host=shop.example.com approved_by=owner outcome=halted written=4 failed=1',
    ]);
  });

  it('names an undo as one', () => {
    const l = log();
    bulkRunTrail(run({ kind: 'undo' }), l as never, tools)!.begin();
    expect(l.rows[0]!.action).toBe('bulk:undo');
  });

  it('says the counts are unknown when they could not be read, not that nothing was written', () => {
    const l = log();
    bulkRunTrail(run(), l as never, tools)!.end('done', null, null, false);
    expect(l.rows[0]!.target).toBe('host=shop.example.com approved_by=owner outcome=done written=unread failed=unread');
  });

  it('throws from the row before when it cannot be written; the row after never throws', () => {
    expect(() => bulkRunTrail(run(), null, tools)!.begin()).toThrow();
    const failing = { record: () => { throw new Error('disk full'); } };
    const t = bulkRunTrail(run(), failing as never, tools)!;
    expect(() => t.begin()).toThrow('disk full');
    expect(() => t.end('done', 1, 0, false)).not.toThrow();
  });

  it('is none for the owner\'s run and a run with no planner, inside the instance as outside', () => {
    for (const targetSystem of ['http:shop.example.com', 'workspace', 'data_store']) {
      expect(bulkRunTrail(run({ targetSystem, delegatedPlanner: null }), log() as never, tools)).toBeNull();
      expect(bulkRunTrail(run({ targetSystem, delegatedPlanner: OWNER_PRINCIPAL }), log() as never, tools)).toBeNull();
    }
  });

  // 660b: a run inside the instance a delegated session planned writes the same pair, naming the
  // store and never a target: not a path, not the collection's name.
  it.each([
    ['workspace', null, 'files'], ['data_store', 'secret_prices', 'data_store'],
  ] as const)('writes a row before and after for a delegated session\'s run on %s, naming the store as %s', (targetSystem, targetCollection, store) => {
    const l = log();
    const t = bulkRunTrail(run({ targetSystem, targetCollection }), l as never, tools)!;
    t.begin();
    t.end('done', 2, 0, false);
    expect(l.rows.map((r) => [r.principal, r.action, r.target, r.phase, r.runId])).toEqual([
      [HELPER, 'bulk:apply', `store=${store} approved_by=owner`, 'attempt', 'run-1'],
      [HELPER, 'bulk:apply', `store=${store} approved_by=owner outcome=done written=2 failed=0`, 'done', 'run-1'],
    ]);
    expect(l.rows.some((r) => (r.target ?? '').includes('secret_prices'))).toBe(false);
  });

  it('throws from the row before for a run inside the instance too', () => {
    expect(() => bulkRunTrail(run({ targetSystem: 'workspace' }), null, tools)!.begin()).toThrow();
    expect(() => bulkRunTrail(run({ targetSystem: 'data_store' }), null, tools)!.begin()).toThrow();
  });
});
