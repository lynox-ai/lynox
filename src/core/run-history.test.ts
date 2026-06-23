import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import BetterSqlite3 from 'better-sqlite3';
import { RunHistory, hashTask } from './run-history.js';

describe('RunHistory', () => {
  const tmpDirs: string[] = [];

  function createHistory(): RunHistory {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-hist-'));
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
      modelTier: 'balanced',
      modelId: 'claude-sonnet-4-6',
    });
    expect(id).toHaveLength(36); // UUID format

    const run = h.getRun(id);
    expect(run).toBeDefined();
    expect(run!.task_text).toBe('Write hello world');
    expect(run!.model_tier).toBe('balanced');
    expect(run!.status).toBe('running');
    h.close();
  });

  it('records the provider a run executed on (v35)', () => {
    const h = createHistory();
    const id = h.insertRun({
      taskText: 'hybrid fast call',
      modelTier: 'fast',
      modelId: 'ministral-8b-2512',
      provider: 'mistral',
    });
    expect(h.getRun(id)!.provider).toBe('mistral');
    h.close();
  });

  it('defaults provider to empty string when unset (back-compat)', () => {
    const h = createHistory();
    const id = h.insertRun({ taskText: 'no provider', modelTier: 'balanced', modelId: 'claude-sonnet-4-6' });
    expect(h.getRun(id)!.provider).toBe('');
    h.close();
  });

  it('updates a run', () => {
    const h = createHistory();
    const id = h.insertRun({
      taskText: 'Test task',
      modelTier: 'deep',
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

  it('A2: updateRun stamps the resolved model_id + tool_call_count at a pipeline_step finalize', () => {
    const h = createHistory();
    // Mirror the runner's pipeline_step lifecycle: only the tier is known at
    // insert (concrete model id empty), then the resolved model + recorded
    // tool-call count are stamped at step end via updateRun.
    const id = h.insertRun({
      taskText: 'step task',
      modelTier: 'balanced',
      modelId: '',
      runType: 'pipeline_step',
    });
    expect(h.getRun(id)!.model_id).toBe('');
    expect(h.getRun(id)!.tool_call_count).toBe(0);

    h.updateRun(id, {
      status: 'completed',
      costUsd: 0.003,
      tokensIn: 6,
      tokensOut: 205,
      durationMs: 80,
      toolCallCount: 3,
      modelId: 'claude-sonnet-4-6',
    });

    const run = h.getRun(id)!;
    expect(run.model_id).toBe('claude-sonnet-4-6');
    expect(run.tool_call_count).toBe(3);
    expect(run.status).toBe('completed');
    h.close();
  });

  it('inserts and retrieves tool calls', () => {
    const h = createHistory();
    const runId = h.insertRun({
      taskText: 'Test',
      modelTier: 'deep',
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

  it('getSessionToolCalls gathers tool calls across all runs in a session', () => {
    const h = createHistory();
    // Two runs in the SAME session (one conversation, two turns).
    const runA = h.insertRun({ sessionId: 'thread-1', taskText: 'turn 1', modelTier: 'balanced', modelId: 'm' });
    h.insertToolCall({ runId: runA, toolName: 'http_request', inputJson: '{"url":"a"}', outputJson: 'ok', durationMs: 10, sequenceOrder: 0 });
    h.insertToolCall({ runId: runA, toolName: 'write_file', inputJson: '{"path":"r.pdf"}', outputJson: 'ok', durationMs: 20, sequenceOrder: 1 });

    const runB = h.insertRun({ sessionId: 'thread-1', taskText: 'turn 2', modelTier: 'balanced', modelId: 'm' });
    h.insertToolCall({ runId: runB, toolName: 'capture_process', inputJson: '{}', outputJson: 'ok', durationMs: 5, sequenceOrder: 0 });

    // A run in a DIFFERENT session — must not leak in.
    const runOther = h.insertRun({ sessionId: 'thread-2', taskText: 'other', modelTier: 'balanced', modelId: 'm' });
    h.insertToolCall({ runId: runOther, toolName: 'bash', inputJson: '{}', outputJson: 'ok', durationMs: 1, sequenceOrder: 0 });

    const sessionCalls = h.getSessionToolCalls('thread-1');
    // Run-creation order then sequence_order: runA[0], runA[1], runB[0].
    expect(sessionCalls.map(c => c.tool_name)).toEqual(['http_request', 'write_file', 'capture_process']);
    // Decryption preserved through the join.
    expect(sessionCalls[0]!.input_json).toBe('{"url":"a"}');
    expect(sessionCalls[1]!.output_json).toBe('ok');

    // No regression: single-run scope still returns only that run's calls.
    expect(h.getRunToolCalls(runB).map(c => c.tool_name)).toEqual(['capture_process']);
    expect(h.getRunToolCalls(runA).map(c => c.tool_name)).toEqual(['http_request', 'write_file']);

    // Other session is isolated.
    expect(h.getSessionToolCalls('thread-2').map(c => c.tool_name)).toEqual(['bash']);
    // Unknown session yields nothing.
    expect(h.getSessionToolCalls('nope')).toEqual([]);
    h.close();
  });

  it('getRunsBySession returns every run for a thread (ALL statuses), chronological + isolated', () => {
    const h = createHistory();
    const r1 = h.insertRun({ sessionId: 'thread-1', taskText: 'turn 1', modelTier: 'balanced', modelId: 'm' });
    h.updateRun(r1, { tokensIn: 100, costUsd: 0.01, status: 'completed' });
    const r2 = h.insertRun({ sessionId: 'thread-1', taskText: 'turn 2', modelTier: 'balanced', modelId: 'm' });
    h.updateRun(r2, { status: 'failed' }); // a FAILED turn must appear — debug needs it
    h.insertRun({ sessionId: 'thread-2', taskText: 'other', modelTier: 'balanced', modelId: 'm' });

    const runs = h.getRunsBySession('thread-1');
    expect(runs.map(r => r.task_text)).toEqual(['turn 1', 'turn 2']);     // chronological
    expect(runs.map(r => r.status)).toEqual(['completed', 'failed']);     // NOT filtered by status
    // Isolated from other threads; unknown session is empty.
    expect(h.getRunsBySession('thread-2').map(r => r.task_text)).toEqual(['other']);
    expect(h.getRunsBySession('nope')).toEqual([]);
    h.close();
  });

  it('Tier 2: round-trips composition_json (plaintext) + error_text (encrypted)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-hist-'));
    tmpDirs.push(dir);
    // An encryption key so error_text exercises the encrypt-at-rest path.
    const h = new RunHistory(join(dir, 'enc.db'), 'a-test-vault-key');
    const r1 = h.insertRun({ sessionId: 'thread-1', taskText: 'turn', modelTier: 'balanced', modelId: 'm' });
    const composition = JSON.stringify({ messageCount: 5, totalBytes: 12345, cacheReadTokens: 9000 });
    h.updateRun(r1, { status: 'completed', compositionJson: composition });
    const r2 = h.insertRun({ sessionId: 'thread-1', taskText: 'boom', modelTier: 'balanced', modelId: 'm' });
    h.updateRun(r2, { status: 'failed', errorText: '{"status":429,"type":"rate_limit_error"}' });

    const [run1, run2] = h.getRunsBySession('thread-1');
    expect(run1!.composition_json).toBe(composition);   // plaintext, verbatim
    expect(run1!.error_text).toBeNull();
    expect(run2!.error_text).toContain('rate_limit_error'); // decrypted back

    // error_text is stored encrypted at rest (raw row is NOT plaintext).
    const raw = new BetterSqlite3(join(dir, 'enc.db'))
      .prepare('SELECT error_text FROM runs WHERE id = ?').get(r2) as { error_text: string };
    expect(raw.error_text.startsWith('enc:')).toBe(true);
    // composition_json is NOT encrypted (counts, no PII) — stored verbatim.
    const rawComp = new BetterSqlite3(join(dir, 'enc.db'))
      .prepare('SELECT composition_json FROM runs WHERE id = ?').get(r1) as { composition_json: string };
    expect(rawComp.composition_json).toBe(composition);
    h.close();
  });

  it('Tier 2: records + retrieves compaction events per session, chronological + isolated', () => {
    const h = createHistory();
    h.insertCompactionEvent({ sessionId: 'thread-1', runId: 'run-a', trigger: 'auto', occupancyBefore: 160000, occupancyAfter: 8000, messagesBefore: 40, messagesAfter: 3, summaryChars: 1200 });
    h.insertCompactionEvent({ sessionId: 'thread-1', trigger: 'manual', occupancyBefore: 150000, occupancyAfter: 9000, messagesBefore: 38, messagesAfter: 4, summaryChars: 900 });
    h.insertCompactionEvent({ sessionId: 'thread-2', trigger: 'auto', occupancyBefore: 100, occupancyAfter: 50, messagesBefore: 2, messagesAfter: 1, summaryChars: 10 });

    const events = h.getCompactionEventsBySession('thread-1');
    expect(events.map(e => e.trigger)).toEqual(['auto', 'manual']);   // chronological
    expect(events[0]!.run_id).toBe('run-a');
    expect(events[1]!.run_id).toBeNull();                              // optional runId
    expect(events[0]!.occupancy_before).toBe(160000);
    expect(h.getCompactionEventsBySession('thread-2')).toHaveLength(1); // isolated
    expect(h.getCompactionEventsBySession('nope')).toEqual([]);
    h.close();
  });

  it('getThreadTotals sums cost + tokens across ALL runs in a session (the per-thread SSOT)', () => {
    const h = createHistory();
    const r1 = h.insertRun({ sessionId: 'thread-1', taskText: 'turn 1', modelTier: 'balanced', modelId: 'm' });
    h.updateRun(r1, { tokensIn: 100, tokensOut: 50, costUsd: 0.01, durationMs: 1000, status: 'completed' });
    const r2 = h.insertRun({ sessionId: 'thread-1', taskText: 'turn 2', modelTier: 'balanced', modelId: 'm' });
    h.updateRun(r2, { tokensIn: 200, tokensOut: 80, costUsd: 0.04, durationMs: 2000, status: 'completed' });
    // A spawned sub-run + a voice run in the same session also count toward the
    // thread's spend (matches the Run History per-thread group total).
    const child = h.insertRun({ sessionId: 'thread-1', taskText: 'sub', modelTier: 'balanced', modelId: 'm', spawnParentId: r2, spawnDepth: 1 });
    h.updateRun(child, { tokensIn: 10, tokensOut: 5, costUsd: 0.005, durationMs: 100, status: 'completed' });
    // A run in a different session must NOT leak in.
    const other = h.insertRun({ sessionId: 'thread-2', taskText: 'other', modelTier: 'balanced', modelId: 'm' });
    h.updateRun(other, { tokensIn: 999, tokensOut: 999, costUsd: 9.99, durationMs: 1, status: 'completed' });

    const totals = h.getThreadTotals('thread-1');
    expect(totals.cost_usd).toBeCloseTo(0.055, 6); // 0.01 + 0.04 + 0.005, NOT just the last turn
    expect(totals.tokens_in).toBe(310);
    expect(totals.tokens_out).toBe(135);
    // Empty / unknown session → zeros, never throws.
    expect(h.getThreadTotals('nope')).toEqual({ cost_usd: 0, tokens_in: 0, tokens_out: 0 });
    h.close();
  });

  it('getCostByDay buckets by the LOCAL day under a tz offset — proves the shift at a day edge', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-hist-'));
    tmpDirs.push(dir);
    const dbPath = join(dir, 'tz.db');
    const h = new RunHistory(dbPath);
    const r = h.insertRun({ sessionId: 's', taskText: 't', modelTier: 'balanced', modelId: 'm' });
    h.updateRun(r, { tokensIn: 1, tokensOut: 1, costUsd: 0.03, durationMs: 1, status: 'completed' });
    h.close();
    // Pin created_at to a fixed UTC time 30 min BEFORE midnight, so a +2h local
    // shift crosses into the next calendar day. A wide window keeps the row in
    // scope regardless of the test clock — the assertion is purely the BUCKET.
    const raw = new BetterSqlite3(dbPath);
    raw.prepare("UPDATE runs SET created_at = '2026-06-04 23:30:00' WHERE id = ?").run(r);
    raw.close();

    const h2 = new RunHistory(dbPath);
    const utc = h2.getCostByDay(3650, { tzOffsetMin: 0 });
    const local = h2.getCostByDay(3650, { tzOffsetMin: -120 }); // Zurich summer = UTC+2
    expect(utc[0]!.day).toBe('2026-06-04');   // UTC bucket
    expect(local[0]!.day).toBe('2026-06-05'); // shifted into the next LOCAL day
    expect(local[0]!.cost_usd).toBeCloseTo(0.03, 6);
    h2.close();
  });

  it('getStats user_turn_runs excludes voice + sub-runs (the headline RC-7 count)', () => {
    // (getRunCounts was removed as dead code — the user-turn headline is served
    // by getCostByDay.user_turns + getStats.user_turn_runs, both covered.)
    const h = createHistory();
    const t = h.insertRun({ sessionId: 's', taskText: 'turn', modelTier: 'balanced', modelId: 'm' });
    h.updateRun(t, { tokensIn: 1, tokensOut: 1, costUsd: 0.01, durationMs: 1, status: 'completed' });
    const voice = h.insertRun({ sessionId: 's', taskText: 'tts', modelTier: 'balanced', modelId: 'voxtral-tts', kind: 'voice_tts' });
    h.updateRun(voice, { tokensIn: 0, tokensOut: 0, costUsd: 0.002, durationMs: 1, status: 'completed' });
    const sub = h.insertRun({ sessionId: 's', taskText: 'sub', modelTier: 'balanced', modelId: 'm', spawnParentId: t, spawnDepth: 1 });
    h.updateRun(sub, { tokensIn: 1, tokensOut: 1, costUsd: 0.005, durationMs: 1, status: 'completed' });
    const stats = h.getStats();
    expect(stats.total_runs).toBe(3);
    expect(stats.user_turn_runs).toBe(1);
    h.close();
  });

  it('returns recent runs', () => {
    const h = createHistory();
    for (let i = 0; i < 5; i++) {
      h.insertRun({
        taskText: `Task ${i}`,
        modelTier: 'deep',
        modelId: 'claude-opus-4-6',
      });
    }

    const runs = h.getRecentRuns(3);
    expect(runs).toHaveLength(3);
    h.close();
  });

  it('searches runs by text', () => {
    const h = createHistory();
    h.insertRun({ taskText: 'Fix the login bug', modelTier: 'deep', modelId: 'claude-opus-4-6' });
    h.insertRun({ taskText: 'Write unit tests', modelTier: 'balanced', modelId: 'claude-sonnet-4-6' });

    const results = h.searchRuns('login');
    expect(results).toHaveLength(1);
    expect(results[0]!.task_text).toContain('login');
    h.close();
  });

  it('computes stats', () => {
    const h = createHistory();
    const id1 = h.insertRun({ taskText: 'Task 1', modelTier: 'deep', modelId: 'claude-opus-4-6' });
    // A Mistral model as a real chat turn — proves cost_by_model is a dynamic
    // GROUP BY model_id (Anthropic AND Mistral AND voice all aggregate), not a
    // fixed roster.
    const id2 = h.insertRun({ taskText: 'Task 2', modelTier: 'balanced', modelId: 'mistral-large-2512' });

    h.updateRun(id1, { tokensIn: 100, tokensOut: 50, costUsd: 0.01, durationMs: 1000, status: 'completed' });
    h.updateRun(id2, { tokensIn: 200, tokensOut: 100, costUsd: 0.02, durationMs: 2000, status: 'completed' });

    // Add a voice run + a spawned sub-run: total_runs counts them, the headline
    // user_turn_runs does not (RC-7 — "N runs" = chat turns).
    const v = h.insertRun({ taskText: 'tts', modelTier: 'balanced', modelId: 'voxtral-tts', kind: 'voice_tts' });
    h.updateRun(v, { tokensIn: 0, tokensOut: 0, costUsd: 0.002, durationMs: 10, status: 'completed' });
    const sub = h.insertRun({ taskText: 'sub', modelTier: 'balanced', modelId: 'm', spawnParentId: id2, spawnDepth: 1 });
    h.updateRun(sub, { tokensIn: 1, tokensOut: 1, costUsd: 0.001, durationMs: 10, status: 'completed' });

    const stats = h.getStats();
    expect(stats.total_runs).toBe(4);       // all rows
    expect(stats.user_turn_runs).toBe(2);   // only the 2 chat turns
    expect(stats.total_tokens_in).toBe(301);
    expect(stats.total_cost_usd).toBeCloseTo(0.033);
    expect(stats.cost_by_model).toHaveLength(4); // opus, mistral-large-2512, voxtral-tts, m
    // Mistral LLM model aggregates exactly like the Anthropic ones.
    expect(stats.cost_by_model.find(m => m.model_id === 'mistral-large-2512')).toBeDefined();
    h.close();
  });

  it('handles prefix-based run lookup', () => {
    const h = createHistory();
    const id = h.insertRun({ taskText: 'Test', modelTier: 'deep', modelId: 'claude-opus-4-6' });
    const prefix = id.slice(0, 8);

    const run = h.getRun(prefix);
    expect(run).toBeDefined();
    expect(run!.id).toBe(id);
    h.close();
  });

  it('inserts and queries spawns', () => {
    const h = createHistory();
    const parentId = h.insertRun({ taskText: 'Parent', modelTier: 'deep', modelId: 'claude-opus-4-6' });
    const childId = h.insertRun({ taskText: 'Child', modelTier: 'balanced', modelId: 'claude-sonnet-4-6', spawnParentId: parentId, spawnDepth: 1 });

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
      modelTier: 'deep',
      modelId: 'claude-opus-4-6',
      runType: 'batch_parent',
    });

    h.insertRun({
      taskText: 'Item 1',
      modelTier: 'balanced',
      modelId: 'claude-sonnet-4-6',
      runType: 'batch_item',
      batchParentId: parentId,
    });
    const id2 = h.insertRun({
      taskText: 'Item 2',
      modelTier: 'balanced',
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
    const id = h.insertRun({ taskText: 'Test', modelTier: 'deep', modelId: 'claude-opus-4-6' });
    h.updateRun(id, { costUsd: 0.05, status: 'completed' });

    const days = h.getCostByDay(7);
    expect(days.length).toBeGreaterThanOrEqual(1);
    expect(days[0]!.cost_usd).toBeCloseTo(0.05);
    h.close();
  });

  it('getCostByModel groups correctly', () => {
    const h = createHistory();
    const id1 = h.insertRun({ taskText: 'T1', modelTier: 'deep', modelId: 'claude-opus-4-6' });
    const id2 = h.insertRun({ taskText: 'T2', modelTier: 'balanced', modelId: 'claude-sonnet-4-6' });
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
    const runId = h.insertRun({ taskText: 'Test', modelTier: 'deep', modelId: 'claude-opus-4-6' });
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
          modelTier: 'deep',
          modelId: 'claude-opus-4-6',
          contextId: '/test',
        });
        h.updateRun(id, { status: 'completed' });
      }
      h.insertRun({
        taskText: 'Different task',
        modelTier: 'deep',
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
        h.insertRun({ taskText: 'Task', modelTier: 'deep', modelId: 'claude-opus-4-6', contextId: '/other' });
      }
      const repeats = h.getRepeatTasks('/test', 3, 7);
      expect(repeats).toHaveLength(0);
      h.close();
    });

    it('getFailurePatterns groups by model and error prefix', () => {
      const h = createHistory();
      for (let i = 0; i < 3; i++) {
        const id = h.insertRun({ taskText: `Fail ${i}`, modelTier: 'deep', modelId: 'claude-opus-4-6', contextId: '/test' });
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
      const id = h.insertRun({ taskText: 'OK', modelTier: 'deep', modelId: 'claude-opus-4-6', contextId: '/test' });
      h.updateRun(id, { status: 'completed' });
      const failures = h.getFailurePatterns('/test', 7);
      expect(failures).toHaveLength(0);
      h.close();
    });

    it('getCacheEfficiency aggregates correctly', () => {
      const h = createHistory();
      for (let i = 0; i < 3; i++) {
        const id = h.insertRun({ taskText: `C${i}`, modelTier: 'deep', modelId: 'claude-opus-4-6', contextId: '/test' });
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
        const id = h.insertRun({ taskText: `O${i}`, modelTier: 'deep', modelId: 'claude-opus-4-6', contextId: '/test' });
        h.updateRun(id, { tokensOut: 1000, toolCallCount: 5, costUsd: 0.10, durationMs: 5000, status: 'completed' });
      }
      const id3 = h.insertRun({ taskText: 'S1', modelTier: 'balanced', modelId: 'claude-sonnet-4-6', contextId: '/test' });
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

    // PRD-HN-LAUNCH-HARDENING T2-W2 — saved workflows (planned templates)
    // share the `pipeline_runs` table with actual runs under `status='planned'`
    // and must NOT surface in the Workflows run-history tab.
    it('getRecentPipelineRuns excludes status=planned rows (templates / plans)', () => {
      const h = createHistory();
      // Two saved-workflow templates living in pipeline_runs as planned rows.
      h.insertPlannedPipeline({
        id: 'tpl-a', name: 'Saved A', goal: 'g',
        steps: [{ id: 's', task: 't' }],
        reasoning: 'r', estimatedCost: 0.01,
        createdAt: new Date().toISOString(),
      } as Parameters<typeof h.insertPlannedPipeline>[0]);
      h.insertPlannedPipeline({
        id: 'tpl-b', name: 'Saved B', goal: 'g',
        steps: [{ id: 's', task: 't' }],
        reasoning: 'r', estimatedCost: 0.01,
        createdAt: new Date().toISOString(),
      } as Parameters<typeof h.insertPlannedPipeline>[0]);
      // Two genuine executions.
      h.insertPipelineRun({
        id: 'run-1', manifestName: 'real-run-1', status: 'completed', manifestJson: '{}',
      });
      h.insertPipelineRun({
        id: 'run-2', manifestName: 'real-run-2', status: 'failed', manifestJson: '{}',
      });

      const recent = h.getRecentPipelineRuns(10);
      expect(recent).toHaveLength(2);
      expect(recent.every((r) => r.status !== 'planned')).toBe(true);
      expect(recent.map((r) => r.id).sort()).toEqual(['run-1', 'run-2']);
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

  // === Saved Workflows library (PRD-WORKFLOW-UX D13) ===

  describe('Planned pipelines library (D13)', () => {
    // insertPlannedPipeline serializes the whole object into manifest_json,
    // so anything extra (template flag) round-trips inside it.
    function insertPlanned(
      h: ReturnType<typeof createHistory>,
      id: string,
      name: string,
      extra: Record<string, unknown> = {},
    ): void {
      h.insertPlannedPipeline({
        id, name, goal: `goal-${name}`,
        steps: [{ id: 'step-1', task: 'do' }],
        reasoning: 'r', estimatedCost: 0.01,
        createdAt: new Date().toISOString(),
        ...extra,
      } as Parameters<typeof h.insertPlannedPipeline>[0]);
    }

    it('getPlannedPipelines returns only status=planned rows, newest first', () => {
      const h = createHistory();
      insertPlanned(h, 'plan-a', 'first');
      insertPlanned(h, 'plan-b', 'second');
      // A non-planned run must not surface here.
      h.insertPipelineRun({ id: 'exec-1', manifestName: 'executed', status: 'completed', manifestJson: '{}' });
      const list = h.getPlannedPipelines(10);
      expect(list).toHaveLength(2);
      expect(list.map((r) => r.id).sort()).toEqual(['plan-a', 'plan-b']);
      expect(list.every((r) => typeof r.manifest_json === 'string')).toBe(true);
      h.close();
    });

    it('getPlannedPipelines respects the limit', () => {
      const h = createHistory();
      for (let i = 0; i < 5; i++) insertPlanned(h, `plan-${i}`, `wf-${i}`);
      expect(h.getPlannedPipelines(3)).toHaveLength(3);
      h.close();
    });

    it('getPlannedPipelines manifest_json carries the template flag', () => {
      const h = createHistory();
      insertPlanned(h, 'plan-tpl', 'tpl', { template: true });
      const [row] = h.getPlannedPipelines(10);
      const parsed = JSON.parse(row!.manifest_json) as { template?: boolean };
      expect(parsed.template).toBe(true);
      h.close();
    });

    it('renamePlannedPipeline updates manifest_name AND manifest_json name', () => {
      const h = createHistory();
      insertPlanned(h, 'plan-rn', 'old name');
      expect(h.renamePlannedPipeline('plan-rn', 'new name')).toBe(true);
      const [row] = h.getPlannedPipelines(10);
      expect(row!.manifest_name).toBe('new name');
      // The name also lives inside manifest_json — the library list and
      // getPipeline's SQLite fallback prefer it, so the rename must propagate
      // there too, else it is a visible no-op.
      expect((JSON.parse(row!.manifest_json) as { name: string }).name).toBe('new name');
      h.close();
    });

    it('renamePlannedPipeline returns false for an unknown id', () => {
      const h = createHistory();
      expect(h.renamePlannedPipeline('nope', 'x')).toBe(false);
      h.close();
    });

    it('renamePlannedPipeline does not rename a non-planned run', () => {
      const h = createHistory();
      h.insertPipelineRun({ id: 'exec-2', manifestName: 'done', status: 'completed', manifestJson: '{}' });
      expect(h.renamePlannedPipeline('exec-2', 'hacked')).toBe(false);
      h.close();
    });

    it('deletePlannedPipeline removes the row and returns true', () => {
      const h = createHistory();
      insertPlanned(h, 'plan-del', 'doomed');
      expect(h.deletePlannedPipeline('plan-del')).toBe(true);
      expect(h.getPlannedPipelines(10)).toHaveLength(0);
      h.close();
    });

    it('deletePlannedPipeline returns false for an unknown id', () => {
      const h = createHistory();
      expect(h.deletePlannedPipeline('ghost')).toBe(false);
      h.close();
    });

    it('deletePlannedPipeline does not delete a non-planned run', () => {
      const h = createHistory();
      h.insertPipelineRun({ id: 'exec-3', manifestName: 'done', status: 'completed', manifestJson: '{}' });
      expect(h.deletePlannedPipeline('exec-3')).toBe(false);
      expect(h.getPipelineRun('exec-3')).toBeDefined();
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
      const runId = h.insertRun({ taskText: 'test', modelTier: 'deep', modelId: 'claude-opus-4-6', contextId: '/test/project' });
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
        modelTier: 'deep',
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
        modelTier: 'deep',
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
        modelTier: 'deep',
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
      h.insertRun({ sessionId: 'sess-aaa', taskText: 'A1', modelTier: 'deep', modelId: 'claude-opus-4-6', contextId: '/proj' });
      h.insertRun({ sessionId: 'sess-aaa', taskText: 'A2', modelTier: 'deep', modelId: 'claude-opus-4-6', contextId: '/proj' });
      h.insertRun({ sessionId: 'sess-bbb', taskText: 'B1', modelTier: 'balanced', modelId: 'claude-sonnet-4-6', contextId: '/proj' });
      const summaries = h.getSessionSummaries('/proj', 7);
      expect(summaries).toHaveLength(2);
      const sessA = summaries.find(s => s.session_id === 'sess-aaa');
      expect(sessA).toBeDefined();
      expect(sessA!.run_count).toBe(2);
      h.close();
    });

    it('filters by context id', () => {
      const h = createHistory();
      h.insertRun({ sessionId: 'sess-1', taskText: 'X', modelTier: 'deep', modelId: 'claude-opus-4-6', contextId: '/other' });
      const summaries = h.getSessionSummaries('/proj', 7);
      expect(summaries).toHaveLength(0);
      h.close();
    });

    it('excludes empty session_id rows', () => {
      const h = createHistory();
      h.insertRun({ taskText: 'Legacy', modelTier: 'deep', modelId: 'claude-opus-4-6', contextId: '/proj' });
      h.insertRun({ sessionId: 'sess-c', taskText: 'New', modelTier: 'deep', modelId: 'claude-opus-4-6', contextId: '/proj' });
      const summaries = h.getSessionSummaries('/proj', 7);
      expect(summaries).toHaveLength(1);
      expect(summaries[0]!.session_id).toBe('sess-c');
      h.close();
    });

    it('deduplicates model_ids in GROUP_CONCAT', () => {
      const h = createHistory();
      h.insertRun({ sessionId: 'sess-d', taskText: 'D1', modelTier: 'deep', modelId: 'claude-opus-4-6', contextId: '/proj' });
      h.insertRun({ sessionId: 'sess-d', taskText: 'D2', modelTier: 'deep', modelId: 'claude-opus-4-6', contextId: '/proj' });
      h.insertRun({ sessionId: 'sess-d', taskText: 'D3', modelTier: 'balanced', modelId: 'claude-sonnet-4-6', contextId: '/proj' });
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
        const id = h.insertRun({ taskText: `Task ${i}`, modelTier: 'deep', modelId: 'claude-opus-4-6', promptHash: 'aaa', contextId: '/proj' });
        h.updateRun(id, { tokensIn: 1000, tokensOut: 500, costUsd: 0.02, status: i === 2 ? 'failed' : 'completed', durationMs: 1000 });
      }
      // 2 runs with hash 'bbb'
      for (let i = 0; i < 2; i++) {
        const id = h.insertRun({ taskText: `Task B${i}`, modelTier: 'deep', modelId: 'claude-opus-4-6', promptHash: 'bbb', contextId: '/proj' });
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
      const id1 = h.insertRun({ taskText: 'A', modelTier: 'deep', modelId: 'claude-opus-4-6', promptHash: 'h1', contextId: '/proj1' });
      h.updateRun(id1, { tokensIn: 100, tokensOut: 50, costUsd: 0.01, status: 'completed', durationMs: 100 });
      const id2 = h.insertRun({ taskText: 'B', modelTier: 'deep', modelId: 'claude-opus-4-6', promptHash: 'h2', contextId: '/proj2' });
      h.updateRun(id2, { tokensIn: 200, tokensOut: 100, costUsd: 0.02, status: 'completed', durationMs: 200 });
      const stats = h.getPromptVariantStats('/proj1', 7);
      expect(stats).toHaveLength(1);
      expect(stats[0]!.prompt_hash).toBe('h1');
      h.close();
    });

    it('excludes empty prompt_hash', () => {
      const h = createHistory();
      const id = h.insertRun({ taskText: 'No hash', modelTier: 'deep', modelId: 'claude-opus-4-6', contextId: '/proj' });
      h.updateRun(id, { tokensIn: 100, tokensOut: 50, costUsd: 0.01, status: 'completed', durationMs: 100 });
      const stats = h.getPromptVariantStats('/proj', 7);
      expect(stats).toHaveLength(0);
      h.close();
    });

    it('respects days parameter', () => {
      const h = createHistory();
      const id = h.insertRun({ taskText: 'Recent', modelTier: 'deep', modelId: 'claude-opus-4-6', promptHash: 'rr', contextId: '/proj' });
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
      const id = h.insertRun({ taskText: 'Delete me', modelTier: 'deep', modelId: 'claude-opus-4-6' });
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
      h.insertRun({ taskText: 'A', modelTier: 'deep', modelId: 'claude-opus-4-6', contextId: '/target' });
      h.insertRun({ taskText: 'B', modelTier: 'deep', modelId: 'claude-opus-4-6', contextId: '/target' });
      h.insertRun({ taskText: 'C', modelTier: 'deep', modelId: 'claude-opus-4-6', contextId: '/other' });

      const count = h.deleteRunsByContext('/target');
      expect(count).toBe(2);
      expect(h.getRecentRuns(10)).toHaveLength(1);
      h.close();
    });
  });

  describe('deleteRunsByTenant', () => {
    it('deletes all runs for a tenant', () => {
      const h = createHistory();
      const id1 = h.insertRun({ taskText: 'T1', modelTier: 'deep', modelId: 'claude-opus-4-6' });
      const id2 = h.insertRun({ taskText: 'T2', modelTier: 'deep', modelId: 'claude-opus-4-6' });
      h.insertRun({ taskText: 'T3', modelTier: 'deep', modelId: 'claude-opus-4-6' });

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
      h.insertRun({ taskText: 'Vacuum test', modelTier: 'deep', modelId: 'claude-opus-4-6' });
      expect(() => h.vacuum()).not.toThrow();
      h.close();
    });
  });

  // === History Encryption ===

  describe('encryption', () => {
    function createEncryptedHistory(): RunHistory {
      const dir = mkdtempSync(join(tmpdir(), 'lynox-hist-enc-'));
      tmpDirs.push(dir);
      return new RunHistory(join(dir, 'test.db'), 'test-vault-key-for-encryption');
    }

    it('encrypts and decrypts task_text round-trip', () => {
      const h = createEncryptedHistory();
      const id = h.insertRun({ taskText: 'Secret prompt here', modelTier: 'deep', modelId: 'claude-opus-4-6' });
      const run = h.getRun(id);
      expect(run!.task_text).toBe('Secret prompt here');
      h.close();
    });

    it('encrypts and decrypts response_text round-trip', () => {
      const h = createEncryptedHistory();
      const id = h.insertRun({ taskText: 'Test', modelTier: 'deep', modelId: 'claude-opus-4-6' });
      h.updateRun(id, { responseText: 'Secret response data' });
      const run = h.getRun(id);
      expect(run!.response_text).toBe('Secret response data');
      h.close();
    });

    it('encrypts and decrypts tool call data round-trip', () => {
      const h = createEncryptedHistory();
      const runId = h.insertRun({ taskText: 'T', modelTier: 'deep', modelId: 'claude-opus-4-6' });
      h.insertToolCall({ runId, toolName: 'bash', inputJson: '{"cmd":"secret"}', outputJson: 'secret output', durationMs: 10, sequenceOrder: 0 });
      const calls = h.getRunToolCalls(runId);
      expect(calls[0]!.input_json).toBe('{"cmd":"secret"}');
      expect(calls[0]!.output_json).toBe('secret output');
      h.close();
    });

    it('stored data is actually encrypted on disk', () => {
      const h = createEncryptedHistory();
      const id = h.insertRun({ taskText: 'Sensitive data must not appear in DB', modelTier: 'deep', modelId: 'claude-opus-4-6' });
      // Read raw from DB without decryption
      const raw = (h as unknown as { db: import('better-sqlite3').Database }).db
        .prepare('SELECT task_text FROM runs WHERE id = ?').get(id) as { task_text: string };
      expect(raw.task_text).not.toBe('Sensitive data must not appear in DB');
      expect(raw.task_text).toMatch(/^enc:/);
      h.close();
    });

    it('unencrypted history works without key (fallback)', () => {
      const h = createHistory(); // No encryption key
      const id = h.insertRun({ taskText: 'Plaintext task', modelTier: 'deep', modelId: 'claude-opus-4-6' });
      const run = h.getRun(id);
      expect(run!.task_text).toBe('Plaintext task');
      h.close();
    });

    it('search finds encrypted records', () => {
      const h = createEncryptedHistory();
      h.insertRun({ taskText: 'Find the secret login bug', modelTier: 'deep', modelId: 'claude-opus-4-6' });
      h.insertRun({ taskText: 'Write unit tests', modelTier: 'deep', modelId: 'claude-opus-4-6' });
      const results = h.searchRuns('secret login');
      expect(results).toHaveLength(1);
      expect(results[0]!.task_text).toContain('secret login');
      h.close();
    });
  });

  // === v28 — voice/LLM split (Usage Dashboard Phase 0) ===

  describe('kind + units (v28)', () => {
    it('defaults kind to null and units to 0 for legacy LLM rows', () => {
      const h = createHistory();
      const id = h.insertRun({ taskText: 'Chat', modelTier: 'balanced', modelId: 'claude-sonnet-4-6' });
      const run = h.getRun(id);
      expect(run!.kind).toBeNull();
      expect(run!.units).toBe(0);
      h.close();
    });

    it('stores kind=voice_tts with character count in units', () => {
      const h = createHistory();
      const id = h.insertRun({
        taskText: 'Read this aloud.',
        modelTier: 'voice',
        modelId: 'voxtral-mini-tts-latest',
        kind: 'voice_tts',
        units: 16,
      });
      const run = h.getRun(id);
      expect(run!.kind).toBe('voice_tts');
      expect(run!.units).toBe(16);
      expect(run!.model_id).toBe('voxtral-mini-tts-latest');
      h.close();
    });

    it('stores kind=voice_stt with seconds placeholder in units', () => {
      const h = createHistory();
      const id = h.insertRun({
        taskText: 'transcribed text',
        modelTier: 'voice',
        modelId: 'voxtral-mini-transcribe',
        kind: 'voice_stt',
        units: 0,
      });
      const run = h.getRun(id);
      expect(run!.kind).toBe('voice_stt');
      expect(run!.units).toBe(0);
      h.close();
    });

    it('kind index exists so per-kind aggregation is fast', () => {
      const h = createHistory();
      const idxRows = (h as unknown as { db: import('better-sqlite3').Database }).db
        .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='runs'`)
        .all() as Array<{ name: string }>;
      const names = idxRows.map(r => r.name);
      expect(names).toContain('idx_runs_kind');
      h.close();
    });
  });

  // === Usage Dashboard Phase 1 — getUsageSummary ===

  describe('getUsageSummary', () => {
    // Insert a completed run with a caller-controlled created_at so we can
    // test period windows deterministically without sleep()ing.
    function insertAt(h: RunHistory, createdAt: string, params: Parameters<RunHistory['insertRun']>[0], done: Parameters<RunHistory['updateRun']>[1]) {
      const id = h.insertRun(params);
      h.updateRun(id, done);
      (h as unknown as { db: import('better-sqlite3').Database }).db
        .prepare('UPDATE runs SET created_at = ? WHERE id = ?')
        .run(createdAt, id);
      return id;
    }

    it('aggregates by_model, by_kind and used_cents within the window', () => {
      const h = createHistory();
      // Two LLM runs + one voice_tts run, all inside the window.
      insertAt(h, '2026-04-10T12:00:00.000Z', {
        taskText: 'A', modelTier: 'balanced', modelId: 'claude-sonnet-4-6',
      }, { tokensIn: 100, tokensOut: 50, costUsd: 0.10, status: 'completed' });
      insertAt(h, '2026-04-11T12:00:00.000Z', {
        taskText: 'B', modelTier: 'fast', modelId: 'claude-haiku-4-5',
      }, { tokensIn: 200, tokensOut: 30, costUsd: 0.02, status: 'completed' });
      insertAt(h, '2026-04-12T12:00:00.000Z', {
        taskText: 'Speak', modelTier: 'voice', modelId: 'voxtral-mini-tts-latest',
        kind: 'voice_tts', units: 200,
      }, { costUsd: 0.0032, status: 'completed' });

      const s = h.getUsageSummary({
        startIso: '2026-04-01T00:00:00.000Z',
        endIso:   '2026-05-01T00:00:00.000Z',
        source: 'calendar-month',
        label: 'Apr 1 – Apr 30',
      });

      expect(s.used_cents).toBe(Math.round((0.10 + 0.02 + 0.0032) * 100));
      expect(s.by_model.map(m => m.model_id).sort()).toEqual([
        'claude-haiku-4-5', 'claude-sonnet-4-6', 'voxtral-mini-tts-latest',
      ]);
      const byKind = Object.fromEntries(s.by_kind.map(k => [k.kind, k]));
      expect(byKind['llm']!.run_count).toBe(2);
      expect(byKind['llm']!.unit_count).toBe(100 + 50 + 200 + 30);
      expect(byKind['llm']!.unit_label).toBe('tokens');
      expect(byKind['voice_tts']!.run_count).toBe(1);
      expect(byKind['voice_tts']!.unit_count).toBe(200);
      expect(byKind['voice_tts']!.unit_label).toBe('characters');
      h.close();
    });

    it('legacy rows with kind=null count as llm', () => {
      const h = createHistory();
      insertAt(h, '2026-04-05T00:00:00.000Z', {
        taskText: 'old', modelTier: 'balanced', modelId: 'claude-sonnet-4-6',
      }, { tokensIn: 10, tokensOut: 5, costUsd: 0.01, status: 'completed' });

      const s = h.getUsageSummary({
        startIso: '2026-04-01T00:00:00.000Z',
        endIso:   '2026-05-01T00:00:00.000Z',
        source: 'calendar-month',
        label: 'Apr',
      });

      expect(s.by_kind.length).toBe(1);
      expect(s.by_kind[0]!.kind).toBe('llm');
      expect(s.by_kind[0]!.unit_count).toBe(15);
      h.close();
    });

    it('window excludes rows outside [start, end)', () => {
      const h = createHistory();
      insertAt(h, '2026-03-31T23:59:59.000Z', {
        taskText: 'pre',  modelTier: 'balanced', modelId: 'claude-sonnet-4-6',
      }, { costUsd: 0.99, status: 'completed' });
      insertAt(h, '2026-04-15T12:00:00.000Z', {
        taskText: 'in',   modelTier: 'balanced', modelId: 'claude-sonnet-4-6',
      }, { costUsd: 0.10, status: 'completed' });
      insertAt(h, '2026-05-01T00:00:00.000Z', {
        taskText: 'post', modelTier: 'balanced', modelId: 'claude-sonnet-4-6',
      }, { costUsd: 0.99, status: 'completed' });

      const s = h.getUsageSummary({
        startIso: '2026-04-01T00:00:00.000Z',
        endIso:   '2026-05-01T00:00:00.000Z',
        source: 'calendar-month',
        label: 'Apr',
      });

      expect(s.used_cents).toBe(10);
      h.close();
    });

    it('zero-fills daily entries so the UI sparkline has no gaps', () => {
      const h = createHistory();
      insertAt(h, '2026-04-10T12:00:00.000Z', {
        taskText: 'x', modelTier: 'balanced', modelId: 'claude-sonnet-4-6',
      }, { costUsd: 0.05, status: 'completed' });

      const s = h.getUsageSummary({
        startIso: '2026-04-08T00:00:00.000Z',
        endIso:   '2026-04-15T00:00:00.000Z',
        source: 'rolling',
        label: '7d',
      });

      expect(s.daily.length).toBe(7);
      const apr10 = s.daily.find(d => d.date === '2026-04-10');
      expect(apr10!.cost_cents).toBe(5);
      const apr09 = s.daily.find(d => d.date === '2026-04-09');
      expect(apr09!.cost_cents).toBe(0);
      h.close();
    });

    it('skips running + failed rows from aggregates', () => {
      const h = createHistory();
      // completed — counts
      insertAt(h, '2026-04-10T12:00:00.000Z', {
        taskText: 'ok', modelTier: 'balanced', modelId: 'claude-sonnet-4-6',
      }, { costUsd: 0.10, status: 'completed' });
      // running — excluded
      insertAt(h, '2026-04-11T12:00:00.000Z', {
        taskText: 'live', modelTier: 'balanced', modelId: 'claude-sonnet-4-6',
      }, { costUsd: 0.99 });
      // failed — excluded
      insertAt(h, '2026-04-12T12:00:00.000Z', {
        taskText: 'bad', modelTier: 'balanced', modelId: 'claude-sonnet-4-6',
      }, { costUsd: 0.99, status: 'failed' });

      const s = h.getUsageSummary({
        startIso: '2026-04-01T00:00:00.000Z',
        endIso:   '2026-05-01T00:00:00.000Z',
        source: 'calendar-month',
        label: 'Apr',
      });

      expect(s.used_cents).toBe(10);
      expect(s.by_kind.reduce((n, k) => n + k.run_count, 0)).toBe(1);
      h.close();
    });

    // Regression — HN-launch P0 billing-summary-zero.
    // `used_cents` MUST be rebuilt from `daily` so the dashboard tiles
    // ("Monat bis dato", "Heute"), the bar chart, and `by_kind` all read
    // the same SSoT bit-for-bit. Previously `used_cents` was a separate
    // SUM over `byModelRows`, which could (and did) drift to 0 on staging
    // while `daily` and `by_kind` carried real spend.
    it('used_cents equals sum(daily.cost_cents) — the chart-SSoT contract', () => {
      const h = createHistory();
      insertAt(h, '2026-04-10T12:00:00.000Z', {
        taskText: 'a', modelTier: 'balanced', modelId: 'claude-sonnet-4-6',
      }, { costUsd: 0.07, status: 'completed' });
      insertAt(h, '2026-04-15T12:00:00.000Z', {
        taskText: 'b', modelTier: 'fast', modelId: 'claude-haiku-4-5',
      }, { costUsd: 0.05, status: 'completed' });

      const s = h.getUsageSummary({
        startIso: '2026-04-01T00:00:00.000Z',
        endIso:   '2026-05-01T00:00:00.000Z',
        source: 'calendar-month',
        label: 'Apr',
      });

      const dailySum = s.daily.reduce((n, d) => n + d.cost_cents, 0);
      expect(s.used_cents).toBe(dailySum);
      expect(s.used_cents).toBe(12);
      h.close();
    });

    // Regression — HN-launch P0 billing-summary-zero.
    // When `daily` and `by_kind` carry spend, `used_cents` MUST NOT be 0.
    // This is the exact symptom staging exhibited: by_kind[llm]=$19.69,
    // daily had non-zero entries, but used_cents=0 → the budget tile read
    // "$0.00 of $20.00" while runs were burning credit.
    it('used_cents matches by_kind sum when daily and by_kind agree', () => {
      const h = createHistory();
      insertAt(h, '2026-04-10T12:00:00.000Z', {
        taskText: 'llm', modelTier: 'balanced', modelId: 'claude-sonnet-4-6',
      }, { tokensIn: 100, tokensOut: 50, costUsd: 0.10, status: 'completed' });
      insertAt(h, '2026-04-11T12:00:00.000Z', {
        taskText: 'llm2', modelTier: 'fast', modelId: 'claude-haiku-4-5',
      }, { tokensIn: 200, tokensOut: 30, costUsd: 0.02, status: 'completed' });

      const s = h.getUsageSummary({
        startIso: '2026-04-01T00:00:00.000Z',
        endIso:   '2026-05-01T00:00:00.000Z',
        source: 'calendar-month',
        label: 'Apr',
      });

      const byKindSum = s.by_kind.reduce((n, k) => n + k.cost_cents, 0);
      const dailySum = s.daily.reduce((n, d) => n + d.cost_cents, 0);
      expect(s.used_cents).toBe(byKindSum);
      expect(s.used_cents).toBe(dailySum);
      expect(s.used_cents).toBe(12);
      h.close();
    });
  });

  // T1-2 regression — see PRD-HN-LAUNCH-HARDENING §3.
  // SQLite CHECK constraints cannot be ALTERed away; the v31 migration
  // recreates the tasks table to widen the status enum from
  // {open,in_progress,completed} to {open,in_progress,completed,failed}.
  describe('v31 migration — tasks.status widens to include failed', () => {
    it('accepts INSERT with status=failed after migration', () => {
      const h = createHistory();
      h.insertTask({ id: 'tfail', title: 'Failed task' });
      // Direct UPDATE through the wrapper (matches the recordTaskRun path)
      h.updateTask('tfail', { status: 'failed' });
      const t = h.getTask('tfail');
      expect(t).toBeDefined();
      expect(t!.status).toBe('failed');
      h.close();
    });

    it('preserves pre-existing tasks across the migration', () => {
      const h = createHistory();
      // Create a task in every status the OLD constraint allowed, then
      // re-open the database. The migration runs again (idempotent) on
      // the second open and the rows must still be there with their
      // original status intact.
      h.insertTask({ id: 'ta', title: 'A', status: 'open' });
      h.insertTask({ id: 'tb', title: 'B', status: 'in_progress' });
      h.insertTask({ id: 'tc', title: 'C', status: 'completed' });
      const dbPath = (h as unknown as { db: { name: string } }).db.name;
      h.close();

      const h2 = new RunHistory(dbPath);
      expect(h2.getTask('ta')!.status).toBe('open');
      expect(h2.getTask('tb')!.status).toBe('in_progress');
      expect(h2.getTask('tc')!.status).toBe('completed');
      // And the new status is accepted post-reopen as well.
      h2.insertTask({ id: 'td', title: 'D' });
      h2.updateTask('td', { status: 'failed' });
      expect(h2.getTask('td')!.status).toBe('failed');
      h2.close();
    });

    it('still rejects an invalid status value', () => {
      const h = createHistory();
      h.insertTask({ id: 'tbad', title: 'Bad' });
      // 'cancelled' is not in the enum — the recreated CHECK must still
      // refuse arbitrary strings.
      expect(() => h.updateTask('tbad', { status: 'cancelled' })).toThrow();
      h.close();
    });

    it('preserves indexes — all seven idx_tasks_* recreated post-migration', () => {
      const h = createHistory();
      // Direct sqlite_master assertion — a botched migration that dropped
      // an index would still let getDueTasks return the row on tiny data
      // (full-scan), so we pin the seven indexes the v31 recreate emits.
      const db = (h as unknown as { db: { prepare(sql: string): { all(): Array<{ name: string }> } } }).db;
      const idxNames = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='tasks' AND name LIKE 'idx_tasks_%'`,
      ).all().map(r => r.name).sort();
      expect(idxNames).toEqual([
        'idx_tasks_assignee',
        'idx_tasks_due_date',
        'idx_tasks_next_run',
        'idx_tasks_parent',
        'idx_tasks_scope',
        'idx_tasks_status',
        'idx_tasks_type',
      ]);

      // Plus the existing functional smoke that getDueTasks works.
      h.insertTask({
        id: 'tdue',
        title: 'Due',
        nextRunAt: '2020-01-01T00:00:00.000Z',
      });
      const due = h.getDueTasks();
      expect(due.some(t => t.id === 'tdue')).toBe(true);
      h.close();
    });

    it('a ONE-SHOT row written as status=failed is excluded from getDueTasks even with a stale next_run_at', () => {
      // Defence in depth: recordTaskRun clears next_run_at when it
      // moves a one-shot task to 'failed', but the SELECT also excludes
      // failed one-shot rows so a malformed row (e.g. surfaced by a
      // future bug) cannot re-introduce the runaway loop.
      const h = createHistory();
      h.insertTask({
        id: 'tstale',
        title: 'Stale failed',
        status: 'failed',
        nextRunAt: '2020-01-01T00:00:00.000Z',
      });
      const due = h.getDueTasks();
      expect(due.some(t => t.id === 'tstale')).toBe(false);
      h.close();
    });

    it('a CRON row with status=failed IS picked up by getDueTasks (recurrence keeps firing)', () => {
      // Counterpart to the one-shot exclusion above: cron tasks must
      // survive a transient failure. The SELECT exempts rows where
      // schedule_cron IS NOT NULL from the failed-status filter so a
      // failed daily cron (e.g. an API-health probe that 500ed once)
      // still re-runs tomorrow. recordTaskRun re-derives status from
      // the next run, so a success flips it back to 'open'.
      const h = createHistory();
      h.insertTask({
        id: 'tcronfail',
        title: 'Failed daily cron',
        status: 'failed',
        scheduleCron: '0 9 * * *',
        nextRunAt: '2020-01-01T00:00:00.000Z',
      });
      const due = h.getDueTasks();
      expect(due.some(t => t.id === 'tcronfail')).toBe(true);
      h.close();
    });
  });

  // === A2 observability: pipeline_step run rows ===
  describe('pipeline_step observability overlay', () => {
    function insertCompleted(h: RunHistory, params: Parameters<RunHistory['insertRun']>[0], cost: number, createdAt?: string): string {
      const id = h.insertRun(params);
      h.updateRun(id, { tokensIn: 100, tokensOut: 50, costUsd: cost, durationMs: 10, status: 'completed' });
      if (createdAt) {
        (h as unknown as { db: import('better-sqlite3').Database }).db
          .prepare('UPDATE runs SET created_at = ? WHERE id = ?').run(createdAt, id);
      }
      return id;
    }

    it('a pipeline_step run NEVER moves spend/stats/usage aggregates (the billing invariant)', () => {
      const h = createHistory();
      const parent = insertCompleted(h, { sessionId: 's', taskText: 'real turn', modelTier: 'balanced', modelId: 'claude-sonnet-4-6' }, 0.10, '2026-04-10T12:00:00.000Z');

      const usageOpts = { startIso: '2026-04-01T00:00:00.000Z', endIso: '2026-05-01T00:00:00.000Z', source: 'calendar-month' as const, label: 'Apr' };
      const before = {
        stats: JSON.stringify(h.getStats()),
        costByDay: JSON.stringify(h.getCostByDay(3650)),
        costByModel: JSON.stringify(h.getCostByModel()),
        usage: JSON.stringify(h.getUsageSummary(usageOpts)),
      };

      // A real, completed, costly pipeline_step row — exactly what the runner writes.
      insertCompleted(h, {
        sessionId: parent, taskText: 'step-1', modelTier: 'balanced', modelId: 'claude-sonnet-4-6',
        runType: 'pipeline_step', spawnParentId: parent, spawnDepth: 1,
      }, 0.05, '2026-04-10T12:00:05.000Z');

      const after = {
        stats: JSON.stringify(h.getStats()),
        costByDay: JSON.stringify(h.getCostByDay(3650)),
        costByModel: JSON.stringify(h.getCostByModel()),
        usage: JSON.stringify(h.getUsageSummary(usageOpts)),
      };

      expect(after.stats).toBe(before.stats);
      expect(after.costByDay).toBe(before.costByDay);
      expect(after.costByModel).toBe(before.costByModel);
      expect(after.usage).toBe(before.usage); // the GET /api/usage/summary billing surface
      h.close();
    });

    it('getSessionToolCalls excludes a pipeline_step row even when its session_id collides with a chat session', () => {
      const h = createHistory();
      const chat = h.insertRun({ sessionId: 'thread-1', taskText: 'turn', modelTier: 'balanced', modelId: 'm' });
      h.insertToolCall({ runId: chat, toolName: 'bash', inputJson: '{"command":"ls"}', outputJson: 'ok', durationMs: 1, sequenceOrder: 0 });
      // Worst case: a pipeline_step row sharing the chat session_id. The run_type
      // filter (not session_id) is what keeps its REPLAYED calls out of capture.
      const step = h.insertRun({ sessionId: 'thread-1', taskText: 'step', modelTier: 'balanced', modelId: 'm', runType: 'pipeline_step', spawnParentId: 'p', spawnDepth: 1 });
      h.insertToolCall({ runId: step, toolName: 'http', inputJson: '{"url":"x"}', outputJson: 'ok', durationMs: 1, sequenceOrder: 0 });

      expect(h.getSessionToolCalls('thread-1').map(c => c.tool_name)).toEqual(['bash']);
      h.close();
    });

    it('a step\'s tool calls ARE queryable under its own pipeline_step run id (run-detail view)', () => {
      const h = createHistory();
      const step = h.insertRun({ taskText: 'step', modelTier: 'balanced', modelId: 'm', runType: 'pipeline_step', spawnParentId: 'p', spawnDepth: 1 });
      h.insertToolCall({ runId: step, toolName: 'bash', inputJson: '{"command":"echo hi"}', outputJson: 'hi', durationMs: 5, sequenceOrder: 0 });
      h.insertToolCall({ runId: step, toolName: 'write_file', inputJson: '{"path":"/tmp/x"}', outputJson: '', durationMs: 3, sequenceOrder: 1 });

      const calls = h.getRunToolCalls(step);
      expect(calls.map(c => c.tool_name)).toEqual(['bash', 'write_file']);
      h.close();
    });

    it('does NOT surface as a phantom thread in getThreadAggregates (its non-empty run-id session would otherwise leak)', () => {
      const h = createHistory();
      const chat = h.insertRun({ sessionId: 'thread-1', taskText: 'turn', modelTier: 'balanced', modelId: 'm' });
      h.updateRun(chat, { costUsd: 0.01, status: 'completed' });
      const step = h.insertRun({ sessionId: 'pipeline-run-99', taskText: 'step', modelTier: 'balanced', modelId: 'm', runType: 'pipeline_step', spawnParentId: 'pipeline-run-99', spawnDepth: 1 });
      h.updateRun(step, { costUsd: 0.05, status: 'completed' });

      const threads = h.getThreadAggregates();
      expect(threads.map(t => t.sessionId)).toEqual(['thread-1']); // not 'pipeline-run-99'
      h.close();
    });

    it('getToolCallCountSince excludes pipeline_step calls — A2 must not change tool rate-limiting', () => {
      const h = createHistory();
      const chat = h.insertRun({ sessionId: 's', taskText: 't', modelTier: 'balanced', modelId: 'm' });
      h.insertToolCall({ runId: chat, toolName: 'http', inputJson: '{}', outputJson: 'ok', durationMs: 1, sequenceOrder: 0 });
      const step = h.insertRun({ taskText: 'step', modelTier: 'balanced', modelId: 'm', runType: 'pipeline_step', spawnParentId: 'p', spawnDepth: 1 });
      h.insertToolCall({ runId: step, toolName: 'http', inputJson: '{}', outputJson: 'ok', durationMs: 1, sequenceOrder: 0 });

      expect(h.getToolCallCountSince('http', 24)).toBe(1); // only the chat turn's call counts
      h.close();
    });

    it('getRecentRuns hides pipeline_step from the general list, but an explicit session filter drills into them', () => {
      const h = createHistory();
      const chat = h.insertRun({ sessionId: 'thread-1', taskText: 'turn', modelTier: 'balanced', modelId: 'm' });
      h.updateRun(chat, { status: 'completed' });
      const step = h.insertRun({ sessionId: 'pipeline-run-1', taskText: 'step', modelTier: 'balanced', modelId: 'm', runType: 'pipeline_step', spawnParentId: 'pipeline-run-1', spawnDepth: 1 });
      h.updateRun(step, { status: 'completed' });

      const general = h.getRecentRuns(20);
      expect(general.map(r => r.id)).toContain(chat);
      expect(general.map(r => r.id)).not.toContain(step);

      // Run-detail drill-down by the pipeline run id still returns the step rows.
      const drill = h.getRecentRuns(20, 0, { sessionId: 'pipeline-run-1' });
      expect(drill.map(r => r.id)).toEqual([step]);
      h.close();
    });
  });
});

