import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngineDb } from './engine-db.js';
import { AuditLog, newCorrelationId } from './audit-log.js';
import { currentWorkflowRun, runAsWorkflowRun } from './plan-run-context.js';
import { OWNER_PRINCIPAL, type RequestPrincipal } from './request-principal.js';

// 660b: a workflow run's key reaches only the rows its own principal writes inside it. A row
// another principal writes in the same async context (the owner's, another person's) is not the
// run's and must not be filed under it.

const HELPER: RequestPrincipal = { kind: 'mandate', email: 'helper@example.invalid', mandateId: 'grant-1' };
// Another person. The key binds by principal tag, as a plan's run does (`currentPlanRun`): one
// person's two grants share it, as they share a plan's.
const OTHER: RequestPrincipal = { kind: 'mandate', email: 'other@example.invalid', mandateId: 'grant-2' };

describe('the key of a workflow run', () => {
  it('is the run\'s for its own principal, inside the run and after an await', async () => {
    await runAsWorkflowRun(HELPER, 'k1', async () => {
      expect(currentWorkflowRun(HELPER)).toBe('k1');
      await Promise.resolve();
      expect(currentWorkflowRun(HELPER)).toBe('k1');
    });
  });

  it('is nobody else\'s, and nothing outside the run', () => {
    runAsWorkflowRun(HELPER, 'k1', () => {
      expect(currentWorkflowRun(OWNER_PRINCIPAL)).toBeUndefined();
      expect(currentWorkflowRun(OTHER)).toBeUndefined();
    });
    expect(currentWorkflowRun(HELPER)).toBeUndefined();
  });
});

describe('a row written inside a workflow run', () => {
  it('is filed under the run\'s key by the log itself; another person\'s row in it is not', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wf-run-key-'));
    const db = new EngineDb(join(dir, 'engine.db'), '');
    try {
      const log = new AuditLog(db.getDb());
      runAsWorkflowRun(HELPER, 'k1', () => {
        log.record({ principal: HELPER, action: 'http_request:read', phase: 'read', correlationId: newCorrelationId() });
        log.record({ principal: OTHER, action: 'http_request:read', phase: 'read', correlationId: newCorrelationId() });
      });
      const rows = db.getDb().prepare(`SELECT actor_email, plan_run FROM audit_log ORDER BY id`).all();
      expect(rows).toEqual([{ actor_email: 'helper@example.invalid', plan_run: 'k1' }, { actor_email: 'other@example.invalid', plan_run: null }]);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
