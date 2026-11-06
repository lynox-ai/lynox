// A provider error that arrives inside the stream (an SSE `error` event after the reply began)
// is retried like its HTTP twin, and the attempt it ended is booked. Driven through a real Agent
// with the real Anthropic SDK client against a local HTTP server, so the error reaches the
// retry decision in the shape the SDK's own stream parser gives it: status undefined, `type`
// set from the event, and `error` holding the whole event body.

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Agent } from './agent.js';
import { Engine } from './engine.js';
import { reloadConfig } from './config.js';
import { abortedCallCost, abortedCallCounts } from './aborted-call.js';
import { StreamIncompleteError } from './stream-incomplete.js';
import type { LynoxConfig } from '../types/index.js';

const SITE = 'agent.stream_error';
const PROMPT_USAGE = { input_tokens: 4321, output_tokens: 1, cache_creation_input_tokens: 100, cache_read_input_tokens: 2000 };

function sse(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function begin(res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  sse(res, 'message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', content: [], model: 'x', stop_reason: null, stop_sequence: null, usage: PROMPT_USAGE } });
  sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
}

function reply(res: ServerResponse, text: string): void {
  begin(res);
  sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
  sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
  sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } });
  sse(res, 'message_stop', { type: 'message_stop' });
  res.end();
}

/** A reply that starts, streams a piece, and then ends in an `error` event of `type`. */
function errorMidStream(res: ServerResponse, type: string, message = 'mid-stream failure'): void {
  begin(res);
  sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial answer ' } });
  sse(res, 'error', { type: 'error', error: { type, message } });
  res.end();
}

/** A reply that reaches its `message_delta` (stop reason and final usage), then ends in an overloaded `error` event. */
function errorAfterTurnEnd(res: ServerResponse): void {
  begin(res);
  sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'full answer' } });
  sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
  sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } });
  sse(res, 'error', { type: 'error', error: { type: 'overloaded_error', message: 'mid-stream failure' } });
  res.end();
}

/** A reply that streams a piece and then closes the response, before its `message_delta` and `message_stop`. */
function truncated(res: ServerResponse): void {
  begin(res);
  sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial answer ' } });
  res.end();
}

/** A reply that reaches its `message_delta` (stop reason and final usage) and then closes the response, before `message_stop`. */
function truncatedAfterTurnEnd(res: ServerResponse): void {
  begin(res);
  sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'full answer' } });
  sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
  sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } });
  res.end();
}

/** An openai-compatible chat-completions stream: a text piece, and, if `complete`, its finish_reason, a usage chunk and `[DONE]`. */
function openaiReply(res: ServerResponse, text: string, complete: boolean): void {
  const data = (d: unknown): void => { res.write(`data: ${typeof d === 'string' ? d : JSON.stringify(d)}\n\n`); };
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  data({ id: 'r', choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
  if (complete) {
    data({ id: 'r', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    data({ id: 'r', choices: [], usage: { prompt_tokens: 50, completion_tokens: 5 } });
    data('[DONE]');
  }
  res.end();
}

/** The request itself refused: HTTP 529. The SDK retries this inside the call before the Agent sees it. */
function overloadedStatus(res: ServerResponse): void {
  res.writeHead(529, { 'content-type': 'application/json', 'retry-after-ms': '1' });
  res.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }));
}

async function provider(respond: (hit: number, res: ServerResponse) => void): Promise<{ url: string; hits: () => number; close: () => void }> {
  let hits = 0;
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => { hits++; respond(hits, res); });
  });
  await new Promise<void>((r) => server.listen(0, r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { url: `http://127.0.0.1:${String(port)}`, hits: () => hits, close: () => { server.closeAllConnections(); server.close(); } };
}

type Inside = { costGuard: { capOnlyUSD: number }; sessionCounters: { costUSD: number }; maxTokens: number; model: string };

/** How the agent's stream consumer treats `turn_end`: counted like Session's, or dropped like a spawned child's. */
type Consumer = { turnEndUsageCounted?: boolean; throwOnTurnEnd?: boolean; wire?: 'anthropic' | 'openai' };

async function runAgainst(respond: (hit: number, res: ServerResponse) => void, consumer: Consumer = {}): Promise<{
  agent: Agent; hits: number; result: string | undefined; err: unknown; retryReasons: string[]; turnEnds: number[]; retryAfterTurnEnd: Array<boolean | undefined>; before: ReturnType<typeof abortedCallCounts>;
}> {
  const p = await provider(respond);
  try {
    const retryReasons: string[] = [];
    const turnEnds: number[] = [];
    const retryAfterTurnEnd: Array<boolean | undefined> = [];
    const agent = new Agent({
      name: 'test',
      ...(consumer.wire === 'openai'
        ? { model: 'm', provider: 'openai' as const, apiBaseURL: `${p.url}/v1`, openaiModelId: 'm', apiKey: 'k' }
        : { model: 'claude-sonnet-4-6', provider: 'anthropic' as const, apiBaseURL: p.url, apiKey: 'not-a-key' }),
      costGuard: { maxBudgetUSD: 100 },
      sessionCounters: { costUSD: 0, spawnCount: 0, spawnCostUSD: 0 } as unknown as import('../types/agent.js').SessionCounters,
      ...(consumer.turnEndUsageCounted === true ? { turnEndUsageCounted: true } : {}),
      onStream: (e) => {
        if (e.type === 'retry') { retryReasons.push(e.reason); retryAfterTurnEnd.push(e.afterTurnEnd); }
        if (e.type === 'turn_end') {
          turnEnds.push(e.usage.output_tokens);
          if (consumer.throwOnTurnEnd === true) throw new Error('consumer failed after counting');
        }
      },
    });
    const before = abortedCallCounts();
    let result: string | undefined;
    let err: unknown;
    try { result = await agent.send('hello'); } catch (e) { err = e; }
    return { agent, hits: p.hits(), result, err, retryReasons, turnEnds, retryAfterTurnEnd, before };
  } finally {
    p.close();
  }
}

/** One booked attempt per `n`: its bound to both caps, its estimate to the run's cost line, one count each. */
function expectBooked(agent: Agent, before: ReturnType<typeof abortedCallCounts>, n: number): void {
  const inside = agent as unknown as Inside;
  const after = abortedCallCounts();
  expect(after.notBilled[SITE] ?? 0).toBe((before.notBilled[SITE] ?? 0) + n);
  // The prompt came from the provider's own count in `message_start`.
  expect(after.uncounted[SITE] ?? 0).toBe(before.uncounted[SITE] ?? 0);
  const counted = abortedCallCost({ model: inside.model, maxTokens: inside.maxTokens, request: '', partial: { usage: PROMPT_USAGE, content: [] } });
  expect(inside.costGuard.capOnlyUSD).toBeCloseTo(n * counted.upperBoundUsd, 12);
  expect(inside.sessionCounters.costUSD).toBeCloseTo(n * counted.upperBoundUsd, 12);
  expect(agent.getHelperCostUsd()).toBeGreaterThan(n * counted.estimateUsd);
  expect(agent.getHelperCostUsd()).toBeLessThan(n * counted.upperBoundUsd);
}

describe('a provider error inside the stream', () => {
  const seam = Agent as unknown as { RETRY_BASE_MS: number };
  let saved = 0;
  beforeAll(() => { saved = seam.RETRY_BASE_MS; seam.RETRY_BASE_MS = 1; });
  afterAll(() => { seam.RETRY_BASE_MS = saved; });

  for (const type of ['overloaded_error', 'api_error', 'rate_limit_error', 'timeout_error'] as const) {
    it(`${type}: is retried with a second request, the run succeeds, the failed attempt is booked`, async () => {
      const { agent, hits, result, err, retryReasons, before } = await runAgainst((hit, res) => {
        if (hit === 1) errorMidStream(res, type); else reply(res, 'recovered');
      });
      expect(err).toBeUndefined();
      expect(result).toBe('recovered');
      expect(hits).toBe(2);
      expect(retryReasons).toHaveLength(1);
      // The reason leads with the type (the message after it carries the whole event body).
      expect(retryReasons[0]?.startsWith(`${type}: `)).toBe(true);
      expectBooked(agent, before, 1);
    }, 10_000);
  }

  it('one that is not transient (invalid_request_error) is not retried, and the attempt is still booked', async () => {
    const { agent, hits, result, err, retryReasons, before } = await runAgainst((hit, res) => {
      if (hit === 1) errorMidStream(res, 'invalid_request_error'); else reply(res, 'should not be asked');
    });
    expect(result).toBeUndefined();
    expect((err as { type?: unknown }).type).toBe('invalid_request_error');
    expect(hits).toBe(1);
    expect(retryReasons).toHaveLength(0);
    expectBooked(agent, before, 1);
  }, 10_000);

  it('overloaded on every attempt: the retry count holds, and every attempt is booked once', async () => {
    const { agent, hits, err, retryReasons, before } = await runAgainst((_hit, res) => { errorMidStream(res, 'overloaded_error'); });
    expect((err as { type?: unknown }).type).toBe('overloaded_error');
    expect(hits).toBe(4);
    expect(retryReasons).toHaveLength(3);
    expectBooked(agent, before, 4);
  }, 10_000);

  /** The bound of one attempt, priced from the provider's count in `message_start`. */
  const bound = (agent: Agent): ReturnType<typeof abortedCallCost> => {
    const inside = agent as unknown as Inside;
    return abortedCallCost({ model: inside.model, maxTokens: inside.maxTokens, request: '', partial: { usage: PROMPT_USAGE, content: [] } });
  };

  it('after its turn_end, with a consumer that counts it (Session): retried, the bound to the caps only, no estimate on top, no count', async () => {
    const { agent, hits, result, retryReasons, turnEnds, before } = await runAgainst((hit, res) => {
      if (hit === 1) errorAfterTurnEnd(res); else reply(res, 'recovered');
    }, { turnEndUsageCounted: true });
    expect(result).toBe('recovered');
    expect(hits).toBe(2);
    expect(retryReasons).toHaveLength(1);
    // The failed attempt's turn_end went out with its usage, which the consumer counts into the
    // run's own (the cost line and the tenant debit are priced from it): counted there once.
    expect(turnEnds).toEqual([5, 5]);
    // So nothing of it goes to the run's cost line on top, and it is not counted as an unbilled call.
    expect(agent.getHelperCostUsd()).toBe(0);
    expect(abortedCallCounts().notBilled[SITE] ?? 0).toBe(before.notBilled[SITE] ?? 0);
    // The caps still get the bound once: the run ceiling's regular booking runs only for a call that returned.
    const inside = agent as unknown as Inside;
    expect(inside.costGuard.capOnlyUSD).toBeCloseTo(bound(agent).upperBoundUsd, 12);
    expect(inside.sessionCounters.costUSD).toBeCloseTo(bound(agent).upperBoundUsd, 12);
  }, 10_000);

  it('after its turn_end, with a consumer that drops it (a spawned child): the estimate and the count, as before turn_end', async () => {
    const { agent, result, turnEnds, before } = await runAgainst((hit, res) => {
      if (hit === 1) errorAfterTurnEnd(res); else reply(res, 'recovered');
    });
    expect(result).toBe('recovered');
    expect(turnEnds).toEqual([5, 5]);
    expectBooked(agent, before, 1);
  }, 10_000);

  it('a consumer that counts turn_end and then throws on it: the call ends, the bound alone is booked', async () => {
    const { agent, hits, err, before } = await runAgainst((_hit, res) => { errorAfterTurnEnd(res); }, { turnEndUsageCounted: true, throwOnTurnEnd: true });
    expect((err as Error).message).toBe('consumer failed after counting');
    expect(hits).toBe(1);
    expect(agent.getHelperCostUsd()).toBe(0);
    expect(abortedCallCounts().notBilled[SITE] ?? 0).toBe(before.notBilled[SITE] ?? 0);
    expect((agent as unknown as Inside).costGuard.capOnlyUSD).toBeCloseTo(bound(agent).upperBoundUsd, 12);
  }, 10_000);

  it('the retry event says whether the failed attempt had sent its turn_end', async () => {
    const after = await runAgainst((hit, res) => { if (hit === 1) errorAfterTurnEnd(res); else reply(res, 'recovered'); });
    expect(after.retryAfterTurnEnd).toEqual([true]);
    const before = await runAgainst((hit, res) => { if (hit === 1) errorMidStream(res, 'overloaded_error'); else reply(res, 'recovered'); });
    expect(before.retryAfterTurnEnd).toEqual([false]);
    const unanswered = await runAgainst((hit, res) => { if (hit <= 3) overloadedStatus(res); else reply(res, 'recovered'); });
    expect(unanswered.retryAfterTurnEnd).toEqual([false]);
  }, 10_000);

  it('control: an HTTP 529 before any event is retried on the same machinery and books nothing', async () => {
    // Three refusals: the SDK's own two retries inside the call, then the Agent's retry.
    const { agent, hits, result, retryReasons, before } = await runAgainst((hit, res) => {
      if (hit <= 3) overloadedStatus(res); else reply(res, 'recovered');
    });
    expect(result).toBe('recovered');
    expect(hits).toBe(4);
    expect(retryReasons).toHaveLength(1);
    expect(retryReasons[0]).toMatch(/^529/);
    const inside = agent as unknown as Inside;
    expect(abortedCallCounts().notBilled[SITE] ?? 0).toBe(before.notBilled[SITE] ?? 0);
    expect(inside.costGuard.capOnlyUSD).toBe(0);
    expect(agent.getHelperCostUsd()).toBe(0);
  }, 10_000);
});

// A response the provider closes cleanly before its `message_stop` is a reply cut off, not a
// finished one: neither the Anthropic SDK's stream nor the openai-compatible adapter reports it,
// so the stream processor does, and the attempt is retried and booked like one ended by an error.
describe('a stream that ends without message_stop', () => {
  const seam = Agent as unknown as { RETRY_BASE_MS: number };
  let saved = 0;
  beforeAll(() => { saved = seam.RETRY_BASE_MS; seam.RETRY_BASE_MS = 1; });
  afterAll(() => { seam.RETRY_BASE_MS = saved; });

  const bound = (agent: Agent): ReturnType<typeof abortedCallCost> => {
    const inside = agent as unknown as Inside;
    return abortedCallCost({ model: inside.model, maxTokens: inside.maxTokens, request: '', partial: { usage: PROMPT_USAGE, content: [] } });
  };

  it('cut off after a text piece: retried with a second request, the run gets the second reply, the first attempt is booked', async () => {
    const { agent, hits, result, err, retryReasons, retryAfterTurnEnd, before } = await runAgainst((hit, res) => {
      if (hit === 1) truncated(res); else reply(res, 'recovered');
    });
    expect(err).toBeUndefined();
    expect(result).toBe('recovered');
    expect(hits).toBe(2);
    expect(retryReasons).toHaveLength(1);
    expect(retryReasons[0]).toMatch(/^StreamIncompleteError: /);
    expect(retryAfterTurnEnd).toEqual([false]);
    expectBooked(agent, before, 1);
  }, 10_000);

  it('cut off on every attempt: the retry count holds, the run fails with the error, every attempt is booked once', async () => {
    const { agent, hits, result, err, retryReasons, before } = await runAgainst((_hit, res) => { truncated(res); });
    expect(result).toBeUndefined();
    expect(err).toBeInstanceOf(StreamIncompleteError);
    expect(hits).toBe(4);
    expect(retryReasons).toHaveLength(3);
    expectBooked(agent, before, 4);
  }, 10_000);

  it('cut off after its turn_end, with a consumer that counts it (Session): retried, the bound to the caps only, no estimate, no count', async () => {
    const { agent, hits, result, retryReasons, retryAfterTurnEnd, turnEnds, before } = await runAgainst((hit, res) => {
      if (hit === 1) truncatedAfterTurnEnd(res); else reply(res, 'recovered');
    }, { turnEndUsageCounted: true });
    expect(result).toBe('recovered');
    expect(hits).toBe(2);
    expect(retryReasons).toHaveLength(1);
    expect(retryAfterTurnEnd).toEqual([true]);
    expect(turnEnds).toEqual([5, 5]);
    expect(agent.getHelperCostUsd()).toBe(0);
    expect(abortedCallCounts().notBilled[SITE] ?? 0).toBe(before.notBilled[SITE] ?? 0);
    const inside = agent as unknown as Inside;
    expect(inside.costGuard.capOnlyUSD).toBeCloseTo(bound(agent).upperBoundUsd, 12);
    expect(inside.sessionCounters.costUSD).toBeCloseTo(bound(agent).upperBoundUsd, 12);
  }, 10_000);

  it('cut off after its turn_end, with a consumer that drops it (a spawned child): the estimate and the count', async () => {
    const { agent, result, turnEnds, before } = await runAgainst((hit, res) => {
      if (hit === 1) truncatedAfterTurnEnd(res); else reply(res, 'recovered');
    });
    expect(result).toBe('recovered');
    expect(turnEnds).toEqual([5, 5]);
    expectBooked(agent, before, 1);
  }, 10_000);

  it('control: a complete Anthropic stream is one request, no retry, nothing booked as ended', async () => {
    const { agent, hits, result, retryReasons, before } = await runAgainst((_hit, res) => { reply(res, 'whole answer'); });
    expect(result).toBe('whole answer');
    expect(hits).toBe(1);
    expect(retryReasons).toHaveLength(0);
    expect(abortedCallCounts().notBilled[SITE] ?? 0).toBe(before.notBilled[SITE] ?? 0);
    expect((agent as unknown as Inside).costGuard.capOnlyUSD).toBe(0);
    expect(agent.getHelperCostUsd()).toBe(0);
  }, 10_000);

  it('control: a complete openai-compatible stream (finish_reason, usage chunk, [DONE]) is one request, no retry, nothing booked as ended', async () => {
    const { agent, hits, result, retryReasons, turnEnds, before } = await runAgainst((_hit, res) => { openaiReply(res, 'whole answer', true); }, { wire: 'openai' });
    expect(result).toBe('whole answer');
    expect(hits).toBe(1);
    expect(retryReasons).toHaveLength(0);
    expect(turnEnds).toEqual([5]);
    expect(abortedCallCounts().notBilled[SITE] ?? 0).toBe(before.notBilled[SITE] ?? 0);
    expect((agent as unknown as Inside).costGuard.capOnlyUSD).toBe(0);
    expect(agent.getHelperCostUsd()).toBe(0);
  }, 10_000);

  it('an openai-compatible stream closed before its finish_reason: retried, the second reply wins, the first attempt is booked', async () => {
    const { agent, hits, result, retryReasons, before } = await runAgainst((hit, res) => {
      openaiReply(res, hit === 1 ? 'partial answer ' : 'recovered', hit !== 1);
    }, { wire: 'openai' });
    expect(result).toBe('recovered');
    expect(hits).toBe(2);
    expect(retryReasons).toHaveLength(1);
    expect(retryReasons[0]).toMatch(/^StreamIncompleteError: /);
    expect(abortedCallCounts().notBilled[SITE] ?? 0).toBe((before.notBilled[SITE] ?? 0) + 1);
    const inside = agent as unknown as Inside;
    expect(inside.costGuard.capOnlyUSD).toBeGreaterThan(0);
    expect(agent.getHelperCostUsd()).toBeGreaterThan(0);
  }, 10_000);
});

// The provider's error text is not a classification: whatever words it carries, a typed
// provider error is decided by its type. Text-based checks are for errors that carry no type.
describe('the retry decision reads the provider type before any text', () => {
  const seam = Agent as unknown as { RETRY_BASE_MS: number };
  let saved = 0;
  beforeAll(() => { saved = seam.RETRY_BASE_MS; seam.RETRY_BASE_MS = 1; });
  afterAll(() => { seam.RETRY_BASE_MS = saved; });

  /** The connection dropped before any response: the SDK's connection error, which has no type. */
  const drop = (res: ServerResponse): void => { res.socket?.destroy(); };
  /** An HTTP 400 whose body is not the provider's error envelope, so the SDK's error has no type. */
  const untyped400 = (text: string) => (res: ServerResponse): void => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: text }));
  };
  /** An HTTP 400 in the provider's envelope, typed `invalid_request_error`. */
  const typed400 = (text: string) => (res: ServerResponse): void => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: text } }));
  };

  for (const text of ['upstream read ECONNRESET', 'ThrottlingException: rate exceeded']) {
    it(`mid-stream invalid_request_error with "${text}" in the provider text: exactly one request, the run fails`, async () => {
      const { hits, result, err, retryReasons } = await runAgainst((hit, res) => {
        if (hit === 1) errorMidStream(res, 'invalid_request_error', text); else reply(res, 'should not be asked');
      });
      expect(result).toBeUndefined();
      expect((err as { type?: unknown }).type).toBe('invalid_request_error');
      expect((err as Error).message).toContain(text);
      expect(hits).toBe(1);
      expect(retryReasons).toHaveLength(0);
    }, 10_000);
  }

  it('HTTP 400 typed invalid_request_error with "ECONNRESET" in its text: one request', async () => {
    const { hits, err } = await runAgainst((_hit, res) => { typed400('upstream read ECONNRESET')(res); });
    expect((err as { status?: unknown }).status).toBe(400);
    expect(hits).toBe(1);
  }, 10_000);

  it('control: a dropped connection is still retried, read through its cause chain', async () => {
    // Three drops: the SDK's own two retries inside the call, then the Agent's retry.
    const { hits, result, retryReasons } = await runAgainst((hit, res) => {
      if (hit <= 3) drop(res); else reply(res, 'recovered');
    });
    expect(result).toBe('recovered');
    expect(hits).toBe(4);
    expect(retryReasons).toHaveLength(1);
    expect(retryReasons[0]).toMatch(/^unknown: Connection error/);
  }, 10_000);

  it('control: an untyped HTTP 400 naming an AWS throttle is still retried', async () => {
    const { hits, result, retryReasons } = await runAgainst((hit, res) => {
      if (hit === 1) untyped400('ThrottlingException: rate exceeded')(res); else reply(res, 'recovered');
    });
    expect(result).toBe('recovered');
    expect(hits).toBe(2);
    expect(retryReasons).toHaveLength(1);
    expect(retryReasons[0]).toMatch(/^400: .*ThrottlingException/);
  }, 10_000);

  it('control: an untyped HTTP 400 naming ECONNRESET is still retried', async () => {
    const { hits, result } = await runAgainst((hit, res) => {
      if (hit === 1) untyped400('read ECONNRESET')(res); else reply(res, 'recovered');
    });
    expect(result).toBe('recovered');
    expect(hits).toBe(2);
  }, 10_000);

  it('control: an untyped HTTP 400 with neither is not retried', async () => {
    const { hits } = await runAgainst((_hit, res) => { untyped400('bad request')(res); });
    expect(hits).toBe(1);
  }, 10_000);
});

describe('who says its stream consumer counts turn_end', () => {
  let dir: string | undefined;
  let prevDataDir: string | undefined;
  let engine: Engine | undefined;
  afterEach(async () => {
    try { await engine?.shutdown(); } catch { /* best effort */ }
    engine = undefined;
    if (prevDataDir === undefined) delete process.env['LYNOX_DATA_DIR'];
    else process.env['LYNOX_DATA_DIR'] = prevDataDir;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
    reloadConfig();
  });

  it('a Session\'s agent does, across a rebuild; an agent built without it does not', async () => {
    prevDataDir = process.env['LYNOX_DATA_DIR'];
    dir = mkdtempSync(join(tmpdir(), 'lynox-turn-end-'));
    process.env['LYNOX_DATA_DIR'] = dir;
    reloadConfig();
    engine = new Engine({} as LynoxConfig);
    await engine.init();
    const session = engine.createSession();
    const counted = (): unknown => (session as unknown as { agent: { turnEndUsageCounted: unknown } }).agent.turnEndUsageCounted;
    expect(counted()).toBe(true);
    session._recreateAgent();
    expect(counted()).toBe(true);
    const plain = new Agent({ name: 'test', model: 'claude-sonnet-4-6' });
    expect((plain as unknown as { turnEndUsageCounted: unknown }).turnEndUsageCounted).toBe(false);
  }, 10_000);
});
