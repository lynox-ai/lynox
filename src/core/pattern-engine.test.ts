import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentMemoryDb } from './agent-memory-db.js';
import { RunHistory } from './run-history.js';
import { PatternEngine } from './pattern-engine.js';

describe('PatternEngine', () => {
  let tempDir: string;
  let db: AgentMemoryDb;
  let rh: RunHistory;
  let engine: PatternEngine;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'lynox-pattern-test-'));
    db = new AgentMemoryDb(join(tempDir, 'memory.db'));
    rh = new RunHistory(join(tempDir, 'history.db'));
    engine = new PatternEngine(rh, db);
  });

  afterEach(async () => {
    db.close();
    rh.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  /** Helper: insert a completed/failed run with tool calls. */
  function insertRun(opts: { sessionId?: string; status?: string; tools?: string[]; durationMs?: number; costUsd?: number }) {
    const runId = rh.insertRun({
      sessionId: opts.sessionId ?? 'test-session',
      taskText: 'test task',
      modelTier: 'sonnet',
      modelId: 'claude-sonnet',
    });
    rh.updateRun(runId, {
      status: (opts.status ?? 'completed') as 'completed' | 'failed',
      durationMs: opts.durationMs ?? 1000,
      costUsd: opts.costUsd ?? 0.01,
    });
    for (let i = 0; i < (opts.tools ?? []).length; i++) {
      rh.insertToolCall({
        runId,
        toolName: opts.tools![i]!,
        inputJson: '{}',
        outputJson: '{}',
        durationMs: 100,
        sequenceOrder: i,
      });
    }
    return runId;
  }

  describe('detectPatterns', () => {
    it('returns 0 with too few runs', () => {
      insertRun({ tools: ['bash'] });
      expect(engine.detectPatterns()).toBe(0);
    });

    it('detects tool sequence patterns', () => {
      for (let i = 0; i < 5; i++) {
        insertRun({ status: 'completed', tools: ['file_read', 'file_write'] });
      }
      const detected = engine.detectPatterns();
      expect(detected).toBeGreaterThanOrEqual(1);

      const patterns = db.getPatterns({ patternType: 'sequence' });
      expect(patterns.length).toBeGreaterThanOrEqual(1);
      expect(patterns[0]!.description).toContain('file_read');
      expect(patterns[0]!.description).toContain('file_write');
    });

    it('detects anti-patterns from high failure rate', () => {
      for (let i = 0; i < 4; i++) {
        insertRun({ status: 'failed', tools: ['bash'] });
      }
      insertRun({ status: 'completed', tools: ['bash'] });
      insertRun({ status: 'completed', tools: ['file_write'] });

      engine.detectPatterns();
      const antiPatterns = db.getPatterns({ patternType: 'anti-pattern' });
      expect(antiPatterns.length).toBeGreaterThanOrEqual(1);
      expect(antiPatterns[0]!.description).toContain('bash');
    });

    it('increments evidence on repeated detection', () => {
      for (let i = 0; i < 5; i++) {
        insertRun({ status: 'completed', tools: ['web_search', 'memory_store'] });
      }
      engine.detectPatterns();
      const before = db.getPatterns({ patternType: 'sequence' });
      expect(before.length).toBe(1);
      const evidenceBefore = before[0]!.evidence_count;

      engine.detectPatterns();
      const after = db.getPatterns({ patternType: 'sequence' });
      expect(after.length).toBe(1);
      expect(after[0]!.evidence_count).toBe(evidenceBefore + 1);
    });
  });

  describe('computeKPIs', () => {
    it('computes success rate', () => {
      insertRun({ status: 'completed' });
      insertRun({ status: 'completed' });
      insertRun({ status: 'failed' });

      engine.computeKPIs();

      const metrics = db.getMetrics('success_rate');
      expect(metrics).toHaveLength(1);
      expect(metrics[0]!.value).toBeCloseTo(2 / 3, 2);
    });

    it('computes average duration', () => {
      insertRun({ durationMs: 1000 });
      insertRun({ durationMs: 3000 });

      engine.computeKPIs();

      const metrics = db.getMetrics('avg_duration_ms');
      expect(metrics).toHaveLength(1);
      expect(metrics[0]!.value).toBe(2000);
    });

    it('computes total cost', () => {
      insertRun({ costUsd: 0.01 });
      insertRun({ costUsd: 0.02 });

      engine.computeKPIs();

      const metrics = db.getMetrics('total_cost_usd');
      expect(metrics).toHaveLength(1);
      expect(metrics[0]!.value).toBeCloseTo(0.03, 4);
    });

    it('tracks tool usage frequency', () => {
      insertRun({ tools: ['bash', 'file_write'] });
      insertRun({ tools: ['bash'] });

      engine.computeKPIs();

      const bashMetrics = db.getMetrics('tool_usage.bash');
      expect(bashMetrics).toHaveLength(1);
      expect(bashMetrics[0]!.value).toBe(2);

      const writeMetrics = db.getMetrics('tool_usage.file_write');
      expect(writeMetrics).toHaveLength(1);
      expect(writeMetrics[0]!.value).toBe(1);
    });

    it('handles empty runs', () => {
      engine.computeKPIs();
      expect(db.getMetrics()).toHaveLength(0);
    });
  });
});
