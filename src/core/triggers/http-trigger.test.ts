import { describe, it, expect, vi, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { HttpTrigger } from './http-trigger.js';
import type { TriggerCallback, TriggerEvent } from '../../types/index.js';

async function getPort(trigger: HttpTrigger): Promise<number> {
  const server = (trigger as unknown as { server: Server | null }).server;
  if (!server) throw new Error('Server not created');
  if (server.address() === null) {
    await once(server, 'listening');
  }
  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('Server not listening');
  }
  return addr.port as number;
}

describe('HttpTrigger', () => {
  let trigger: HttpTrigger | null = null;

  afterEach(() => {
    if (trigger) {
      trigger.stop();
      trigger = null;
    }
  });

  it('responds 200 on POST to correct path and fires callback with parsed JSON body', async () => {
    trigger = new HttpTrigger({ type: 'http', port: 0 });
    const events: TriggerEvent[] = [];
    const callback: TriggerCallback = async (event) => { events.push(event); };

    trigger.start(callback);
    const port = await getPort(trigger);

    const res = await fetch(`http://127.0.0.1:${port}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'test' }),
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('OK');

    // Give the callback a tick to fire
    await new Promise((r) => setTimeout(r, 50));

    expect(events).toHaveLength(1);
    expect(events[0]!.source).toBe('http');
    expect((events[0]!.payload as any).body).toEqual({ action: 'test' });
    expect((events[0]!.payload as any).method).toBe('POST');
    expect((events[0]!.payload as any).path).toBe('/webhook');
    expect(typeof events[0]!.timestamp).toBe('string');
  });

  it('responds 404 on wrong path', async () => {
    trigger = new HttpTrigger({ type: 'http', port: 0 });
    trigger.start(vi.fn(() => Promise.resolve()));
    const port = await getPort(trigger);

    const res = await fetch(`http://127.0.0.1:${port}/wrong-path`, { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('responds 404 on non-POST method (GET)', async () => {
    trigger = new HttpTrigger({ type: 'http', port: 0 });
    trigger.start(vi.fn(() => Promise.resolve()));
    const port = await getPort(trigger);

    const res = await fetch(`http://127.0.0.1:${port}/webhook`, { method: 'GET' });
    expect(res.status).toBe(404);
  });

  it('uses custom path when configured', async () => {
    trigger = new HttpTrigger({ type: 'http', port: 0, path: '/custom' });
    const callback = vi.fn<TriggerCallback>(() => Promise.resolve());

    trigger.start(callback);
    const port = await getPort(trigger);

    const res = await fetch(`http://127.0.0.1:${port}/custom`, {
      method: 'POST',
      body: '{}',
    });
    expect(res.status).toBe(200);

    // Default path should 404
    const res2 = await fetch(`http://127.0.0.1:${port}/webhook`, {
      method: 'POST',
      body: '{}',
    });
    expect(res2.status).toBe(404);
  });

  it('default path is /webhook', async () => {
    trigger = new HttpTrigger({ type: 'http', port: 0 });
    const callback = vi.fn<TriggerCallback>(() => Promise.resolve());

    trigger.start(callback);
    const port = await getPort(trigger);

    const res = await fetch(`http://127.0.0.1:${port}/webhook`, {
      method: 'POST',
      body: '{}',
    });
    expect(res.status).toBe(200);
  });

  describe('HMAC verification', () => {
    const secret = 'test-secret-key';

    it('accepts valid HMAC signature with 200', async () => {
      trigger = new HttpTrigger({ type: 'http', port: 0, hmacSecret: secret });
      const events: TriggerEvent[] = [];
      const callback: TriggerCallback = async (event) => { events.push(event); };

      trigger.start(callback);
      const port = await getPort(trigger);

      const body = JSON.stringify({ data: 'signed' });
      const signature = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');

      const res = await fetch(`http://127.0.0.1:${port}/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-signature-256': signature,
        },
        body,
      });

      expect(res.status).toBe(200);
      await new Promise((r) => setTimeout(r, 50));
      expect(events).toHaveLength(1);
    });

    it('rejects invalid HMAC signature with 401', async () => {
      trigger = new HttpTrigger({ type: 'http', port: 0, hmacSecret: secret });
      const callback = vi.fn<TriggerCallback>(() => Promise.resolve());

      trigger.start(callback);
      const port = await getPort(trigger);

      const res = await fetch(`http://127.0.0.1:${port}/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-signature-256': 'sha256=invalidsignature',
        },
        body: JSON.stringify({ data: 'test' }),
      });

      expect(res.status).toBe(401);
      expect(await res.text()).toBe('Invalid signature');
    });

    it('rejects missing HMAC signature with 401', async () => {
      trigger = new HttpTrigger({ type: 'http', port: 0, hmacSecret: secret });
      const callback = vi.fn<TriggerCallback>(() => Promise.resolve());

      trigger.start(callback);
      const port = await getPort(trigger);

      const res = await fetch(`http://127.0.0.1:${port}/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: 'test' }),
      });

      expect(res.status).toBe(401);
    });
  });

  it('skips HMAC check when no secret configured and returns 200', async () => {
    trigger = new HttpTrigger({ type: 'http', port: 0 });
    const callback = vi.fn<TriggerCallback>(() => Promise.resolve());

    trigger.start(callback);
    const port = await getPort(trigger);

    const res = await fetch(`http://127.0.0.1:${port}/webhook`, {
      method: 'POST',
      body: JSON.stringify({ data: 'unsigned' }),
    });

    expect(res.status).toBe(200);
  });

  it('stop closes the server', async () => {
    trigger = new HttpTrigger({ type: 'http', port: 0 });
    trigger.start(vi.fn(() => Promise.resolve()));
    const port = await getPort(trigger);

    trigger.stop();

    // Connection should fail after stop
    await expect(
      fetch(`http://127.0.0.1:${port}/webhook`, { method: 'POST', body: '{}' }),
    ).rejects.toThrow();

    trigger = null; // prevent double-stop in afterEach
  });

  it('swallows rejected callback promises after responding', async () => {
    trigger = new HttpTrigger({ type: 'http', port: 0 });
    const callback = vi.fn<TriggerCallback>().mockRejectedValue(new Error('boom'));

    trigger.start(callback);
    const port = await getPort(trigger);

    const res = await fetch(`http://127.0.0.1:${port}/webhook`, {
      method: 'POST',
      body: '{}',
    });

    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    expect(callback).toHaveBeenCalledTimes(1);
  });
});
