import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RunHistory } from './run-history.js';
import { PreApproveAudit } from './pre-approve-audit.js';
import type { PreApprovalSet } from '../types/index.js';

function makeSet(overrides?: Partial<PreApprovalSet>): PreApprovalSet {
  return {
    id: 'test-set-id',
    approvedAt: new Date().toISOString(),
    approvedBy: 'operator',
    taskSummary: 'Deploy feature',
    patterns: [
      { tool: 'bash', pattern: 'npm run *', label: 'npm run', risk: 'low' },
      { tool: 'write_file', pattern: 'dist/**', label: 'dist writes', risk: 'medium' },
    ],
    maxUses: 10,
    ttlMs: 0,
    usageCounts: [0, 0],
    ...overrides,
  };
}

describe('PreApproveAudit', () => {
  const tmpDirs: string[] = [];

  function createAudit(): { audit: PreApproveAudit; history: RunHistory } {
    const dir = mkdtempSync(join(tmpdir(), 'nodyn-audit-'));
    tmpDirs.push(dir);
    const history = new RunHistory(join(dir, 'test.db'));
    return { audit: new PreApproveAudit(history), history };
  }

  afterEach(() => {
    for (const dir of tmpDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tmpDirs.length = 0;
  });

  it('records set creation with all fields', () => {
    const { audit } = createAudit();
    const set = makeSet();
    audit.recordSetCreated(set);

    const sets = audit.listSets();
    expect(sets).toHaveLength(1);
    expect(sets[0]!.setId).toBe('test-set-id');
    expect(sets[0]!.taskSummary).toBe('Deploy feature');
    expect(sets[0]!.approvedBy).toBe('operator');
  });

  it('records approval event with pattern match', () => {
    const { audit } = createAudit();
    const set = makeSet();
    audit.recordSetCreated(set);

    audit.recordCheck({
      setId: set.id,
      patternIdx: 0,
      toolName: 'bash',
      matchString: 'npm run build',
      pattern: 'npm run *',
      decision: 'approved',
    });

    const events = audit.getEvents(set.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.decision).toBe('approved');
    expect(events[0]!.toolName).toBe('bash');
    expect(events[0]!.matchString).toBe('npm run build');
  });

  it('records exhausted event when maxUses exceeded', () => {
    const { audit } = createAudit();
    const set = makeSet();
    audit.recordSetCreated(set);

    audit.recordCheck({
      setId: set.id,
      patternIdx: 0,
      toolName: 'bash',
      matchString: 'npm run build',
      pattern: 'npm run *',
      decision: 'exhausted',
    });

    const events = audit.getEvents(set.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.decision).toBe('exhausted');
  });

  it('records expired event when TTL elapsed', () => {
    const { audit } = createAudit();
    const set = makeSet();
    audit.recordSetCreated(set);

    audit.recordCheck({
      setId: set.id,
      patternIdx: 0,
      toolName: 'bash',
      matchString: 'npm run test',
      pattern: 'npm run *',
      decision: 'expired',
    });

    const events = audit.getEvents(set.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.decision).toBe('expired');
  });

  it('getSummary returns correct totals', () => {
    const { audit } = createAudit();
    const set = makeSet();
    audit.recordSetCreated(set);

    audit.recordCheck({ setId: set.id, patternIdx: 0, toolName: 'bash', matchString: 'npm run build', pattern: 'npm run *', decision: 'approved' });
    audit.recordCheck({ setId: set.id, patternIdx: 0, toolName: 'bash', matchString: 'npm run test', pattern: 'npm run *', decision: 'approved' });
    audit.recordCheck({ setId: set.id, patternIdx: 0, toolName: 'bash', matchString: 'npm run lint', pattern: 'npm run *', decision: 'exhausted' });
    audit.recordCheck({ setId: set.id, patternIdx: 1, toolName: 'write_file', matchString: 'dist/x.js', pattern: 'dist/**', decision: 'expired' });

    const summary = audit.getSummary(set.id);
    expect(summary).toBeDefined();
    expect(summary!.totalMatches).toBe(2);
    expect(summary!.totalExhausted).toBe(1);
    expect(summary!.totalExpired).toBe(1);
    expect(summary!.byPattern).toHaveLength(1);
    expect(summary!.byPattern[0]!.matches).toBe(2);
  });

  it('getSummary returns undefined for unknown set', () => {
    const { audit } = createAudit();
    expect(audit.getSummary('nonexistent')).toBeUndefined();
  });

  it('listSets respects limit parameter', () => {
    const { audit } = createAudit();
    for (let i = 0; i < 5; i++) {
      audit.recordSetCreated(makeSet({ id: `set-${i}`, taskSummary: `Task ${i}` }));
    }
    const limited = audit.listSets(3);
    expect(limited).toHaveLength(3);
  });

  it('getEvents returns events for specific set only', () => {
    const { audit } = createAudit();
    audit.recordSetCreated(makeSet({ id: 'set-a' }));
    audit.recordSetCreated(makeSet({ id: 'set-b' }));

    audit.recordCheck({ setId: 'set-a', patternIdx: 0, toolName: 'bash', matchString: 'x', pattern: 'x', decision: 'approved' });
    audit.recordCheck({ setId: 'set-b', patternIdx: 0, toolName: 'bash', matchString: 'y', pattern: 'y', decision: 'approved' });
    audit.recordCheck({ setId: 'set-a', patternIdx: 0, toolName: 'bash', matchString: 'z', pattern: 'z', decision: 'approved' });

    expect(audit.getEvents('set-a')).toHaveLength(2);
    expect(audit.getEvents('set-b')).toHaveLength(1);
  });

  it('exportAudit returns structured JSON', () => {
    const { audit } = createAudit();
    const set = makeSet();
    audit.recordSetCreated(set);
    audit.recordCheck({ setId: set.id, patternIdx: 0, toolName: 'bash', matchString: 'npm run build', pattern: 'npm run *', decision: 'approved' });

    const exported = audit.exportAudit(set.id) as { set: unknown; events: unknown[] };
    expect(exported.set).toBeDefined();
    expect(exported.events).toHaveLength(1);
  });

  it('recordCheck never throws on DB error', () => {
    const { audit, history } = createAudit();
    history.close();
    // Should not throw even after DB is closed
    expect(() => {
      audit.recordCheck({
        setId: 'bad-id', patternIdx: 0, toolName: 'bash',
        matchString: 'x', pattern: 'y', decision: 'approved',
      });
    }).not.toThrow();
  });

  it('multiple sets tracked independently', () => {
    const { audit } = createAudit();
    audit.recordSetCreated(makeSet({ id: 'set-1', taskSummary: 'Task 1' }));
    audit.recordSetCreated(makeSet({ id: 'set-2', taskSummary: 'Task 2' }));

    audit.recordCheck({ setId: 'set-1', patternIdx: 0, toolName: 'bash', matchString: 'a', pattern: 'a', decision: 'approved' });
    audit.recordCheck({ setId: 'set-2', patternIdx: 0, toolName: 'bash', matchString: 'b', pattern: 'b', decision: 'approved' });
    audit.recordCheck({ setId: 'set-2', patternIdx: 0, toolName: 'bash', matchString: 'c', pattern: 'c', decision: 'approved' });

    const s1 = audit.getSummary('set-1');
    const s2 = audit.getSummary('set-2');
    expect(s1!.totalMatches).toBe(1);
    expect(s2!.totalMatches).toBe(2);
  });

  it('events linked to correct run_id', () => {
    const { audit, history } = createAudit();
    // Create a real run to satisfy FK
    const runId = history.insertRun({ taskText: 'Test', modelTier: 'opus', modelId: 'claude-opus-4-6' });
    audit.recordSetCreated(makeSet());
    audit.recordCheck({
      setId: 'test-set-id', patternIdx: 0, toolName: 'bash',
      matchString: 'npm run build', pattern: 'npm run *', decision: 'approved',
      runId,
    });

    const events = audit.getEvents('test-set-id');
    expect(events[0]!.runId).toBe(runId);
  });
});
