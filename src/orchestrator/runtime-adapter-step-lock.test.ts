import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LynoxUserConfig, ToolEntry } from '../types/index.js';
import type { ManifestStep } from './types.js';

// A step's tools under a mandate, with a REAL step agent: only the model is replaced. The
// refusal in `spawnInline` counts the tools a step names; a tool its role grants but it does not
// name is cut by the step agent's own lock, which spawnInline builds for the run's principal.
// These tests pin that cut where a model would hit it: the call at run time.

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    beta = { messages: { stream: vi.fn() } };
  }
  class APIError extends Error {}
  return { default: MockAnthropic, APIError };
});

const mockProcess = vi.fn();
vi.mock('../core/stream.js', () => ({
  StreamProcessor: vi.fn().mockImplementation(function (this: { process: typeof mockProcess }) {
    this.process = mockProcess;
  }),
}));

const { spawnInline } = await import('./runtime-adapter.js');
const { OWNER_PRINCIPAL } = await import('../core/request-principal.js');

const MANDATE = { kind: 'mandate' as const, email: 'setup@example.org' };
const config = { api_key: 'test-key' } as unknown as LynoxUserConfig;

function tool(name: string): ToolEntry {
  return {
    definition: { name, description: `Test tool ${name}`, input_schema: { type: 'object' as const, properties: {}, additionalProperties: true } },
    handler: vi.fn(async () => `${name} ran`),
  };
}
const usage = { input_tokens: 10, output_tokens: 5 };
const callsReadFile = { content: [{ type: 'tool_use' as const, id: 'tu_read', name: 'read_file', input: { path: 'notes.txt' } }], stop_reason: 'tool_use', usage };
const done = { content: [{ type: 'text' as const, text: 'summary' }], stop_reason: 'end_turn', usage };

/** A collector step that names no tool, run with a parent set that still holds read_file. */
async function runCollector(principal: typeof MANDATE | typeof OWNER_PRINCIPAL): Promise<ToolEntry> {
  const readFile = tool('read_file');
  mockProcess.mockResolvedValueOnce(callsReadFile).mockResolvedValueOnce(done);
  const step: ManifestStep = { id: 'collect', agent: 'collect', runtime: 'inline', task: 'summarise the file', role: 'collector' };
  await spawnInline(
    step, {}, config, [readFile, tool('http_request')], undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, principal,
  );
  return readFile;
}

describe('a collector step of a mandate\'s run: admitted, and its role\'s read_file cut at run time', () => {
  beforeEach(() => { mockProcess.mockReset(); });

  it('is admitted, and the model\'s read_file call does not run', async () => {
    const readFile = await runCollector(MANDATE);
    expect(mockProcess).toHaveBeenCalledTimes(2);
    expect(readFile.handler).not.toHaveBeenCalled();
  });

  it('control: the owner\'s step runs the same call', async () => {
    const readFile = await runCollector(OWNER_PRINCIPAL);
    expect(readFile.handler).toHaveBeenCalledTimes(1);
  });
});
