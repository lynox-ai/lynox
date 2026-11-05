// A reply that writes the same tool call out as text, over and over, is stopped while it
// streams. Driven through a REAL Engine, Session, Agent, StreamProcessor and ThreadStore;
// only the provider's event stream is stubbed.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages.js';

interface Script { events: Array<Record<string, unknown>>; yielded: number; returned: boolean; hang?: boolean }

const { calls, scripts } = vi.hoisted(() => ({
  calls: [] as Array<{ params: { messages: BetaMessageParam[] }; signal: AbortSignal | undefined }>,
  scripts: [] as Script[],
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
            const script = scripts.shift();
            if (!script) throw new Error('no scripted reply left');
            return {
              next: async () => {
                if (script.yielded < script.events.length) return { done: false, value: script.events[script.yielded++] };
                if (!script.hang) return { done: true, value: undefined };
                // A reply still being generated: the read waits until the call is aborted.
                return new Promise((_res, rej) => {
                  const fail = (): void => { rej(new Error('Request was aborted.')); };
                  if (opts?.signal?.aborted) fail(); else opts?.signal?.addEventListener('abort', fail, { once: true });
                });
              },
              return: async () => { script.returned = true; return { done: true, value: undefined }; },
            };
          },
        }),
      },
    };
  }
  class APIError extends Error {}
  return { default: MockAnthropic, APIError };
});

import { RunAbortedError, ToolCallImitationError } from './agent.js';
import { Engine } from './engine.js';
import { reloadConfig } from './config.js';
import { SessionStore } from './session-store.js';
import { readRunStop, runStopText, applyRunStops } from './run-stop.js';
import { TOOL_CALL_IMITATION_REPEATS } from './tool-call-imitation.js';
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
    { type: 'message_start', message: { usage } },
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
    { type: 'message_start', message: { usage } },
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
    const session = engine.createSession();
    handler.mockResolvedValue('200 OK, order list');
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
    // The request itself was ended through the call's own signal.
    expect(calls[1]!.signal?.aborted).toBe(true);

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
    // The run's own signal was never aborted: the next call got a live one.
    expect(calls.at(-1)!.signal?.aborted).toBe(false);
  });

  it('a reply that shows the request twice is read to the end', async () => {
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
