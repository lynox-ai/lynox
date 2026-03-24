import type { PreApprovalSet, PreApproveAuditLike } from '../types/index.js';
import type { RunHistory } from './run-history.js';
import { channels } from './observability.js';

export interface AuditEvent {
  setId: string;
  patternIdx: number;
  toolName: string;
  matchString: string;
  pattern: string;
  decision: 'approved' | 'exhausted' | 'expired' | 'no_match';
  autonomyLevel?: string | undefined;
  runId?: string | undefined;
}

export interface AuditSummary {
  setId: string;
  taskSummary: string;
  approvedBy: string;
  totalMatches: number;
  totalExhausted: number;
  totalExpired: number;
  byPattern: Array<{ pattern: string; tool: string; matches: number }>;
  createdAt: string;
}

export class PreApproveAudit implements PreApproveAuditLike {
  constructor(private readonly history: RunHistory) {}

  /** Record a pre-approval set being created (mode start) */
  recordSetCreated(set: PreApprovalSet): void {
    try {
      this.history.insertPreApprovalSet({
        id: set.id,
        taskSummary: set.taskSummary,
        approvedBy: set.approvedBy,
        patternsJson: JSON.stringify(set.patterns),
        maxUses: set.maxUses,
        ttlMs: set.ttlMs,
      });
    } catch {
      // Fire-and-forget — never block agent execution
    }
  }

  /** Record an individual approval check result */
  recordCheck(event: AuditEvent): void {
    try {
      this.history.insertPreApprovalEvent({
        setId: event.setId,
        patternIdx: event.patternIdx,
        toolName: event.toolName,
        matchString: event.matchString,
        pattern: event.pattern,
        decision: event.decision,
        autonomyLevel: event.autonomyLevel,
        runId: event.runId,
      });

      // Publish to observability channels
      if (event.decision === 'approved') {
        channels.preApprovalMatch.publish(event);
      } else if (event.decision === 'exhausted') {
        channels.preApprovalExhausted.publish(event);
      } else if (event.decision === 'expired') {
        channels.preApprovalExpired.publish(event);
      }
    } catch {
      // Fire-and-forget — never block agent execution
    }
  }

  /** Get audit summary for a specific set */
  getSummary(setId: string): AuditSummary | undefined {
    const sets = this.history.getPreApprovalSets(100);
    const set = sets.find(s => s.id === setId);
    if (!set) return undefined;

    const summary = this.history.getPreApprovalSummary(setId);
    const events = this.history.getPreApprovalEvents(setId);

    // Build per-pattern match counts
    const patternCounts = new Map<string, { pattern: string; tool: string; matches: number }>();
    for (const ev of events) {
      if (ev.decision === 'approved') {
        const key = `${ev.tool_name}:${ev.pattern}`;
        const existing = patternCounts.get(key);
        if (existing) {
          existing.matches++;
        } else {
          patternCounts.set(key, { pattern: ev.pattern, tool: ev.tool_name, matches: 1 });
        }
      }
    }

    return {
      setId: set.id,
      taskSummary: set.task_summary,
      approvedBy: set.approved_by,
      totalMatches: summary?.total_matches ?? 0,
      totalExhausted: summary?.total_exhausted ?? 0,
      totalExpired: summary?.total_expired ?? 0,
      byPattern: [...patternCounts.values()],
      createdAt: set.created_at,
    };
  }

  /** List recent audit sets */
  listSets(limit = 20): AuditSummary[] {
    const sets = this.history.getPreApprovalSets(limit);
    return sets.map(s => {
      const summary = this.history.getPreApprovalSummary(s.id);
      const events = this.history.getPreApprovalEvents(s.id);

      const patternCounts = new Map<string, { pattern: string; tool: string; matches: number }>();
      for (const ev of events) {
        if (ev.decision === 'approved') {
          const key = `${ev.tool_name}:${ev.pattern}`;
          const existing = patternCounts.get(key);
          if (existing) {
            existing.matches++;
          } else {
            patternCounts.set(key, { pattern: ev.pattern, tool: ev.tool_name, matches: 1 });
          }
        }
      }

      return {
        setId: s.id,
        taskSummary: s.task_summary,
        approvedBy: s.approved_by,
        totalMatches: summary?.total_matches ?? 0,
        totalExhausted: summary?.total_exhausted ?? 0,
        totalExpired: summary?.total_expired ?? 0,
        byPattern: [...patternCounts.values()],
        createdAt: s.created_at,
      };
    });
  }

  /** Get detailed events for a set */
  getEvents(setId: string): AuditEvent[] {
    const rows = this.history.getPreApprovalEvents(setId);
    return rows.map(r => ({
      setId: r.set_id,
      patternIdx: r.pattern_idx,
      toolName: r.tool_name,
      matchString: r.match_string,
      pattern: r.pattern,
      decision: r.decision as AuditEvent['decision'],
      autonomyLevel: r.autonomy_level ?? undefined,
      runId: r.run_id ?? undefined,
    }));
  }

  /** Export audit trail as JSON */
  exportAudit(setId?: string | undefined): unknown {
    if (setId) {
      return {
        set: this.getSummary(setId),
        events: this.getEvents(setId),
      };
    }
    const sets = this.listSets(100);
    return {
      sets: sets.map(s => ({
        ...s,
        events: this.getEvents(s.setId),
      })),
    };
  }
}
