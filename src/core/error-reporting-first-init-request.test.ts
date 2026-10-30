/**
 * Reporting off at boot, then turned on for the first time from inside a request: before any
 * `Sentry.init` in the process no async strategy is installed, so the init binds its client where
 * every later scope comes from, and a capture outside the request is sent. Its own file, so no
 * earlier test has initialised the SDK in this process. Real @sentry/node SDK, counting transport,
 * real HTTP request.
 */
import { it, expect, vi, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const sent: string[] = [];
vi.mock('@sentry/node', async () => {
  const actual = await vi.importActual<typeof import('@sentry/node')>('@sentry/node');
  return {
    ...actual,
    init: (options: Record<string, unknown>) =>
      actual.init({
        ...options,
        transport: () => ({
          send: async (envelope: unknown) => {
            sent.push(JSON.stringify(envelope));
            return {};
          },
          flush: async () => true,
        }),
      }),
  };
});

const Sentry = await import('@sentry/node');
const { initErrorReporting, captureError } = await import('./error-reporting.js');

const servers: http.Server[] = [];
afterAll(() => { for (const s of servers) s.close(); });

const reached = (value: string): boolean => sent.some((e) => e.includes(`"value":"${value}"`));

it('reports from outside the request when the first init runs inside one', async () => {
  let onInRequest = false;
  const server = http.createServer((_req, res) => {
    void (async () => {
      onInRequest = await initErrorReporting('https://key@bugs.example.invalid/1');
      res.writeHead(200);
      res.end();
    })();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => {
    const rq = http.request({ host: '127.0.0.1', port, method: 'GET', path: '/' }, (r) => { r.resume(); r.on('end', resolve); });
    rq.on('error', reject);
    rq.end();
  });
  expect(onInRequest).toBe(true);
  captureError(new Error('outside-after-first-init'));
  await Sentry.flush(2000);
  expect(reached('outside-after-first-init')).toBe(true);
});
