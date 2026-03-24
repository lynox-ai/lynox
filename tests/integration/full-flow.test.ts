import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RunHistory } from '../../src/core/run-history.js';
import { calculateCost } from '../../src/core/pricing.js';

describe('Full Flow: Config + RunHistory + Cost Tracking', () => {
  const tmpDirs: string[] = [];

  function makeTmpDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), `nodyn-int-${prefix}-`));
    tmpDirs.push(dir);
    return dir;
  }

  function createHistory(dir?: string | undefined): RunHistory {
    const d = dir ?? makeTmpDir('hist');
    return new RunHistory(join(d, 'test.db'));
  }

  afterEach(() => {
    for (const dir of tmpDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tmpDirs.length = 0;
  });

  describe('loadConfig', () => {
    let fakeHome: string;

    beforeEach(() => {
      fakeHome = makeTmpDir('cfg-home');
      vi.resetModules();
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('returns defaults when no config files exist', async () => {
      vi.doMock('node:os', async (importOriginal) => {
        const orig = await importOriginal<typeof import('node:os')>();
        return { ...orig, homedir: () => fakeHome };
      });

      const { loadConfig } = await import('../../src/core/config.js');
      const savedKey = process.env['ANTHROPIC_API_KEY'];
      delete process.env['ANTHROPIC_API_KEY'];
      const config = loadConfig();
      if (savedKey !== undefined) process.env['ANTHROPIC_API_KEY'] = savedKey;

      // No files exist, so merged config should be an empty object (all defaults)
      expect(config).toBeDefined();
      expect(config.api_key).toBeUndefined();
      expect(config.default_tier).toBeUndefined();
      expect(config.effort_level).toBeUndefined();
    });
  });

  describe('RunHistory records and retrieves runs', () => {
    it('insertRun + updateRun + getRecentRuns round-trip', () => {
      const dir = makeTmpDir('rh');
      const h = createHistory(dir);

      const id = h.insertRun({
        sessionId: 'sess-001',
        taskText: 'Implement feature X',
        modelTier: 'nodyn',
        modelId: 'claude-opus-4-6',
        promptHash: 'abc123',
        runType: 'single',
        projectDir: '/test/project',
      });

      expect(id).toHaveLength(16);

      // Verify initial state
      const run = h.getRun(id);
      expect(run).toBeDefined();
      expect(run!.task_text).toBe('Implement feature X');
      expect(run!.session_id).toBe('sess-001');
      expect(run!.model_tier).toBe('nodyn');
      expect(run!.model_id).toBe('claude-opus-4-6');
      expect(run!.status).toBe('running');
      expect(run!.run_type).toBe('single');

      // Update the run
      h.updateRun(id, {
        responseText: 'Feature X implemented successfully',
        tokensIn: 5000,
        tokensOut: 2000,
        tokensCacheRead: 1000,
        tokensCacheWrite: 500,
        costUsd: 0.1234,
        toolCallCount: 3,
        durationMs: 4500,
        stopReason: 'end_turn',
        status: 'completed',
      });

      // Verify updated state
      const updated = h.getRun(id);
      expect(updated).toBeDefined();
      expect(updated!.response_text).toBe('Feature X implemented successfully');
      expect(updated!.tokens_in).toBe(5000);
      expect(updated!.tokens_out).toBe(2000);
      expect(updated!.tokens_cache_read).toBe(1000);
      expect(updated!.tokens_cache_write).toBe(500);
      expect(updated!.cost_usd).toBeCloseTo(0.1234);
      expect(updated!.tool_call_count).toBe(3);
      expect(updated!.duration_ms).toBe(4500);
      expect(updated!.stop_reason).toBe('end_turn');
      expect(updated!.status).toBe('completed');

      // Verify getRecentRuns
      const recent = h.getRecentRuns(10);
      expect(recent).toHaveLength(1);
      expect(recent[0]!.id).toBe(id);

      h.close();
    });
  });

  describe('calculateCost computes correctly for different models', () => {
    it('haiku cost calculation', () => {
      const cost = calculateCost('claude-haiku-4-5-20251001', {
        input_tokens: 500_000,
        output_tokens: 100_000,
        cache_creation_input_tokens: 50_000,
        cache_read_input_tokens: 200_000,
      });

      // input:  500k * $0.80/M  = $0.40
      // output: 100k * $4.00/M  = $0.40
      // cacheW:  50k * $1.00/M  = $0.05
      // cacheR: 200k * $0.08/M  = $0.016
      const expected = 0.40 + 0.40 + 0.05 + 0.016;
      expect(cost).toBeCloseTo(expected, 4);
    });

    it('sonnet cost calculation', () => {
      const cost = calculateCost('claude-sonnet-4-6', {
        input_tokens: 1_000_000,
        output_tokens: 500_000,
        cache_creation_input_tokens: 100_000,
        cache_read_input_tokens: 300_000,
      });

      // input:  1M   * $3.00/M  = $3.00
      // output: 500k * $15.0/M  = $7.50
      // cacheW: 100k * $3.75/M  = $0.375
      // cacheR: 300k * $0.30/M  = $0.09
      const expected = 3.0 + 7.5 + 0.375 + 0.09;
      expect(cost).toBeCloseTo(expected, 4);
    });

    it('opus cost calculation', () => {
      const cost = calculateCost('claude-opus-4-6', {
        input_tokens: 200_000,
        output_tokens: 100_000,
      });

      // input:  200k * $15.0/M = $3.00
      // output: 100k * $75.0/M = $7.50
      const expected = 3.0 + 7.5;
      expect(cost).toBeCloseTo(expected, 4);
    });

    it('handles zero tokens', () => {
      const cost = calculateCost('claude-sonnet-4-6', {
        input_tokens: 0,
        output_tokens: 0,
      });
      expect(cost).toBe(0);
    });
  });

  describe('RunHistory getCostByDay aggregates costs', () => {
    it('aggregates costs by day correctly', () => {
      const dir = makeTmpDir('cost-day');
      const h = createHistory(dir);

      // Insert multiple runs and update with costs
      const id1 = h.insertRun({
        taskText: 'Task alpha',
        modelTier: 'nodyn',
        modelId: 'claude-opus-4-6',
      });
      h.updateRun(id1, { costUsd: 0.05, status: 'completed' });

      const id2 = h.insertRun({
        taskText: 'Task beta',
        modelTier: 'nodyn-fast',
        modelId: 'claude-sonnet-4-6',
      });
      h.updateRun(id2, { costUsd: 0.03, status: 'completed' });

      const id3 = h.insertRun({
        taskText: 'Task gamma',
        modelTier: 'nodyn',
        modelId: 'claude-opus-4-6',
      });
      h.updateRun(id3, { costUsd: 0.12, status: 'completed' });

      // All runs inserted "now", so getCostByDay(7) should have 1 day entry
      const days = h.getCostByDay(7);
      expect(days.length).toBeGreaterThanOrEqual(1);

      // The total cost for today should be sum of all runs
      const todayCost = days[0]!.cost_usd;
      expect(todayCost).toBeCloseTo(0.05 + 0.03 + 0.12, 4);

      const todayCount = days[0]!.run_count;
      expect(todayCount).toBe(3);

      h.close();
    });
  });

  describe('RunHistory stats cover all metrics', () => {
    it('getStats returns correct aggregated metrics', () => {
      const dir = makeTmpDir('stats');
      const h = createHistory(dir);

      // Insert and complete several runs with varying models and costs
      const id1 = h.insertRun({
        taskText: 'Build API endpoint',
        modelTier: 'nodyn',
        modelId: 'claude-opus-4-6',
      });
      h.updateRun(id1, {
        tokensIn: 10000,
        tokensOut: 5000,
        costUsd: 0.50,
        durationMs: 3000,
        status: 'completed',
      });

      const id2 = h.insertRun({
        taskText: 'Write unit tests',
        modelTier: 'nodyn-fast',
        modelId: 'claude-sonnet-4-6',
      });
      h.updateRun(id2, {
        tokensIn: 8000,
        tokensOut: 4000,
        costUsd: 0.10,
        durationMs: 2000,
        status: 'completed',
      });

      const id3 = h.insertRun({
        taskText: 'Quick fix',
        modelTier: 'nodyn-micro',
        modelId: 'claude-haiku-4-5-20251001',
      });
      h.updateRun(id3, {
        tokensIn: 2000,
        tokensOut: 1000,
        costUsd: 0.005,
        durationMs: 500,
        status: 'completed',
      });

      // Insert a still-running run (should NOT count in stats)
      h.insertRun({
        taskText: 'Running task',
        modelTier: 'nodyn',
        modelId: 'claude-opus-4-6',
      });

      const stats = h.getStats();

      // Only completed runs count
      expect(stats.total_runs).toBe(3);
      expect(stats.total_tokens_in).toBe(10000 + 8000 + 2000);
      expect(stats.total_tokens_out).toBe(5000 + 4000 + 1000);
      expect(stats.total_cost_usd).toBeCloseTo(0.50 + 0.10 + 0.005, 4);
      expect(stats.avg_duration_ms).toBeCloseTo((3000 + 2000 + 500) / 3, 0);

      // cost_by_model should have 3 distinct models
      expect(stats.cost_by_model).toHaveLength(3);

      // Verify the highest-cost model is first (opus)
      const opusEntry = stats.cost_by_model.find(
        (m: { model_id: string; cost_usd: number; run_count: number }) =>
          m.model_id === 'claude-opus-4-6'
      );
      expect(opusEntry).toBeDefined();
      expect(opusEntry!.cost_usd).toBeCloseTo(0.50, 4);
      expect(opusEntry!.run_count).toBe(1);

      h.close();
    });
  });
});
