// A reply that writes the same tool call out as text, over and over, is stopped while it
// streams. Driven through a REAL Engine, Session, Agent, StreamProcessor and ThreadStore;
// only the provider's event stream is stubbed.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages.js';

interface Script { events: Array<Record<string, unknown>>; yielded: number; returned: boolean; abortedAtReturn?: boolean; hang?: boolean; failWith?: Error }

const { calls, scripts, onCall } = vi.hoisted(() => ({
  calls: [] as Array<{ params: { messages: BetaMessageParam[] }; signal: AbortSignal | undefined }>,
  scripts: [] as Script[],
  onCall: { fn: null as (() => void) | null },
}));

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    beta = {
      messages: {
        stream: (params: { messages: BetaMessageParam[] }, opts?: { signal?: AbortSignal }) => ({
          // Helper calls of the run (retrieval, extraction) read the whole message at once;
          // they get an empty one and are not counted. Only the agent's own call streams.
          finalMessage: async () => ({ content: [{ type: 'text', text: '' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }),
          [Symbol.asyncIterator]() {
            calls.push({ params, signal: opts?.signal });
            onCall.fn?.();
            const script = scripts.shift();
            if (!script) throw new Error('no scripted reply left');
            return {
              next: async () => {
                if (script.yielded < script.events.length) return { done: false, value: script.events[script.yielded++] };
                if (script.failWith) throw script.failWith;
                if (!script.hang) return { done: true, value: undefined };
                // A reply still being generated: the read waits until the call is aborted.
                return new Promise((_res, rej) => {
                  const fail = (): void => { rej(new Error('Request was aborted.')); };
                  if (opts?.signal?.aborted) fail(); else opts?.signal?.addEventListener('abort', fail, { once: true });
                });
              },
              return: async () => {
                script.returned = true;
                script.abortedAtReturn = opts?.signal?.aborted === true;
                return { done: true, value: undefined };
              },
            };
          },
        }),
      },
    };
  }
  class APIError extends Error {}
  return { default: MockAnthropic, APIError };
});

import { getEventListeners } from 'node:events';
import { Agent, RunAbortedError, ToolCallImitationError } from './agent.js';
import { Engine } from './engine.js';
import { reloadConfig } from './config.js';
import { SessionStore } from './session-store.js';
import { readRunStop, runStopText, applyRunStops } from './run-stop.js';
import { TOOL_CALL_IMITATION_REPEATS } from './tool-call-imitation.js';
import { abortedCallCost, abortedCallCounts } from './aborted-call.js';
import { calculateCost } from './pricing.js';
import type { Session } from './session.js';
import type { ToolEntry } from '../types/index.js';
import type { LynoxConfig } from '../types/config.js';

const usage = { input_tokens: 100, output_tokens: 0, cache_creation: null, cache_creation_input_tokens: null, cache_read_input_tokens: null, inference_geo: null, iterations: null, server_tool_use: null, service_tier: null, speed: null };

function script(events: Array<Record<string, unknown>>): Script {
  const s = { events, yielded: 0, returned: false };
  scripts.push(s);
  return s;
}

function toolUseReply(id: string, input: Record<string, unknown>): Script {
  return script([
    { type: 'message_start', message: { usage: { ...usage } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name: 'send_request', input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 20 } },
    { type: 'message_stop' },
  ]);
}

/** A text reply, streamed in pieces of `step` characters. */
function textReply(text: string, step: number, stopReason = 'end_turn'): Script {
  const deltas: Array<Record<string, unknown>> = [];
  for (let o = 0; o < text.length; o += step) {
    deltas.push({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(o, o + step) } });
  }
  return script([
    { type: 'message_start', message: { usage: { ...usage } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    ...deltas,
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: 500 } },
    { type: 'message_stop' },
  ]);
}

const handler = vi.fn();
const sendTool: ToolEntry = {
  definition: {
    name: 'send_request',
    description: 'Send an HTTP request',
    input_schema: { type: 'object' as const, properties: { url: { type: 'string' }, method: { type: 'string' }, body: { type: 'string' } }, required: ['url'] },
  },
  handler: (input: unknown) => handler(input) as Promise<string>,
};

const ENV_KEYS = ['LYNOX_DATA_DIR', 'LYNOX_VAULT_KEY', 'ANTHROPIC_API_KEY', 'LYNOX_MANAGED_INSTANCE_ID', 'LYNOX_EMBEDDING_PROVIDER'] as const;
const saved = new Map<string, string | undefined>();
const dirs: string[] = [];
const engines: Engine[] = [];

function setEnv(key: string, value: string | undefined): void {
  if (!saved.has(key)) saved.set(key, process.env[key]);
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
}

async function boot(): Promise<Engine> {
  const dir = mkdtempSync(join(tmpdir(), 'lynox-tci-'));
  dirs.push(dir);
  for (const k of ENV_KEYS) setEnv(k, undefined);
  setEnv('LYNOX_DATA_DIR', dir);
  setEnv('ANTHROPIC_API_KEY', 'test-key-not-real');
  // The local embedder: no model download and no network in a test about the stream.
  setEnv('LYNOX_EMBEDDING_PROVIDER', 'local');
  reloadConfig();
  const engine = new Engine({} as LynoxConfig);
  engines.push(engine);
  await engine.init();
  engine.registerTool(sendTool);
  return engine;
}

beforeEach(() => {
  onCall.fn = null;
  handler.mockReset();
  calls.length = 0;
  scripts.length = 0;
});

afterEach(async () => {
  for (const e of engines) { try { await e.shutdown(); } catch { /* best effort */ } }
  engines.length = 0;
  for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  saved.clear();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
  reloadConfig();
}, 30_000);

function apiRows(engine: Engine, session: Session): BetaMessageParam[] {
  return engine.getThreadStore()!.getMessages(session.sessionId, { apiOnly: true })
    .map((r) => ({ role: r.role as 'user' | 'assistant', content: JSON.parse(r.content_json) as BetaMessageParam['content'] }));
}

function outgoingTexts(messages: BetaMessageParam[]): string[] {
  return messages.flatMap((m) => typeof m.content === 'string'
    ? [m.content]
    : m.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])));
}

const COPY = 'Sending it now:\n{"url": "https://shop.example.com/api/orders", "method": "POST", "body": "{\\"sku\\": \\"A-17\\"}"}\n';

/** Index (in the script's events) of the text delta that completes the n-th copy of COPY. */
function deltaCompletingCopy(n: number, step: number): number {
  // The unit ends at the closing brace of the n-th JSON object.
  const end = COPY.length * (n - 1) + COPY.lastIndexOf('}') + 1;
  return 2 + Math.ceil(end / step) - 1;
}

describe('a reply that writes the same tool call out as text', { timeout: 60_000 }, () => {
  it('is stopped while it streams: question and completed pairs stay, the text goes, the call ends upstream, no retry', async () => {
    const engine = await boot();
    const debited = new Map<string, number[]>();
    engine.registerHooks({ onAfterRun: (runId: string, costUsd: number) => { debited.set(runId, [...(debited.get(runId) ?? []), costUsd]); } });
    const session = engine.createSession();
    handler.mockResolvedValue('200 OK, order list');
    // Per call: the run's signal, and whether the call's own signal was live when it started.
    const runSignals: AbortSignal[] = [];
    const liveAtStart: boolean[] = [];
    onCall.fn = () => {
      const run = (session.getAgent() as unknown as { abortController: AbortController | null }).abortController;
      if (run) runSignals.push(run.signal);
      liveAtStart.push(calls.at(-1)!.signal?.aborted === false);
    };
    toolUseReply('tu_list', { url: 'https://shop.example.com/api/orders', method: 'GET' });
    const step = 9;
    const looping = textReply(COPY.repeat(5), step);

    const err = await session.run('place the order for A-17').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ToolCallImitationError);
    expect((err as ToolCallImitationError).toolName).toBe('send_request');

    // One call per reply: the stopped one is not sent again.
    expect(calls).toHaveLength(2);
    // The stream was left on the delta that completed the third copy, and closed.
    expect(TOOL_CALL_IMITATION_REPEATS).toBe(3);
    expect(looping.yielded).toBe(deltaCompletingCopy(3, step) + 1);
    expect(looping.yielded).toBeLessThan(looping.events.length);
    expect(looping.returned).toBe(true);
    // The request itself was ended through the call's own signal, before the stream was left.
    expect(looping.abortedAtReturn).toBe(true);

    // The stop leaves the run's own signal alone.
    expect(runSignals).toHaveLength(2);
    expect(runSignals[1]!.aborted).toBe(false);

    // The stopped call is booked as an aborted call: its estimate goes to the run's cost line,
    // and none of it to the tenant debit, which gets the finished call's exact cost only.
    const run = engine.getRunHistory()!.getRunsBySession(session.sessionId)[0]!;
    const finishedCost = calculateCost(run.model_id, { input_tokens: 100, output_tokens: 20 });
    expect(run.tokens_in).toBe(100);
    expect(run.tokens_out).toBe(20);
    expect(run.cost_usd).toBeGreaterThan(finishedCost);
    const debit = debited.get(run.id) ?? [];
    expect(debit).toHaveLength(1);
    expect(debit[0]).toBeCloseTo(finishedCost, 12);

    const live = session.getAgent()!.getMessages();
    // The question and the completed pair; nothing of the stopped reply.
    expect(live).toHaveLength(3);
    expect(live[0]!.role).toBe('user');
    expect(JSON.stringify(live[0])).toContain('place the order for A-17');
    expect(JSON.stringify(live)).toContain('200 OK, order list');
    expect(JSON.stringify(live)).not.toContain('Sending it now');
    expect(readRunStop(live.at(-1)!)?.code).toBe('tool_call_imitation');
    // Disk and reload agree with the model's context.
    expect(JSON.stringify(apiRows(engine, session))).toBe(JSON.stringify(live));
    const reloaded = new SessionStore().getOrCreate(session.sessionId, engine).getAgent()!.getMessages();
    expect(reloaded).toEqual(live);
    expect(readRunStop(reloaded.at(-1)!)?.code).toBe('tool_call_imitation');
    // The display note carries the code.
    const notes = engine.getThreadStore()!.getMessages(session.sessionId).filter((r) => r.display_only === 1);
    expect(notes.map((r) => r.content_json).join('')).toContain('tool_call_imitation');

    // The next call tells the model why, once, and the run goes on normally.
    textReply('Understood.', 50);
    await session.run('try again');
    const sent = calls.at(-1)!.params.messages;
    expect(outgoingTexts(sent).filter((t) => t === runStopText({ code: 'tool_call_imitation' }))).toHaveLength(1);
    expect(outgoingTexts(applyRunStops(live)).at(-1)).toBe(runStopText({ code: 'tool_call_imitation' }));
    expect(runStopText({ code: 'tool_call_imitation' })).toContain('wrote a tool call out as text');
    expect(runStopText({ code: 'tool_call_imitation' })).toContain('Nothing of it was run');
    // The next call starts with a live signal, and its controller is released after it, so
    // nothing of it can run on.
    expect(liveAtStart.at(-1)).toBe(true);
    expect(calls.at(-1)!.signal?.aborted).toBe(true);
  });

  it('reads a reply that quotes the request as an example to the end', async () => {
    const engine = await boot();
    const session = engine.createSession();
    const reply = textReply(COPY.repeat(2), 9);
    await expect(session.run('show me the request twice')).resolves.toBeDefined();
    expect(reply.yielded).toBe(reply.events.length);
    expect(calls).toHaveLength(1);
  });

  it('a user stop during such a reply ends the call and is still a stop by the user', async () => {
    const engine = await boot();
    const session = engine.createSession();
    // One copy, then the reply keeps generating until the call is aborted.
    const s = textReply(COPY, 9);
    s.events.splice(-3);
    s.hang = true;
    const turn = session.run('go');
    for (let i = 0; i < 2000 && s.yielded < s.events.length; i++) await new Promise((r) => setTimeout(r, 5));
    expect(s.yielded).toBe(s.events.length);
    expect(calls[0]!.signal?.aborted).toBe(false);
    session.abort();
    const err = await turn.catch((e: unknown) => e);
    // The run's abort reaches the call's own signal.
    expect(calls[0]!.signal?.aborted).toBe(true);
    expect(err).toBeInstanceOf(RunAbortedError);
    expect(err).not.toBeInstanceOf(ToolCallImitationError);
    expect(readRunStop(session.getAgent()!.getMessages().at(-1)!)?.code).toBe('run_interrupted');
  });
});

describe('the per-call controller on a long run', () => {
  it('keeps at most one abort listener on the run\'s signal across twelve calls', async () => {
    const agent = new Agent({ name: 'test', model: 'claude-sonnet-4-6', tools: [sendTool] });
    handler.mockResolvedValue('ok');
    for (let i = 0; i < 11; i++) toolUseReply(`tu_${String(i)}`, { url: `https://x.test/${String(i)}` });
    textReply('Done.', 50);
    const counts: number[] = [];
    onCall.fn = () => {
      const run = (agent as unknown as { abortController: AbortController | null }).abortController;
      counts.push(run ? getEventListeners(run.signal, 'abort').length : -1);
    };
    await agent.send('go through all of them');
    expect(counts).toHaveLength(12);
    // The listener of the call in flight, and none left behind by the calls before it.
    expect(Math.max(...counts)).toBeLessThanOrEqual(1);
    expect(Math.min(...counts)).toBeGreaterThanOrEqual(1);
  });

  it('a call that starts after the run was stopped starts with a stopped signal', { timeout: 15_000 }, async () => {
    const agent = new Agent({ name: 'test', model: 'claude-sonnet-4-6', tools: [sendTool] });
    // The run is stopped while its tool runs; the tool still returns.
    handler.mockImplementation(() => {
      (agent as unknown as { abortController: AbortController }).abortController.abort();
      return Promise.resolve('ok');
    });
    toolUseReply('tu_1', { url: 'https://x.test/1' });
    // Its reply would never end on its own: only the call's signal ends it.
    const s2 = textReply('never read', 50);
    s2.events.splice(-3);
    s2.hang = true;
    const abortedAtStart: boolean[] = [];
    onCall.fn = () => { abortedAtStart.push(calls.at(-1)!.signal?.aborted === true); };
    const err = await agent.send('go').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunAbortedError);
    expect(calls).toHaveLength(2);
    // The second call is handed a signal that is already stopped, so it does not run on.
    expect(abortedAtStart).toEqual([false, true]);
  });
});

describe('what a stopped call used', () => {
  type Booked = { costGuard: { capOnlyUSD: number } };
  const site = 'agent.tool_call_imitation';

  it('is booked as an aborted call: the bound to the caps, the estimate to the cost line, no turn usage', async () => {
    const events: Array<{ type: string }> = [];
    const counters = { costUSD: 0, spawnCount: 0, spawnCostUSD: 0 } as unknown as import('../types/agent.js').SessionCounters;
    const agent = new Agent({
      name: 'test', model: 'claude-sonnet-4-6', tools: [sendTool], costGuard: { maxBudgetUSD: 100 }, sessionCounters: counters,
      onStream: (e) => { events.push(e as { type: string }); },
    });
    const before = abortedCallCounts().notBilled[site] ?? 0;
    const uncountedBefore = abortedCallCounts().uncounted[site] ?? 0;
    textReply(COPY.repeat(5), 9);
    const err = await agent.send('place the order').catch((e: unknown) => e) as ToolCallImitationError;
    expect(err).toBeInstanceOf(ToolCallImitationError);
    const capOnly = (agent as unknown as Booked).costGuard.capOnlyUSD;
    const estimate = agent.getHelperCostUsd();
    expect(estimate).toBeGreaterThan(0);
    expect(capOnly).toBeGreaterThan(estimate);
    expect(counters.costUSD).toBeCloseTo(capOnly, 12);
    // Not as a finished call's usage: no turn_end, and the guard counted no tokens.
    expect(events.filter((e) => e.type === 'turn_end')).toHaveLength(0);
    expect(agent.getCostSnapshot()!.inputTokens).toBe(0);
    // Reported per site; the provider counted this prompt (message_start carried 100).
    expect(abortedCallCounts().notBilled[site]).toBe(before + 1);
    expect(abortedCallCounts().uncounted[site] ?? 0).toBe(uncountedBefore);
  });

  it('estimates the prompt from the request when the wire reports no input count', async () => {
    const agent = new Agent({ name: 'test', model: 'claude-sonnet-4-6', tools: [sendTool], costGuard: { maxBudgetUSD: 100 } });
    const uncountedBefore = abortedCallCounts().uncounted[site] ?? 0;
    const s = textReply(COPY.repeat(5), 9);
    // The openai-compatible adapter's message_start carries no input count.
    (s.events[0] as { message: { usage: { input_tokens: number } } }).message.usage.input_tokens = 0;
    const err = await agent.send('place the order').catch((e: unknown) => e) as ToolCallImitationError;
    expect(err).toBeInstanceOf(ToolCallImitationError);
    expect(abortedCallCounts().uncounted[site]).toBe(uncountedBefore + 1);
    // More than the output alone: the request's size priced as input.
    const outputOnly = abortedCallCost({ model: 'claude-sonnet-4-6', maxTokens: (agent as unknown as { maxTokens: number }).maxTokens, request: '', partial: err.partial }).estimateUsd;
    expect(agent.getHelperCostUsd()).toBeGreaterThan(outputOnly);
  });
});

describe('what a call the person stopped used', () => {
  type Booked = { costGuard: { capOnlyUSD: number; recordCapOnlyCost: (usd: number) => boolean }; maxTokens: number };
  const site = 'agent.user_abort';
  const model = 'claude-sonnet-4-6';

  /** A reply that starts and then keeps generating until its call is aborted. */
  function hangingReply(events: Array<Record<string, unknown>>): Script {
    const s = script(events);
    s.hang = true;
    return s;
  }

  async function untilRead(s: Script): Promise<void> {
    for (let i = 0; i < 2000 && s.yielded < s.events.length; i++) await new Promise((r) => setTimeout(r, 5));
    expect(s.yielded).toBe(s.events.length);
    // The processor handles the last event before it asks for the next.
    await new Promise((r) => setTimeout(r, 10));
  }

  /** The error `_callAPI` itself rethrows, before `send` turns an abort into a RunAbortedError. */
  function captureCallError(agent: Agent): { err: unknown } {
    const seen: { err: unknown } = { err: undefined };
    const a = agent as unknown as { _callAPI: () => Promise<unknown> };
    const orig = a._callAPI.bind(agent);
    a._callAPI = async () => { try { return await orig(); } catch (e) { seen.err = e; throw e; } };
    return seen;
  }

  function newAgent(counters?: import('../types/agent.js').SessionCounters): Agent {
    return new Agent({ name: 'test', model, tools: [sendTool], costGuard: { maxBudgetUSD: 100 }, sessionCounters: counters });
  }

  it('a stop after the first event books the call: the bound to the caps, the estimate to the cost line, the error unchanged', async () => {
    const counters = { costUSD: 0, spawnCount: 0, spawnCostUSD: 0 } as unknown as import('../types/agent.js').SessionCounters;
    const agent = newAgent(counters);
    const callErr = captureCallError(agent);
    const before = abortedCallCounts().notBilled[site] ?? 0;
    const uncountedBefore = abortedCallCounts().uncounted[site] ?? 0;
    const s = hangingReply([{ type: 'message_start', message: { usage: { ...usage } } }]);
    const turn = agent.send('list everything');
    await untilRead(s);
    agent.abort();
    const err = await turn.catch((e: unknown) => e);

    // The error is the one the stream threw, and the run's stop as before.
    expect((callErr.err as Error).message).toBe('Request was aborted.');
    expect(callErr.err).not.toBeInstanceOf(RunAbortedError);
    expect(err).toBeInstanceOf(RunAbortedError);
    expect((err as Error).message).toBe(new RunAbortedError().message);

    // Priced from the provider's own count (message_start carried 100), nothing generated yet.
    const expected = abortedCallCost({
      model, maxTokens: (agent as unknown as Booked).maxTokens, request: '',
      partial: { usage: { ...usage }, content: [] },
    });
    expect(expected.fromSnapshot).toBe(true);
    expect(agent.getHelperCostUsd()).toBeCloseTo(expected.estimateUsd, 12);
    expect(agent.getHelperCostUsd()).toBeGreaterThan(0);
    expect((agent as unknown as Booked).costGuard.capOnlyUSD).toBeCloseTo(expected.upperBoundUsd, 12);
    expect(counters.costUSD).toBeCloseTo(expected.upperBoundUsd, 12);
    // Counted under its own site, and as counted by the provider.
    expect(abortedCallCounts().notBilled[site]).toBe(before + 1);
    expect(abortedCallCounts().uncounted[site] ?? 0).toBe(uncountedBefore);
    expect(agent.getCostSnapshot()!.inputTokens).toBe(0);
  });

  it('a stop before the first event prices the prompt from the request', async () => {
    const agent = newAgent();
    const uncountedBefore = abortedCallCounts().uncounted[site] ?? 0;
    const s = hangingReply([]);
    const turn = agent.send('list everything');
    await untilRead(s);
    agent.abort();
    await turn.catch(() => undefined);
    expect(abortedCallCounts().uncounted[site]).toBe(uncountedBefore + 1);
    // More than nothing: the request's size priced as input.
    const promptless = abortedCallCost({ model, maxTokens: (agent as unknown as Booked).maxTokens, request: '', partial: { content: [] } }).estimateUsd;
    expect(agent.getHelperCostUsd()).toBeGreaterThan(promptless);
  });

  it('booking that fails does not replace the stop', async () => {
    const agent = newAgent();
    const callErr = captureCallError(agent);
    (agent as unknown as Booked).costGuard.recordCapOnlyCost = () => { throw new Error('booking broke'); };
    const s = hangingReply([{ type: 'message_start', message: { usage: { ...usage } } }]);
    const turn = agent.send('list everything');
    await untilRead(s);
    agent.abort();
    const err = await turn.catch((e: unknown) => e);
    expect((callErr.err as Error).message).toBe('Request was aborted.');
    expect(err).toBeInstanceOf(RunAbortedError);
  });

  it('a call that starts after the run was stopped books nothing, while the one before it was booked as finished', async () => {
    const agent = newAgent();
    const before = abortedCallCounts().notBilled[site] ?? 0;
    handler.mockImplementation(() => {
      (agent as unknown as { abortController: AbortController }).abortController.abort();
      return Promise.resolve('ok');
    });
    toolUseReply('tu_1', { url: 'https://x.test/1' });
    // The mock yields this call's events although its signal is stopped: the processor sees
    // usage, and still nothing may be booked, as neither wire sends such a request.
    hangingReply([{ type: 'message_start', message: { usage: { ...usage } } }]);
    const err = await agent.send('go').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunAbortedError);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.signal?.aborted).toBe(true);
    expect(agent.getHelperCostUsd()).toBe(0);
    expect((agent as unknown as Booked).costGuard.capOnlyUSD).toBe(0);
    expect(abortedCallCounts().notBilled[site] ?? 0).toBe(before);
  });

  it('a stop during the wait before a retry books nothing', { timeout: 15_000 }, async () => {
    const before = abortedCallCounts().notBilled[site] ?? 0;
    let agent: Agent | null = null;
    agent = new Agent({
      name: 'test', model, tools: [sendTool], costGuard: { maxBudgetUSD: 100 },
      // The wait before the second attempt is two seconds; the stop comes inside it.
      onStream: (e) => { if ((e as { type: string }).type === 'retry') setTimeout(() => { agent!.abort(); }, 50); },
    });
    const s = script([{ type: 'message_start', message: { usage: { ...usage } } }]);
    s.failWith = new TypeError('terminated');
    script([{ type: 'message_start', message: { usage: { ...usage } } }]);
    const started = Date.now();
    const err = await agent.send('go').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunAbortedError);
    // Stopped inside the wait, and the second attempt never started.
    expect(Date.now() - started).toBeLessThan(1500);
    expect(calls).toHaveLength(1);
    expect(agent.getHelperCostUsd()).toBe(0);
    expect((agent as unknown as Booked).costGuard.capOnlyUSD).toBe(0);
    expect(abortedCallCounts().notBilled[site] ?? 0).toBe(before);
  });

  it('a guard stop that coincides with the run\'s stop is booked once, under the guard', async () => {
    const counters = { costUSD: 0, spawnCount: 0, spawnCostUSD: 0 } as unknown as import('../types/agent.js').SessionCounters;
    let agent: Agent | null = null;
    // The run is stopped on the first text the reply shows; the scripted stream reads on until
    // the guard trips, so both stops are in place when the call's error is caught.
    agent = new Agent({
      name: 'test', model, tools: [sendTool], costGuard: { maxBudgetUSD: 100 }, sessionCounters: counters,
      onStream: (e) => { if ((e as { type: string }).type === 'text') agent!.abort(); },
    });
    const callErr = captureCallError(agent);
    const userBefore = abortedCallCounts().notBilled[site] ?? 0;
    const guardBefore = abortedCallCounts().notBilled['agent.tool_call_imitation'] ?? 0;
    textReply(COPY.repeat(5), 9);
    const err = await agent.send('place the order').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunAbortedError);
    expect(callErr.err).toBeInstanceOf(ToolCallImitationError);
    expect(abortedCallCounts().notBilled['agent.tool_call_imitation']).toBe(guardBefore + 1);
    expect(abortedCallCounts().notBilled[site] ?? 0).toBe(userBefore);
    const expected = abortedCallCost({ model, maxTokens: (agent as unknown as Booked).maxTokens, request: '', partial: (callErr.err as ToolCallImitationError).partial });
    expect(agent.getHelperCostUsd()).toBeCloseTo(expected.estimateUsd, 12);
    expect((agent as unknown as Booked).costGuard.capOnlyUSD).toBeCloseTo(expected.upperBoundUsd, 12);
    expect(counters.costUSD).toBeCloseTo(expected.upperBoundUsd, 12);
  });

  it('a run the person stops mid-stream is recorded aborted, with the call\'s estimate in its cost', async () => {
    const engine = await boot();
    const session = engine.createSession();
    const s = hangingReply([
      { type: 'message_start', message: { usage: { ...usage } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Here is the first part of the list' } },
    ]);
    const turn = session.run('list everything');
    await untilRead(s);
    session.abort();
    const err = await turn.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunAbortedError);
    const run = engine.getRunHistory()!.getRunsBySession(session.sessionId)[0]!;
    expect(run.status).toBe('aborted');
    const agent = session.getAgent()!;
    const expected = abortedCallCost({
      model: run.model_id, maxTokens: (agent as unknown as Booked).maxTokens, request: '',
      partial: { usage: { ...usage }, content: [{ type: 'text', text: 'Here is the first part of the list' }] },
    });
    expect(run.cost_usd).toBeGreaterThan(0);
    expect(run.cost_usd).toBeCloseTo(expected.estimateUsd, 12);
  });
});
