import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { OpenAIAdapter, getCacheKeySalt, _resetCacheKeySaltMemo } from './openai-adapter.js';
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

    it('does not crash on a usage-only final chunk with no choices array (Mistral)', async () => {
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
