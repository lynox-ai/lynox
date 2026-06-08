import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentMemoryDb } from './agent-memory-db.js';
import { RunHistory } from './run-history.js';
import { KpiEngine } from './kpi-engine.js';

describe('KpiEngine', () => {
  let tempDir: string;
  let db: AgentMemoryDb;
  let rh: RunHistory;
  let engine: KpiEngine;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'lynox-kpi-test-'));
    db = new AgentMemoryDb(join(tempDir, 'memory.db'));
    rh = new RunHistory(join(tempDir, 'history.db'));
    engine = new KpiEngine(rh, db);
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
      modelTier: 'balanced',
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

  it('no-ops with no runs', () => {
    engine.computeKPIs();
    expect(db.getMetrics()).toHaveLength(0);
  });

  it('computes success_rate, total_runs, cost and tool-usage metrics', () => {
    insertRun({ status: 'completed', tools: ['http_request'], costUsd: 0.02 });
    insertRun({ status: 'completed', tools: ['http_request', 'memory_recall'], costUsd: 0.03 });
    insertRun({ status: 'failed', tools: ['web_search'], costUsd: 0.01 });

    engine.computeKPIs();

    const successRate = db.getMetrics('success_rate');
    expect(successRate).toHaveLength(1);
    expect(successRate[0]!.value).toBeCloseTo(2 / 3, 5);

    const totalRuns = db.getMetrics('total_runs');
    expect(totalRuns[0]!.value).toBe(3);

    const cost = db.getMetrics('total_cost_usd');
    expect(cost[0]!.value).toBeCloseTo(0.06, 5);

    const httpUsage = db.getMetrics('tool_usage.http_request');
    expect(httpUsage[0]!.value).toBe(2);
  });
});
