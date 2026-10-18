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
const noStore = { getByHostname: () => undefined };

describe('bulkRunTrail', () => {
  it('writes a row before and after for a delegated session\'s external run, naming planner, approver and host', () => {
    const l = log();
    const t = bulkRunTrail(run(), l as never, noStore, tools)!;
    t.begin();
    t.end('done', 3, 1);
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
    bulkRunTrail(run(), l as never, noStore, tools)!.end(outcome, 0, 0);
    expect(l.rows[0]).toMatchObject({ phase, target: `host=shop.example.com approved_by=owner outcome=${outcome} written=0 failed=0` });
  });

  it('names an undo as one', () => {
    const l = log();
    bulkRunTrail(run({ kind: 'undo' }), l as never, noStore, tools)!.begin();
    expect(l.rows[0]!.action).toBe('bulk:undo');
  });

  it('names the host a token for the run\'s host is renewed at, and never the token URL\'s path', () => {
    const l = log();
    const store = { getByHostname: (h: string) => (h === 'shop.example.com' ? { auth: { oauth: { token_url: 'https://auth.example.com/oauth/token?client=x' } } } : undefined) };
    bulkRunTrail(run(), l as never, store, tools)!.begin();
    expect(l.rows[0]!.target).toBe('host=shop.example.com token_host=auth.example.com approved_by=owner');
    const bad = { getByHostname: () => ({ auth: { oauth: { token_url: 'not a url' } } }) };
    bulkRunTrail(run(), l as never, bad, tools)!.begin();
    expect(l.rows[1]!.target).toBe('host=shop.example.com token_host=unreadable approved_by=owner');
  });

  it('throws from the row before when it cannot be written; the row after never throws', () => {
    expect(() => bulkRunTrail(run(), null, noStore, tools)!.begin()).toThrow();
    const failing = { record: () => { throw new Error('disk full'); } };
    const t = bulkRunTrail(run(), failing as never, noStore, tools)!;
    expect(() => t.begin()).toThrow('disk full');
    expect(() => t.end('done', 1, 0)).not.toThrow();
  });

  it('is none for the owner\'s run, a run with no planner and a run inside the instance', () => {
    expect(bulkRunTrail(run({ delegatedPlanner: null }), log() as never, noStore, tools)).toBeNull();
    expect(bulkRunTrail(run({ delegatedPlanner: OWNER_PRINCIPAL }), log() as never, noStore, tools)).toBeNull();
    expect(bulkRunTrail(run({ targetSystem: 'workspace' }), log() as never, noStore, tools)).toBeNull();
    expect(bulkRunTrail(run({ targetSystem: 'datastore:x' }), log() as never, noStore, tools)).toBeNull();
  });
});
