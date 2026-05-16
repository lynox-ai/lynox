import { describe, it, expect } from 'vitest';
import { OpenAIAdapter } from './openai-adapter.js';
import type Anthropic from '@anthropic-ai/sdk';
import type { BetaRawMessageStreamEvent } from '@anthropic-ai/sdk/resources/beta/messages/messages.js';
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
      // Tier-routing path: getModelId('sonnet', 'openai') resolved to a
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
});
