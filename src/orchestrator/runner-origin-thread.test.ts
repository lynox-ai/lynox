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
import type { ChatOrigin } from './runtime-adapter.js';

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
      const state = await runManifest(NESTED, CONFIG, { parentTools: tools, runHistory: h, chatOrigin: chat('chat-1') });
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
      await runManifest(STEP, CONFIG, { parentTools: tools, runHistory: h });
      expect(rows(h)).toEqual([{ parent_run_id: null, origin_thread_id: null }]);
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
      await expect(runManifest(STEP, CONFIG, { parentTools: tools, runHistory: h, chatOrigin: chat('chat-1') }))
        .rejects.toThrow('This workflow run was not started: its record, which names the chat it runs for, could not be written. Try again later.');
      expect(mockSpawnInline).not.toHaveBeenCalled();
    } finally { h.close(); }
  }, 60_000);

  it('runs as before without a chat, or on an instance that is not provisioned (control)', async () => {
    const h = tmpHistory();
    try {
      failingInsert(h);
      expect((await runManifest(STEP, CONFIG, { parentTools: tools, runHistory: h, chatOrigin: chat('chat-1') })).status).toBe('completed');
      vi.stubEnv('LYNOX_BILLING_TIER', 'managed');
      failingInsert(h);
      expect((await runManifest(STEP, CONFIG, { parentTools: tools, runHistory: h })).status).toBe('completed');
      expect(mockSpawnInline).toHaveBeenCalledTimes(2);
    } finally { h.close(); }
  }, 60_000);
});
