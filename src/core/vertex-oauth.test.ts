/**
 * Unit tests for Vertex AI OAuth token provider.
 *
 * Verifies the integration between OpenAIAdapter (dynamic api_key provider)
 * and the vertex-oauth module — without actually hitting Google's API.
 */

import { describe, it, expect } from 'vitest';
import { OpenAIAdapter, type ApiKeyProvider } from './openai-adapter.js';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

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

describe('OpenAIAdapter with dynamic api_key provider', () => {
  it('calls the provider function for each request and uses the returned token', async () => {
    let capturedAuthHeader = '';
    const server = await createMockServer((req, res) => {
      capturedAuthHeader = String(req.headers['authorization'] ?? '');
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: {"id":"x","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });

    try {
      let callCount = 0;
      const tokenProvider: ApiKeyProvider = async () => {
        callCount++;
        return `ya29.mock-token-${callCount}`;
      };

      const adapter = new OpenAIAdapter({
        baseURL: `http://localhost:${server.port}`,
        apiKey: tokenProvider,
        modelId: 'google/gemini-2.5-flash',
      });

      // First request
      const events1: unknown[] = [];
      for await (const e of adapter.beta.messages.stream({
        model: 'google/gemini-2.5-flash',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'Hi' }],
      })) {
        events1.push(e);
      }

      expect(callCount).toBe(1);
      expect(capturedAuthHeader).toBe('Bearer ya29.mock-token-1');

      // Second request — provider called again (in real google-auth, this would return cached token)
      const events2: unknown[] = [];
      for await (const e of adapter.beta.messages.stream({
        model: 'google/gemini-2.5-flash',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'Hi again' }],
      })) {
        events2.push(e);
      }

      expect(callCount).toBe(2);
      expect(capturedAuthHeader).toBe('Bearer ya29.mock-token-2');
    } finally {
      server.close();
    }
  });

  it('accepts static string api_key (backward compatible)', async () => {
    let capturedAuthHeader = '';
    const server = await createMockServer((req, res) => {
      capturedAuthHeader = String(req.headers['authorization'] ?? '');
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"id":"x","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });

    try {
      const adapter = new OpenAIAdapter({
        baseURL: `http://localhost:${server.port}`,
        apiKey: 'sk-static-key-123',
        modelId: 'mistral-large-latest',
      });

      for await (const _e of adapter.beta.messages.stream({
        model: 'mistral-large-latest',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'Hi' }],
      })) {
        void _e;
      }

      expect(capturedAuthHeader).toBe('Bearer sk-static-key-123');
    } finally {
      server.close();
    }
  });

  it('propagates errors from the token provider', async () => {
    const adapter = new OpenAIAdapter({
      baseURL: 'http://localhost:1',
      apiKey: async () => { throw new Error('Failed to obtain Vertex AI access token'); },
      modelId: 'google/gemini-2.5-flash',
    });

    await expect(async () => {
      for await (const _e of adapter.beta.messages.stream({
        model: 'google/gemini-2.5-flash',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'Hi' }],
      })) {
        void _e;
      }
    }).rejects.toThrow('Failed to obtain Vertex AI access token');
  });
});
