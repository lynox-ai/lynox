import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { OpenAIAdapter, getCacheKeySalt, _resetCacheKeySaltMemo, translateMessages, REASONING_SUPPRESSION_MAX_TOKENS } from './openai-adapter.js';
import { modelCapability } from '../types/models.js';
import { StreamProcessor } from './stream.js';
import type Anthropic from '@anthropic-ai/sdk';
import type {
  BetaRawMessageStreamEvent,
  BetaToolUseBlock,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.js';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

// ── Helpers ─────────────────────────────────────────────────────

/** Create a mock OpenAI-compatible SSE server that returns deterministic responses. */
function createMockServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ port: number; close: () => void }> {
  return new Promise(resolve => {
    const server = createServer(handler);
    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ port, close: () => server.close() });
    });
  });
}

function sseChunk(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

async function collectEvents(stream: AsyncIterable<BetaRawMessageStreamEvent>): Promise<BetaRawMessageStreamEvent[]> {
  const events: BetaRawMessageStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

// ── Tests ───────────────────────────────────────────────────────

describe('OpenAIAdapter', () => {
  describe('text response streaming', () => {
    it('translates OpenAI text deltas to Anthropic content_block events', async () => {
      const server = await createMockServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(sseChunk({
          id: 'test-1', choices: [{ index: 0, delta: { role: 'assistant', content: 'Hallo' }, finish_reason: null }],
        }));
        res.write(sseChunk({
          id: 'test-1', choices: [{ index: 0, delta: { content: ' Welt' }, finish_reason: null }],
        }));
        res.write(sseChunk({
          id: 'test-1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }));
        res.write('data: [DONE]\n\n');
        res.end();
      });

      try {
        const adapter = new OpenAIAdapter({
          baseURL: `http://localhost:${server.port}`,
          apiKey: 'test-key',
          modelId: 'test-model',
        });

        const events = await collectEvents(adapter.beta.messages.stream({
          model: 'test-model', max_tokens: 100, messages: [{ role: 'user', content: 'Hi' }],
        }));

        const types = events.map(e => e.type);
        expect(types).toContain('message_start');
        expect(types).toContain('content_block_start');
        expect(types).toContain('content_block_delta');
        expect(types).toContain('content_block_stop');
        expect(types).toContain('message_delta');
        expect(types).toContain('message_stop');

        // Check text content was assembled
        const textDeltas = events
          .filter(e => e.type === 'content_block_delta')
          .map(e => (e as { delta: { text?: string } }).delta.text)
          .filter(Boolean);
        expect(textDeltas).toEqual(['Hallo', ' Welt']);

        // Check stop reason
        const msgDelta = events.find(e => e.type === 'message_delta') as { delta: { stop_reason?: string } };
        expect(msgDelta.delta.stop_reason).toBe('end_turn');
      } finally {
        server.close();
      }
    });

    it('survives a usage-only final chunk with no choices array and reports its usage (Mistral)', async () => {
      const server = await createMockServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(sseChunk({
          id: 'm-1', choices: [{ index: 0, delta: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' }],
        }));
        // Mistral emits a trailing usage-only chunk with NO `choices` key at all.
        // Indexing chunk.choices[0] on this used to throw and abort the stream.
        res.write(sseChunk({ id: 'm-1', usage: { prompt_tokens: 7, completion_tokens: 2 } }));
        res.write('data: [DONE]\n\n');
        res.end();
      });

      try {
        const adapter = new OpenAIAdapter({
          baseURL: `http://localhost:${server.port}`,
          apiKey: 'test-key',
          modelId: 'test-model',
        });
        const events = await collectEvents(adapter.beta.messages.stream({
          model: 'test-model', max_tokens: 100, messages: [{ role: 'user', content: 'Hi' }],
        }));
        // Stream completes cleanly and the text survived the usage-only chunk.
        expect(events.map(e => e.type)).toContain('message_stop');
        const textDeltas = events
          .filter(e => e.type === 'content_block_delta')
          .map(e => (e as { delta: { text?: string } }).delta.text)
          .filter(Boolean);
        expect(textDeltas).toEqual(['Hi']);
        // The trailing chunk carried the ONLY usage of the stream — the
        // message_delta must be emitted after that chunk is parsed, never
        // at finish_reason time, or it reports 0/0.
        const msgDelta = events.find(e => e.type === 'message_delta') as {
          delta: { stop_reason?: string };
          usage: { input_tokens: number; output_tokens: number };
        };
        expect(msgDelta.delta.stop_reason).toBe('end_turn');
        expect(msgDelta.usage.input_tokens).toBe(7);
        expect(msgDelta.usage.output_tokens).toBe(2);
        // Event ordering must stay Anthropic-canonical even though the
        // terminal events are now deferred past the trailing chunk.
        const types = events.map(e => e.type);
        expect(types.indexOf('content_block_stop')).toBeLessThan(types.indexOf('message_delta'));
        expect(types.indexOf('message_delta')).toBeLessThan(types.indexOf('message_stop'));
      } finally {
        server.close();
      }
    });

    it('reports usage from a trailing chunk with empty choices array (OpenAI include_usage / Fireworks)', async () => {
      // OpenAI `stream_options.include_usage` semantics — used verbatim by
      // Fireworks: the finish_reason chunk carries `usage: null`, then a
      // SEPARATE trailing chunk arrives with `choices: []` (empty array, not
      // missing) and the real usage. The message_delta must carry THIS
      // chunk's totals — an emission tied to the finish_reason chunk reports
      // 0/0 tokens downstream (billing, cost guard, run history).
      const server = await createMockServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(sseChunk({
          id: 'fw-1', choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello' }, finish_reason: null }],
          usage: null,
        }));
        res.write(sseChunk({
          id: 'fw-1', choices: [{ index: 0, delta: {}, finish_reason: 'length' }],
          usage: null,
        }));
        // Trailing usage chunk: empty choices ARRAY + real usage incl. cache.
        res.write(sseChunk({
          id: 'fw-1', choices: [],
          usage: {
            prompt_tokens: 18, completion_tokens: 30,
            prompt_tokens_details: { cached_tokens: 4 },
          },
        }));
        res.write('data: [DONE]\n\n');
        res.end();
      });

      try {
        const adapter = new OpenAIAdapter({
          baseURL: `http://localhost:${server.port}`,
          apiKey: 'test-key',
          modelId: 'test-model',
        });

        const events = await collectEvents(adapter.beta.messages.stream({
          model: 'test-model', max_tokens: 100, messages: [{ role: 'user', content: 'Hi' }],
        }));

        const msgDelta = events.find(e => e.type === 'message_delta') as {
          delta: { stop_reason?: string };
          usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number | null };
        };
        expect(msgDelta).toBeDefined();
        // finish_reason 'length' still maps to 'max_tokens' after deferral.
        expect(msgDelta.delta.stop_reason).toBe('max_tokens');
        // Anthropic semantics: input_tokens excludes cached (18 - 4).
        expect(msgDelta.usage.input_tokens).toBe(14);
        expect(msgDelta.usage.output_tokens).toBe(30);
        expect(msgDelta.usage.cache_read_input_tokens).toBe(4);

        // Ordering: content_block_stop → message_delta → message_stop.
        const types = events.map(e => e.type);
        expect(types.indexOf('content_block_stop')).toBeLessThan(types.indexOf('message_delta'));
        expect(types.indexOf('message_delta')).toBeLessThan(types.indexOf('message_stop'));
        expect(types.filter(t => t === 'message_stop').length).toBe(1);

        // finalMessage() (fresh request against the same mock) must see the
        // same totals — it reads the message_delta usage.
        const msg = await adapter.beta.messages.stream({
          model: 'test-model', max_tokens: 100, messages: [{ role: 'user', content: 'Hi' }],
        }).finalMessage();
        expect(msg.stop_reason).toBe('max_tokens');
        expect(msg.usage.input_tokens).toBe(14);
        expect(msg.usage.output_tokens).toBe(30);
        expect(msg.usage.cache_read_input_tokens).toBe(4);
      } finally {
        server.close();
      }
    });

    it('reports usage from a trailing chunk after a tool_calls finish', async () => {
      const server = await createMockServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(sseChunk({
          id: 'fw-2', choices: [{
            index: 0,
            delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', function: { name: 'get_weather', arguments: '{"q":"ZRH"}' } }] },
            finish_reason: null,
          }],
          usage: null,
        }));
        res.write(sseChunk({
          id: 'fw-2', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
          usage: null,
        }));
        res.write(sseChunk({
          id: 'fw-2', choices: [],
          usage: { prompt_tokens: 25, completion_tokens: 9 },
        }));
        res.write('data: [DONE]\n\n');
        res.end();
      });

      try {
        const adapter = new OpenAIAdapter({
          baseURL: `http://localhost:${server.port}`,
          apiKey: 'test-key',
          modelId: 'test-model',
        });
        const events = await collectEvents(adapter.beta.messages.stream({
          model: 'test-model', max_tokens: 100, messages: [{ role: 'user', content: 'Hi' }],
        }));
        const msgDelta = events.find(e => e.type === 'message_delta') as {
          delta: { stop_reason?: string };
          usage: { input_tokens: number; output_tokens: number };
        };
        expect(msgDelta.delta.stop_reason).toBe('tool_use');
        expect(msgDelta.usage.input_tokens).toBe(25);
        expect(msgDelta.usage.output_tokens).toBe(9);
      } finally {
        server.close();
      }
    });

    it('reports usage from a final data frame with no trailing newline', async () => {
      // Some servers close the socket right after the trailing usage frame
      // without a final newline — the frame must still reach the usage totals
      // via the post-loop buffer flush.
      const server = await createMockServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(sseChunk({
          id: 'fw-3', choices: [{ index: 0, delta: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' }],
          usage: null,
        }));
        // No trailing newline, no [DONE] — the socket just ends.
        res.end(`data: ${JSON.stringify({ id: 'fw-3', choices: [], usage: { prompt_tokens: 11, completion_tokens: 3 } })}`);
      });

      try {
        const adapter = new OpenAIAdapter({
          baseURL: `http://localhost:${server.port}`,
          apiKey: 'test-key',
          modelId: 'test-model',
        });
        const events = await collectEvents(adapter.beta.messages.stream({
          model: 'test-model', max_tokens: 100, messages: [{ role: 'user', content: 'Hi' }],
        }));
        const msgDelta = events.find(e => e.type === 'message_delta') as {
          usage: { input_tokens: number; output_tokens: number };
        };
        expect(msgDelta.usage.input_tokens).toBe(11);
        expect(msgDelta.usage.output_tokens).toBe(3);
      } finally {
        server.close();
      }
    });

    it('reports 0/0 usage when the provider never sends usage', async () => {
      const server = await createMockServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(sseChunk({
          id: 'nu-1', choices: [{ index: 0, delta: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' }],
        }));
        res.write('data: [DONE]\n\n');
        res.end();
      });

      try {
        const adapter = new OpenAIAdapter({
          baseURL: `http://localhost:${server.port}`,
          apiKey: 'test-key',
          modelId: 'test-model',
        });
        const events = await collectEvents(adapter.beta.messages.stream({
          model: 'test-model', max_tokens: 100, messages: [{ role: 'user', content: 'Hi' }],
        }));
        const msgDelta = events.find(e => e.type === 'message_delta') as {
          usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number | null };
        };
        expect(msgDelta.usage.input_tokens).toBe(0);
        expect(msgDelta.usage.output_tokens).toBe(0);
        expect(msgDelta.usage.cache_read_input_tokens).toBeNull();
      } finally {
        server.close();
      }
    });
  });

  describe('tool call streaming', () => {
    it('translates OpenAI tool_calls to Anthropic tool_use blocks', async () => {
      const server = await createMockServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        // Tool call start
        res.write(sseChunk({
          id: 'test-2',
          choices: [{
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: [{ index: 0, id: 'call_123', type: 'function', function: { name: 'data_store_query', arguments: '' } }],
            },
            finish_reason: null,
          }],
        }));
        // Tool call arguments streamed
        res.write(sseChunk({
          id: 'test-2',
          choices: [{
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: '{"collection":' } }] },
            finish_reason: null,
          }],
        }));
        res.write(sseChunk({
          id: 'test-2',
          choices: [{
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: '"deals"}' } }] },
            finish_reason: null,
          }],
        }));
        // Finish
        res.write(sseChunk({
          id: 'test-2',
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 50, completion_tokens: 20 },
        }));
        res.write('data: [DONE]\n\n');
        res.end();
      });

      try {
        const adapter = new OpenAIAdapter({
          baseURL: `http://localhost:${server.port}`,
          apiKey: 'test-key',
          modelId: 'test-model',
        });

        const tools: Anthropic.Tool[] = [{
          name: 'data_store_query',
          description: 'Query data',
          input_schema: { type: 'object' as const, properties: { collection: { type: 'string' } }, required: ['collection'] },
        }];

        const events = await collectEvents(adapter.beta.messages.stream({
          model: 'test-model', max_tokens: 100,
          messages: [{ role: 'user', content: 'Show deals' }],
          tools,
        }));

        // Should have tool_use content_block_start
        const blockStart = events.find(e =>
          e.type === 'content_block_start' &&
          (e as { content_block: { type: string } }).content_block.type === 'tool_use',
        ) as { content_block: { type: string; name: string; id: string } } | undefined;
        expect(blockStart).toBeDefined();
        expect(blockStart!.content_block.name).toBe('data_store_query');
        expect(blockStart!.content_block.id).toBe('call_123');

        // Should have input_json_delta events
        const jsonDeltas = events
          .filter(e => e.type === 'content_block_delta')
          .map(e => (e as { delta: { type: string; partial_json?: string } }).delta)
          .filter(d => d.type === 'input_json_delta');
        expect(jsonDeltas.length).toBe(2);
        const fullJson = jsonDeltas.map(d => d.partial_json).join('');
        expect(JSON.parse(fullJson)).toEqual({ collection: 'deals' });

        // Stop reason should be tool_use
        const msgDelta = events.find(e => e.type === 'message_delta') as { delta: { stop_reason?: string } };
        expect(msgDelta.delta.stop_reason).toBe('tool_use');
      } finally {
        server.close();
      }
    });

    it('keeps parallel tool_calls in distinct blocks (regression: blockIndex collision)', async () => {
      // Regression for T1-3: prior to the fix, blockIndex was incremented only
      // when a text block closed — never per tool block. Two sequential
      // tool_calls (or a single chunk carrying two tool_calls) therefore
      // shared one blockIndex; content_block_start fired twice at the same
      // index and StreamProcessor.rawInputs (keyed by index) concatenated
      // both partial_json streams into one buffer → JSON.parse threw and
      // both inputs collapsed to {}. Affects every non-Anthropic provider
      // (Mistral / Groq / vLLM / Ollama / OpenAI itself when parallel calls
      // are enabled).
      const server = await createMockServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        // First chunk opens BOTH tool slots at once (common Mistral/OpenAI shape).
        res.write(sseChunk({
          id: 'parallel-1',
          choices: [{
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: [
                { index: 0, id: 'call_alpha', type: 'function', function: { name: 'get_weather', arguments: '' } },
                { index: 1, id: 'call_beta', type: 'function', function: { name: 'get_stock', arguments: '' } },
              ],
            },
            finish_reason: null,
          }],
        }));
        // Stream arguments for tool 0 in two pieces.
        res.write(sseChunk({
          id: 'parallel-1',
          choices: [{
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] },
            finish_reason: null,
          }],
        }));
        res.write(sseChunk({
          id: 'parallel-1',
          choices: [{
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: '"Berlin"}' } }] },
            finish_reason: null,
          }],
        }));
        // Stream arguments for tool 1 — DIFFERENT shape + values, so a
        // concatenation bug would produce invalid JSON or the wrong object.
        res.write(sseChunk({
          id: 'parallel-1',
          choices: [{
            index: 0,
            delta: { tool_calls: [{ index: 1, function: { arguments: '{"ticker":' } }] },
            finish_reason: null,
          }],
        }));
        res.write(sseChunk({
          id: 'parallel-1',
          choices: [{
            index: 0,
            delta: { tool_calls: [{ index: 1, function: { arguments: '"AAPL"}' } }] },
            finish_reason: null,
          }],
        }));
        res.write(sseChunk({
          id: 'parallel-1',
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 60, completion_tokens: 30 },
        }));
        res.write('data: [DONE]\n\n');
        res.end();
      });

      try {
        const adapter = new OpenAIAdapter({
          baseURL: `http://localhost:${server.port}`,
          apiKey: 'test-key',
          modelId: 'test-model',
        });

        const events = await collectEvents(adapter.beta.messages.stream({
          model: 'test-model', max_tokens: 100,
          messages: [{ role: 'user', content: 'Weather and stock?' }],
        }));

        // ── Layer 1: raw event shape ──────────────────────────────────
        // Two tool_use content_block_start events at distinct indices.
        const toolStarts = events
          .filter(e => e.type === 'content_block_start')
          .map(e => e as { type: string; index: number; content_block: { type: string; name?: string; id?: string } })
          .filter(e => e.content_block.type === 'tool_use');
        expect(toolStarts.length).toBe(2);
        expect(toolStarts[0]!.index).not.toBe(toolStarts[1]!.index);
        expect(new Set(toolStarts.map(e => e.index)).size).toBe(2);

        // Each tool's input_json_delta events target its OWN block index.
        const deltasByIndex = new Map<number, string>();
        for (const e of events) {
          if (e.type !== 'content_block_delta') continue;
          const ev = e as { index: number; delta: { type: string; partial_json?: string } };
          if (ev.delta.type !== 'input_json_delta') continue;
          deltasByIndex.set(ev.index, (deltasByIndex.get(ev.index) ?? '') + (ev.delta.partial_json ?? ''));
        }
        expect(deltasByIndex.size).toBe(2);
        // The two assembled JSON strings parse to two DIFFERENT objects.
        const parsedByIndex = [...deltasByIndex.entries()]
          .sort(([a], [b]) => a - b)
          .map(([, json]) => JSON.parse(json) as Record<string, string>);
        expect(parsedByIndex).toEqual([
          { city: 'Berlin' },
          { ticker: 'AAPL' },
        ]);

        // ── Layer 2: end-to-end through StreamProcessor ───────────────
        // This is the real consumer that the original bug broke: it keys
        // its rawInputs map by event.index. Re-stream the same events
        // through it and assert both tool_use blocks have correctly
        // parsed, distinct, non-empty inputs.
        async function* replay(): AsyncIterable<BetaRawMessageStreamEvent> {
          // StreamProcessor needs a message_start before block events to
          // pick up usage; the adapter does not emit one, so synthesise.
          yield {
            type: 'message_start',
            message: {
              id: 'replay', type: 'message', role: 'assistant', model: 'test-model',
              content: [], stop_reason: null, stop_sequence: null,
              usage: {
                input_tokens: 0, output_tokens: 0,
                cache_creation_input_tokens: null, cache_read_input_tokens: null,
              },
            },
          } as unknown as BetaRawMessageStreamEvent;
          for (const e of events) yield e;
        }

        const processor = new StreamProcessor(async () => { /* no-op */ }, 'test-agent');
        const result = await processor.process(replay());

        const toolBlocks = result.content.filter((b): b is BetaToolUseBlock => b.type === 'tool_use');
        expect(toolBlocks.length).toBe(2);
        expect(toolBlocks[0]!.name).toBe('get_weather');
        expect(toolBlocks[0]!.input).toEqual({ city: 'Berlin' });
        expect(toolBlocks[1]!.name).toBe('get_stock');
        expect(toolBlocks[1]!.input).toEqual({ ticker: 'AAPL' });

        // Negative assertions that pin the regression: neither input is
        // empty (pre-fix StreamProcessor caught the parse-throw and set
        // input={}), and neither is the concatenation of both.
        expect(toolBlocks[0]!.input).not.toEqual({});
        expect(toolBlocks[1]!.input).not.toEqual({});
        expect(Object.keys(toolBlocks[0]!.input as object)).not.toContain('ticker');
        expect(Object.keys(toolBlocks[1]!.input as object)).not.toContain('city');

        expect(result.stop_reason).toBe('tool_use');
      } finally {
        server.close();
      }
    });

    it('preserves text-then-tool ordering when a tool follows a text block', async () => {
      // Off-by-one guard for the T1-3 fix: the text block must close at
      // index 0, the tool block must open at index 1, and a SECOND tool
      // (if any) must open at index 2 — no collision with the text-stop.
      const server = await createMockServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(sseChunk({
          id: 'mixed-1',
          choices: [{ index: 0, delta: { role: 'assistant', content: 'Let me check.' }, finish_reason: null }],
        }));
        res.write(sseChunk({
          id: 'mixed-1',
          choices: [{
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: 'call_a', type: 'function', function: { name: 'tool_a', arguments: '{"q":"x"}' } },
                { index: 1, id: 'call_b', type: 'function', function: { name: 'tool_b', arguments: '{"q":"y"}' } },
              ],
            },
            finish_reason: null,
          }],
        }));
        res.write(sseChunk({
          id: 'mixed-1',
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }));
        res.write('data: [DONE]\n\n');
        res.end();
      });

      try {
        const adapter = new OpenAIAdapter({
          baseURL: `http://localhost:${server.port}`,
          apiKey: 'test-key',
          modelId: 'test-model',
        });

        const events = await collectEvents(adapter.beta.messages.stream({
          model: 'test-model', max_tokens: 100,
          messages: [{ role: 'user', content: 'Go.' }],
        }));

        const starts = events
          .filter(e => e.type === 'content_block_start')
          .map(e => e as { index: number; content_block: { type: string } });
        expect(starts.length).toBe(3);
        expect(starts[0]!.content_block.type).toBe('text');
        expect(starts[0]!.index).toBe(0);
        expect(starts[1]!.content_block.type).toBe('tool_use');
        expect(starts[1]!.index).toBe(1);
        expect(starts[2]!.content_block.type).toBe('tool_use');
        expect(starts[2]!.index).toBe(2);

        // The text-block stop must fire at index 0 (not 1, which would
        // mean we stomped the first tool's start), and the per-tool
        // stops at the close fire at indices 1 and 2.
        const stops = events
          .filter(e => e.type === 'content_block_stop')
          .map(e => (e as { index: number }).index);
        expect(stops).toContain(0);
        expect(stops).toContain(1);
        expect(stops).toContain(2);
      } finally {
        server.close();
      }
    });

    it('does not leak [object Object] into text channel when delta.content is non-string (regression: Mistral spawn bracket leak)', async () => {
      // Regression for issue #37: on Mistral, the spawn-sub-agent reply
      // contained `[object Object]` prefix + runaway `}] }] }] }]` tail.
      // Root cause: the SSE chunk's `choice.delta.content` was non-string
      // (e.g. legacy multimodal array shape, or stray object during the
      // tool-call → tool-result transition). The adapter forwarded the
      // object straight into `text_delta.text`; StreamProcessor's
      // `text += textDelta.text` coerced it via Object.prototype.toString
      // → "[object Object]" got baked into the assistant message text.
      // That corrupted text then went back into history; Mistral, seeing
      // its own malformed prior turn, hallucinated the runaway `}] }] }]`
      // tail as it tried to "close" the broken JSON brackets it imagined.
      //
      // The fix is defense-in-depth at the adapter boundary: only emit a
      // text_delta when `delta.content` is a real string. Non-string
      // shapes (objects, arrays without text parts, numbers, booleans)
      // are skipped — never coerced.
      const server = await createMockServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        // Chunk 1: legitimate text — the adapter must still emit this.
        res.write(sseChunk({
          id: 'leak-1',
          choices: [{ index: 0, delta: { role: 'assistant', content: 'Spawning helper. ' }, finish_reason: null }],
        }));
        // Chunk 2: malformed — content is an OBJECT (the exact shape that
        // caused the leak in the wild). Pre-fix this stringified to
        // "[object Object]" inside the assistant text block.
        res.write(sseChunk({
          id: 'leak-1',
          choices: [{ index: 0, delta: { content: { partial: 'oops' } }, finish_reason: null }],
        }));
        // Chunk 3: another legitimate text chunk after the malformed one —
        // the adapter must continue cleanly.
        res.write(sseChunk({
          id: 'leak-1',
          choices: [{ index: 0, delta: { content: 'Done.' }, finish_reason: null }],
        }));
        res.write(sseChunk({
          id: 'leak-1',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }));
        res.write('data: [DONE]\n\n');
        res.end();
      });

      try {
        const adapter = new OpenAIAdapter({
          baseURL: `http://localhost:${server.port}`,
          apiKey: 'test-key',
          modelId: 'test-model',
        });

        const stream = adapter.beta.messages.stream({
          model: 'test-model', max_tokens: 100, messages: [{ role: 'user', content: 'Spawn.' }],
        });
        const msg = await stream.finalMessage();

        // The assembled assistant text must NOT contain "[object Object]".
        const text = msg.content
          .filter((b): b is { type: 'text'; text: string } => b.type === 'text' && typeof b.text === 'string')
          .map(b => b.text)
          .join('');
        expect(text).not.toContain('[object Object]');
        // Legitimate text chunks must still flow through.
        expect(text).toContain('Spawning helper.');
        expect(text).toContain('Done.');
      } finally {
        server.close();
      }
    });

    it('extracts text from array-shaped delta.content (OpenAI multimodal content parts)', async () => {
      // Some OpenAI-compatible servers emit `delta.content` as an array of
      // content parts (the post-2024 multimodal shape):
      //   [{ type: 'text', text: '...' }, { type: 'image_url', ... }]
      // The adapter should pull the `text` parts out so legitimate text
      // still streams through, rather than dropping the whole chunk.
      const server = await createMockServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(sseChunk({
          id: 'multi-1',
          choices: [{
            index: 0,
            delta: {
              role: 'assistant',
              content: [
                { type: 'text', text: 'Hello ' },
                { type: 'text', text: 'world' },
              ],
            },
            finish_reason: null,
          }],
        }));
        res.write(sseChunk({
          id: 'multi-1',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 2 },
        }));
        res.write('data: [DONE]\n\n');
        res.end();
      });

      try {
        const adapter = new OpenAIAdapter({
          baseURL: `http://localhost:${server.port}`,
          apiKey: 'test-key',
          modelId: 'test-model',
        });

        const msg = await adapter.beta.messages.stream({
          model: 'test-model', max_tokens: 100, messages: [{ role: 'user', content: 'Hi' }],
        }).finalMessage();

        const text = msg.content
          .filter((b): b is { type: 'text'; text: string } => b.type === 'text' && typeof b.text === 'string')
          .map(b => b.text)
          .join('');
        expect(text).toBe('Hello world');
        expect(text).not.toContain('[object Object]');
      } finally {
        server.close();
      }
    });
  });

  describe('request translation', () => {
    it('sends correct OpenAI format to the endpoint', async () => {
      let capturedBody = '';
      const server = await createMockServer((req, res) => {
        let body = '';
        req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        req.on('end', () => {
          capturedBody = body;
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write(sseChunk({
            id: 'test-3', choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: null }],
          }));
          res.write(sseChunk({
            id: 'test-3', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          }));
          res.write('data: [DONE]\n\n');
          res.end();
        });
      });

      try {
        const adapter = new OpenAIAdapter({
          baseURL: `http://localhost:${server.port}`,
          apiKey: 'my-api-key',
          modelId: 'mistral-large-latest',
        });

        const tools: Anthropic.Tool[] = [{
          name: 'memory_store',
          description: 'Store knowledge',
          input_schema: { type: 'object' as const, properties: { content: { type: 'string' } }, required: ['content'] },
        }];

        await collectEvents(adapter.beta.messages.stream({
          model: 'claude-sonnet-4-6',
          max_tokens: 1024,
          system: 'You are a helpful assistant.',
          messages: [{ role: 'user', content: 'Remember this.' }],
          tools,
        }));

        const parsed = JSON.parse(capturedBody) as {
          model: string;
          messages: Array<{ role: string; content: string }>;
          tools: Array<{ type: string; function: { name: string } }>;
          stream: boolean;
          max_tokens: number;
        };

        // Anthropic-style request model falls back to ctor modelId
        // (downstream Mistral/OpenAI reject claude-* ids). Real downstream
        // ids are covered in the "model id forwarding" describe.
        expect(parsed.model).toBe('mistral-large-latest');
        // System prompt should be first message
        expect(parsed.messages[0]!.role).toBe('system');
        expect(parsed.messages[0]!.content).toBe('You are a helpful assistant.');
        // User message
        expect(parsed.messages[1]!.role).toBe('user');
        expect(parsed.messages[1]!.content).toBe('Remember this.');
        // Tools in OpenAI format
        expect(parsed.tools[0]!.type).toBe('function');
        expect(parsed.tools[0]!.function.name).toBe('memory_store');
        // Streaming enabled
        expect(parsed.stream).toBe(true);
        expect(parsed.max_tokens).toBe(1024);
      } finally {
        server.close();
      }
    });
  });

  describe('error handling', () => {
    it('throws on non-200 response', async () => {
      const server = await createMockServer((_req, res) => {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Invalid API key' } }));
      });

      try {
        const adapter = new OpenAIAdapter({
          baseURL: `http://localhost:${server.port}`,
          apiKey: 'bad-key',
          modelId: 'test-model',
        });

        await expect(
          collectEvents(adapter.beta.messages.stream({
            model: 'test', max_tokens: 100, messages: [{ role: 'user', content: 'Hi' }],
          })),
        ).rejects.toThrow('401');
      } finally {
        server.close();
      }
    });
  });

  describe('model id forwarding', () => {
    async function captureRequestModel(
      params: { ctorModel: string; requestModel: string },
    ): Promise<string> {
      let captured = '';
      const server = await createMockServer((req, res) => {
        let body = '';
        req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        req.on('end', () => {
          captured = body;
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write(sseChunk({ id: 'x', choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: 'stop' }] }));
          res.write('data: [DONE]\n\n');
          res.end();
        });
      });

      try {
        const adapter = new OpenAIAdapter({
          baseURL: `http://localhost:${server.port}`,
          apiKey: 'key',
          modelId: params.ctorModel,
        });
        await collectEvents(adapter.beta.messages.stream({
          model: params.requestModel, max_tokens: 100,
          messages: [{ role: 'user', content: 'Hi' }],
        }));
      } finally {
        server.close();
      }

      return (JSON.parse(captured) as { model: string }).model;
    }

    it('forwards request-provided model id when it is a real downstream id', async () => {
      // Tier-routing path: getModelId('balanced', 'openai') resolved to a
      // Mistral id via MISTRAL_MODEL_MAP, caller sends it through, adapter
      // forwards it as-is. Without this the adapter would always send its
      // constructor modelId — collapsing all tiers onto a single model.
      const sent = await captureRequestModel({
        ctorModel: 'mistral-large-2512',
        requestModel: 'mistral-small-2603',
      });
      expect(sent).toBe('mistral-small-2603');
    });

    it('falls back to constructor modelId when request model is an Anthropic alias', async () => {
      // Legacy path: no tier-map registered, getModelId returns Anthropic
      // ids. Forwarding those would make Mistral/OpenAI reject the call —
      // so the adapter swaps in its own configured id.
      const sent = await captureRequestModel({
        ctorModel: 'mistral-large-2512',
        requestModel: 'claude-sonnet-4-6',
      });
      expect(sent).toBe('mistral-large-2512');
    });

    it('falls back to constructor modelId on empty request model', async () => {
      const sent = await captureRequestModel({
        ctorModel: 'mistral-large-2512',
        requestModel: '',
      });
      expect(sent).toBe('mistral-large-2512');
    });
  });

  // Reasoning channel of an OpenAI-compat reasoning model. Every chunk shape
  // below was OBSERVED on the wire against
  // `accounts/fireworks/models/glm-5p2` (2026-08-02) — the ordering (reasoning
  // first, `content` empty until reasoning ends, a tool call terminating the
  // reasoning phase with `content` never arriving at all) is the model's real
  // behaviour, not a guess about it. Before this, the adapter read only
  // `delta.content` and the whole channel was billed and discarded: a plain
  // answer split 3242 chars of reasoning against 492 of content (87% lost).
  describe('reasoning channel → thinking blocks', () => {
    /** Run one SSE script through the adapter and return the events. */
    async function runStream(chunks: unknown[]): Promise<BetaRawMessageStreamEvent[]> {
      const server = await createMockServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const c of chunks) res.write(sseChunk(c));
        res.write('data: [DONE]\n\n');
        res.end();
      });
      try {
        const adapter = new OpenAIAdapter({
          baseURL: `http://localhost:${server.port}`, apiKey: 'test-key', modelId: 'glm-5p2',
        });
        return await collectEvents(adapter.beta.messages.stream({
          model: 'glm-5p2', max_tokens: 100, messages: [{ role: 'user', content: 'Hi' }],
        }));
      } finally { server.close(); }
    }

    const thinkingDeltas = (evs: BetaRawMessageStreamEvent[]): string[] => evs
      .filter(e => e.type === 'content_block_delta')
      .map(e => (e as { delta: { type?: string; thinking?: string } }).delta)
      .filter(d => d.type === 'thinking_delta')
      .map(d => d.thinking ?? '');

    const textDeltas = (evs: BetaRawMessageStreamEvent[]): string[] => evs
      .filter(e => e.type === 'content_block_delta')
      .map(e => (e as { delta: { type?: string; text?: string } }).delta)
      .filter(d => d.type === 'text_delta')
      .map(d => d.text ?? '');

    it('emits reasoning_content as thinking deltas instead of discarding it', async () => {
      const events = await runStream([
        { id: 'r-1', choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'Der Nutzer fragt' }, finish_reason: null }] },
        { id: 'r-1', choices: [{ index: 0, delta: { reasoning_content: ' nach Caching.' }, finish_reason: null }] },
        { id: 'r-1', choices: [{ index: 0, delta: { content: 'Caching senkt' }, finish_reason: null }] },
        { id: 'r-1', choices: [{ index: 0, delta: { content: ' die Kosten.' }, finish_reason: 'stop' }] },
      ]);

      expect(thinkingDeltas(events)).toEqual(['Der Nutzer fragt', ' nach Caching.']);
      // The text channel must be untouched by the change.
      expect(textDeltas(events)).toEqual(['Caching senkt', ' die Kosten.']);
    });

    it('opens a thinking block and closes it when content starts', async () => {
      const events = await runStream([
        { id: 'r-2', choices: [{ index: 0, delta: { reasoning_content: 'denk' }, finish_reason: null }] },
        { id: 'r-2', choices: [{ index: 0, delta: { content: 'Antwort' }, finish_reason: 'stop' }] },
      ]);

      const starts = events.filter(e => e.type === 'content_block_start')
        .map(e => (e as { index: number; content_block: { type: string } }));
      expect(starts.map(s => s.content_block.type)).toEqual(['thinking', 'text']);
      // Separate indices — a shared one makes StreamProcessor append the text
      // onto the thinking block.
      expect(starts[0]?.index).toBe(0);
      expect(starts[1]?.index).toBe(1);
      expect(events.filter(e => e.type === 'content_block_stop')).toHaveLength(2);
    });

    it('closes the thinking block when a tool call ends the reasoning phase', async () => {
      // The observed glm-5p2 tool-calling turn: reasoning, then tool_calls,
      // and `delta.content` never arrives at all.
      const events = await runStream([
        { id: 'r-3', choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'Ich brauche das Tool.' }, finish_reason: null }] },
        { id: 'r-3', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'web_research', arguments: '' } }] }, finish_reason: null }] },
        { id: 'r-3', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"action":"read"}' } }] }, finish_reason: 'tool_calls' }] },
      ]);

      const starts = events.filter(e => e.type === 'content_block_start')
        .map(e => (e as { index: number; content_block: { type: string } }));
      expect(starts.map(s => s.content_block.type)).toEqual(['thinking', 'tool_use']);
      expect(starts[0]?.index).toBe(0);
      expect(starts[1]?.index).toBe(1);

      // StreamProcessor must still parse the tool input — a thinking block that
      // stole the tool's index would corrupt `rawInputs`.
      const processor = new StreamProcessor(async () => { /* no-op */ }, 'test-agent');
      const result = await processor.process(
        (async function* () { for (const e of events) yield e; })(),
      );
      const toolUse = result.content.find(b => b.type === 'tool_use') as BetaToolUseBlock | undefined;
      expect(toolUse?.name).toBe('web_research');
      expect(toolUse?.input).toEqual({ action: 'read' });
    });

    it('closes a reasoning-only turn that never produces content', async () => {
      const events = await runStream([
        { id: 'r-4', choices: [{ index: 0, delta: { reasoning_content: 'nur denken' }, finish_reason: null }] },
        { id: 'r-4', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 900 } },
      ]);

      expect(thinkingDeltas(events)).toEqual(['nur denken']);
      // Unbalanced start/stop leaves StreamProcessor with an open block.
      expect(events.filter(e => e.type === 'content_block_start')).toHaveLength(1);
      expect(events.filter(e => e.type === 'content_block_stop')).toHaveLength(1);
    });

    it("accepts OpenRouter's `reasoning` spelling of the same channel", async () => {
      const events = await runStream([
        { id: 'r-5', choices: [{ index: 0, delta: { reasoning: 'via openrouter' }, finish_reason: null }] },
        { id: 'r-5', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] },
      ]);
      expect(thinkingDeltas(events)).toEqual(['via openrouter']);
    });

    it('keeps the channel when a proxy sends an EMPTY reasoning_content beside `reasoning`', async () => {
      // `?? ` would pick the empty string and lose the channel. Not observed at
      // any provider — insurance on a field two vendors spell differently.
      const events = await runStream([
        { id: 'r-8', choices: [{ index: 0, delta: { reasoning_content: '', reasoning: 'über den proxy' }, finish_reason: null }] },
        { id: 'r-8', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] },
      ]);
      expect(thinkingDeltas(events)).toEqual(['über den proxy']);
    });

    it('keeps block indices disjoint when reasoning arrives BETWEEN two content deltas', async () => {
      // glm-5p2 does reasoning-then-content, so this ordering is not observed
      // there — but the code handles it (the text-block close above the
      // reasoning branch exists for nothing else), so it needs a test. A shared
      // index here would make StreamProcessor append text onto the thinking
      // block.
      const events = await runStream([
        { id: 'r-9', choices: [{ index: 0, delta: { content: 'Die Rechnung ' }, finish_reason: null }] },
        { id: 'r-9', choices: [{ index: 0, delta: { reasoning_content: 'Moment.' }, finish_reason: null }] },
        { id: 'r-9', choices: [{ index: 0, delta: { content: 'betraegt 1200 Euro.' }, finish_reason: 'stop' }] },
      ]);

      const starts = events.filter(e => e.type === 'content_block_start')
        .map(e => (e as { index: number; content_block: { type: string } }));
      expect(starts.map(s => s.content_block.type)).toEqual(['text', 'thinking', 'text']);
      expect(starts.map(s => s.index)).toEqual([0, 1, 2]);
      expect(events.filter(e => e.type === 'content_block_stop')).toHaveLength(3);

      // The user-visible text must survive the split intact. (The next request's
      // history does NOT — `translateMessages` joins text parts with a newline
      // and plants one mid-sentence. Pre-existing, tracked separately; asserted
      // here only so the split itself is not blamed for it later.)
      const processor = new StreamProcessor(async () => { /* no-op */ }, 'test-agent');
      const result = await processor.process(
        (async function* () { for (const e of events) yield e; })(),
      );
      const text = result.content.filter(b => b.type === 'text')
        .map(b => (b as { text: string }).text).join('');
      expect(text).toBe('Die Rechnung betraegt 1200 Euro.');
    });

    it('leaves a non-reasoning provider byte-identical (no thinking block)', async () => {
      const events = await runStream([
        { id: 'r-6', choices: [{ index: 0, delta: { role: 'assistant', content: 'Hallo' }, finish_reason: null }] },
        { id: 'r-6', choices: [{ index: 0, delta: { content: ' Welt' }, finish_reason: 'stop' }] },
      ]);
      expect(thinkingDeltas(events)).toEqual([]);
      expect(textDeltas(events)).toEqual(['Hallo', ' Welt']);
      const starts = events.filter(e => e.type === 'content_block_start')
        .map(e => (e as { content_block: { type: string } }).content_block.type);
      expect(starts).toEqual(['text']);
    });

    it('never lets a non-string reasoning field reach the thinking channel', async () => {
      // Same leak guard as `delta.content`: an object coerced downstream bakes
      // "[object Object]" into the block.
      const events = await runStream([
        { id: 'r-7', choices: [{ index: 0, delta: { reasoning_content: { unexpected: 'shape' } }, finish_reason: null }] },
        { id: 'r-7', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] },
      ]);
      expect(thinkingDeltas(events)).toEqual([]);
      expect(textDeltas(events)).toEqual(['ok']);
    });
  });

  // T2-P1: OpenAI/Mistral/Ollama spec uses 'length' for max-tokens-hit; the
  // Anthropic event spec uses 'max_tokens'. Without the translation the
  // downstream Agent loop silently drops the truncated turn.
  describe('finish_reason translation (T2-P1)', () => {
    it("maps OpenAI 'length' finish_reason to Anthropic 'max_tokens' stop_reason", async () => {
      const server = await createMockServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(sseChunk({
          id: 'len-1',
          choices: [{ index: 0, delta: { role: 'assistant', content: 'Truncated...' }, finish_reason: null }],
        }));
        res.write(sseChunk({
          id: 'len-1',
          choices: [{ index: 0, delta: {}, finish_reason: 'length' }],
          usage: { prompt_tokens: 8, completion_tokens: 100 },
        }));
        res.write('data: [DONE]\n\n');
        res.end();
      });

      try {
        const adapter = new OpenAIAdapter({
          baseURL: `http://localhost:${server.port}`,
          apiKey: 'test-key',
          modelId: 'test-model',
        });

        const events = await collectEvents(adapter.beta.messages.stream({
          model: 'test-model', max_tokens: 100, messages: [{ role: 'user', content: 'Hi' }],
        }));

        const types = events.map(e => e.type);
        expect(types).toContain('message_delta');
        expect(types).toContain('message_stop');

        const msgDelta = events.find(e => e.type === 'message_delta') as { delta: { stop_reason?: string } };
        expect(msgDelta.delta.stop_reason).toBe('max_tokens');
        // Negative: pre-fix the raw 'length' string leaked through.
        expect(msgDelta.delta.stop_reason).not.toBe('length');
      } finally {
        server.close();
      }
    });
  });

  // T2-P2: tool_choice was ignored — forced tool-use (llm-helper /
  // dag-planner / process-capture / entity-extractor-v2) was silently
  // downgraded to "auto", breaking structured-extraction contracts.
  describe('reasoning_effort forwarding (double-gated)', () => {
    // The registry flag is deliberately absent on every model today; the test
    // flips it on GLM's shared features object for its own duration. `features`
    // is FIREWORKS_TEXT_FEATURES, shared across the Fireworks entries — the
    // unflagged case therefore uses a MISTRAL model (its own features object).
    const GLM = 'accounts/fireworks/models/glm-5p2';

    async function captureBody(model: string, outputConfig: unknown, maxTokens = 100): Promise<Record<string, unknown>> {
      let captured = '';
      const server = await createMockServer((req, res) => {
        let body = '';
        req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        req.on('end', () => {
          captured = body;
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write(sseChunk({
            id: 're-1', choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: 'stop' }],
          }));
          res.write('data: [DONE]\n\n');
          res.end();
        });
      });
      try {
        const adapter = new OpenAIAdapter({ baseURL: `http://localhost:${server.port}`, apiKey: 'key', modelId: model });
        await collectEvents(adapter.beta.messages.stream({
          model, max_tokens: maxTokens,
          messages: [{ role: 'user', content: 'Go.' }],
          ...(outputConfig !== undefined ? { output_config: outputConfig } : {}),
        } as unknown as Parameters<typeof adapter.beta.messages.stream>[0]));
      } finally {
        server.close();
      }
      return JSON.parse(captured) as Record<string, unknown>;
    }

    function withFlag<T>(fn: () => Promise<T>): Promise<T> {
      const features = modelCapability(GLM)!.features as { reasoningEffort?: boolean };
      features.reasoningEffort = true;
      return fn().finally(() => { delete features.reasoningEffort; });
    }

    it('forwards effort for a flagged model', async () => {
      const body = await withFlag(() => captureBody(GLM, { effort: 'high' }));
      expect(body['reasoning_effort']).toBe('high');
    });

    it("clamps the Anthropic-only 'max' tier to the wire ceiling 'high'", async () => {
      const body = await withFlag(() => captureBody(GLM, { effort: 'max' }));
      expect(body['reasoning_effort']).toBe('high');
    });

    it("clamps 'xhigh' to 'high' too — both Anthropic-only tiers, one wire ceiling", async () => {
      const body = await withFlag(() => captureBody(GLM, { effort: 'xhigh' }));
      expect(body['reasoning_effort']).toBe('high');
    });

    it('sends nothing when the caller sent no effort — the model stays self-adaptive', async () => {
      const body = await withFlag(() => captureBody(GLM, undefined));
      expect(body).not.toHaveProperty('reasoning_effort');
    });

    it('drops a malformed effort value instead of forwarding it', async () => {
      const body = await withFlag(() => captureBody(GLM, { effort: 'turbo' }));
      expect(body).not.toHaveProperty('reasoning_effort');
    });

    // ── defaultReasoningEffort ────────────────────────────────────────────
    // A hybrid-reasoning model whose thinking floor is bigger than its callers'
    // output budgets answers HTTP 200 with an EMPTY string. Measured against the
    // live Fireworks API on 2026-08-18: 4 of 6 fast-tier callers came back empty
    // at their real max_tokens, each having spent 100% of the budget on
    // reasoning tokens. These pin the suppression that fixes it.
    const FAST = 'accounts/fireworks/models/deepseek-v4-flash-0731';
    const NO_DEFAULT = 'accounts/fireworks/models/minimax-m3';

    it("sends reasoning_effort:'none' for a model that declares the default", async () => {
      const body = await captureBody(FAST, undefined);
      expect(body['reasoning_effort']).toBe('none');
    });

    it('applies the default even when the caller sent an effort — the model is not ladder-flagged', async () => {
      // Documents the real precedence rather than the one the field name
      // suggests. `'low'` was measured NOT to suppress the floor, so a caller
      // able to override down to it would reinstate the empty-response bug.
      const body = await captureBody(FAST, { effort: 'high' });
      expect(body['reasoning_effort']).toBe('none');
    });

    it('wins over the ladder when a model sets both — `features` is a SHARED object', async () => {
      // Flagging any ONE Fireworks model for the ladder flags all six (they
      // point at the same FIREWORKS_TEXT_FEATURES reference), and the agent's
      // post-run effort restore would then put `medium` on this wire. `'low'`
      // was measured not to suppress the floor, so yielding here would make the
      // empty-response bug reachable from an unrelated model's flag.
      const cap = modelCapability(FAST)! as { features: { reasoningEffort?: boolean } };
      cap.features.reasoningEffort = true;
      try {
        const body = await captureBody(FAST, { effort: 'high' });
        expect(body['reasoning_effort']).toBe('none');
      } finally {
        delete cap.features.reasoningEffort;
      }
    });

    it('leaves a call above the budget bound self-adaptive — a spawned sub-agent keeps its thinking', async () => {
      const body = await captureBody(FAST, undefined, REASONING_SUPPRESSION_MAX_TOKENS + 1);
      expect(body).not.toHaveProperty('reasoning_effort');
    });

    it('still suppresses exactly AT the bound', async () => {
      const body = await captureBody(FAST, undefined, REASONING_SUPPRESSION_MAX_TOKENS);
      expect(body['reasoning_effort']).toBe('none');
    });

    it('sends nothing for a model that declares no default', async () => {
      const body = await captureBody(NO_DEFAULT, undefined);
      expect(body).not.toHaveProperty('reasoning_effort');
    });

    it('drops effort for an unflagged model — the registry default keeps today\'s wire byte-identical', async () => {
      // mistral-medium is registered but NOT flagged (own features object, not
      // the mutated Fireworks one) — the Agent's default effort must not reach it.
      const body = await captureBody('mistral-medium-2604', { effort: 'high' });
      expect(body).not.toHaveProperty('reasoning_effort');
    });
  });

  describe('tool_choice translation (T2-P2)', () => {
    async function captureRequestBody(toolChoice: unknown): Promise<{ tool_choice?: unknown }> {
      let captured = '';
      const server = await createMockServer((req, res) => {
        let body = '';
        req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        req.on('end', () => {
          captured = body;
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write(sseChunk({
            id: 'tc-1', choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: 'stop' }],
          }));
          res.write('data: [DONE]\n\n');
          res.end();
        });
      });

      try {
        const adapter = new OpenAIAdapter({
          baseURL: `http://localhost:${server.port}`,
          apiKey: 'key',
          modelId: 'm',
        });
        const tools: Anthropic.Tool[] = [{
          name: 'extract',
          description: 'Forced tool',
          input_schema: { type: 'object' as const, properties: { x: { type: 'string' } }, required: ['x'] },
        }];
        await collectEvents(adapter.beta.messages.stream({
          model: 'm', max_tokens: 100,
          messages: [{ role: 'user', content: 'Go.' }],
          tools,
          tool_choice: toolChoice,
        } as unknown as Parameters<typeof adapter.beta.messages.stream>[0]));
      } finally {
        server.close();
      }
      return JSON.parse(captured) as { tool_choice?: unknown };
    }

    it("translates Anthropic {type:'auto'} to OpenAI 'auto'", async () => {
      const body = await captureRequestBody({ type: 'auto' });
      expect(body.tool_choice).toBe('auto');
    });

    it("translates Anthropic {type:'any'} to OpenAI 'required'", async () => {
      const body = await captureRequestBody({ type: 'any' });
      expect(body.tool_choice).toBe('required');
    });

    it("translates Anthropic {type:'tool', name:'X'} to OpenAI {type:'function', function:{name:'X'}}", async () => {
      const body = await captureRequestBody({ type: 'tool', name: 'extract' });
      expect(body.tool_choice).toEqual({ type: 'function', function: { name: 'extract' } });
    });

    it("defaults to 'auto' when no tool_choice is provided (back-compat)", async () => {
      const body = await captureRequestBody(undefined);
      expect(body.tool_choice).toBe('auto');
    });

    it("defaults to 'auto' on malformed/unknown tool_choice shape (fail-soft)", async () => {
      const body = await captureRequestBody({ type: 'gibberish' });
      expect(body.tool_choice).toBe('auto');
    });
  });

  describe('system prompt blocks', () => {
    it('handles array-of-blocks system prompt (Anthropic format)', async () => {
      let capturedBody = '';
      const server = await createMockServer((req, res) => {
        let body = '';
        req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        req.on('end', () => {
          capturedBody = body;
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write(sseChunk({ id: 'x', choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: 'stop' }] }));
          res.write('data: [DONE]\n\n');
          res.end();
        });
      });

      try {
        const adapter = new OpenAIAdapter({
          baseURL: `http://localhost:${server.port}`,
          apiKey: 'key',
          modelId: 'model',
        });

        await collectEvents(adapter.beta.messages.stream({
          model: 'model', max_tokens: 100,
          system: [
            { type: 'text', text: 'Block 1: system prompt.' },
            { type: 'text', text: 'Block 2: knowledge context.' },
          ],
          messages: [{ role: 'user', content: 'Hi' }],
        }));

        const parsed = JSON.parse(capturedBody) as { messages: Array<{ role: string; content: string }> };
        expect(parsed.messages[0]!.role).toBe('system');
        expect(parsed.messages[0]!.content).toContain('Block 1');
        expect(parsed.messages[0]!.content).toContain('Block 2');
      } finally {
        server.close();
      }
    });
  });

  // ── Mistral native prompt cache surface ───────────────────────
  // Spec'd by PRD-MISTRAL-CACHE-SURFACE 2026-05-24. Anthropic-shape semantic
  // (cache_read_input_tokens as a subset of input_tokens) is shared with
  // PRD-OPENAI-NATIVE §G1 — keep these assertions identical across both
  // test surfaces so they cannot drift.
  describe('mistral prompt cache surface', () => {
    it('extracts cached_tokens from prompt_tokens_details and applies subset-not-additive semantics', async () => {
      const server = await createMockServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(sseChunk({
          id: 'cache-1', choices: [{ index: 0, delta: { role: 'assistant', content: 'Hi' }, finish_reason: null }],
        }));
        res.write(sseChunk({
          id: 'cache-1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: 2000, completion_tokens: 50,
            prompt_tokens_details: { cached_tokens: 1500 },
          },
        }));
        res.write('data: [DONE]\n\n');
        res.end();
      });
      try {
        const adapter = new OpenAIAdapter({
          baseURL: `http://localhost:${server.port}`, apiKey: 'test', modelId: 'm',
        });
        const stream = adapter.beta.messages.stream({
          model: 'm', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }],
        });
        const msg = await stream.finalMessage();
        // Anthropic shape: input_tokens excludes cached, cache_read_input_tokens carries the cached count.
        expect(msg.usage.input_tokens).toBe(500);
        expect(msg.usage.cache_read_input_tokens).toBe(1500);
        expect(msg.usage.output_tokens).toBe(50);
      } finally {
        server.close();
      }
    });

    it('returns null cache_read_input_tokens when prompt_tokens_details is empty object', async () => {
      const server = await createMockServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(sseChunk({
          id: 'empty-1', choices: [{ index: 0, delta: { role: 'assistant', content: 'Hi' }, finish_reason: null }],
        }));
        res.write(sseChunk({
          id: 'empty-1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: {} },
        }));
        res.write('data: [DONE]\n\n');
        res.end();
      });
      try {
        const adapter = new OpenAIAdapter({
          baseURL: `http://localhost:${server.port}`, apiKey: 'test', modelId: 'm',
        });
        const msg = await adapter.beta.messages.stream({
          model: 'm', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }],
        }).finalMessage();
        expect(msg.usage.input_tokens).toBe(100);
        expect(msg.usage.cache_read_input_tokens).toBeNull();
      } finally {
        server.close();
      }
    });

    it('returns null cache_read_input_tokens when prompt_tokens_details missing (backward compat)', async () => {
      const server = await createMockServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(sseChunk({
          id: 'nc-1', choices: [{ index: 0, delta: { role: 'assistant', content: 'Hi' }, finish_reason: null }],
        }));
        res.write(sseChunk({
          id: 'nc-1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 100, completion_tokens: 20 },
        }));
        res.write('data: [DONE]\n\n');
        res.end();
      });
      try {
        const adapter = new OpenAIAdapter({
          baseURL: `http://localhost:${server.port}`, apiKey: 'test', modelId: 'm',
        });
        const msg = await adapter.beta.messages.stream({
          model: 'm', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }],
        }).finalMessage();
        expect(msg.usage.input_tokens).toBe(100);
        expect(msg.usage.cache_read_input_tokens).toBeNull();
      } finally {
        server.close();
      }
    });

    it('forwards salted prompt_cache_key when outgoing host is api.mistral.ai', async () => {
      // We can't actually hit api.mistral.ai. Validate the gate via the
      // helper-exported salt + the request-body builder by spying on fetch.
      let capturedBody = '';
      const originalFetch = global.fetch;
      global.fetch = (async (url: string | URL, init?: { body?: string }) => {
        capturedBody = (init?.body as string) ?? '';
        return new Response(
          new ReadableStream({
            start(controller) {
              const enc = new TextEncoder();
              controller.enqueue(enc.encode(sseChunk({
                id: 'p-1', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 5, completion_tokens: 1 },
              })));
              controller.enqueue(enc.encode('data: [DONE]\n\n'));
              controller.close();
            },
          }),
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
        );
        void url;
      }) as typeof global.fetch;

      try {
        const adapter = new OpenAIAdapter({
          baseURL: 'https://api.mistral.ai/v1', apiKey: 'test', modelId: 'mistral-large-2512',
        });
        await adapter.beta.messages.stream({
          model: 'mistral-large-2512', max_tokens: 50,
          messages: [{ role: 'user', content: 'x' }],
          prompt_cache_key: 'bench-test-1',
        } as Parameters<typeof adapter.beta.messages.stream>[0]).finalMessage();
        const parsed = JSON.parse(capturedBody) as { prompt_cache_key?: string };
        expect(parsed.prompt_cache_key).toBeDefined();
        expect(parsed.prompt_cache_key).toMatch(/^[0-9a-f]{16}:bench-test-1$/);
      } finally {
        global.fetch = originalFetch;
      }
    });

    it('does NOT forward prompt_cache_key when outgoing host is not api.mistral.ai', async () => {
      let capturedBody = '';
      const originalFetch = global.fetch;
      global.fetch = (async (url: string | URL, init?: { body?: string }) => {
        capturedBody = (init?.body as string) ?? '';
        return new Response(
          new ReadableStream({
            start(controller) {
              const enc = new TextEncoder();
              controller.enqueue(enc.encode(sseChunk({
                id: 'p-2', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 5, completion_tokens: 1 },
              })));
              controller.enqueue(enc.encode('data: [DONE]\n\n'));
              controller.close();
            },
          }),
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
        );
        void url;
      }) as typeof global.fetch;

      try {
        const adapter = new OpenAIAdapter({
          baseURL: 'https://api.openai.com/v1', apiKey: 'test', modelId: 'gpt-4',
        });
        await adapter.beta.messages.stream({
          model: 'gpt-4', max_tokens: 50,
          messages: [{ role: 'user', content: 'x' }],
          prompt_cache_key: 'bench-test-2',
        } as Parameters<typeof adapter.beta.messages.stream>[0]).finalMessage();
        const parsed = JSON.parse(capturedBody) as { prompt_cache_key?: string };
        expect(parsed.prompt_cache_key).toBeUndefined();
      } finally {
        global.fetch = originalFetch;
      }
    });
  });

  describe('cache-key salt persistence', () => {
    let tmpLynoxDir: string;
    let originalLynoxDir: string | undefined;

    beforeEach(() => {
      _resetCacheKeySaltMemo();
      tmpLynoxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lynox-test-'));
      originalLynoxDir = process.env['LYNOX_DIR'];
      process.env['LYNOX_DIR'] = tmpLynoxDir;
    });

    afterEach(() => {
      _resetCacheKeySaltMemo();
      if (originalLynoxDir === undefined) {
        delete process.env['LYNOX_DIR'];
      } else {
        process.env['LYNOX_DIR'] = originalLynoxDir;
      }
      try { fs.rmSync(tmpLynoxDir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it('creates a 16-hex-char salt file with 0600 perms on first call', () => {
      const salt = getCacheKeySalt();
      expect(salt).toMatch(/^[0-9a-f]{16}$/);
      const saltPath = path.join(tmpLynoxDir, '.cache-salt');
      expect(fs.existsSync(saltPath)).toBe(true);
      const stat = fs.statSync(saltPath);
      // On POSIX, mode includes file-type bits; mask with 0o777 for perms.
      expect(stat.mode & 0o777).toBe(0o600);
    });

    it('returns a stable salt across calls in the same process (memoized)', () => {
      const a = getCacheKeySalt();
      const b = getCacheKeySalt();
      expect(a).toBe(b);
    });

    it('prefers the canonical LYNOX_DATA_DIR over the legacy LYNOX_DIR for the salt dir', () => {
      // beforeEach already set LYNOX_DIR=tmpLynoxDir (legacy). The canonical
      // var must win, so the salt lands in the data dir, not the legacy dir.
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lynox-data-'));
      process.env['LYNOX_DATA_DIR'] = dataDir;
      try {
        const salt = getCacheKeySalt();
        expect(salt).toMatch(/^[0-9a-f]{16}$/);
        expect(fs.existsSync(path.join(dataDir, '.cache-salt'))).toBe(true);
        expect(fs.existsSync(path.join(tmpLynoxDir, '.cache-salt'))).toBe(false);
      } finally {
        delete process.env['LYNOX_DATA_DIR'];
        try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    });

    // POSIX-only: ENOTDIR semantics under "file as directory" differ on
    // Windows. Engine README pins Node 22+ on macOS+Linux so this is fine.
    it('falls back to in-memory salt when filesystem write fails', () => {
      // Point LYNOX_DIR at a path where a regular file exists in place of
      // the directory — mkdirSync fails with ENOTDIR, exercising the
      // catch-block / in-memory fallback path. ESM module namespaces can't
      // be spied on (vi.spyOn limitation), so we force the failure via
      // real fs state instead of a mock.
      const conflictPath = path.join(tmpLynoxDir, 'not-a-dir');
      fs.writeFileSync(conflictPath, 'placeholder');
      process.env['LYNOX_DIR'] = path.join(conflictPath, 'cannot-mkdir-here');

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const salt = getCacheKeySalt();
        // randomBytes(8) → 16 hex chars in the fallback path.
        expect(salt).toMatch(/^[0-9a-f]{16}$/);
        expect(warnSpy).toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
      }
    });
  });
});

describe('translateMessages — user content is never silently dropped', () => {
  const IMG = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } };

  it('DEF-0073: translates a user image to an image_url part when vision is supported', () => {
    const out = translateMessages(undefined, [
      { role: 'user', content: [{ type: 'text', text: 'what is this?' }, IMG] },
    ], { visionSupport: true });
    const userMsg = out.find((m) => m.role === 'user')!;
    expect(Array.isArray(userMsg.content)).toBe(true);
    const parts = userMsg.content as Array<{ type: string; text?: string; image_url?: { url: string } }>;
    expect(parts).toEqual([
      { type: 'text', text: 'what is this?' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    ]);
  });

  it('DEF-0073: translates an image for an unknown/custom model (visionSupport undefined)', () => {
    const out = translateMessages(undefined, [{ role: 'user', content: [IMG] }], {});
    const parts = out.find((m) => m.role === 'user')!.content as Array<{ type: string }>;
    expect(parts[0]!.type).toBe('image_url');
  });

  it('DEF-0073: throws a clear error for a known non-vision model instead of silently dropping', () => {
    // Use a genuinely non-vision id: gen-3 Mistral (mistral-large-2512 etc.) is
    // now vision:true, so codestral — a code model that rejects images — is the
    // honest example of the visionSupport:false path.
    expect(() =>
      translateMessages(undefined, [{ role: 'user', content: [{ type: 'text', text: 'hi' }, IMG] }], {
        visionSupport: false,
        modelLabel: 'codestral-2508',
      }),
    ).toThrow(/codestral-2508.*cannot process images/i);
  });

  // #2 CI guard: the online test proves registry→adapter against the real
  // Mistral API but is skipped in CI (no MISTRAL_API_KEY). This drives the SAME
  // wiring the production path uses — modelCapability(datedId).features.vision
  // feeding translateMessages — so a flag flip-back is caught in CI too, not
  // only in the (skipped) online guard.
  it('#2: gen-3 Mistral resolves vision:true from the registry → adapter translates the image', () => {
    for (const id of ['ministral-3b-2512', 'ministral-8b-2512', 'ministral-14b-2512', 'mistral-large-2512']) {
      const visionSupport = modelCapability(id)?.features?.vision;
      expect(visionSupport, id).toBe(true);
      const out = translateMessages(undefined, [{ role: 'user', content: [{ type: 'text', text: 'hi' }, IMG] }], {
        visionSupport, modelLabel: id,
      });
      const parts = out.find((m) => m.role === 'user')!.content as Array<{ type: string }>;
      expect(parts.some((p) => p.type === 'image_url'), id).toBe(true);
    }
  });

  it('#2: a non-vision Mistral id (codestral) resolves vision:false → adapter throws', () => {
    const visionSupport = modelCapability('codestral-2508')?.features?.vision;
    expect(visionSupport).toBe(false);
    expect(() =>
      translateMessages(undefined, [{ role: 'user', content: [IMG] }], { visionSupport, modelLabel: 'codestral-2508' }),
    ).toThrow(/cannot process images/i);
  });

  // Fireworks vision candidates (2026-08-14): registry → adapter, same shape as
  // the Mistral #2 guard. The online test (tests/online/fireworks-vision.test.ts)
  // proves the wire against the real Fireworks endpoint but skips without
  // FIREWORKS_API_KEY — this CI-visible twin catches a flip-back to
  // FIREWORKS_TEXT_FEATURES on the three candidate entries.
  it('fireworks: kimi-k3 / qwen3p7-plus / minimax-m3 resolve vision:true → adapter translates the image', () => {
    for (const id of ['accounts/fireworks/models/kimi-k3', 'accounts/fireworks/models/qwen3p7-plus', 'accounts/fireworks/models/minimax-m3']) {
      const visionSupport = modelCapability(id)?.features?.vision;
      expect(visionSupport, id).toBe(true);
      const out = translateMessages(undefined, [{ role: 'user', content: [{ type: 'text', text: 'hi' }, IMG] }], {
        visionSupport, modelLabel: id,
      });
      const parts = out.find((m) => m.role === 'user')!.content as Array<{ type: string }>;
      expect(parts.some((p) => p.type === 'image_url'), id).toBe(true);
    }
  });

  it('fireworks: genuinely non-vision siblings stay vision:false → adapter throws (no shared-object flip)', () => {
    // GLM 5.2 / DeepSeek v4 / gpt-oss-120b have no image input on Fireworks. If
    // someone "fixes" the candidates by flipping FIREWORKS_TEXT_FEATURES itself,
    // these models would silently start receiving images their pages disavow.
    for (const id of ['accounts/fireworks/models/glm-5p2', 'accounts/fireworks/models/deepseek-v4-pro', 'accounts/fireworks/models/deepseek-v4-flash-0731', 'accounts/fireworks/models/gpt-oss-120b']) {
      const visionSupport = modelCapability(id)?.features?.vision;
      expect(visionSupport, id).toBe(false);
      expect(() =>
        translateMessages(undefined, [{ role: 'user', content: [IMG] }], { visionSupport, modelLabel: id }),
      ).toThrow(/cannot process images/i);
    }
  });

  it('DEF-0074: preserves user text that shares a turn with a tool_result', () => {
    const out = translateMessages(undefined, [
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'call_1', content: 'result text' },
        { type: 'text', text: 'and here is my follow-up' },
      ] },
    ]);
    // tool message first (answers the assistant's tool_call), then the user's own text — NOT discarded.
    const tool = out.find((m) => m.role === 'tool')!;
    expect(tool.content).toBe('result text');
    expect(tool.tool_call_id).toBe('call_1');
    const user = out.find((m) => m.role === 'user')!;
    expect(user.content).toBe('and here is my follow-up');
  });

  it('DEF-openai-wire-toolerr: prefixes an is_error tool_result so the model sees the failure', () => {
    // The Anthropic wire carries is_error on tool_result; the OpenAI wire has no
    // such field on role:'tool'. Without a marker, agent.ts error results
    // ('Permission denied', tool exceptions) reach the model as ordinary
    // success-shaped text on every openai-compat provider.
    const out = translateMessages(undefined, [
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'call_e', content: 'Permission denied', is_error: true },
      ] },
    ]);
    expect(out).toEqual([{ role: 'tool', tool_call_id: 'call_e', content: '[Tool error] Permission denied' }]);
  });

  it('DEF-openai-wire-toolerr: prefixes is_error with block-array content too', () => {
    const out = translateMessages(undefined, [
      { role: 'user', content: [
        {
          type: 'tool_result', tool_use_id: 'call_b', is_error: true,
          content: [{ type: 'text', text: 'HTTP 403' }, { type: 'text', text: 'forbidden' }],
        },
      ] },
    ]);
    const tool = out.find((m) => m.role === 'tool')!;
    expect(tool.content).toBe('[Tool error] HTTP 403\nforbidden');
  });

  it('DEF-openai-wire-toolerr: an is_error result with empty content still carries the marker', () => {
    const out = translateMessages(undefined, [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_x', is_error: true }] },
    ]);
    // '[Tool error] ' with a trailing space would be the only content on the
    // message — assert the bare marker instead.
    expect(out).toEqual([{ role: 'tool', tool_call_id: 'call_x', content: '[Tool error]' }]);
  });

  it('DEF-openai-wire-toolerr: a successful tool_result carries no prefix', () => {
    const out = translateMessages(undefined, [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_ok', content: 'fine', is_error: false }] },
    ]);
    expect(out).toEqual([{ role: 'tool', tool_call_id: 'call_ok', content: 'fine' }]);
  });

  it('byte-parity: a text-only user message stays a plain string (no array)', () => {
    const out = translateMessages(undefined, [{ role: 'user', content: [{ type: 'text', text: 'plain' }] }]);
    expect(out).toEqual([{ role: 'user', content: 'plain' }]);
  });

  it('byte-parity: a tool_result-only turn emits just the tool message, no empty user message', () => {
    const out = translateMessages(undefined, [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_2', content: 'r' }] },
    ]);
    expect(out).toEqual([{ role: 'tool', tool_call_id: 'call_2', content: 'r' }]);
  });
});

describe('translateMessages — empty-content edge', () => {
  it('skips an empty user text block that shares a tool_result turn (no content:"" message)', () => {
    const out = translateMessages(undefined, [
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'c', content: 'r' },
        { type: 'text', text: '' },
      ] },
    ]);
    // Only the tool message — no trailing empty user message.
    expect(out).toEqual([{ role: 'tool', tool_call_id: 'c', content: 'r' }]);
  });
});


describe('OpenAIAdapter — request idle timeout (DEF-openai-adapter-timeout)', () => {
  const prev = process.env['LYNOX_OPENAI_REQUEST_TIMEOUT_MS'];
  beforeEach(() => { process.env['LYNOX_OPENAI_REQUEST_TIMEOUT_MS'] = '300'; });
  afterEach(() => {
    if (prev === undefined) delete process.env['LYNOX_OPENAI_REQUEST_TIMEOUT_MS'];
    else process.env['LYNOX_OPENAI_REQUEST_TIMEOUT_MS'] = prev;
  });

  it('aborts a connection that never sends response headers (silently-dropped socket)', async () => {
    // Handler accepts the socket and never responds — the openai-wire fetch has no built-in
    // timeout, so without the idle watchdog this hangs forever (the 2026-07-16 prod-shape hang).
    const server = await createMockServer(() => { /* hang: never writeHead / end */ });
    try {
      const adapter = new OpenAIAdapter({ baseURL: `http://localhost:${server.port}`, apiKey: 'k', modelId: 'm' });
      await expect(
        collectEvents(adapter.beta.messages.stream({ model: 'm', max_tokens: 10, messages: [{ role: 'user', content: 'Hi' }] })),
      ).rejects.toThrow(/timed out|no data/i);
    } finally { server.close(); }
  }, 5000);

  it('aborts a stream that stalls mid-response (headers + one chunk, then silence)', async () => {
    const server = await createMockServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(sseChunk({ id: 's', choices: [{ index: 0, delta: { role: 'assistant', content: 'Hi' }, finish_reason: null }] }));
      // then stall forever — no [DONE], no res.end()
    });
    try {
      const adapter = new OpenAIAdapter({ baseURL: `http://localhost:${server.port}`, apiKey: 'k', modelId: 'm' });
      await expect(
        collectEvents(adapter.beta.messages.stream({ model: 'm', max_tokens: 10, messages: [{ role: 'user', content: 'Hi' }] })),
      ).rejects.toThrow(/timed out|no data/i);
    } finally { server.close(); }
  }, 5000);

  it('a caller-supplied signal still aborts (composition preserved)', async () => {
    const server = await createMockServer(() => { /* hang */ });
    try {
      const adapter = new OpenAIAdapter({ baseURL: `http://localhost:${server.port}`, apiKey: 'k', modelId: 'm' });
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 100);
      await expect(
        collectEvents(adapter.beta.messages.stream({ model: 'm', max_tokens: 10, messages: [{ role: 'user', content: 'Hi' }] }, { signal: ac.signal })),
      ).rejects.toThrow();
    } finally { server.close(); }
  }, 5000);
});

describe('OpenAIAdapter — the non-streaming call every extraction path uses', () => {
  /**
   * `createLLMClient` returns `new OpenAIAdapter(...) as unknown as Anthropic` for every tenant
   * whose provider maps to the openai wire client — Mistral and OpenAI. The cast makes the
   * compiler agree with any shape, so a method the adapter simply did not have failed at
   * RUNTIME and only there: `client.beta.messages.create is not a function`.
   *
   * Three callers reach it — `llm-helper.ts` (save_workflow extraction), `process-capture.ts`,
   * and the inbox classifier — and two of them use the UN-prefixed `client.messages.create`,
   * which is a different property. Both are covered here for that reason; testing one would
   * have left half the callers broken while looking green.
   */
  function toolCallServer(): Promise<{ port: number; close: () => void }> {
    return createMockServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(sseChunk({
        id: 'x-1', choices: [{
          index: 0,
          delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', function: { name: 'extract', arguments: '{"ok":true}' } }] },
          finish_reason: null,
        }],
      }));
      res.write(sseChunk({
        id: 'x-1', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 7, completion_tokens: 3 },
      }));
      res.write('data: [DONE]\n\n');
      res.end();
    });
  }

  it.each([
    ['beta.messages.create', (a: OpenAIAdapter) => a.beta.messages.create],
    ['messages.create',      (a: OpenAIAdapter) => a.messages.create],
  ])('%s returns an assembled message with the fields its callers read', async (_label, pick) => {
    const server = await toolCallServer();
    try {
      const adapter = new OpenAIAdapter({
        baseURL: `http://localhost:${server.port}`, apiKey: 'test-key', modelId: 'test-model',
      });
      const msg = await pick(adapter)({
        model: 'test-model', max_tokens: 100, messages: [{ role: 'user', content: 'Hi' }],
      });

      // Exactly what the three call sites destructure: the content blocks and the usage.
      expect(msg.stop_reason).toBe('tool_use');
      expect(msg.content.find(b => b.type === 'tool_use')?.name).toBe('extract');
      expect(msg.usage.input_tokens).toBe(7);
      expect(msg.usage.output_tokens).toBe(3);
    } finally {
      server.close();
    }
  });
});

describe('OpenAIAdapter — a truncated stream must not assemble into a plausible message', () => {
  it('throws instead of returning end_turn with zero usage', async () => {
    // The upstream ends mid-answer: content arrived, no finish_reason ever did. Before this,
    // `finalMessage()` returned partial content with `stop_reason: 'end_turn'` and usage 0/0 —
    // indistinguishable from a short, cheap, successful call. `process-capture.ts` debits from
    // that usage, so it recorded a real API call as costing nothing and accepted the truncated
    // extraction as the answer.
    const server = await createMockServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(sseChunk({ id: 't-1', choices: [{ index: 0, delta: { role: 'assistant', content: 'Half a th' }, finish_reason: null }] }));
      res.write('data: [DONE]\n\n');
      res.end();
    });
    try {
      const adapter = new OpenAIAdapter({
        baseURL: `http://localhost:${server.port}`, apiKey: 'test-key', modelId: 'test-model',
      });
      await expect(adapter.messages.create({
        model: 'test-model', max_tokens: 100, messages: [{ role: 'user', content: 'Hi' }],
      })).rejects.toThrow(/incomplete/);
    } finally {
      server.close();
    }
  });
});
