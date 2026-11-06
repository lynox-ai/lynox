// A call the person stops while the model streams is booked as an aborted call on both wires:
// a real Agent with the real Anthropic SDK client and with the real openai-compatible adapter,
// each against a real HTTP server that keeps writing until the client goes away. What the
// prompt is priced from differs by wire: the Anthropic wire reports the provider's input count
// in its first event, the openai-compatible wire only in its last chunk, which never comes.
// A stop before the provider answered at all gets the cap bound only: the request may not have
// been sent (the Anthropic SDK retries an overloaded provider inside the call), and whether a
// sent request with no answer is billed cannot be seen from here.

import { describe, it, expect } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Agent, RunAbortedError } from './agent.js';
import { abortedCallCost, abortedCallCounts } from './aborted-call.js';

const SITE = 'agent.user_abort';
const PROMPT_USAGE = { input_tokens: 4321, output_tokens: 1, cache_creation_input_tokens: 100, cache_read_input_tokens: 2000 };

/** A provider that starts a reply and then writes a text piece every few ms, until the client goes away. */
async function endlessProvider(wire: 'anthropic' | 'openai'): Promise<{ url: string; chunks: () => number; closed: () => boolean; close: () => void }> {
  let chunks = 0;
  let closed = false;
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const send = (event: string, data: unknown): void => {
        res.write(`${wire === 'anthropic' ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`);
      };
      if (wire === 'anthropic') {
        send('message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', content: [], model: 'x', stop_reason: null, stop_sequence: null, usage: PROMPT_USAGE } });
        send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      }
      const timer = setInterval(() => {
        chunks++;
        const piece = `item ${String(chunks)}, `;
        if (wire === 'anthropic') send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } });
        else send('', { id: 'r', choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] });
      }, 5);
      res.on('close', () => { clearInterval(timer); closed = true; });
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${String(port)}${wire === 'openai' ? '/v1' : ''}`,
    chunks: () => chunks,
    closed: () => closed,
    close: () => { server.closeAllConnections(); server.close(); },
  };
}

function agentOn(wire: 'anthropic' | 'openai', url: string): Agent {
  return wire === 'anthropic'
    ? new Agent({ name: 'test', model: 'claude-sonnet-4-6', provider: 'anthropic', apiBaseURL: url, apiKey: 'not-a-key', costGuard: { maxBudgetUSD: 100 } })
    : new Agent({ name: 'test', model: 'm', provider: 'openai', apiBaseURL: url, openaiModelId: 'm', apiKey: 'k', costGuard: { maxBudgetUSD: 100 } });
}

type Inside = { costGuard: { capOnlyUSD: number }; maxTokens: number; model: string };

async function stopMidStream(wire: 'anthropic' | 'openai'): Promise<{ agent: Agent; err: unknown; text: string }> {
  const provider = await endlessProvider(wire);
  try {
    let text = '';
    const agent = agentOn(wire, provider.url);
    (agent as unknown as { onStream: (e: { type: string; text?: string }) => void }).onStream = (e) => { if (e.type === 'text') text += e.text ?? ''; };
    const turn = agent.send('list all of them');
    for (let i = 0; i < 500 && provider.chunks() < 5; i++) await new Promise((r) => setTimeout(r, 10));
    agent.abort();
    const err = await turn.catch((e: unknown) => e);
    for (let i = 0; i < 100 && !provider.closed(); i++) await new Promise((r) => setTimeout(r, 10));
    expect(provider.closed(), 'the stop ended the request').toBe(true);
    return { agent, err, text };
  } finally {
    provider.close();
  }
}

describe('a call the person stops mid-stream is booked', () => {
  it('on the Anthropic wire, from the input count of its first event', async () => {
    const before = abortedCallCounts();
    const { agent, err } = await stopMidStream('anthropic');
    expect(err).toBeInstanceOf(RunAbortedError);
    const after = abortedCallCounts();
    expect(after.notBilled[SITE]).toBe((before.notBilled[SITE] ?? 0) + 1);
    expect(after.uncounted[SITE] ?? 0).toBe(before.uncounted[SITE] ?? 0);
    const inside = agent as unknown as Inside;
    // The bound uses the provider's count: the whole budget as output on top of the counted prompt.
    const counted = abortedCallCost({ model: inside.model, maxTokens: inside.maxTokens, request: '', partial: { usage: PROMPT_USAGE, content: [] } });
    expect(inside.costGuard.capOnlyUSD).toBeCloseTo(counted.upperBoundUsd, 12);
    // The estimate: the counted prompt plus what streamed, which is at least nothing.
    expect(agent.getHelperCostUsd()).toBeGreaterThanOrEqual(counted.estimateUsd);
    expect(agent.getHelperCostUsd()).toBeLessThan(counted.upperBoundUsd);
  }, 15_000);

  it('on the openai-compatible wire, from the request size, as the wire reports no input count before its end', async () => {
    const before = abortedCallCounts();
    const { agent, err, text } = await stopMidStream('openai');
    expect(err).toBeInstanceOf(RunAbortedError);
    expect(text.length).toBeGreaterThan(0);
    const after = abortedCallCounts();
    expect(after.notBilled[SITE]).toBe((before.notBilled[SITE] ?? 0) + 1);
    expect(after.uncounted[SITE]).toBe((before.uncounted[SITE] ?? 0) + 1);
    const inside = agent as unknown as Inside;
    // More than the streamed text alone: the request's size is priced as input.
    const outputOnly = abortedCallCost({ model: inside.model, maxTokens: inside.maxTokens, request: '', partial: { content: [{ type: 'text', text }] } }).estimateUsd;
    expect(agent.getHelperCostUsd()).toBeGreaterThan(outputOnly);
    expect(inside.costGuard.capOnlyUSD).toBeGreaterThan(agent.getHelperCostUsd());
  }, 15_000);
});

/** A provider that handles each request with `respond`; counts the requests it received. */
async function provider(respond: (res: ServerResponse) => void): Promise<{ url: string; hits: () => number; close: () => void }> {
  let hits = 0;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.resume();
    req.on('end', () => { hits++; respond(res); });
  });
  await new Promise<void>((r) => server.listen(0, r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { url: `http://127.0.0.1:${String(port)}`, hits: () => hits, close: () => { server.closeAllConnections(); server.close(); } };
}

/** The error `_callAPI` itself rethrows, before `send` turns an abort into a RunAbortedError. */
function captureCallError(agent: Agent): { err: unknown } {
  const seen: { err: unknown } = { err: undefined };
  const a = agent as unknown as { _callAPI: () => Promise<unknown> };
  const orig = a._callAPI.bind(agent);
  a._callAPI = async () => { try { return await orig(); } catch (e) { seen.err = e; throw e; } };
  return seen;
}

function expectCapOnly(agent: Agent, before: ReturnType<typeof abortedCallCounts>): void {
  const inside = agent as unknown as Inside;
  // The bound: at least the whole output budget, whatever the prompt was.
  const floor = abortedCallCost({ model: inside.model, maxTokens: inside.maxTokens, request: '', partial: { content: [] } }).upperBoundUsd;
  expect(inside.costGuard.capOnlyUSD).toBeGreaterThan(floor);
  expect(agent.getHelperCostUsd()).toBe(0);
  const after = abortedCallCounts();
  expect(after.notBilled[SITE] ?? 0).toBe(before.notBilled[SITE] ?? 0);
  expect(after.uncounted[SITE] ?? 0).toBe(before.uncounted[SITE] ?? 0);
}

describe('a call the person stops before the provider answered', () => {
  it('during the Anthropic SDK\'s own wait after an overloaded answer: the bound to the caps, no estimate, no count', async () => {
    const p = await provider((res) => {
      res.writeHead(529, { 'content-type': 'application/json', 'retry-after': '1' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }));
    });
    try {
      const agent = agentOn('anthropic', p.url);
      const callErr = captureCallError(agent);
      const before = abortedCallCounts();
      const turn = agent.send('hello');
      for (let i = 0; i < 200 && p.hits() < 1; i++) await new Promise((r) => setTimeout(r, 10));
      await new Promise((r) => setTimeout(r, 100));
      agent.abort();
      const err = await turn.catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RunAbortedError);
      // The SDK's own abort, unchanged; the provider was asked once and answered no.
      expect((callErr.err as Error).constructor.name).toBe('APIUserAbortError');
      expect(p.hits()).toBe(1);
      expectCapOnly(agent, before);
    } finally {
      p.close();
    }
  }, 15_000);

  for (const wire of ['anthropic', 'openai'] as const) {
    it(`on the ${wire} wire, sent and not answered yet: the bound to the caps, no estimate, no count`, async () => {
      // Takes the request and never answers.
      const p = await provider(() => undefined);
      try {
        const agent = agentOn(wire, wire === 'openai' ? `${p.url}/v1` : p.url);
        const before = abortedCallCounts();
        const turn = agent.send('hello');
        for (let i = 0; i < 200 && p.hits() < 1; i++) await new Promise((r) => setTimeout(r, 10));
        expect(p.hits()).toBe(1);
        agent.abort();
        const err = await turn.catch((e: unknown) => e);
        expect(err).toBeInstanceOf(RunAbortedError);
        expectCapOnly(agent, before);
      } finally {
        p.close();
      }
    }, 15_000);
  }
});
