/**
 * `failureOf`: a tool that answers a call it did not carry out with a plain string declares how
 * to read that answer. A reason makes the call a soft failure, exactly as a thrown
 * `ToolSoftFailure` would: the model reads the same text, the ledger records the reason, and the
 * stream event says `softFailure` so the chat does not show the call as done.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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

import { Agent } from './agent.js';
import { createToolContext } from './tool-context.js';
import type { StreamEvent, ToolEntry } from '../types/index.js';

const endTurn = (text: string) => ({
  content: [{ type: 'text' as const, text }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 },
});
const toolUse = (name: string, id: string) => ({
  content: [{ type: 'tool_use' as const, id, name, input: {} }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 },
});

type Ev = Extract<StreamEvent, { type: 'tool_result' }>;
interface Rec { isError?: boolean; outputJson?: string }

function toolAnswering(answer: string, failureOf?: ToolEntry['failureOf']): ToolEntry {
  return {
    definition: { name: 'probe_tool', description: 'answers a fixed string', input_schema: { type: 'object', properties: {} } },
    handler: async () => answer,
    ...(failureOf !== undefined ? { failureOf } : {}),
  } as ToolEntry;
}

async function run(tool: ToolEntry): Promise<{ events: Ev[]; recs: Rec[]; modelSaw: string }> {
  const events: Ev[] = [];
  const recs: Rec[] = [];
  mockProcess.mockResolvedValueOnce(toolUse('probe_tool', 'tu-1'));
  mockProcess.mockResolvedValueOnce(endTurn('done'));
  const agent = new Agent({
    name: 'chat', model: 'claude-sonnet-4-6', tools: [tool], autonomy: 'autonomous',
    toolContext: createToolContext({}),
    recordToolCall: (c) => { recs.push(c as Rec); },
    onStream: async (e) => { if (e.type === 'tool_result') events.push(e); },
  });
  await agent.send('go');
  // The tool_result blocks the conversation carries to the model.
  const modelSaw = JSON.stringify(agent.getMessages().flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .filter((b) => (b as { type?: string }).type === 'tool_result'));
  return { events, recs, modelSaw };
}

describe('failureOf', () => {
  beforeEach(() => { mockProcess.mockReset(); });

  it('a reason makes the answer a soft failure: same text for the model, failure in the ledger and on the event', async () => {
    const answer = 'Error: nothing was saved.';
    const { events, recs, modelSaw } = await run(toolAnswering(answer, (a) => (a.startsWith('Error:') ? a : null)));
    // The tool_result the model reads is the answer as it was, without an is_error.
    expect(JSON.parse(modelSaw)).toEqual([expect.objectContaining({ type: 'tool_result', tool_use_id: 'tu-1', content: answer })]);
    expect(modelSaw).not.toContain('"is_error"');
    expect(events[0]!.result).toBe(answer);
    expect(events[0]!.isError).toBeUndefined();
    expect(events[0]!.softFailure).toBe(true);
    expect(recs[0]).toEqual(expect.objectContaining({ isError: true }));
    expect(recs[0]!.outputJson).toContain('nothing was saved');
  });

  it('control: null from the reader is a done call', async () => {
    const { events, recs } = await run(toolAnswering('Saved.', () => null));
    expect(events[0]!.softFailure).toBeUndefined();
    expect(recs[0]).toEqual(expect.objectContaining({ isError: false }));
  });

  it('control: a tool without a reader is a done call whatever it answers', async () => {
    const { events, recs } = await run(toolAnswering('Error: looks like a failure.'));
    expect(events[0]!.softFailure).toBeUndefined();
    expect(recs[0]).toEqual(expect.objectContaining({ isError: false }));
  });

  it('a reader that throws decides nothing: the call stays as it would be without it', async () => {
    const { events, recs } = await run(toolAnswering('Error: x', () => { throw new Error('reader broke'); }));
    expect(events[0]!.result).toBe('Error: x');
    expect(events[0]!.isError).toBeUndefined();
    expect(events[0]!.softFailure).toBeUndefined();
    expect(recs[0]).toEqual(expect.objectContaining({ isError: false }));
  });
});
