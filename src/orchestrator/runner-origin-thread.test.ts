/**
 * A pipeline run records the chat it was started from (`pipeline_runs.origin_thread_id`), nested
 * runs included, and on a provisioned instance a run from a chat whose record cannot be written
 * does not start.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Only the inline step is stubbed, so a step that runs is counted and a nested pipeline is real.
const mockSpawnInline = vi.fn().mockResolvedValue({ result: 'inline-r', tokensIn: 10, tokensOut: 5, durationMs: 3 });
vi.mock('./runtime-adapter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./runtime-adapter.js')>();
  return { ...actual, spawnInline: (...args: unknown[]) => mockSpawnInline(...args) };
});

import { runManifest } from './runner.js';
import { RunHistory } from '../core/run-history.js';
import type { Manifest } from '../types/orchestration.js';
import type { LynoxUserConfig, ToolEntry } from '../types/index.js';
import { chatOriginOf, type ChatOrigin } from './runtime-adapter.js';

const CONFIG: LynoxUserConfig = { api_key: 'test-key' };
const tools = [{ definition: { name: 'read_file', description: '', input_schema: { type: 'object' } }, handler: async () => 'x' }] as unknown as ToolEntry[];
const BASE = { manifest_version: '1.0', name: 'flow', triggered_by: 'test', context: {}, gate_points: [], on_failure: 'stop' } as const;
const STEP: Manifest = { ...BASE, agents: [{ id: 'step-1', agent: 'step-1', runtime: 'inline', task: 'do it' }] } as unknown as Manifest;
const NESTED: Manifest = { ...BASE, agents: [{ id: 'outer', agent: 'outer', runtime: 'pipeline', pipeline: [{ id: 'inner', task: 'do inner' }] }] } as unknown as Manifest;
const chat = (threadId: string): ChatOrigin => ({ threadId, skipsCapture: () => false });

let dirs: string[] = [];
function tmpHistory(): RunHistory {
  const d = mkdtempSync(join(tmpdir(), 'lynox-origin-run-'));
  dirs.push(d);
  return new RunHistory(join(d, 'history.db'));
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  mockSpawnInline.mockClear();
});

const rows = (h: RunHistory): { parent_run_id: string | null; origin_thread_id: string | null }[] =>
  h.getDb().prepare('SELECT parent_run_id, origin_thread_id FROM pipeline_runs ORDER BY started_at, rowid').all() as never;

describe('origin_thread_id', () => {
  it('is written from the chat origin, on the nested run as well', async () => {
    const h = tmpHistory();
    try {
      const state = await runManifest(NESTED, CONFIG, { source: { kind: 'adhoc' as const }, parentTools: tools, runHistory: h, chatOrigin: chat('chat-1') });
      expect(state.status).toBe('completed');
      expect(rows(h)).toEqual([
        { parent_run_id: null, origin_thread_id: 'chat-1' },
        { parent_run_id: state.runId, origin_thread_id: 'chat-1' },
      ]);
    } finally { h.close(); }
  }, 60_000);

  it('is NULL for a run no chat started (control)', async () => {
    const h = tmpHistory();
    try {
      await runManifest(STEP, CONFIG, { source: { kind: 'adhoc' as const }, parentTools: tools, runHistory: h });
      expect(rows(h)).toEqual([{ parent_run_id: null, origin_thread_id: null }]);
    } finally { h.close(); }
  }, 60_000);
});

/**
 * v72: the chat run whose turn started the workflow (`ChatOrigin.runId`) is on the pipeline run,
 * nested runs included, so the chat's footer counts the paid API calls a step sent.
 */
describe('started_by_run_id', () => {
  // The recorder the runner hands a step (`spawnInline`'s 12th argument) records the step's calls.
  const stepSendsPaidCall = (): void => {
    mockSpawnInline.mockImplementation(async (...args: unknown[]) => {
      const record = args[11] as ((call: object) => void) | undefined;
      record?.({ toolName: 'http_request', inputJson: '{}', outputJson: '', durationMs: 1, isError: false, apiCost: { usd: 0.05, source: 'response' } });
      return { result: 'inline-r', tokensIn: 10, tokensOut: 5, durationMs: 3 };
    });
  };
  it('is read off the calling agent\'s run (`chatOriginOf`)', () => {
    expect(chatOriginOf({ currentThreadId: 't-1', originThreadId: undefined, skipMemoryExtraction: false, currentRunId: 'run-7' }).runId).toBe('run-7');
    expect(chatOriginOf({ currentThreadId: 't-1', originThreadId: undefined, skipMemoryExtraction: false }).runId).toBeUndefined();
  });
  afterEach(() => { mockSpawnInline.mockReset(); mockSpawnInline.mockResolvedValue({ result: 'inline-r', tokensIn: 10, tokensOut: 5, durationMs: 3 }); });

  it('is written from the chat origin, on the nested run as well, and the chat run counts the step\'s paid call', async () => {
    const h = tmpHistory();
    try {
      stepSendsPaidCall();
      const chatRun = h.insertRun({ taskText: 'chat', modelTier: 'balanced', modelId: 'm' });
      const state = await runManifest(NESTED, CONFIG, { source: { kind: 'adhoc' as const }, parentTools: tools, runHistory: h, chatOrigin: { ...chat('chat-1'), runId: chatRun } });
      expect(state.status).toBe('completed');
      const started = h.getDb().prepare('SELECT started_by_run_id FROM pipeline_runs ORDER BY started_at, rowid').all() as { started_by_run_id: string | null }[];
      expect(started).toEqual([{ started_by_run_id: chatRun }, { started_by_run_id: chatRun }]);
      expect(mockSpawnInline).toHaveBeenCalledTimes(1);
      const sum = h.getApiCallsOfRun(chatRun);
      expect(sum.calls).toBe(1);
      expect(sum.usd).toBeCloseTo(0.05, 9);
    } finally { h.close(); }
  }, 60_000);

  it('is NULL, and the step\'s call counts for no chat run, when no chat turn started it (control)', async () => {
    const h = tmpHistory();
    try {
      stepSendsPaidCall();
      const chatRun = h.insertRun({ taskText: 'chat', modelTier: 'balanced', modelId: 'm' });
      await runManifest(STEP, CONFIG, { source: { kind: 'adhoc' as const }, parentTools: tools, runHistory: h, chatOrigin: chat('chat-1') });
      expect(h.getDb().prepare('SELECT started_by_run_id FROM pipeline_runs').all()).toEqual([{ started_by_run_id: null }]);
      expect(h.getApiCallsOfRun(chatRun).calls).toBe(0);
      // The call was recorded, on the step's own run.
      expect(h.getDb().prepare("SELECT COUNT(*) AS n FROM run_tool_calls WHERE api_cost_source = 'response'").get()).toEqual({ n: 1 });
    } finally { h.close(); }
  }, 60_000);
});

describe('a run whose record cannot be written', () => {
  const failingInsert = (h: RunHistory): void => {
    vi.spyOn(h, 'insertPipelineRun').mockImplementationOnce(() => { throw new Error('SQLITE_FULL'); });
  };

  it('from a chat on a provisioned instance: stops before its first step', async () => {
    vi.stubEnv('LYNOX_BILLING_TIER', 'managed');
    const h = tmpHistory();
    try {
      failingInsert(h);
      await expect(runManifest(STEP, CONFIG, { source: { kind: 'adhoc' as const }, parentTools: tools, runHistory: h, chatOrigin: chat('chat-1') }))
        .rejects.toThrow('This workflow run was not started: its record, which names the chat it runs for, could not be written. Try again later.');
      expect(mockSpawnInline).not.toHaveBeenCalled();
    } finally { h.close(); }
  }, 60_000);

  it('runs as before without a chat, or on an instance that is not provisioned (control)', async () => {
    const h = tmpHistory();
    try {
      failingInsert(h);
      expect((await runManifest(STEP, CONFIG, { source: { kind: 'adhoc' as const }, parentTools: tools, runHistory: h, chatOrigin: chat('chat-1') })).status).toBe('completed');
      vi.stubEnv('LYNOX_BILLING_TIER', 'managed');
      failingInsert(h);
      expect((await runManifest(STEP, CONFIG, { source: { kind: 'adhoc' as const }, parentTools: tools, runHistory: h })).status).toBe('completed');
      expect(mockSpawnInline).toHaveBeenCalledTimes(2);
    } finally { h.close(); }
  }, 60_000);
});
