/**
 * An actor trail for tests that run a mandate's writing tool directly: a real `AuditLog` over an
 * in-memory `audit_log` table of engine.db's shape. A mandate's write inside the instance is
 * refused without a trail (`instance-trail.ts`), so a fixture that acts as a mandate hands one
 * in rather than acting as the owner.
 */
import Database from 'better-sqlite3';
import { AuditLog } from '../../src/core/audit-log.js';

export interface TestAuditLog {
  readonly log: AuditLog;
  /** The rows written so far, oldest first. */
  rows(): Array<{ action: string; target: string | null; phase: string; correlation_id: string; actor_kind: string; actor_email: string | null; mandate_id: string | null; run_id: string | null }>;
  readonly db: Database.Database;
}

export function testAuditLog(): TestAuditLog {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, actor_kind TEXT NOT NULL, actor_email TEXT,
    actor_display TEXT, mandate_id TEXT, action TEXT NOT NULL, target TEXT, phase TEXT NOT NULL,
    correlation_id TEXT NOT NULL, run_id TEXT, request_id TEXT, recorded_at TEXT)`);
  return {
    log: new AuditLog(db),
    db,
    rows: () => db.prepare('SELECT * FROM audit_log ORDER BY id').all() as ReturnType<TestAuditLog['rows']>,
  };
}
