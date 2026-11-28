// When the guard on a tool call written out as text stops a reply on the openai-compatible
// wire, the request to the provider is ended too: leaving the stream's iteration alone only
// releases the adapter's reader, and the provider would keep generating, and billing, a reply
// nobody reads. A real Agent, the real adapter and a real HTTP server that never stops writing.

import { describe, it, expect } from 'vitest';
import { createServer } from 'node:http';
import { Agent, ToolCallImitationError } from './agent.js';
import type { ToolEntry } from '../types/index.js';

const COPY = 'Sending it now:\n{"url": "https://shop.example.com/api/orders", "method": "POST"}\n';

const sendTool: ToolEntry = {
  definition: {
    name: 'send_request',
    description: 'Send an HTTP request',
    input_schema: { type: 'object' as const, properties: { url: { type: 'string' }, method: { type: 'string' } }, required: ['url'] },
  },
  handler: () => Promise.resolve('ok'),
};

/** A provider that streams COPY in small chunks, forever, until the client goes away. */
async function endlessProvider(): Promise<{ port: number; closedAt: () => number | null; chunks: () => number; close: () => void }> {
  let closedAt: number | null = null;
  let chunks = 0;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => { body += c.toString(); });
    req.on('end', () => {
      // Helper calls without tools get a short, finished answer.
      if (!body.includes('"tools"')) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ id: 'h', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\n`);
        res.end('data: [DONE]\n\n');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      let o = 0;
      const timer = setInterval(() => {
        const piece = COPY.slice(o % COPY.length, (o % COPY.length) + 11);
        o += piece.length;
        chunks++;
        res.write(`data: ${JSON.stringify({ id: 'r', choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] })}\n\n`);
      }, 2);
      res.on('close', () => { clearInterval(timer); closedAt ??= Date.now(); });
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { port, closedAt: () => closedAt, chunks: () => chunks, close: () => { server.closeAllConnections(); server.close(); } };
}

describe('the guard ends the upstream request on the openai-compatible wire', () => {
  it('the provider sees the connection closed right after the stop, and stops writing', async () => {
    const provider = await endlessProvider();
    try {
      const agent = new Agent({
        name: 'test',
        model: 'm',
        provider: 'openai',
        apiBaseURL: `http://127.0.0.1:${String(provider.port)}/v1`,
        openaiModelId: 'm',
        apiKey: 'k',
        tools: [sendTool],
      });
      const err = await agent.send('place the order').catch((e: unknown) => e);
      const stoppedAt = Date.now();
      expect(err).toBeInstanceOf(ToolCallImitationError);

      // The connection closes within a moment of the stop, not when the provider finishes
      // (this one never does).
      for (let i = 0; i < 200 && provider.closedAt() === null; i++) await new Promise((r) => setTimeout(r, 10));
      expect(provider.closedAt(), 'the provider saw the request end').not.toBeNull();
      expect(provider.closedAt()! - stoppedAt).toBeLessThan(1000);
      // And nothing more is generated for it.
      const after = provider.chunks();
      await new Promise((r) => setTimeout(r, 100));
      expect(provider.chunks()).toBe(after);
    } finally {
      provider.close();
    }
  }, 15_000);
});
