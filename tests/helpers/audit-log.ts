/**
 * An actor trail for tests that run a mandate's writing tool directly: a real `AuditLog` over an
 * in-memory `audit_log` table of engine.db's shape. A mandate's write inside the instance is
 * refused without a trail (`instance-trail.ts`), so a fixture that acts as a mandate hands one
 * in rather than acting as the owner.
 *
 * The table's shape is taken from engine.db's own migrations, once per process, so a column a
 * later migration adds reaches these fixtures too (a hand-copied shape lacked v56's `plan_run`).
 */
import Database from 'better-sqlite3';
import { AuditLog } from '../../src/core/audit-log.js';
import { EngineDb } from '../../src/core/engine-db.js';

let auditLogDdl: string | undefined;

/** engine.db's `audit_log` as its migrations leave it: the table, its indexes, its triggers. */
export function auditLogSchema(): string {
  if (auditLogDdl === undefined) {
    const engine = new EngineDb(':memory:');
    const rows = engine.getDb()
      .prepare("SELECT sql FROM sqlite_master WHERE tbl_name = 'audit_log' AND sql IS NOT NULL ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END")
      .all() as Array<{ sql: string }>;
    engine.close();
    if (rows.length === 0) throw new Error('engine.db has no audit_log table');
    auditLogDdl = rows.map(r => `${r.sql};`).join('\n');
  }
  return auditLogDdl;
}

export interface TestAuditLog {
  readonly log: AuditLog;
  /** The rows written so far, oldest first. */
  rows(): Array<{ action: string; target: string | null; phase: string; correlation_id: string; actor_kind: string; actor_email: string | null; mandate_id: string | null; run_id: string | null }>;
  readonly db: Database.Database;
}

export function testAuditLog(): TestAuditLog {
  const db = new Database(':memory:');
  db.exec(auditLogSchema());
  return {
    log: new AuditLog(db),
    db,
    rows: () => db.prepare('SELECT * FROM audit_log ORDER BY id').all() as ReturnType<TestAuditLog['rows']>,
  };
}
