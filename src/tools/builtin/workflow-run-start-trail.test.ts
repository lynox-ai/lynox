import { describe, it, expect } from 'vitest';
import type { AuditLog } from '../../core/audit-log.js';
import type { RequestPrincipal } from '../../core/request-principal.js';
import { runAsWorkerRun, type WorkerRunStart } from '../../core/worker-run-start.js';
import { ownerStartOfCall, workflowRunTrail } from './pipeline.js';

// 1184 (2): the owner's run of a mandate's workflow records how it was started. A run of the
// owner's own worker started by its schedule is not a start by hand.
const BEA: RequestPrincipal = { kind: 'mandate', email: 'bea@example.test', mandateId: 'grant-b' };

function startRow(start: WorkerRunStart | undefined): string {
  const targets: string[] = [];
  const log = { record: (row: { target?: string }) => { targets.push(row.target ?? ''); } } as unknown as AuditLog;
  const write = (): void => {
    const trail = workflowRunTrail(BEA, log, { workflowId: 'imported-wf', oneShot: false, retry: false, startedBy: ownerStartOfCall() });
    trail!.begin();
  };
  if (start === undefined) write(); else runAsWorkerRun(start, write);
  expect(targets).toHaveLength(1);
  return targets[0]!;
}

describe("the start row of the owner's run of a mandate's workflow says how it was started (1184)", () => {
  it("the owner's chat, outside a worker run: by hand (control, as before)", () => {
    expect(startRow(undefined)).toBe('one_shot=no started=hand by=owner');
  });

  it("a run of the owner's worker by its schedule: schedule, not hand", () => {
    expect(startRow('schedule')).toBe('one_shot=no started=schedule by=owner');
  });

  it('a run of the worker started by "Run now": by hand', () => {
    expect(startRow('hand')).toBe('one_shot=no started=hand by=owner');
  });

  it('a run of the worker started by an event: no start word, never hand', () => {
    expect(startRow('event')).toBe('one_shot=no by=owner');
  });

  it('a run of the worker picked up after an answered question: no start word, neither hand nor schedule', () => {
    expect(startRow('answered')).toBe('one_shot=no by=owner');
  });
});
