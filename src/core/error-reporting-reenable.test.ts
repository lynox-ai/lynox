/**
 * Error reporting turned on again from inside a request reports from the whole process, and a
 * toggle on that arrives while a shutdown is still running is not lost: against the REAL
 * @sentry/node SDK with a counting transport, and a real HTTP request for the first case, since a
 * request's scope is forked by the SDK's own instrumentation.
 */
import { it, expect, vi, beforeEach, afterAll } from 'vitest';
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
const {
  initErrorReporting, captureError, shutdownErrorReporting, isErrorReportingEnabled, _resetForTesting,
} = await import('./error-reporting.js');

const DSN = 'https://key@bugs.example.invalid/1';
// Matched as the exception's value: the SDK attaches source lines as context, so another
// message's bare text can ride along in an event.
const reached = (value: string): boolean => sent.some((e) => e.includes(`"value":"${value}"`));

const servers: http.Server[] = [];
afterAll(() => { for (const s of servers) s.close(); });

beforeEach(() => {
  _resetForTesting();
  sent.length = 0;
});

it('reports from outside the request after reporting is turned on again inside one', async () => {
  // On at boot, off, then on again from a request handler, as the settings route does.
  expect(await initErrorReporting(DSN)).toBe(true);
  await shutdownErrorReporting();
  let onInRequest = false;
  const server = http.createServer((_req, res) => {
    void (async () => {
      onInRequest = await initErrorReporting(DSN);
      captureError(new Error('inside-the-request'));
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

  captureError(new Error('outside-the-request'));
  await Sentry.flush(2000);
  expect(reached('inside-the-request')).toBe(true);  // control: the client sends
  expect(reached('outside-the-request')).toBe(true);
});

it('turns reporting on when the toggle arrives while a shutdown is still running', async () => {
  expect(await initErrorReporting(DSN)).toBe(true);
  const off = shutdownErrorReporting();
  const on = initErrorReporting(DSN);
  await off;
  expect(await on).toBe(true);
  expect(isErrorReportingEnabled()).toBe(true);
  captureError(new Error('after-the-toggle'));
  await Sentry.flush(2000);
  expect(reached('after-the-toggle')).toBe(true);
});

it('ends off when reporting is turned off while turning it on is still loading the SDK', async () => {
  const on = initErrorReporting(DSN);
  const off = shutdownErrorReporting();
  await Promise.all([on, off]);
  expect(await on).toBe(true);
  expect(isErrorReportingEnabled()).toBe(false);
  // The client the init built is closed too: nothing it is handed reaches the transport.
  const client = Sentry.getClient()!;
  client.captureException(new Error('after-the-last-off'));
  await client.flush(2000);
  expect(reached('after-the-last-off')).toBe(false);
});

it('ends off after off, on and off again while the first off is still running', async () => {
  expect(await initErrorReporting(DSN)).toBe(true);
  const first = shutdownErrorReporting();
  const on = initErrorReporting(DSN);
  const second = shutdownErrorReporting();
  await Promise.all([first, on, second]);
  expect(isErrorReportingEnabled()).toBe(false);
  const client = Sentry.getClient()!;
  client.captureException(new Error('after-the-second-off'));
  await client.flush(2000);
  expect(reached('after-the-second-off')).toBe(false);
});

