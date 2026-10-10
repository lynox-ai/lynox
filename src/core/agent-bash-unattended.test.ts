import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolEntry } from '../types/index.js';

// The real permission guard, unlike agent.test.ts: these tests pin what a bash rule does to a
// run end to end, with and without someone to ask.

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

function bashCall(command: string) {
  return {
    content: [{ type: 'tool_use' as const, id: 'tu_1', name: 'bash', input: { command } }],
    stop_reason: 'tool_use',
    usage: { input_tokens: 100, output_tokens: 50 },
  };
}

const endTurn = {
  content: [{ type: 'text' as const, text: 'done' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 100, output_tokens: 50 },
};

function bashTool(): ToolEntry & { handler: ReturnType<typeof vi.fn> } {
  return {
    definition: {
      name: 'bash',
      description: 'Test bash',
      input_schema: { type: 'object' as const, properties: { command: { type: 'string' } }, required: ['command'] },
    },
    handler: vi.fn().mockResolvedValue('ran'),
  };
}

function resultOf(agent: Agent): string {
  for (const msg of agent.getMessages()) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content as unknown as Array<{ type?: string; content?: unknown }>) {
      if (block.type === 'tool_result') return String(block.content);
    }
  }
  throw new Error('no tool_result');
}

async function run(command: string, opts: { autonomous: boolean; answer?: string }) {
  mockProcess.mockResolvedValueOnce(bashCall(command)).mockResolvedValueOnce(endTurn);
  const tool = bashTool();
  const promptUser = opts.answer === undefined ? undefined : vi.fn().mockResolvedValue(opts.answer);
  const agent = new Agent({
    name: 'test',
    model: 'claude-sonnet-4-6',
    tools: [tool],
    ...(opts.autonomous ? { autonomy: 'autonomous' as const } : {}),
    ...(promptUser ? { promptUser } : {}),
  });
  await agent.send('go');
  return { ran: tool.handler.mock.calls.length > 0, result: resultOf(agent), promptUser };
}

describe('a bash rule, end to end through the agent', () => {
  beforeEach(() => { mockProcess.mockReset(); });

  it('an unattended run with no one to ask refuses a rule it asks about', async () => {
    const r = await run('ssh user@host', { autonomous: true });
    expect(r.ran).toBe(false);
    expect(r.result).toContain('Permission denied (non-interactive)');
  });

  it('an unattended run with no one to ask runs a local rule it allows (a workflow cleaning up)', async () => {
    const r = await run('rm build/out.txt', { autonomous: true });
    expect(r.ran).toBe(true);
  });

  it('an unattended run with a question channel asks about the rule and runs on yes', async () => {
    const r = await run('ssh user@host', { autonomous: true, answer: 'Allow' });
    expect(r.promptUser).toHaveBeenCalledTimes(1);
    expect(String(r.promptUser!.mock.calls[0]![0])).toContain('remote shell access');
    expect(r.ran).toBe(true);
  });

  // `[BLOCKED]` is not a refusal where a person can be asked: it cannot be lifted by a
  // declaration, but it is put to the person. Pinned so that nobody reads it as more.
  it('a blocked rule is a question to a person when there is a channel, and stops on no', async () => {
    const r = await run('sudo ls', { autonomous: true, answer: 'Deny' });
    expect(r.promptUser).toHaveBeenCalledTimes(1);
    expect(String(r.promptUser!.mock.calls[0]![0])).toContain('[BLOCKED');
    expect(r.ran).toBe(false);
  });

  it('a blocked rule with no one to ask is refused', async () => {
    const r = await run('sudo ls', { autonomous: true });
    expect(r.ran).toBe(false);
    expect(r.result).toContain('Permission denied (non-interactive)');
  });

  it('in a chat, a rule only CRITICAL_BASH lists is asked about, and stops on no', async () => {
    const r = await run('docker exec app ls', { autonomous: false, answer: 'Deny' });
    expect(r.promptUser).toHaveBeenCalledTimes(1);
    expect(String(r.promptUser!.mock.calls[0]![0])).toContain('container execution');
    expect(r.ran).toBe(false);
  });
});
