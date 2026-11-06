// A call the person stops while the model streams is booked as an aborted call on both wires:
// a real Agent with the real Anthropic SDK client and with the real openai-compatible adapter,
// each against a real HTTP server that keeps writing until the client goes away. What the
// prompt is priced from differs by wire: the Anthropic wire reports the provider's input count
// in its first event, the openai-compatible wire only in its last chunk, which never comes.

import { describe, it, expect } from 'vitest';
import { createServer } from 'node:http';
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
