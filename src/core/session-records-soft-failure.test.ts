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
  let prevDataDir: string | undefined;

  afterEach(async () => {
    for (const e of engines) { try { await e.shutdown(); } catch { /* best effort */ } }
    engines.length = 0;
    if (prevDataDir === undefined) delete process.env['LYNOX_DATA_DIR'];
    else process.env['LYNOX_DATA_DIR'] = prevDataDir;
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
    vi.unstubAllEnvs();
    reloadConfig();
    mockProcess.mockReset();
    captureProcessMock.mockReset();
  });

  /** One turn: a read_file call (so the session has work to save), then save_workflow, then the end. */
  type Row = { tool_name: string; output_json: string; is_error?: number | null };
  /** The run's tool rows, and how many session captures history.db holds (written last by a save). */
  async function runSave(paramName: string): Promise<{ rows: Row[]; captures: number }> {
    prevDataDir = process.env['LYNOX_DATA_DIR'];
    const dir = mkdtempSync(join(tmpdir(), 'lynox-soft-failure-row-'));
    dirs.push(dir);
    process.env['LYNOX_DATA_DIR'] = dir;
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test-not-sent');
    reloadConfig();
    const engine = new Engine({ api_key: 'sk-test-not-sent' } as LynoxConfig);
    engines.push(engine);
    await engine.init();
    // The record names the run it was captured from, as the real capture does.
    captureProcessMock.mockImplementation(async () => record(paramName, engine.getRunHistory()!.getRecentRuns(1)[0]!.id));
    mockProcess
      .mockResolvedValueOnce(toolUse('read_file', { path: join(dir, 'missing.txt') }, 'tu-read'))
      .mockResolvedValueOnce(toolUse('save_workflow', { name: 'Report' }, 'tu-save'))
      .mockResolvedValueOnce(endTurn('done'));
    const session = engine.createSession();
    await session.run('go');
    const history = engine.getRunHistory()!;
    const runs = history.getRecentRuns(5);
    expect(runs).toHaveLength(1);
    const rows = history.getRunToolCalls(runs[0]!.id) as unknown as Row[];
    const captures = (history.getDb().prepare('SELECT COUNT(*) AS c FROM processes').get() as { c: number }).c;
    return { rows, captures };
  }

  it('a save_workflow refused for a parameter name is stored with is_error 1 and the fixed reason, not the name', async () => {
    const { rows, captures } = await runSave(SENT);
    expect(captureProcessMock).toHaveBeenCalledTimes(1);
    expect(captures).toBe(0);
    const save = rows.find((r) => r.tool_name === 'save_workflow');
    expect(save).toBeDefined();
    expect(save!.is_error).toBe(1);
    expect(save!.output_json).toBe('not saved: a parameter name outside the accepted form');
  });

  it('control: a save_workflow that saved is stored with is_error 0 and an empty output', async () => {
    const { rows, captures } = await runSave('file_path');
    expect(captures).toBe(1);
    const save = rows.find((r) => r.tool_name === 'save_workflow');
    expect(save).toBeDefined();
    expect(save!.is_error).toBe(0);
    expect(save!.output_json).toBe('');
  });
});
