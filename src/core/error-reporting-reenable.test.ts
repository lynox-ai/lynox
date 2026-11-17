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
  initErrorReporting, captureError, captureLynoxError, captureUserFeedback, shutdownErrorReporting, isErrorReportingEnabled,
  installGlobalHandlers, uninstallGlobalHandlers, _resetForTesting,
} = await import('./error-reporting.js');
const { LynoxError } = await import('./errors.js');

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

// A request that started before reporting was turned off and on again (a long chat stream) and a
// timer a request started keep the scope forked then, and that scope names the client of its time,
// now closed. What they capture after the new init must reach the new client.
it('reports from a timer a request started before reporting was turned off and on again', async () => {
  expect(await initErrorReporting(DSN)).toBe(true);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let fired!: () => void;
  const done = new Promise<void>((resolve) => { fired = resolve; });
  let timerClient: unknown;
  let onUncaught: ((e: Error) => void) | undefined;
  let onRejection: ((r: unknown) => void) | undefined;
  const server = http.createServer((_req, res) => {
    // Started inside the request, so it runs in the request's scope; it captures only once released.
    setTimeout(() => {
      void gate.then(async () => {
        timerClient = Sentry.getClient();
        captureError(new Error('from-an-old-timer'));
        onRejection?.(new Error('rejection-in-an-old-timer'));
        onUncaught?.(new Error('uncaught-in-an-old-timer'));
        captureLynoxError(new LynoxError('lynox-from-an-old-timer', 'TEST_CODE'));
        await captureUserFeedback({ name: 'n', comments: 'feedback-from-an-old-timer' });
        fired();
      });
    }, 0);
    res.writeHead(200);
    res.end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => {
    const rq = http.request({ host: '127.0.0.1', port, method: 'GET', path: '/' }, (r) => { r.resume(); r.on('end', resolve); });
    rq.on('error', reject);
    rq.end();
  });

  // Off, then on again from outside the request: the timer's scope still names the closed client.
  await shutdownErrorReporting();
  expect(await initErrorReporting(DSN)).toBe(true);
  const liveClient = Sentry.getClient();
  // The process-wide handlers, called by hand from the timer: emitting the events would reach
  // the test runner's own listeners, and the uncaught one ends the process.
  const before = { u: process.listeners('uncaughtException'), r: process.listeners('unhandledRejection') };
  installGlobalHandlers();
  onUncaught = process.listeners('uncaughtException').find((l) => !before.u.includes(l)) as typeof onUncaught;
  onRejection = process.listeners('unhandledRejection').find((l) => !before.r.includes(l)) as typeof onRejection;
  const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  const liveFlush = vi.spyOn(liveClient!, 'flush');
  release();
  await done;
  // The uncaught handler waits for the live client's flush before it exits, not the old one's;
  // read before the flush below, which calls the live client too.
  expect(liveFlush).toHaveBeenCalledWith(2000);
  liveFlush.mockRestore();
  await Sentry.flush(2000);
  await vi.waitFor(() => expect(exit).toHaveBeenCalled());
  exit.mockRestore();
  uninstallGlobalHandlers();
  // Control: the timer still runs in the scope forked before the re-init, which names the old,
  // disabled client; without that the cases below would pass without the routing.
  expect(timerClient).toBeDefined();
  expect(timerClient).not.toBe(liveClient);
  expect((timerClient as { getOptions(): { enabled?: boolean } }).getOptions().enabled).toBe(false);
  expect(reached('rejection-in-an-old-timer')).toBe(true);
  expect(reached('uncaught-in-an-old-timer')).toBe(true);
  expect(reached('from-an-old-timer')).toBe(true);
  expect(reached('lynox-from-an-old-timer')).toBe(true);
  // Matched as the feedback's message field: the comment's bare text also rides along as source
  // context in the error events above.
  expect(sent.some((e) => e.includes('"message":"feedback-from-an-old-timer"'))).toBe(true);
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

it('ends off when reporting is turned off before turning it on has finished', async () => {
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
  const bootClient = Sentry.getClient();
  const first = shutdownErrorReporting();
  const on = initErrorReporting(DSN);
  const second = shutdownErrorReporting();
  await Promise.all([first, on, second]);
  expect(await on).toBe(true);
  expect(isErrorReportingEnabled()).toBe(false);
  const client = Sentry.getClient()!;
  expect(client).not.toBe(bootClient);  // the client the init in between built
  client.captureException(new Error('after-the-second-off'));
  await client.flush(2000);
  expect(reached('after-the-second-off')).toBe(false);
});

