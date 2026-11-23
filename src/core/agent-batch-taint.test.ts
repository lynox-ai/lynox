import { describe, it, expect, vi } from 'vitest';
import type { ToolEntry } from '../types/index.js';

// `batchStartedTainted`: what a search's result hosts are judged by before they join the shell's
// egress set. It answers for the batch the running call belongs to, and `true` outside one.

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    beta = { messages: { stream: vi.fn() } };
  }
  class APIError extends Error {}
  return { default: MockAnthropic, APIError };
});

const mockProcess = vi.fn();

vi.mock('./stream.js', () => ({
  StreamProcessor: vi.fn().mockImplementation(function (this: { process: typeof mockProcess }) {
    this.process = mockProcess;
  }),
}));

import { Agent } from './agent.js';

const endTurn = { content: [{ type: 'text' as const, text: 'done' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } };
const calls = (...names: string[]) => ({
  content: names.map((name, i) => ({ type: 'tool_use' as const, id: `tu_${name}_${String(i)}`, name, input: {} })),
  stop_reason: 'tool_use',
  usage: { input_tokens: 1, output_tokens: 1 },
});

function tool(name: string, seen: Array<[string, boolean]>): ToolEntry {
  return {
    definition: { name, description: name, input_schema: { type: 'object' as const, properties: {} } },
    handler: async (_input: unknown, agent: unknown) => {
      seen.push([name, (agent as Agent).batchStartedTainted()]);
      return 'ok';
    },
  };
}

describe('batchStartedTainted', () => {
  it('is false for every call of a batch that started clean, siblings of a foreign read included, and true for the next batch', async () => {
    const seen: Array<[string, boolean]> = [];
    mockProcess.mockResolvedValueOnce(calls('web_research', 'probe')).mockResolvedValueOnce(calls('probe')).mockResolvedValueOnce(endTurn);
    const agent = new Agent({ name: 't', model: 'claude-sonnet-4-6', tools: [tool('web_research', seen), tool('probe', seen)] });
    await agent.send('go');
    expect(seen).toEqual([['web_research', false], ['probe', false], ['probe', true]]);
  });

  it('answers true outside a batch', () => {
    const agent = new Agent({ name: 't', model: 'claude-sonnet-4-6', tools: [] });
    expect(agent.batchStartedTainted()).toBe(true);
  });
});
