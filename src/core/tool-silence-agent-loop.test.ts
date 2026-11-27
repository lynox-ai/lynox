// The tool clock's release rests on one property of the agent loop: the agent streams its next
// response only once every call of the response before has settled (it awaits the dispatch of a
// response's calls before it calls the model again). Driven through a real Agent and the real
// Anthropic SDK client against a local HTTP server, so a loop that streamed on while a call still
// ran would release that call here, and this test would fail.

import { describe, it, expect } from 'vitest';
import { createServer, type ServerResponse } from 'node:http';
import { Agent } from './agent.js';
import { ToolSilenceClock } from './tool-silence.js';
import type { ToolEntry } from '../types/index.js';

const USAGE = { input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

function sse(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function start(res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  sse(res, 'message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', content: [], model: 'x', stop_reason: null, stop_sequence: null, usage: USAGE } });
}

function toolUse(res: ServerResponse, id: string, name: string): void {
  start(res);
  sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } });
  sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } });
  sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
  sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 5 } });
  sse(res, 'message_stop', { type: 'message_stop' });
  res.end();
}

function text(res: ServerResponse, body: string): void {
  start(res);
  sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: body } });
  sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
  sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } });
  sse(res, 'message_stop', { type: 'message_stop' });
  res.end();
}

async function provider(respond: (hit: number, res: ServerResponse) => void): Promise<{ url: string; close: () => void }> {
  let hits = 0;
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => { hits++; respond(hits, res); });
  });
  await new Promise<void>((r) => server.listen(0, r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { url: `http://127.0.0.1:${String(port)}`, close: () => { server.closeAllConnections(); server.close(); } };
}

function agentAgainst(url: string, tools: ToolEntry[], clock: ToolSilenceClock, seen: string[]): Agent {
  return new Agent({
    name: 'test', model: 'claude-sonnet-4-6', provider: 'anthropic', apiBaseURL: url, apiKey: 'not-a-key',
    tools, costGuard: { maxBudgetUSD: 100 },
    onStream: (e) => { seen.push(e.type); clock.note(e as Parameters<ToolSilenceClock['note']>[0]); },
  });
}

describe('the tool clock against the real agent loop', () => {
  it('holds a call that runs after its response ended, until the call has settled', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let heldWhileRunning: boolean | undefined;
    let turnEndsBeforeRunning = 0;
    const clock = new ToolSilenceClock();
    const seen: string[] = [];
    const slow: ToolEntry = {
      definition: { name: 'slow_work', description: 'Works for a while', input_schema: { type: 'object' as const, properties: {} } },
      handler: async () => {
        turnEndsBeforeRunning = seen.filter((t) => t === 'turn_end').length;
        // Give the loop every chance to stream on while the call runs.
        await new Promise<void>((r) => setTimeout(r, 50));
        heldWhileRunning = clock.holds(Date.now() + 61_000);
        await gate;
        return 'worked';
      },
    };
    const p = await provider((hit, res) => { if (hit === 1) toolUse(res, 'tu-slow', 'slow_work'); else text(res, 'done'); });
    try {
      const agent = agentAgainst(p.url, [slow], clock, seen);
      const run = agent.send('work');
      await new Promise<void>((r) => setTimeout(r, 200));
      release();
      expect(await run).toBe('done');
    } finally {
      p.close();
    }
    expect(turnEndsBeforeRunning, 'positive control: the response had ended before the call ran').toBe(1);
    expect(heldWhileRunning).toBe(true);
    expect(clock.holds(Date.now() + 61_000)).toBe(false);
  });

  // A call refused without a streamed result is released by the agent's next response.
  it('lets go of a call that never streams a result once the next response begins', async () => {
    const clock = new ToolSilenceClock();
    const seen: string[] = [];
    let afterFirst: boolean | undefined;
    const p = await provider((hit, res) => {
      if (hit === 1) { toolUse(res, 'tu-none', 'no_such_tool'); return; }
      afterFirst = clock.holds(Date.now() + 61_000);
      text(res, 'answered');
    });
    try {
      const agent = agentAgainst(p.url, [], clock, seen);
      expect(await agent.send('go')).toBe('answered');
    } finally {
      p.close();
    }
    expect(seen.includes('tool_call'), 'positive control: the call was streamed').toBe(true);
    expect(seen.includes('tool_result'), 'the refused call streamed no result').toBe(false);
    expect(afterFirst, 'positive control: held until the next response').toBe(true);
    expect(clock.holds(Date.now() + 61_000)).toBe(false);
  });
});
