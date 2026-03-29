import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentMemoryDb } from './agent-memory-db.js';
import { PatternEngine } from './pattern-engine.js';

describe('PatternEngine', () => {
  let tempDir: string;
  let db: AgentMemoryDb;
  let engine: PatternEngine;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'lynox-pattern-test-'));
    db = new AgentMemoryDb(join(tempDir, 'test.db'));
    engine = new PatternEngine(db);
  });

  afterEach(async () => {
    db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('detectPatterns', () => {
    it('returns 0 with too few episodes', () => {
      db.createEpisode({ task: 'A', outcomeSignal: 'success', toolsUsed: ['bash'] });
      expect(engine.detectPatterns()).toBe(0);
    });

    it('detects tool sequence patterns', () => {
      // Create 5 successful episodes with same tool combo
      for (let i = 0; i < 5; i++) {
        db.createEpisode({
          task: `Task ${i}`,
          outcomeSignal: 'success',
          toolsUsed: ['file_read', 'file_write'],
        });
      }
      const detected = engine.detectPatterns();
      expect(detected).toBeGreaterThanOrEqual(1);

      const patterns = db.getPatterns({ patternType: 'sequence' });
      expect(patterns.length).toBeGreaterThanOrEqual(1);
      expect(patterns[0]!.description).toContain('file_read');
      expect(patterns[0]!.description).toContain('file_write');
    });

    it('detects anti-patterns from high failure rate', () => {
      // Create episodes where 'bash' as primary tool fails often
      for (let i = 0; i < 4; i++) {
        db.createEpisode({ task: `Fail ${i}`, outcomeSignal: 'failed', toolsUsed: ['bash'] });
      }
      db.createEpisode({ task: 'OK', outcomeSignal: 'success', toolsUsed: ['bash'] });
      // Need 5+ total for detection to run
      db.createEpisode({ task: 'Other', outcomeSignal: 'success', toolsUsed: ['file_write'] });

      const detected = engine.detectPatterns();
      const antiPatterns = db.getPatterns({ patternType: 'anti-pattern' });
      expect(antiPatterns.length).toBeGreaterThanOrEqual(1);
      expect(antiPatterns[0]!.description).toContain('bash');
    });

    it('increments evidence on repeated detection', () => {
      for (let i = 0; i < 5; i++) {
        db.createEpisode({ task: `T${i}`, outcomeSignal: 'success', toolsUsed: ['web_search', 'memory_store'] });
      }
      engine.detectPatterns();
      const before = db.getPatterns({ patternType: 'sequence' });
      expect(before.length).toBe(1);
      const evidenceBefore = before[0]!.evidence_count;

      // Run again — same pattern should get incremented, not duplicated
      engine.detectPatterns();
      const after = db.getPatterns({ patternType: 'sequence' });
      expect(after.length).toBe(1);
      expect(after[0]!.evidence_count).toBe(evidenceBefore + 1);
    });
  });

  describe('computeKPIs', () => {
    it('computes success rate', () => {
      db.createEpisode({ task: 'A', outcomeSignal: 'success' });
      db.createEpisode({ task: 'B', outcomeSignal: 'success' });
      db.createEpisode({ task: 'C', outcomeSignal: 'failed' });

      engine.computeKPIs();

      const metrics = db.getMetrics('success_rate');
      expect(metrics).toHaveLength(1);
      expect(metrics[0]!.value).toBeCloseTo(2 / 3, 2);
    });

    it('computes average duration', () => {
      db.createEpisode({ task: 'A', outcomeSignal: 'success', durationMs: 1000 });
      db.createEpisode({ task: 'B', outcomeSignal: 'success', durationMs: 3000 });

      engine.computeKPIs();

      const metrics = db.getMetrics('avg_duration_ms');
      expect(metrics).toHaveLength(1);
      expect(metrics[0]!.value).toBe(2000);
    });

    it('computes total cost', () => {
      db.createEpisode({ task: 'A', outcomeSignal: 'success', tokenCost: 0.01 });
      db.createEpisode({ task: 'B', outcomeSignal: 'success', tokenCost: 0.02 });

      engine.computeKPIs();

      const metrics = db.getMetrics('total_cost_usd');
      expect(metrics).toHaveLength(1);
      expect(metrics[0]!.value).toBeCloseTo(0.03, 4);
    });

    it('tracks tool usage frequency', () => {
      db.createEpisode({ task: 'A', outcomeSignal: 'success', toolsUsed: ['bash', 'file_write'] });
      db.createEpisode({ task: 'B', outcomeSignal: 'success', toolsUsed: ['bash'] });

      engine.computeKPIs();

      const bashMetrics = db.getMetrics('tool_usage.bash');
      expect(bashMetrics).toHaveLength(1);
      expect(bashMetrics[0]!.value).toBe(2);

      const writeMetrics = db.getMetrics('tool_usage.file_write');
      expect(writeMetrics).toHaveLength(1);
      expect(writeMetrics[0]!.value).toBe(1);
    });

    it('handles empty episodes', () => {
      engine.computeKPIs();
      expect(db.getMetrics()).toHaveLength(0);
    });
  });
});
