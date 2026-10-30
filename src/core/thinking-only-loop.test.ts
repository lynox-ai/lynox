// Regression: the THINKING-ONLY TRUNCATION LOOP (996, run A2 on staging, 2026-10-27).
// A turn that spends its whole output limit on thinking is cut off with no text and no tool
// call. The agent strips thinking from the history, so the model sees only the placeholder and
// a request to "continue from where you left off" — nothing it can continue. It started the same
// reasoning over, five turns in a row, until a person stopped the run.
//
// Now the continuation after such a turn says what happened and asks for an act, and a second
// one in a row with no tool dispatched in between stops the run with ThinkingOnlyLoopError.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockProcess = vi.fn();

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    beta = { messages: { stream: vi.fn() } };
  }
  return { default: MockAnthropic };
});

vi.mock('./stream.js', () => ({
  StreamProcessor: vi.fn().mockImplementation(function (this: { process: typeof mockProcess }) {
    this.process = mockProcess;
  }),
}));

vi.mock('./observability.js', () => ({
  channels: {
    toolStart: { publish: vi.fn() },
    toolEnd: { publish: vi.fn() },
    contentTruncation: { hasSubscribers: false, publish: vi.fn() },
    securityFlagged: { hasSubscribers: false, publish: vi.fn() },
  },
  measureTool: vi.fn().mockReturnValue({ end: () => 0 }),
}));

import { Agent, ContinuationLoopError, ThinkingOnlyLoopError } from './agent.js';
import { MAX_TOKENS_CONTINUATION_PROMPT, THINKING_ONLY_CONTINUATION_PROMPT } from './render-projection.js';
import type { ToolEntry } from '../types/index.js';

/** The whole output limit spent on thinking: cut off, no text, no tool call. */
const thinkingOnly = (): unknown => ({
  content: [{ type: 'thinking', thinking: 'Let me work through the list again…', signature: 'sig' }],
  stop_reason: 'max_tokens',
  usage: { input_tokens: 100, output_tokens: 16_000 },
});
const textCut = (text: string): unknown => ({
  content: [{ type: 'thinking', thinking: 'thinking', signature: 'sig' }, { type: 'text', text }],
  stop_reason: 'max_tokens',
  usage: { input_tokens: 100, output_tokens: 16_000 },
});
const toolCall = (id: string): unknown => ({
  content: [{ type: 'tool_use', id, name: 'recall', input: { q: id } }],
  stop_reason: 'tool_use',
  usage: { input_tokens: 100, output_tokens: 50 },
});
const answer = (text: string): unknown => ({
  content: [{ type: 'text', text }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 100, output_tokens: 50 },
});

function scripted(turns: unknown[]): void {
  let i = 0;
  mockProcess.mockImplementation(() => {
    const t = turns[i++];
    if (t === undefined) throw new Error(`no scripted turn ${String(i)}`);
    return Promise.resolve(t);
  });
}

let n = 0;
const recall: ToolEntry = {
  definition: { name: 'recall', description: 'Test tool recall', input_schema: { type: 'object' as const, properties: {}, additionalProperties: true } },
  handler: vi.fn().mockImplementation(() => Promise.resolve(`result ${String(n++)}`)),
};

/** The continuation prompts the agent wrote, in order. */
function continuations(agent: Agent): string[] {
  return agent.getMessages()
    .filter((m) => m.role === 'user' && typeof m.content === 'string')
    .map((m) => m.content as string)
    .filter((c) => c === MAX_TOKENS_CONTINUATION_PROMPT || c === THINKING_ONLY_CONTINUATION_PROMPT);
}

describe('thinking-only truncation loop (996)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stops after the second thinking-only truncated turn in a row', async () => {
    scripted([thinkingOnly(), thinkingOnly(), answer('never reached')]);
    const agent = new Agent({ name: 'test', model: 'claude-sonnet-4-6' });
    const err = await agent.send('evaluate the list').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ThinkingOnlyLoopError);
    // A ContinuationLoopError, so every place that ends a run on a loop break treats it alike.
    expect(err).toBeInstanceOf(ContinuationLoopError);
    expect(mockProcess).toHaveBeenCalledTimes(2);
  });

  it('after a thinking-only truncated turn the continuation says so and asks for an act', async () => {
    scripted([thinkingOnly(), answer('done')]);
    const agent = new Agent({ name: 'test', model: 'claude-sonnet-4-6' });
    await expect(agent.send('evaluate the list')).resolves.toBe('done');
    expect(continuations(agent)).toEqual([THINKING_ONLY_CONTINUATION_PROMPT]);
    expect(THINKING_ONLY_CONTINUATION_PROMPT).not.toMatch(/where you left off/);
  });

  it('a truncated turn with text keeps the plain continuation', async () => {
    scripted([textCut('Here is the first half'), answer('done')]);
    const agent = new Agent({ name: 'test', model: 'claude-sonnet-4-6' });
    await expect(agent.send('evaluate the list')).resolves.toBe('done');
    expect(continuations(agent)).toEqual([MAX_TOKENS_CONTINUATION_PROMPT]);
  });

  it('a tool dispatched between two thinking-only truncated turns starts the count over', async () => {
    scripted([thinkingOnly(), toolCall('t1'), thinkingOnly(), answer('done')]);
    const agent = new Agent({ name: 'test', model: 'claude-sonnet-4-6', tools: [recall] });
    await expect(agent.send('evaluate the list')).resolves.toBe('done');
    expect(mockProcess).toHaveBeenCalledTimes(4);
  });

  it('a truncated turn with text between two thinking-only ones starts the count over', async () => {
    scripted([thinkingOnly(), textCut('first half'), thinkingOnly(), answer('done')]);
    const agent = new Agent({ name: 'test', model: 'claude-sonnet-4-6' });
    await expect(agent.send('evaluate the list')).resolves.toBe('done');
    expect(continuations(agent)).toEqual([THINKING_ONLY_CONTINUATION_PROMPT, MAX_TOKENS_CONTINUATION_PROMPT, THINKING_ONLY_CONTINUATION_PROMPT]);
  });

  it('a new send starts the count over', async () => {
    scripted([thinkingOnly(), answer('one'), thinkingOnly(), answer('two')]);
    const agent = new Agent({ name: 'test', model: 'claude-sonnet-4-6' });
    await expect(agent.send('first')).resolves.toBe('one');
    await expect(agent.send('second')).resolves.toBe('two');
  });

  it('a truncated turn that holds only a cut-off tool call is not a thinking-only turn', async () => {
    // The tool call is discarded (never dispatched), but the turn did act: the thinking prompt
    // ("no tool call", "do not start it over") would be untrue, and the stop belongs to the
    // other guard. Two such turns in a row keep the plain continuation.
    const cutCall = (): unknown => ({
      content: [{ type: 'tool_use', id: 'tu_cut', name: 'write_file', input: { path: '/tmp/x', content: 'x'.repeat(1000) } }],
      stop_reason: 'max_tokens',
      usage: { input_tokens: 100, output_tokens: 16_000 },
    });
    scripted([cutCall(), cutCall(), answer('done')]);
    const agent = new Agent({ name: 'test', model: 'claude-sonnet-4-6' });
    await expect(agent.send('write the file')).resolves.toBe('done');
    expect(continuations(agent)).toEqual([MAX_TOKENS_CONTINUATION_PROMPT, MAX_TOKENS_CONTINUATION_PROMPT]);
  });

  it('a long thinking turn that is not cut off is an ordinary answer', async () => {
    scripted([{ content: [{ type: 'thinking', thinking: 'x'.repeat(50_000), signature: 's' }, { type: 'text', text: 'done' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 15_999 } }]);
    const agent = new Agent({ name: 'test', model: 'claude-sonnet-4-6' });
    await expect(agent.send('evaluate the list')).resolves.toBe('done');
    expect(continuations(agent)).toEqual([]);
  });
});
