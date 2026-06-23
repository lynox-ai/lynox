import Database from 'better-sqlite3';
import { join } from 'node:path';
import { channels } from './observability.js';
import { getLynoxDir } from './config.js';

export interface SecurityEvent {
  event_type: string;
  tool_name?: string | undefined;
  input_preview?: string | undefined;
  decision: string;
  autonomy_level?: string | undefined;
  agent_name?: string | undefined;
  run_id?: string | undefined;
  source?: string | undefined;
  detail?: string | undefined;
  /** A2 (S5): the capability-contract version that governed this decision.
   * Null in A1/A2 (the seam carries no contract); Slice B populates it. */
  contract_version?: string | undefined;
}

/** Mask common secret patterns in preview strings. */
function maskSecrets(text: string): string {
  return text
    .replace(/sk-ant-[a-zA-Z0-9_-]{6,}/g, 'sk-ant-***')
    .replace(/sk-[a-zA-Z0-9]{6,}/g, 'sk-***')
    .replace(/ghp_[a-zA-Z0-9]{6,}/g, 'ghp_***')
    .replace(/gho_[a-zA-Z0-9]{6,}/g, 'gho_***')
    .replace(/AKIA[A-Z0-9]{6,}/g, 'AKIA***')
    .replace(/AIza[a-zA-Z0-9_-]{6,}/g, 'AIza***')
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, 'eyJ***');
}

export class SecurityAudit {
  private db: Database.Database;
  private insertStmt: Database.Statement;

  constructor(dbPath?: string | undefined) {
    const path = dbPath ?? join(getLynoxDir(), 'history.db');
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');

    // Ensure security_events table exists (idempotent)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS security_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        tool_name TEXT,
        input_preview TEXT,
        decision TEXT NOT NULL,
        autonomy_level TEXT,
        agent_name TEXT,
        run_id TEXT,
        source TEXT,
        detail TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_security_events_type ON security_events(event_type);
      CREATE INDEX IF NOT EXISTS idx_security_events_created ON security_events(created_at);
    `);

    // A2 (S5): own the `contract_version` column idempotently HERE.
    // security-audit.ts owns `security_events` on its OWN DB connection
    // (separate from RunHistory's), so a RunHistory migration `ALTER` plus this
    // module's idempotent CREATE would race to add the column on a fresh DB
    // (whichever connection runs second throws "duplicate column"). A
    // pragma-guarded add is order-independent and keeps the single owner. The
    // column is null in A1/A2 (the capability-contract seam carries no
    // contract); Slice B stamps the authorising version.
    const cols = this.db.prepare(`PRAGMA table_info(security_events)`).all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'contract_version')) {
      this.db.exec(`ALTER TABLE security_events ADD COLUMN contract_version TEXT`);
    }

    this.insertStmt = this.db.prepare(`
      INSERT INTO security_events (event_type, tool_name, input_preview, decision, autonomy_level, agent_name, run_id, source, detail, contract_version)
      VALUES (@event_type, @tool_name, @input_preview, @decision, @autonomy_level, @agent_name, @run_id, @source, @detail, @contract_version)
    `);

    // Subscribe to guardBlock channel (existing). A2: map the run id (so a
    // headless step's block is attributable to its run) + the contract version
    // that governed the decision — both newly carried on the published event.
    channels.guardBlock.subscribe((msg: unknown) => {
      const event = msg as { toolName?: string; warning?: string; autonomy?: string; runId?: string; contractVersion?: number };
      this.record({
        event_type: event.warning?.includes('[BLOCKED') ? 'tool_blocked' : 'danger_flagged',
        tool_name: event.toolName,
        input_preview: event.warning?.slice(0, 500),
        decision: event.warning?.includes('[BLOCKED') ? 'blocked' : 'flagged',
        autonomy_level: event.autonomy,
        run_id: event.runId,
        contract_version: event.contractVersion !== undefined ? String(event.contractVersion) : undefined,
      });
    });

    // Subscribe to security channels
    channels.securityBlocked.subscribe((msg: unknown) => {
      this.record(msg as SecurityEvent);
    });
    channels.securityFlagged.subscribe((msg: unknown) => {
      this.record(msg as SecurityEvent);
    });
    channels.securityInjection.subscribe((msg: unknown) => {
      this.record(msg as SecurityEvent);
    });
  }

  record(event: SecurityEvent): void {
    try {
      this.insertStmt.run({
        event_type: event.event_type,
        tool_name: event.tool_name ?? null,
        input_preview: event.input_preview ? maskSecrets(event.input_preview.slice(0, 500)) : null,
        decision: event.decision,
        autonomy_level: event.autonomy_level ?? null,
        agent_name: event.agent_name ?? null,
        run_id: event.run_id ?? null,
        source: event.source ?? null,
        detail: event.detail ?? null,
        contract_version: event.contract_version ?? null,
      });
    } catch {
      // Silently ignore insert failures — security audit should never crash the runtime
    }
  }

  getRecentEvents(hours = 24): Array<Record<string, unknown>> {
    try {
      const stmt = this.db.prepare(
        `SELECT * FROM security_events WHERE created_at >= datetime('now', '-' || ? || ' hours') ORDER BY created_at DESC LIMIT 100`,
      );
      return stmt.all(hours) as Array<Record<string, unknown>>;
    } catch {
      return [];
    }
  }

  getEventCounts(days = 7): Array<{ event_type: string; count: number }> {
    try {
      const stmt = this.db.prepare(
        `SELECT event_type, COUNT(*) as count FROM security_events WHERE created_at >= datetime('now', '-' || ? || ' days') GROUP BY event_type ORDER BY count DESC`,
      );
      return stmt.all(days) as Array<{ event_type: string; count: number }>;
    } catch {
      return [];
    }
  }

  /**
   * Content-free aggregate of security events over a time window, grouped by
   * the non-content dimensions only. Used by the managed control plane's
   * abuse-detection poll: it must reveal WHETHER guards are firing and how
   * often, never WHAT triggered them.
   *
   * The projection is an explicit column list — `input_preview` and `detail`
   * (the only two columns that can carry customer content) are never selected,
   * so this method is structurally incapable of leaking content even if the
   * caller serialises the whole result. This is the security invariant the
   * `/api/security/events/aggregate` endpoint relies on; the regression test
   * asserts the keys can never appear.
   */
  getContentFreeAggregates(windowHours = 24): SecurityEventAggregate[] {
    try {
      const stmt = this.db.prepare(
        `SELECT event_type, tool_name, decision, autonomy_level,
                COUNT(*) as count, MAX(created_at) as last_seen
         FROM security_events
         WHERE created_at >= datetime('now', '-' || ? || ' hours')
         GROUP BY event_type, tool_name, decision, autonomy_level
         ORDER BY count DESC`,
      );
      return stmt.all(windowHours) as SecurityEventAggregate[];
    } catch {
      return [];
    }
  }
}

/**
 * One row of {@link SecurityAudit.getContentFreeAggregates}. Every field is a
 * non-content dimension (enum/identifier/timestamp/count) — there is no slot
 * for `input_preview` or `detail`.
 */
export interface SecurityEventAggregate {
  event_type: string;
  tool_name: string | null;
  decision: string;
  autonomy_level: string | null;
  count: number;
  last_seen: string;
}
