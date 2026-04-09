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
});
