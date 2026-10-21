/**
 * The shutdown of error reporting ends against an endpoint that never answers.
 *
 * Real @sentry/node SDK and its real HTTP transport, against a local TCP server that accepts the
 * connection, reads the request and never writes a byte back. The flush gives up after its 5 s;
 * the close after it must give up too. Without a bound the SDK's close waits until every event
 * is sent, so the shutdown, and a migration restore that awaits it, would never return.
 *
 * The control: the event did reach the server, and the flush did wait for it. Without it, an SDK
 * or configuration that sends nothing would let the shutdown return at once and this test pass
 * for the wrong reason.
 */
import { it, expect, afterAll } from 'vitest';
import net from 'node:net';
import type { AddressInfo } from 'node:net';

const { initErrorReporting, captureError, shutdownErrorReporting, _resetForTesting } = await import('./error-reporting.js');

const sockets = new Set<net.Socket>();
let received = '';
const silent = net.createServer((socket) => {
  sockets.add(socket);
  socket.on('data', (chunk: Buffer) => { received += chunk.toString('utf8'); });
  socket.on('close', () => sockets.delete(socket));
});

afterAll(async () => {
  for (const s of sockets) s.destroy();
  await new Promise<void>((resolve) => silent.close(() => resolve()));
});

it('returns within its bound when the endpoint accepts and never answers', async () => {
  await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
  const { port } = silent.address() as AddressInfo;

  _resetForTesting();
  expect(await initErrorReporting(`http://key@127.0.0.1:${String(port)}/1`)).toBe(true);
  captureError(new Error('reported while the endpoint is silent'));

  const started = Date.now();
  const outcome = await Promise.race([
    shutdownErrorReporting().then(() => 'returned' as const),
    new Promise<'still waiting'>((resolve) => setTimeout(() => resolve('still waiting'), 12_000).unref()),
  ]);
  const elapsed = Date.now() - started;

  expect(received).toContain('reported while the endpoint is silent');
  expect(outcome).toBe('returned');
  // The flush waited out its 5 s, so the endpoint really held the event; then at most about 2 s
  // of close, with room for a slow box, far below the 12 s a hang runs into.
  expect(elapsed).toBeGreaterThanOrEqual(4_500);
  expect(elapsed).toBeLessThan(9_000);
}, 20_000);
