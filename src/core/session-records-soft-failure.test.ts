/**
 * A tool call the tool reports as not done reaches `run_tool_calls` as a failed row, through the
 * real Session sink: the Agent hands the record to the Session, and the Session writes it with
 * RunHistory. Only the model and the session analysis are mocked; the engine, the Session, the
 * save_workflow tool and history.db are the real ones.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic { beta = { messages: { stream: vi.fn() } }; }
  class APIError extends Error {}
  return { default: MockAnthropic, APIError };
});

const mockProcess = vi.fn();
vi.mock('./stream.js', () => ({
  StreamProcessor: vi.fn().mockImplementation(function (this: { process: typeof mockProcess }) {
    this.process = mockProcess;
  }),
}));

const captureProcessMock = vi.fn();
vi.mock('./process-capture.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./process-capture.js')>()),
  captureProcess: (...args: unknown[]) => captureProcessMock(...args),
}));

import { Engine } from './engine.js';
import { reloadConfig } from './config.js';
import type { LynoxConfig, ProcessRecord } from '../types/index.js';
import type { ToolCallRecord } from './run-history.js';

const endTurn = (text: string) => ({
  content: [{ type: 'text' as const, text }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 },
});
const toolUse = (name: string, input: unknown, id: string) => ({
  content: [{ type: 'tool_use' as const, id, name, input }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 },
});

const SENT = 'größe.SENT';

function record(paramName: string, sourceRunId: string): ProcessRecord {
  return {
    id: 'proc-1', name: 'Report', description: 'd', sourceRunId, createdAt: new Date().toISOString(),
    steps: [{ order: 0, tool: 'read_file', description: `Read {{${paramName}}}`, inputTemplate: { path: `{{${paramName}}}` }, dependsOn: [] }],
    parameters: [{ name: paramName, description: 'the file', type: 'string', source: 'user_input' }],
  } as ProcessRecord;
}

describe('the Session writes a call its tool reports as not done as a failed row', () => {
  const dirs: string[] = [];
  const engines: Engine[] = [];

  afterEach(async () => {
    for (const e of engines) { try { await e.shutdown(); } catch { /* best effort */ } }
    engines.length = 0;
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
    vi.unstubAllEnvs();
    reloadConfig();
    mockProcess.mockReset();
    captureProcessMock.mockReset();
  });

  /**
   * One turn: a read_file call (so the session has work to save), then save_workflow, then the end.
   * Returns the run's tool rows, and how many session captures history.db holds (a save writes one last).
   */
  async function runSave(paramName: string): Promise<{ rows: ToolCallRecord[]; captures: number }> {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-soft-failure-row-'));
    dirs.push(dir);
    // Nothing from the caller's shell reaches the engine: no vault key, no instance id, no other
    // provider, no error sink.
    for (const k of ['LYNOX_VAULT_KEY', 'LYNOX_MANAGED_INSTANCE_ID', 'LYNOX_BUGSINK_DSN', 'LYNOX_LLM_PROVIDER', 'MISTRAL_API_KEY']) vi.stubEnv(k, undefined);
    vi.stubEnv('LYNOX_DATA_DIR', dir);
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key-not-real');
    // The run's retrieval would embed with the default ONNX provider, which downloads a model on
    // first use; the local provider needs no network.
    vi.stubEnv('LYNOX_EMBEDDING_PROVIDER', 'local');
    reloadConfig();
    const engine = new Engine({} as LynoxConfig);
    engines.push(engine);
    await engine.init();
    // The record names the run it was captured from, as the real capture does with its first argument.
    captureProcessMock.mockImplementation(async (runId: unknown) => record(paramName, runId as string));
    mockProcess
      .mockResolvedValueOnce(toolUse('read_file', { path: join(dir, 'missing.txt') }, 'tu-read'))
      .mockResolvedValueOnce(toolUse('save_workflow', { name: 'Report' }, 'tu-save'))
      .mockResolvedValueOnce(endTurn('done'));
    const session = engine.createSession();
    await session.run('go');
    const history = engine.getRunHistory()!;
    const runs = history.getRecentRuns(5);
    expect(runs).toHaveLength(1);
    const rows = history.getRunToolCalls(runs[0]!.id);
    const captures = (history.getDb().prepare('SELECT COUNT(*) AS c FROM processes').get() as { c: number }).c;
    return { rows, captures };
  }

  it('a save_workflow refused for a parameter name is stored with is_error 1 and the fixed reason, not the name', async () => {
    const { rows, captures } = await runSave(SENT);
    expect(captureProcessMock).toHaveBeenCalledTimes(1);
    expect(captures).toBe(0);
    const saves = rows.filter((r) => r.tool_name === 'save_workflow');
    expect(saves).toHaveLength(1);
    const save = saves[0]!;
    // The row is this call's, by the id the model gave it.
    expect(save.tool_use_id).toBe('tu-save');
    expect(save.is_error).toBe(1);
    expect(save.output_json).toBe('not saved: a parameter name outside the accepted form');
  });

  it('control: a save_workflow that saved is stored with is_error 0 and an empty output', async () => {
    const { rows, captures } = await runSave('file_path');
    expect(captures).toBe(1);
    const saves = rows.filter((r) => r.tool_name === 'save_workflow');
    expect(saves).toHaveLength(1);
    expect(saves[0]!.tool_use_id).toBe('tu-save');
    expect(saves[0]!.is_error).toBe(0);
    expect(saves[0]!.output_json).toBe('');
  });
});
