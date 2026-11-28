// A main-model call that runs into the per-call stream timeout is ended and booked like a
// stopped call: the bound to the run ceiling and the session cap whenever the request went out,
// and, once the provider answered, the estimate to the run's cost line plus one count for the
// timeout site. The error the caller sees is unchanged. A real Agent with the real Anthropic SDK
// client and with the real openai-compatible adapter, each against a real HTTP server that
// answers and then stalls, or never answers.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Agent, RunAbortedError } from './agent.js';
import { abortedCallCost, abortedCallCounts } from './aborted-call.js';
import type { SessionCounters } from '../types/agent.js';

const SITE = 'agent.stream_timeout';
const TIMEOUT_MESSAGE = 'Stream timeout: API response exceeded 10 minutes';
const PROMPT_USAGE = { input_tokens: 4321, output_tokens: 1, cache_creation_input_tokens: 100, cache_read_input_tokens: 2000 };

type Statics = { STREAM_TIMEOUT_MS: number };
const statics = Agent as unknown as Statics;
// Read before any test shortens it.
const DEFAULT_TIMEOUT_MS = statics.STREAM_TIMEOUT_MS;

type Inside = { costGuard: { capOnlyUSD: number }; sessionCounters: { costUSD: number }; maxTokens: number; model: string };
type Mode = 'stall' | 'no-answer' | 'finish';

/** A provider that answers per `mode`; counts requests and the connections the client closed. */
async function provider(wire: 'anthropic' | 'openai', mode: Mode): Promise<{ url: string; requests: () => number; closed: () => number; close: () => void }> {
  let requests = 0;
  let closed = 0;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.resume();
    req.on('end', () => {
      requests++;
      res.on('close', () => { closed++; });
      if (mode === 'no-answer') return;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const send = (event: string, data: unknown): void => {
        res.write(`${wire === 'anthropic' ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`);
      };
      if (wire === 'anthropic') {
        send('message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', content: [], model: 'x', stop_reason: null, stop_sequence: null, usage: PROMPT_USAGE } });
        send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
        send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'a first piece' } });
        if (mode === 'finish') {
          send('content_block_stop', { type: 'content_block_stop', index: 0 });
          send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } });
          send('message_stop', { type: 'message_stop' });
          res.end();
        }
      } else {
        send('', { id: 'r', choices: [{ index: 0, delta: { content: 'a first piece' }, finish_reason: null }] });
        if (mode === 'finish') {
          send('', { id: 'r', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 4 } });
          res.write('data: [DONE]\n\n');
          res.end();
        }
      }
      // 'stall': the connection stays open and nothing more comes.
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${String(port)}${wire === 'openai' ? '/v1' : ''}`,
    requests: () => requests,
    closed: () => closed,
    close: () => { server.closeAllConnections(); server.close(); },
  };
}

function sessionCounters(): SessionCounters {
  return { costUSD: 0, spawnCount: 0, spawnCostUSD: 0 } as unknown as SessionCounters;
}

function agentOn(wire: 'anthropic' | 'openai', url: string): Agent {
  return wire === 'anthropic'
    ? new Agent({ name: 'test', model: 'claude-sonnet-4-6', provider: 'anthropic', apiBaseURL: url, apiKey: 'not-a-key', costGuard: { maxBudgetUSD: 100 }, sessionCounters: sessionCounters() })
    : new Agent({ name: 'test', model: 'm', provider: 'openai', apiBaseURL: url, openaiModelId: 'm', apiKey: 'k', costGuard: { maxBudgetUSD: 100 }, sessionCounters: sessionCounters() });
}

/** The error `_callAPI` itself rethrows, before `send` handles it. */
function captureCallError(agent: Agent): { err: unknown } {
  const seen: { err: unknown } = { err: undefined };
  const a = agent as unknown as { _callAPI: (...args: unknown[]) => Promise<unknown> };
  const orig = a._callAPI.bind(agent);
  a._callAPI = async (...args: unknown[]) => { try { return await orig(...args); } catch (e) { seen.err = e; throw e; } };
  return seen;
}

async function waitFor(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
}

function expectTimeoutError(err: unknown): void {
  expect(err).toBeInstanceOf(Error);
  expect((err as Error).constructor).toBe(Error);
  expect((err as Error).message).toBe(TIMEOUT_MESSAGE);
}

function count(c: ReturnType<typeof abortedCallCounts>, kind: 'notBilled' | 'uncounted', site = SITE): number {
  return c[kind][site] ?? 0;
}

describe('the per-call stream timeout', () => {
  it('is ten minutes by default', () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(600_000);
  });
});

describe('a call the stream timeout ends', () => {
  beforeEach(() => { statics.STREAM_TIMEOUT_MS = 300; });
  afterEach(() => { statics.STREAM_TIMEOUT_MS = DEFAULT_TIMEOUT_MS; vi.restoreAllMocks(); });

  it('on the Anthropic wire, after the provider answered: bound to both caps, estimate to the cost line, counted once, not retried', async () => {
    const p = await provider('anthropic', 'stall');
    try {
      const agent = agentOn('anthropic', p.url);
      const callErr = captureCallError(agent);
      const before = abortedCallCounts();
      const err = await agent.send('hello').catch((e: unknown) => e);
      expectTimeoutError(err);
      expect(callErr.err).toBe(err);
      await waitFor(() => p.closed() > 0);
      expect(p.closed(), 'the timeout ended the request').toBe(1);
      expect(p.requests(), 'a timed-out call is not sent again').toBe(1);
      const after = abortedCallCounts();
      expect(count(after, 'notBilled')).toBe(count(before, 'notBilled') + 1);
      expect(count(after, 'uncounted')).toBe(count(before, 'uncounted'));
      const inside = agent as unknown as Inside;
      const counted = abortedCallCost({ model: inside.model, maxTokens: inside.maxTokens, request: '', partial: { usage: PROMPT_USAGE, content: [] } });
      expect(inside.costGuard.capOnlyUSD).toBeCloseTo(counted.upperBoundUsd, 12);
      expect(inside.sessionCounters.costUSD).toBeCloseTo(counted.upperBoundUsd, 12);
      expect(agent.getHelperCostUsd()).toBeGreaterThanOrEqual(counted.estimateUsd);
      expect(agent.getHelperCostUsd()).toBeLessThan(counted.upperBoundUsd);
    } finally {
      p.close();
    }
  }, 15_000);

  it('on the openai-compatible wire, after the provider answered: priced from the request size, counted once, not retried', async () => {
    const p = await provider('openai', 'stall');
    try {
      const agent = agentOn('openai', p.url);
      const before = abortedCallCounts();
      const err = await agent.send('hello').catch((e: unknown) => e);
      expectTimeoutError(err);
      await waitFor(() => p.closed() > 0);
      expect(p.closed(), 'the timeout ended the request').toBe(1);
      expect(p.requests()).toBe(1);
      const after = abortedCallCounts();
      expect(count(after, 'notBilled')).toBe(count(before, 'notBilled') + 1);
      expect(count(after, 'uncounted')).toBe(count(before, 'uncounted') + 1);
      const inside = agent as unknown as Inside;
      const outputOnly = abortedCallCost({ model: inside.model, maxTokens: inside.maxTokens, request: '', partial: { content: [{ type: 'text', text: 'a first piece' }] } }).estimateUsd;
      expect(agent.getHelperCostUsd()).toBeGreaterThan(outputOnly);
      expect(inside.costGuard.capOnlyUSD).toBeGreaterThan(agent.getHelperCostUsd());
      expect(inside.sessionCounters.costUSD).toBeCloseTo(inside.costGuard.capOnlyUSD, 12);
    } finally {
      p.close();
    }
  }, 15_000);

  for (const wire of ['anthropic', 'openai'] as const) {
    it(`on the ${wire} wire, before the provider answered: the bound to the caps only, no estimate, no count`, async () => {
      const p = await provider(wire, 'no-answer');
      try {
        const agent = agentOn(wire, p.url);
        const before = abortedCallCounts();
        const err = await agent.send('hello').catch((e: unknown) => e);
        expectTimeoutError(err);
        await waitFor(() => p.closed() > 0);
        expect(p.closed(), 'the timeout ended the request').toBe(1);
        const inside = agent as unknown as Inside;
        const floor = abortedCallCost({ model: inside.model, maxTokens: inside.maxTokens, request: '', partial: { content: [] } }).upperBoundUsd;
        expect(inside.costGuard.capOnlyUSD).toBeGreaterThan(floor);
        expect(inside.sessionCounters.costUSD).toBeCloseTo(inside.costGuard.capOnlyUSD, 12);
        expect(agent.getHelperCostUsd()).toBe(0);
        const after = abortedCallCounts();
        expect(count(after, 'notBilled')).toBe(count(before, 'notBilled'));
        expect(count(after, 'uncounted')).toBe(count(before, 'uncounted'));
      } finally {
        p.close();
      }
    }, 15_000);
  }

  it('when the run is stopped in the same instant: booked once, under the timeout', async () => {
    const p = await provider('anthropic', 'stall');
    try {
      const agent = agentOn('anthropic', p.url);
      const callErr = captureCallError(agent);
      // The run stop lands right after the timeout fired, before the call's error is handled:
      // both are true when the catch reads them.
      const realSetTimeout = globalThis.setTimeout;
      vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) =>
        realSetTimeout(ms === statics.STREAM_TIMEOUT_MS ? () => { fn(); agent.abort(); } : fn, ms, ...rest)) as typeof setTimeout);
      const before = abortedCallCounts();
      const err = await agent.send('hello').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RunAbortedError);
      expectTimeoutError(callErr.err);
      const after = abortedCallCounts();
      expect(count(after, 'notBilled')).toBe(count(before, 'notBilled') + 1);
      expect(count(after, 'notBilled', 'agent.user_abort')).toBe(count(before, 'notBilled', 'agent.user_abort'));
      const inside = agent as unknown as Inside;
      const counted = abortedCallCost({ model: inside.model, maxTokens: inside.maxTokens, request: '', partial: { usage: PROMPT_USAGE, content: [] } });
      expect(inside.costGuard.capOnlyUSD).toBeCloseTo(counted.upperBoundUsd, 12);
      expect(inside.sessionCounters.costUSD).toBeCloseTo(counted.upperBoundUsd, 12);
    } finally {
      p.close();
    }
  }, 15_000);
});

describe('a call that finishes before the stream timeout', () => {
  afterEach(() => { statics.STREAM_TIMEOUT_MS = DEFAULT_TIMEOUT_MS; vi.restoreAllMocks(); });

  for (const wire of ['anthropic', 'openai'] as const) {
    it(`on the ${wire} wire: books nothing as aborted and leaves no timeout timer behind`, async () => {
      // A delay no other timer in the run uses, so the call's own timer can be told apart.
      statics.STREAM_TIMEOUT_MS = 543_210;
      const armed: unknown[] = [];
      const cleared = new Set<unknown>();
      const realSetTimeout = globalThis.setTimeout;
      const realClearTimeout = globalThis.clearTimeout;
      vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) => {
        const h = realSetTimeout(fn, ms, ...rest);
        if (ms === 543_210) armed.push(h);
        return h;
      }) as typeof setTimeout);
      vi.spyOn(globalThis, 'clearTimeout').mockImplementation(((h?: Parameters<typeof clearTimeout>[0]) => {
        cleared.add(h);
        realClearTimeout(h);
      }) as typeof clearTimeout);
      const p = await provider(wire, 'finish');
      try {
        const agent = agentOn(wire, p.url);
        const before = abortedCallCounts();
        await agent.send('hello');
        expect(armed.length).toBe(1);
        expect(cleared.has(armed[0]), 'the call cleared its timeout timer').toBe(true);
        const inside = agent as unknown as Inside;
        expect(inside.costGuard.capOnlyUSD).toBe(0);
        const after = abortedCallCounts();
        expect(count(after, 'notBilled')).toBe(count(before, 'notBilled'));
      } finally {
        p.close();
      }
    }, 15_000);
  }
});
