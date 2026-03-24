import Database from 'better-sqlite3';
import { join } from 'node:path';
import { channels } from './observability.js';
import { getNodynDir } from './config.js';

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
    const path = dbPath ?? join(getNodynDir(), 'history.db');
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

    this.insertStmt = this.db.prepare(`
      INSERT INTO security_events (event_type, tool_name, input_preview, decision, autonomy_level, agent_name, run_id, source, detail)
      VALUES (@event_type, @tool_name, @input_preview, @decision, @autonomy_level, @agent_name, @run_id, @source, @detail)
    `);

    // Subscribe to guardBlock channel (existing)
    channels.guardBlock.subscribe((msg: unknown) => {
      const event = msg as { toolName?: string; warning?: string; autonomy?: string };
      this.record({
        event_type: event.warning?.includes('[BLOCKED') ? 'tool_blocked' : 'danger_flagged',
        tool_name: event.toolName,
        input_preview: event.warning?.slice(0, 500),
        decision: event.warning?.includes('[BLOCKED') ? 'blocked' : 'flagged',
        autonomy_level: event.autonomy,
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
}
