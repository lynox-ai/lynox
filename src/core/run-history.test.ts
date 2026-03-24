import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RunHistory, hashTask } from './run-history.js';

describe('RunHistory', () => {
  const tmpDirs: string[] = [];

  function createHistory(): RunHistory {
    const dir = mkdtempSync(join(tmpdir(), 'nodyn-hist-'));
    tmpDirs.push(dir);
    return new RunHistory(join(dir, 'test.db'));
  }

  afterEach(() => {
    for (const dir of tmpDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tmpDirs.length = 0;
  });

  it('creates database and schema', () => {
    const h = createHistory();
    expect(h).toBeDefined();
    h.close();
  });

  it('inserts and retrieves a run', () => {
    const h = createHistory();
    const id = h.insertRun({
      taskText: 'Write hello world',
      modelTier: 'sonnet',
      modelId: 'claude-sonnet-4-6',
    });
    expect(id).toHaveLength(16);

    const run = h.getRun(id);
    expect(run).toBeDefined();
    expect(run!.task_text).toBe('Write hello world');
    expect(run!.model_tier).toBe('sonnet');
    expect(run!.status).toBe('running');
    h.close();
  });

  it('updates a run', () => {
    const h = createHistory();
    const id = h.insertRun({
      taskText: 'Test task',
      modelTier: 'opus',
      modelId: 'claude-opus-4-6',
    });

    h.updateRun(id, {
      responseText: 'Hello world',
      tokensIn: 100,
      tokensOut: 50,
      tokensCacheRead: 20,
      tokensCacheWrite: 10,
      costUsd: 0.0123,
      toolCallCount: 2,
      durationMs: 1500,
      stopReason: 'end_turn',
      status: 'completed',
    });

    const run = h.getRun(id);
    expect(run!.response_text).toBe('Hello world');
    expect(run!.tokens_in).toBe(100);
    expect(run!.tokens_out).toBe(50);
    expect(run!.cost_usd).toBeCloseTo(0.0123);
    expect(run!.status).toBe('completed');
    expect(run!.duration_ms).toBe(1500);
    h.close();
  });

  it('inserts and retrieves tool calls', () => {
    const h = createHistory();
    const runId = h.insertRun({
      taskText: 'Test',
      modelTier: 'opus',
      modelId: 'claude-opus-4-6',
    });

    h.insertToolCall({
      runId,
      toolName: 'bash',
      inputJson: '{"command":"ls"}',
      outputJson: 'file1.ts\nfile2.ts',
      durationMs: 50,
      sequenceOrder: 0,
    });
    h.insertToolCall({
      runId,
      toolName: 'read_file',
      inputJson: '{"path":"test.ts"}',
      outputJson: 'content',
      durationMs: 10,
      sequenceOrder: 1,
    });

    const calls = h.getRunToolCalls(runId);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.tool_name).toBe('bash');
    expect(calls[1]!.tool_name).toBe('read_file');
    h.close();
  });

  it('returns recent runs', () => {
    const h = createHistory();
    for (let i = 0; i < 5; i++) {
      h.insertRun({
        taskText: `Task ${i}`,
        modelTier: 'opus',
        modelId: 'claude-opus-4-6',
      });
    }

    const runs = h.getRecentRuns(3);
    expect(runs).toHaveLength(3);
    h.close();
  });

  it('searches runs by text', () => {
    const h = createHistory();
    h.insertRun({ taskText: 'Fix the login bug', modelTier: 'opus', modelId: 'claude-opus-4-6' });
    h.insertRun({ taskText: 'Write unit tests', modelTier: 'sonnet', modelId: 'claude-sonnet-4-6' });

    const results = h.searchRuns('login');
    expect(results).toHaveLength(1);
    expect(results[0]!.task_text).toContain('login');
    h.close();
  });

  it('computes stats', () => {
    const h = createHistory();
    const id1 = h.insertRun({ taskText: 'Task 1', modelTier: 'opus', modelId: 'claude-opus-4-6' });
    const id2 = h.insertRun({ taskText: 'Task 2', modelTier: 'sonnet', modelId: 'claude-sonnet-4-6' });

    h.updateRun(id1, { tokensIn: 100, tokensOut: 50, costUsd: 0.01, durationMs: 1000, status: 'completed' });
    h.updateRun(id2, { tokensIn: 200, tokensOut: 100, costUsd: 0.02, durationMs: 2000, status: 'completed' });

    const stats = h.getStats();
    expect(stats.total_runs).toBe(2);
    expect(stats.total_tokens_in).toBe(300);
    expect(stats.total_cost_usd).toBeCloseTo(0.03);
    expect(stats.cost_by_model).toHaveLength(2);
    h.close();
  });

  it('handles prefix-based run lookup', () => {
    const h = createHistory();
    const id = h.insertRun({ taskText: 'Test', modelTier: 'opus', modelId: 'claude-opus-4-6' });
    const prefix = id.slice(0, 8);

    const run = h.getRun(prefix);
    expect(run).toBeDefined();
    expect(run!.id).toBe(id);
    h.close();
  });

  it('inserts and queries spawns', () => {
    const h = createHistory();
    const parentId = h.insertRun({ taskText: 'Parent', modelTier: 'opus', modelId: 'claude-opus-4-6' });
    const childId = h.insertRun({ taskText: 'Child', modelTier: 'sonnet', modelId: 'claude-sonnet-4-6', spawnParentId: parentId, spawnDepth: 1 });

    h.insertSpawn({ parentRunId: parentId, childRunId: childId, depth: 1 });

    const tree = h.getSpawnTree(parentId);
    expect(tree).toHaveLength(1);
    expect(tree[0]!.child_run_id).toBe(childId);

    const descendants = h.getRunWithDescendants(parentId);
    expect(descendants).toHaveLength(2);
    h.close();
  });

  it('handles batch parent/child', () => {
    const h = createHistory();
    const parentId = h.insertRun({
      taskText: 'Batch job',
      modelTier: 'opus',
      modelId: 'claude-opus-4-6',
      runType: 'batch_parent',
    });

    h.insertRun({
      taskText: 'Item 1',
      modelTier: 'sonnet',
      modelId: 'claude-sonnet-4-6',
      runType: 'batch_item',
      batchParentId: parentId,
    });
    const id2 = h.insertRun({
      taskText: 'Item 2',
      modelTier: 'sonnet',
      modelId: 'claude-sonnet-4-6',
      runType: 'batch_item',
      batchParentId: parentId,
    });
    h.updateRun(id2, { status: 'failed' });

    const items = h.getBatchRuns(parentId);
    expect(items).toHaveLength(2);

    const summary = h.getBatchSummary(parentId);
    expect(summary.total).toBe(2);
    expect(summary.failed).toBe(1);
    h.close();
  });

  it('runs migration idempotently', () => {
    const h = createHistory();
    // Second open should not fail
    const dbPath = (h as unknown as { db: { name: string } }).db.name;
    h.close();
    const h2 = new RunHistory(dbPath);
    expect(h2).toBeDefined();
    h2.close();
  });

  it('hashTask produces consistent 16-char hex', () => {
    expect(hashTask('hello')).toHaveLength(16);
    expect(hashTask('hello')).toBe(hashTask('hello'));
    expect(hashTask('hello')).not.toBe(hashTask('world'));
  });

  it('getCostByDay returns daily breakdown', () => {
    const h = createHistory();
    const id = h.insertRun({ taskText: 'Test', modelTier: 'opus', modelId: 'claude-opus-4-6' });
    h.updateRun(id, { costUsd: 0.05, status: 'completed' });

    const days = h.getCostByDay(7);
    expect(days.length).toBeGreaterThanOrEqual(1);
    expect(days[0]!.cost_usd).toBeCloseTo(0.05);
    h.close();
  });

  it('getCostByModel groups correctly', () => {
    const h = createHistory();
    const id1 = h.insertRun({ taskText: 'T1', modelTier: 'opus', modelId: 'claude-opus-4-6' });
    const id2 = h.insertRun({ taskText: 'T2', modelTier: 'sonnet', modelId: 'claude-sonnet-4-6' });
    h.updateRun(id1, { costUsd: 0.10 });
    h.updateRun(id2, { costUsd: 0.02 });

    const models = h.getCostByModel();
    expect(models.length).toBe(2);
    h.close();
  });

  // === v4 Pre-approval audit ===

  it('v4 migration creates pre_approval_sets table', () => {
    const h = createHistory();
    // If table doesn't exist, insertPreApprovalSet would throw
    h.insertPreApprovalSet({
      id: 'set-1',
      taskSummary: 'test',
      approvedBy: 'operator',
      patternsJson: '[]',
      maxUses: 10,
      ttlMs: 0,
    });
    const sets = h.getPreApprovalSets();
    expect(sets).toHaveLength(1);
    expect(sets[0]!.id).toBe('set-1');
    h.close();
  });

  it('v4 migration creates pre_approval_events table', () => {
    const h = createHistory();
    h.insertPreApprovalSet({
      id: 'set-ev', taskSummary: 'test', approvedBy: 'operator',
      patternsJson: '[]', maxUses: 10, ttlMs: 0,
    });
    h.insertPreApprovalEvent({
      setId: 'set-ev', patternIdx: 0, toolName: 'bash',
      matchString: 'npm run build', pattern: 'npm run *', decision: 'approved',
    });
    const events = h.getPreApprovalEvents('set-ev');
    expect(events).toHaveLength(1);
    expect(events[0]!.tool_name).toBe('bash');
    h.close();
  });

  it('insertPreApprovalSet stores correct data', () => {
    const h = createHistory();
    // Create a run to satisfy FK
    const runId = h.insertRun({ taskText: 'Test', modelTier: 'opus', modelId: 'claude-opus-4-6' });
    h.insertPreApprovalSet({
      id: 'set-full', taskSummary: 'Deploy',
      approvedBy: 'operator', patternsJson: '[{"tool":"bash"}]',
      maxUses: 5, ttlMs: 60000, runId,
    });
    const sets = h.getPreApprovalSets();
    expect(sets[0]!.task_summary).toBe('Deploy');
    expect(sets[0]!.max_uses).toBe(5);
    expect(sets[0]!.ttl_ms).toBe(60000);
    expect(sets[0]!.run_id).toBe(runId);
    h.close();
  });

  // === v6 Advisor queries ===

  describe('Advisor queries', () => {
    it('getRepeatTasks groups by hash and respects minCount', () => {
      const h = createHistory();
      for (let i = 0; i < 5; i++) {
        const id = h.insertRun({
          taskText: 'Same task',
          modelTier: 'opus',
          modelId: 'claude-opus-4-6',
          contextId: '/test',
        });
        h.updateRun(id, { status: 'completed' });
      }
      h.insertRun({
        taskText: 'Different task',
        modelTier: 'opus',
        modelId: 'claude-opus-4-6',
        contextId: '/test',
      });

      const repeats = h.getRepeatTasks('/test', 3, 7);
      expect(repeats).toHaveLength(1);
      expect(repeats[0]!.task_text).toBe('Same task');
      expect(repeats[0]!.run_count).toBe(5);
      h.close();
    });

    it('getRepeatTasks scopes to context id', () => {
      const h = createHistory();
      for (let i = 0; i < 5; i++) {
        h.insertRun({ taskText: 'Task', modelTier: 'opus', modelId: 'claude-opus-4-6', contextId: '/other' });
      }
      const repeats = h.getRepeatTasks('/test', 3, 7);
      expect(repeats).toHaveLength(0);
      h.close();
    });

    it('getFailurePatterns groups by model and error prefix', () => {
      const h = createHistory();
      for (let i = 0; i < 3; i++) {
        const id = h.insertRun({ taskText: `Fail ${i}`, modelTier: 'opus', modelId: 'claude-opus-4-6', contextId: '/test' });
        h.updateRun(id, { status: 'failed', responseText: 'Rate limit exceeded' });
      }
      const failures = h.getFailurePatterns('/test', 7);
      expect(failures).toHaveLength(1);
      expect(failures[0]!.fail_count).toBe(3);
      expect(failures[0]!.model_id).toBe('claude-opus-4-6');
      h.close();
    });

    it('getFailurePatterns returns empty for no failures', () => {
      const h = createHistory();
      const id = h.insertRun({ taskText: 'OK', modelTier: 'opus', modelId: 'claude-opus-4-6', contextId: '/test' });
      h.updateRun(id, { status: 'completed' });
      const failures = h.getFailurePatterns('/test', 7);
      expect(failures).toHaveLength(0);
      h.close();
    });

    it('getCacheEfficiency aggregates correctly', () => {
      const h = createHistory();
      for (let i = 0; i < 3; i++) {
        const id = h.insertRun({ taskText: `C${i}`, modelTier: 'opus', modelId: 'claude-opus-4-6', contextId: '/test' });
        h.updateRun(id, { tokensIn: 1000, tokensCacheRead: 200, tokensCacheWrite: 50 });
      }
      const cache = h.getCacheEfficiency('/test', 7);
      expect(cache).toBeDefined();
      expect(cache!.total_input).toBe(3000);
      expect(cache!.total_cache_read).toBe(600);
      expect(cache!.total_cache_write).toBe(150);
      expect(cache!.run_count).toBe(3);
      h.close();
    });

    it('getCacheEfficiency returns undefined for empty project', () => {
      const h = createHistory();
      const cache = h.getCacheEfficiency('/empty', 7);
      expect(cache).toBeUndefined();
      h.close();
    });

    it('getModelEfficiency returns per-model averages', () => {
      const h = createHistory();
      for (let i = 0; i < 2; i++) {
        const id = h.insertRun({ taskText: `O${i}`, modelTier: 'opus', modelId: 'claude-opus-4-6', contextId: '/test' });
        h.updateRun(id, { tokensOut: 1000, toolCallCount: 5, costUsd: 0.10, durationMs: 5000, status: 'completed' });
      }
      const id3 = h.insertRun({ taskText: 'S1', modelTier: 'sonnet', modelId: 'claude-sonnet-4-6', contextId: '/test' });
      h.updateRun(id3, { tokensOut: 200, toolCallCount: 2, costUsd: 0.01, durationMs: 2000, status: 'completed' });

      const models = h.getModelEfficiency('/test', 7);
      expect(models.length).toBe(2);
      const opus = models.find(m => m.model_id.includes('opus'));
      expect(opus).toBeDefined();
      expect(opus!.avg_tokens_out).toBe(1000);
      expect(opus!.run_count).toBe(2);
      h.close();
    });

    it('v6 migration is idempotent', () => {
      const h = createHistory();
      const dbPath = (h as unknown as { db: { name: string } }).db.name;
      h.close();
      // Re-open should not fail
      const h2 = new RunHistory(dbPath);
      expect(h2).toBeDefined();
      h2.close();
    });
  });

  it('getPreApprovalSummary returns totals', () => {
    const h = createHistory();
    h.insertPreApprovalSet({
      id: 'set-sum', taskSummary: 'test', approvedBy: 'operator',
      patternsJson: '[]', maxUses: 10, ttlMs: 0,
    });
    h.insertPreApprovalEvent({
      setId: 'set-sum', patternIdx: 0, toolName: 'bash',
      matchString: 'a', pattern: 'x', decision: 'approved',
    });
    h.insertPreApprovalEvent({
      setId: 'set-sum', patternIdx: 0, toolName: 'bash',
      matchString: 'b', pattern: 'x', decision: 'exhausted',
    });
    const summary = h.getPreApprovalSummary('set-sum');
    expect(summary).toBeDefined();
    expect(summary!.total_matches).toBe(1);
    expect(summary!.total_exhausted).toBe(1);
    h.close();
  });

  // === v7 Pipeline runs & step results ===

  describe('Pipeline runs (v7)', () => {
    it('insertPipelineRun creates a record', () => {
      const h = createHistory();
      h.insertPipelineRun({
        id: 'pipe-001',
        manifestName: 'test-pipeline',
        status: 'completed',
        manifestJson: '{"name":"test"}',
        totalDurationMs: 5000,
        totalCostUsd: 0.05,
        totalTokensIn: 1000,
        totalTokensOut: 500,
        stepCount: 3,
      });
      const run = h.getPipelineRun('pipe-001');
      expect(run).toBeDefined();
      expect(run!.id).toBe('pipe-001');
      expect(run!.manifest_name).toBe('test-pipeline');
      expect(run!.status).toBe('completed');
      expect(run!.total_duration_ms).toBe(5000);
      expect(run!.total_cost_usd).toBeCloseTo(0.05);
      expect(run!.total_tokens_in).toBe(1000);
      expect(run!.total_tokens_out).toBe(500);
      expect(run!.step_count).toBe(3);
      expect(run!.manifest_json).toBe('{"name":"test"}');
      h.close();
    });

    it('getRecentPipelineRuns returns records', () => {
      const h = createHistory();
      for (let i = 0; i < 5; i++) {
        h.insertPipelineRun({
          id: `pipe-${i}`,
          manifestName: `pipeline-${i}`,
          status: 'completed',
          manifestJson: '{}',
          stepCount: i + 1,
        });
      }
      const runs = h.getRecentPipelineRuns(3);
      expect(runs).toHaveLength(3);
      // Most recent first
      expect(runs[0]!.manifest_name).toBe('pipeline-4');
      h.close();
    });

    it('getPipelineRun retrieves by full ID', () => {
      const h = createHistory();
      h.insertPipelineRun({
        id: 'pipe-full-id',
        manifestName: 'my-pipe',
        status: 'running',
        manifestJson: '{}',
      });
      const run = h.getPipelineRun('pipe-full-id');
      expect(run).toBeDefined();
      expect(run!.id).toBe('pipe-full-id');
      h.close();
    });

    it('getPipelineRun retrieves by prefix', () => {
      const h = createHistory();
      h.insertPipelineRun({
        id: 'pipe-prefix-test-1234',
        manifestName: 'prefix-pipe',
        status: 'completed',
        manifestJson: '{}',
      });
      const run = h.getPipelineRun('pipe-prefix');
      expect(run).toBeDefined();
      expect(run!.id).toBe('pipe-prefix-test-1234');
      h.close();
    });

    it('insertPipelineStepResult creates step records', () => {
      const h = createHistory();
      h.insertPipelineRun({
        id: 'pipe-steps',
        manifestName: 'step-pipe',
        status: 'completed',
        manifestJson: '{}',
      });
      h.insertPipelineStepResult({
        pipelineRunId: 'pipe-steps',
        stepId: 'step-a',
        status: 'completed',
        result: 'output-a',
        durationMs: 1000,
        tokensIn: 200,
        tokensOut: 100,
        costUsd: 0.01,
      });
      const results = h.getPipelineStepResults('pipe-steps');
      expect(results).toHaveLength(1);
      expect(results[0]!.step_id).toBe('step-a');
      expect(results[0]!.status).toBe('completed');
      expect(results[0]!.result).toBe('output-a');
      expect(results[0]!.duration_ms).toBe(1000);
      expect(results[0]!.tokens_in).toBe(200);
      expect(results[0]!.tokens_out).toBe(100);
      expect(results[0]!.cost_usd).toBeCloseTo(0.01);
      h.close();
    });

    it('getPipelineStepResults returns step records for a pipeline', () => {
      const h = createHistory();
      h.insertPipelineRun({
        id: 'pipe-multi',
        manifestName: 'multi-pipe',
        status: 'completed',
        manifestJson: '{}',
      });
      h.insertPipelineStepResult({
        pipelineRunId: 'pipe-multi',
        stepId: 'step-1',
        status: 'completed',
        result: 'r1',
      });
      h.insertPipelineStepResult({
        pipelineRunId: 'pipe-multi',
        stepId: 'step-2',
        status: 'failed',
        error: 'timeout',
      });
      h.insertPipelineStepResult({
        pipelineRunId: 'pipe-multi',
        stepId: 'step-3',
        status: 'completed',
        result: 'r3',
      });

      const results = h.getPipelineStepResults('pipe-multi');
      expect(results).toHaveLength(3);
      expect(results[0]!.step_id).toBe('step-1');
      expect(results[1]!.step_id).toBe('step-2');
      expect(results[1]!.error).toBe('timeout');
      expect(results[2]!.step_id).toBe('step-3');
      h.close();
    });

    it('updatePipelineRun updates status and duration', () => {
      const h = createHistory();
      h.insertPipelineRun({
        id: 'pipe-update',
        manifestName: 'update-pipe',
        status: 'running',
        manifestJson: '{}',
      });
      h.updatePipelineRun('pipe-update', {
        status: 'completed',
        totalDurationMs: 12000,
        totalCostUsd: 0.15,
      });
      const run = h.getPipelineRun('pipe-update');
      expect(run).toBeDefined();
      expect(run!.status).toBe('completed');
      expect(run!.total_duration_ms).toBe(12000);
      expect(run!.total_cost_usd).toBeCloseTo(0.15);
      expect(run!.completed_at).toBeDefined();
      h.close();
    });

    it('empty pipeline runs returns empty array', () => {
      const h = createHistory();
      const runs = h.getRecentPipelineRuns();
      expect(runs).toHaveLength(0);
      const steps = h.getPipelineStepResults('nonexistent');
      expect(steps).toHaveLength(0);
      h.close();
    });
  });

  // === v8 Scope registry & embedding scope fields ===

  describe('Scope registry (v8)', () => {
    it('v8 migration creates scopes table with global seed', () => {
      const h = createHistory();
      const global = h.getScope('global');
      expect(global).toBeDefined();
      expect(global!.type).toBe('global');
      expect(global!.name).toBe('Global');
      h.close();
    });

    it('insertScope creates a scope', () => {
      const h = createHistory();
      h.insertScope('proj-abc', 'context', 'My Project');
      const scope = h.getScope('proj-abc');
      expect(scope).toBeDefined();
      expect(scope!.type).toBe('context');
      expect(scope!.name).toBe('My Project');
      h.close();
    });

    it('insertScope is idempotent (INSERT OR IGNORE)', () => {
      const h = createHistory();
      h.insertScope('user-alex', 'user', 'Alex');
      h.insertScope('user-alex', 'user', 'Alex Updated'); // Should not fail
      const scope = h.getScope('user-alex');
      expect(scope!.name).toBe('Alex'); // First insert wins
      h.close();
    });

    it('listScopes returns all scopes', () => {
      const h = createHistory();
      h.insertScope('proj-1', 'context', 'P1');
      h.insertScope('user-1', 'user', 'U1');
      const all = h.listScopes();
      expect(all.length).toBeGreaterThanOrEqual(3); // global + proj + user
      h.close();
    });

    it('listScopes filters by type', () => {
      const h = createHistory();
      h.insertScope('proj-t', 'context', 'P');
      h.insertScope('user-t', 'user', 'U');
      const contexts = h.listScopes('context');
      expect(contexts.every(s => s.type === 'context')).toBe(true);
      h.close();
    });

    it('deleteScope removes a scope', () => {
      const h = createHistory();
      h.insertScope('del-scope', 'user', 'ToDelete');
      const deleted = h.deleteScope('del-scope');
      expect(deleted).toBe(true);
      expect(h.getScope('del-scope')).toBeUndefined();
      h.close();
    });

    it('deleteScope returns false for non-existent scope', () => {
      const h = createHistory();
      const deleted = h.deleteScope('nonexistent');
      expect(deleted).toBe(false);
      h.close();
    });
  });

  describe('v8 migration preserves scopes', () => {
    it('v8 migration is idempotent', () => {
      const h = createHistory();
      const dbPath = (h as unknown as { db: { name: string } }).db.name;
      h.close();
      const h2 = new RunHistory(dbPath);
      expect(h2).toBeDefined();
      // Global scope should still exist
      expect(h2.getScope('global')).toBeDefined();
      h2.close();
    });
  });

  // === v16 Simplified scopes (global + context + user) ===

  describe('Simplified scopes (v16)', () => {
    it('v16 migration allows context scope type', () => {
      const h = createHistory();
      h.insertScope('ctx-acme', 'context', 'Acme Context');
      const scope = h.getScope('ctx-acme');
      expect(scope).toBeDefined();
      expect(scope!.type).toBe('context');
      expect(scope!.name).toBe('Acme Context');
      h.close();
    });

    it('v16 migration allows user scope type', () => {
      const h = createHistory();
      h.insertScope('user-1', 'user', 'User One');
      const scope = h.getScope('user-1');
      expect(scope).toBeDefined();
      expect(scope!.type).toBe('user');
      h.close();
    });

    it('v16 migration preserves existing scopes', () => {
      const h = createHistory();
      // Global should already exist from v8 seed
      expect(h.getScope('global')).toBeDefined();
      // Create a context scope
      h.insertScope('ctx-123', 'context', 'Test');
      expect(h.getScope('ctx-123')).toBeDefined();
      h.close();
    });

    it('v16 migration is idempotent', () => {
      const h = createHistory();
      const dbPath = (h as unknown as { db: { name: string } }).db.name;
      h.close();
      const h2 = new RunHistory(dbPath);
      expect(h2).toBeDefined();
      expect(h2.getScope('global')).toBeDefined();
      // Can insert context/user types
      h2.insertScope('ctx-test', 'context', 'Test Context');
      expect(h2.getScope('ctx-test')).toBeDefined();
      h2.close();
    });

    it('insertScope with parent_id sets hierarchy', () => {
      const h = createHistory();
      h.insertScope('ctx-a', 'context', 'Context A');
      h.insertScope('user-b', 'user', 'User B', 'ctx-a');
      const scope = h.getScope('user-b');
      expect(scope).toBeDefined();
      expect(scope!.parent_id).toBe('ctx-a');
      h.close();
    });

    it('deleteScope blocks when child scopes reference it', () => {
      const h = createHistory();
      h.insertScope('ctx-parent', 'context', 'Parent Context');
      h.insertScope('user-child', 'user', 'Child User', 'ctx-parent');
      const deleted = h.deleteScope('ctx-parent');
      expect(deleted).toBe(false);
      // Parent still exists
      expect(h.getScope('ctx-parent')).toBeDefined();
      h.close();
    });

    it('deleteScope succeeds when no children or embeddings', () => {
      const h = createHistory();
      h.insertScope('ctx-lonely', 'context', 'Lonely Context');
      const deleted = h.deleteScope('ctx-lonely');
      expect(deleted).toBe(true);
      expect(h.getScope('ctx-lonely')).toBeUndefined();
      h.close();
    });

    it('getScopeChildren returns direct children', () => {
      const h = createHistory();
      h.insertScope('ctx-root', 'context', 'Root');
      h.insertScope('user-a', 'user', 'User A', 'ctx-root');
      h.insertScope('user-b', 'user', 'User B', 'ctx-root');
      h.insertScope('ctx-x', 'context', 'Context X', 'user-a');
      const children = h.getScopeChildren('ctx-root');
      expect(children).toHaveLength(2);
      expect(children.map(c => c.id).sort()).toEqual(['user-a', 'user-b']);
      h.close();
    });

    it('getScopeChildren returns empty for leaf scope', () => {
      const h = createHistory();
      h.insertScope('leaf', 'user', 'Leaf');
      const children = h.getScopeChildren('leaf');
      expect(children).toHaveLength(0);
      h.close();
    });

    it('getScopeTree returns recursive hierarchy', () => {
      const h = createHistory();
      h.insertScope('ctx-top', 'context', 'Top');
      h.insertScope('user-mid', 'user', 'Mid', 'ctx-top');
      h.insertScope('ctx-leaf', 'context', 'Leaf', 'user-mid');
      const tree = h.getScopeTree('ctx-top');
      expect(tree).toHaveLength(3);
      expect(tree[0]!.id).toBe('ctx-top');
      expect(tree[0]!.depth).toBe(0);
      expect(tree[1]!.id).toBe('user-mid');
      expect(tree[1]!.depth).toBe(1);
      expect(tree[2]!.id).toBe('ctx-leaf');
      expect(tree[2]!.depth).toBe(2);
      h.close();
    });

    it('getScopeTree returns single node for leaf', () => {
      const h = createHistory();
      h.insertScope('single', 'user', 'Single');
      const tree = h.getScopeTree('single');
      expect(tree).toHaveLength(1);
      expect(tree[0]!.depth).toBe(0);
      h.close();
    });
  });

  // === v10 Advisor suggestion persistence ===

  describe('Advisor suggestions (v10)', () => {
    it('v10 migration is idempotent', () => {
      const h = createHistory();
      const dbPath = (h as unknown as { db: { name: string } }).db.name;
      h.close();
      const h2 = new RunHistory(dbPath);
      expect(h2).toBeDefined();
      h2.close();
    });

    it('getToolStats aggregates tool call data', () => {
      const h = createHistory();
      const runId = h.insertRun({ taskText: 'test', modelTier: 'opus', modelId: 'claude-opus-4-6', contextId: '/test/project' });
      h.insertToolCall({ runId, toolName: 'bash', inputJson: '{}', outputJson: 'error', durationMs: 100, sequenceOrder: 0 });
      h.insertToolCall({ runId, toolName: 'bash', inputJson: '{}', outputJson: '', durationMs: 200, sequenceOrder: 1 });
      h.insertToolCall({ runId, toolName: 'read_file', inputJson: '{}', outputJson: '', durationMs: 50, sequenceOrder: 2 });
      const stats = h.getToolStats('/test/project', 7);
      expect(stats.length).toBe(2);
      const bashStats = stats.find(s => s.tool_name === 'bash');
      expect(bashStats).toBeDefined();
      expect(bashStats!.call_count).toBe(2);
      expect(bashStats!.error_count).toBe(1);
      h.close();
    });

    it('getPipelineStepStats aggregates step data', () => {
      const h = createHistory();
      h.insertPipelineRun({ id: 'pr-1', manifestName: 'ci', status: 'completed', manifestJson: '{}' });
      h.insertPipelineStepResult({ pipelineRunId: 'pr-1', stepId: 'lint', status: 'completed', durationMs: 500 });
      h.insertPipelineStepResult({ pipelineRunId: 'pr-1', stepId: 'test', status: 'failed', durationMs: 1000 });
      const stats = h.getPipelineStepStats(7);
      expect(stats.length).toBe(2);
      const testStep = stats.find(s => s.step_id === 'test');
      expect(testStep).toBeDefined();
      expect(testStep!.fail_count).toBe(1);
      h.close();
    });

    it('getPipelineCostStats aggregates by manifest', () => {
      const h = createHistory();
      h.insertPipelineRun({ id: 'pc-1', manifestName: 'deploy', status: 'completed', manifestJson: '{}', totalCostUsd: 0.15 });
      h.insertPipelineRun({ id: 'pc-2', manifestName: 'deploy', status: 'completed', manifestJson: '{}', totalCostUsd: 0.25 });
      const stats = h.getPipelineCostStats(7);
      expect(stats.length).toBe(1);
      expect(stats[0]!.manifest_name).toBe('deploy');
      expect(stats[0]!.run_count).toBe(2);
      expect(stats[0]!.avg_cost_usd).toBe(0.2);
      h.close();
    });
  });

  // === getStaleEmbeddings + deleteEmbedding ===


  describe('getToolStats error counting', () => {
    it('counts only non-empty non-legacy output_json as errors', () => {
      const h = createHistory();
      const runId = h.insertRun({
        taskText: 'test',
        modelTier: 'opus',
        modelId: 'claude-opus-4-6',
        contextId: '/proj',
      });

      // Success: empty output_json
      h.insertToolCall({ runId, toolName: 'bash', inputJson: '{"cmd":"ls"}', outputJson: '', durationMs: 100, sequenceOrder: 0 });
      // Error: non-empty output_json with error message
      h.insertToolCall({ runId, toolName: 'bash', inputJson: '{"cmd":"bad"}', outputJson: 'command not found', durationMs: 50, sequenceOrder: 1 });
      // Legacy: output_json is '{}' (should not count as error)
      h.insertToolCall({ runId, toolName: 'bash', inputJson: '{}', outputJson: '{}', durationMs: 80, sequenceOrder: 2 });

      const stats = h.getToolStats('/proj', 7);
      const bashStats = stats.find(s => s.tool_name === 'bash');
      expect(bashStats).toBeDefined();
      expect(bashStats!.call_count).toBe(3);
      expect(bashStats!.error_count).toBe(1); // Only the actual error, not legacy '{}'
      h.close();
    });

    it('returns zero errors when all output_json are empty', () => {
      const h = createHistory();
      const runId = h.insertRun({
        taskText: 'test',
        modelTier: 'opus',
        modelId: 'claude-opus-4-6',
        contextId: '/proj',
      });

      h.insertToolCall({ runId, toolName: 'read_file', inputJson: '{"path":"/a.ts"}', outputJson: '', durationMs: 10, sequenceOrder: 0 });
      h.insertToolCall({ runId, toolName: 'read_file', inputJson: '{"path":"/b.ts"}', outputJson: '', durationMs: 15, sequenceOrder: 1 });

      const stats = h.getToolStats('/proj', 7);
      const readStats = stats.find(s => s.tool_name === 'read_file');
      expect(readStats).toBeDefined();
      expect(readStats!.error_count).toBe(0);
      h.close();
    });

    it('stores and retrieves tool input json', () => {
      const h = createHistory();
      const runId = h.insertRun({
        taskText: 'test',
        modelTier: 'opus',
        modelId: 'claude-opus-4-6',
      });

      const input = '{"command":"echo hello","timeout":5000}';
      h.insertToolCall({ runId, toolName: 'bash', inputJson: input, outputJson: '', durationMs: 100, sequenceOrder: 0 });

      const calls = h.getRunToolCalls(runId);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.input_json).toBe(input);
      h.close();
    });
  });

  describe('getSessionSummaries', () => {
    it('returns empty for no sessions', () => {
      const h = createHistory();
      const summaries = h.getSessionSummaries('/proj', 7);
      expect(summaries).toHaveLength(0);
      h.close();
    });

    it('groups runs by session_id', () => {
      const h = createHistory();
      h.insertRun({ sessionId: 'sess-aaa', taskText: 'A1', modelTier: 'opus', modelId: 'claude-opus-4-6', contextId: '/proj' });
      h.insertRun({ sessionId: 'sess-aaa', taskText: 'A2', modelTier: 'opus', modelId: 'claude-opus-4-6', contextId: '/proj' });
      h.insertRun({ sessionId: 'sess-bbb', taskText: 'B1', modelTier: 'sonnet', modelId: 'claude-sonnet-4-6', contextId: '/proj' });
      const summaries = h.getSessionSummaries('/proj', 7);
      expect(summaries).toHaveLength(2);
      const sessA = summaries.find(s => s.session_id === 'sess-aaa');
      expect(sessA).toBeDefined();
      expect(sessA!.run_count).toBe(2);
      h.close();
    });

    it('filters by context id', () => {
      const h = createHistory();
      h.insertRun({ sessionId: 'sess-1', taskText: 'X', modelTier: 'opus', modelId: 'claude-opus-4-6', contextId: '/other' });
      const summaries = h.getSessionSummaries('/proj', 7);
      expect(summaries).toHaveLength(0);
      h.close();
    });

    it('excludes empty session_id rows', () => {
      const h = createHistory();
      h.insertRun({ taskText: 'Legacy', modelTier: 'opus', modelId: 'claude-opus-4-6', contextId: '/proj' });
      h.insertRun({ sessionId: 'sess-c', taskText: 'New', modelTier: 'opus', modelId: 'claude-opus-4-6', contextId: '/proj' });
      const summaries = h.getSessionSummaries('/proj', 7);
      expect(summaries).toHaveLength(1);
      expect(summaries[0]!.session_id).toBe('sess-c');
      h.close();
    });

    it('deduplicates model_ids in GROUP_CONCAT', () => {
      const h = createHistory();
      h.insertRun({ sessionId: 'sess-d', taskText: 'D1', modelTier: 'opus', modelId: 'claude-opus-4-6', contextId: '/proj' });
      h.insertRun({ sessionId: 'sess-d', taskText: 'D2', modelTier: 'opus', modelId: 'claude-opus-4-6', contextId: '/proj' });
      h.insertRun({ sessionId: 'sess-d', taskText: 'D3', modelTier: 'sonnet', modelId: 'claude-sonnet-4-6', contextId: '/proj' });
      const summaries = h.getSessionSummaries('/proj', 7);
      expect(summaries).toHaveLength(1);
      const models = summaries[0]!.model_ids.split(',');
      expect(models).toHaveLength(2);
      expect(models).toContain('claude-opus-4-6');
      expect(models).toContain('claude-sonnet-4-6');
      h.close();
    });
  });

  // === getPromptVariantStats ===

  describe('getPromptVariantStats', () => {
    it('returns empty for no runs', () => {
      const h = createHistory();
      const stats = h.getPromptVariantStats('/proj', 7);
      expect(stats).toHaveLength(0);
      h.close();
    });

    it('groups by prompt_hash with correct aggregates', () => {
      const h = createHistory();
      // 3 runs with hash 'aaa', 1 failed
      for (let i = 0; i < 3; i++) {
        const id = h.insertRun({ taskText: `Task ${i}`, modelTier: 'opus', modelId: 'claude-opus-4-6', promptHash: 'aaa', contextId: '/proj' });
        h.updateRun(id, { tokensIn: 1000, tokensOut: 500, costUsd: 0.02, status: i === 2 ? 'failed' : 'completed', durationMs: 1000 });
      }
      // 2 runs with hash 'bbb'
      for (let i = 0; i < 2; i++) {
        const id = h.insertRun({ taskText: `Task B${i}`, modelTier: 'opus', modelId: 'claude-opus-4-6', promptHash: 'bbb', contextId: '/proj' });
        h.updateRun(id, { tokensIn: 2000, tokensOut: 800, costUsd: 0.05, status: 'completed', durationMs: 2000 });
      }
      const stats = h.getPromptVariantStats('/proj', 7);
      expect(stats).toHaveLength(2);
      const aaa = stats.find(s => s.prompt_hash === 'aaa')!;
      expect(aaa.run_count).toBe(3);
      expect(aaa.error_count).toBe(1);
      expect(aaa.avg_tokens_in).toBe(1000);
      const bbb = stats.find(s => s.prompt_hash === 'bbb')!;
      expect(bbb.run_count).toBe(2);
      expect(bbb.error_count).toBe(0);
      h.close();
    });

    it('filters by context_id', () => {
      const h = createHistory();
      const id1 = h.insertRun({ taskText: 'A', modelTier: 'opus', modelId: 'claude-opus-4-6', promptHash: 'h1', contextId: '/proj1' });
      h.updateRun(id1, { tokensIn: 100, tokensOut: 50, costUsd: 0.01, status: 'completed', durationMs: 100 });
      const id2 = h.insertRun({ taskText: 'B', modelTier: 'opus', modelId: 'claude-opus-4-6', promptHash: 'h2', contextId: '/proj2' });
      h.updateRun(id2, { tokensIn: 200, tokensOut: 100, costUsd: 0.02, status: 'completed', durationMs: 200 });
      const stats = h.getPromptVariantStats('/proj1', 7);
      expect(stats).toHaveLength(1);
      expect(stats[0]!.prompt_hash).toBe('h1');
      h.close();
    });

    it('excludes empty prompt_hash', () => {
      const h = createHistory();
      const id = h.insertRun({ taskText: 'No hash', modelTier: 'opus', modelId: 'claude-opus-4-6', contextId: '/proj' });
      h.updateRun(id, { tokensIn: 100, tokensOut: 50, costUsd: 0.01, status: 'completed', durationMs: 100 });
      const stats = h.getPromptVariantStats('/proj', 7);
      expect(stats).toHaveLength(0);
      h.close();
    });

    it('respects days parameter', () => {
      const h = createHistory();
      const id = h.insertRun({ taskText: 'Recent', modelTier: 'opus', modelId: 'claude-opus-4-6', promptHash: 'rr', contextId: '/proj' });
      h.updateRun(id, { tokensIn: 100, tokensOut: 50, costUsd: 0.01, status: 'completed', durationMs: 100 });
      // Within default 7 days, should be returned
      const stats = h.getPromptVariantStats('/proj', 7);
      expect(stats).toHaveLength(1);
      h.close();
    });
  });

  // === Run Deletion ===

  describe('deleteRun', () => {
    it('deletes a run and its tool calls', () => {
      const h = createHistory();
      const id = h.insertRun({ taskText: 'Delete me', modelTier: 'opus', modelId: 'claude-opus-4-6' });
      h.insertToolCall({ runId: id, toolName: 'bash', inputJson: '{}', outputJson: 'ok', durationMs: 10, sequenceOrder: 0 });

      expect(h.deleteRun(id)).toBe(true);
      expect(h.getRun(id)).toBeUndefined();
      expect(h.getRunToolCalls(id)).toHaveLength(0);
      h.close();
    });

    it('returns false for non-existent run', () => {
      const h = createHistory();
      expect(h.deleteRun('nonexistent-id-1')).toBe(false);
      h.close();
    });
  });

  describe('deleteRunsByContext', () => {
    it('deletes all runs for a context', () => {
      const h = createHistory();
      h.insertRun({ taskText: 'A', modelTier: 'opus', modelId: 'claude-opus-4-6', contextId: '/target' });
      h.insertRun({ taskText: 'B', modelTier: 'opus', modelId: 'claude-opus-4-6', contextId: '/target' });
      h.insertRun({ taskText: 'C', modelTier: 'opus', modelId: 'claude-opus-4-6', contextId: '/other' });

      const count = h.deleteRunsByContext('/target');
      expect(count).toBe(2);
      expect(h.getRecentRuns(10)).toHaveLength(1);
      h.close();
    });
  });

  describe('deleteRunsByTenant', () => {
    it('deletes all runs for a tenant', () => {
      const h = createHistory();
      const id1 = h.insertRun({ taskText: 'T1', modelTier: 'opus', modelId: 'claude-opus-4-6' });
      const id2 = h.insertRun({ taskText: 'T2', modelTier: 'opus', modelId: 'claude-opus-4-6' });
      h.insertRun({ taskText: 'T3', modelTier: 'opus', modelId: 'claude-opus-4-6' });

      // Insert tenant record for FK, then assign runs
      const db = (h as unknown as { db: import('better-sqlite3').Database }).db;
      db.prepare("INSERT INTO tenants (id, name, config_json) VALUES (?, ?, '{}')").run('tenant-a', 'Tenant A');
      db.prepare('UPDATE runs SET tenant_id = ? WHERE id = ?').run('tenant-a', id1);
      db.prepare('UPDATE runs SET tenant_id = ? WHERE id = ?').run('tenant-a', id2);

      const count = h.deleteRunsByTenant('tenant-a');
      expect(count).toBe(2);
      expect(h.getRecentRuns(10)).toHaveLength(1);
      h.close();
    });
  });

  describe('vacuum', () => {
    it('runs without error', () => {
      const h = createHistory();
      h.insertRun({ taskText: 'Vacuum test', modelTier: 'opus', modelId: 'claude-opus-4-6' });
      expect(() => h.vacuum()).not.toThrow();
      h.close();
    });
  });

  // === History Encryption ===

  describe('encryption', () => {
    function createEncryptedHistory(): RunHistory {
      const dir = mkdtempSync(join(tmpdir(), 'nodyn-hist-enc-'));
      tmpDirs.push(dir);
      return new RunHistory(join(dir, 'test.db'), 'test-vault-key-for-encryption');
    }

    it('encrypts and decrypts task_text round-trip', () => {
      const h = createEncryptedHistory();
      const id = h.insertRun({ taskText: 'Secret prompt here', modelTier: 'opus', modelId: 'claude-opus-4-6' });
      const run = h.getRun(id);
      expect(run!.task_text).toBe('Secret prompt here');
      h.close();
    });

    it('encrypts and decrypts response_text round-trip', () => {
      const h = createEncryptedHistory();
      const id = h.insertRun({ taskText: 'Test', modelTier: 'opus', modelId: 'claude-opus-4-6' });
      h.updateRun(id, { responseText: 'Secret response data' });
      const run = h.getRun(id);
      expect(run!.response_text).toBe('Secret response data');
      h.close();
    });

    it('encrypts and decrypts tool call data round-trip', () => {
      const h = createEncryptedHistory();
      const runId = h.insertRun({ taskText: 'T', modelTier: 'opus', modelId: 'claude-opus-4-6' });
      h.insertToolCall({ runId, toolName: 'bash', inputJson: '{"cmd":"secret"}', outputJson: 'secret output', durationMs: 10, sequenceOrder: 0 });
      const calls = h.getRunToolCalls(runId);
      expect(calls[0]!.input_json).toBe('{"cmd":"secret"}');
      expect(calls[0]!.output_json).toBe('secret output');
      h.close();
    });

    it('stored data is actually encrypted on disk', () => {
      const h = createEncryptedHistory();
      const id = h.insertRun({ taskText: 'Sensitive data must not appear in DB', modelTier: 'opus', modelId: 'claude-opus-4-6' });
      // Read raw from DB without decryption
      const raw = (h as unknown as { db: import('better-sqlite3').Database }).db
        .prepare('SELECT task_text FROM runs WHERE id = ?').get(id) as { task_text: string };
      expect(raw.task_text).not.toBe('Sensitive data must not appear in DB');
      expect(raw.task_text).toMatch(/^enc:/);
      h.close();
    });

    it('unencrypted history works without key (fallback)', () => {
      const h = createHistory(); // No encryption key
      const id = h.insertRun({ taskText: 'Plaintext task', modelTier: 'opus', modelId: 'claude-opus-4-6' });
      const run = h.getRun(id);
      expect(run!.task_text).toBe('Plaintext task');
      h.close();
    });

    it('search finds encrypted records', () => {
      const h = createEncryptedHistory();
      h.insertRun({ taskText: 'Find the secret login bug', modelTier: 'opus', modelId: 'claude-opus-4-6' });
      h.insertRun({ taskText: 'Write unit tests', modelTier: 'opus', modelId: 'claude-opus-4-6' });
      const results = h.searchRuns('secret login');
      expect(results).toHaveLength(1);
      expect(results[0]!.task_text).toContain('secret login');
      h.close();
    });
  });
});

