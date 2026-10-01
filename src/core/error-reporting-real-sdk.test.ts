/**
 * Scrubbing against the REAL @sentry/node SDK, not a mock.
 *
 * The main suite pulls `beforeSend` out of a mocked `init` and feeds it events
 * it builds itself. That proves the transformation, but only for fields the test
 * thought to write. Here the SDK builds the event from a real incoming HTTP
 * request, and a capturing transport records exactly what would be sent.
 *
 * Two directions, both required:
 *  - a credential-shaped value in the query string does not leave, in either
 *    copy (`query_string` and `url`);
 *  - the request context DOES arrive. Without that control an SDK version or a
 *    configuration that stops attaching `request` would make the first check
 *    pass for the wrong reason.
 *
 * Deliberately NOT asserted: that `request` is absent. If a future SDK or setup
 * stops attaching it, the control below fails loudly; that is a finding to look
 * at, not a state this file should pin as correct.
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

const { initErrorReporting, captureError, _resetForTesting } = await import('./error-reporting.js');

const servers: http.Server[] = [];
afterAll(() => {
  for (const s of servers) s.close();
});

it('masks a credential in the query string in both request fields, and the request still arrives', async () => {
  _resetForTesting();
  expect(await initErrorReporting('https://key@bugs.example.invalid/1')).toBe(true);

  const secret = 'b'.repeat(64);
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      captureError(new Error('failure inside a request'));
      res.writeHead(500);
      res.end();
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  await new Promise<void>((resolve, reject) => {
    const rq = http.request(
      { host: '127.0.0.1', port, method: 'GET', path: `/api/run?t=${secret}&q=hello` },
      (r) => {
        r.resume();
        r.on('end', resolve);
      },
    );
    rq.on('error', reject);
    rq.end();
  });

  const Sentry = await import('@sentry/node');
  await Sentry.flush(3000);

  // Envelopes are [headers, [[itemHeader, payload], ...]]; find the error event.
  type Payload = { exception?: unknown; request?: { url?: string; query_string?: string } };
  const events = sent
    .map((s) => JSON.parse(s) as [unknown, [unknown, Payload][]])
    .flatMap(([, items]) => items.map(([, payload]) => payload))
    .filter((p) => p.exception !== undefined);
  expect(events, 'exactly one error event was captured').toHaveLength(1);
  const request = events[0]?.request;
  // Positive control, on the event's OWN request field: the SDK attached the
  // request this error happened in. (The test's outgoing call also leaves an
  // http breadcrumb with the same path, so a search over the whole envelope
  // would pass without it.)
  expect(request?.url, 'the event carries its request URL').toContain('/api/run?t=');
  expect(request?.url, 'the non-secret part of the query survives').toContain('q=hello');
  // The property under test, in both copies of the query string.
  expect(request?.url).not.toContain(secret);
  expect(request?.query_string).not.toContain(secret);
  // And nowhere else in what would be sent.
  expect(sent.join('\n')).not.toContain(secret);
});
