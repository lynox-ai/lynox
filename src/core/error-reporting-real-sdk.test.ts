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
  type Payload = { exception?: unknown; user?: unknown; request?: { url?: string; query_string?: string } };
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
  // No user identity: @sentry/node 11 defaults to sending the client IP as
  // `user.ip_address`; the explicit `dataCollection` turns that off.
  expect(events[0]?.user, 'no user identity (client IP) on the event').toBeUndefined();
  // The property under test, in both copies of the query string.
  expect(request?.url).not.toContain(secret);
  expect(request?.query_string).not.toContain(secret);
  // And nowhere else in what would be sent.
  expect(sent.join('\n')).not.toContain(secret);
});

it('sends no body, cookie or authorization from a POST, and the request still arrives', async () => {
  // The HTTP API reads a POST body first (`await` on a reader built on the
  // stream's data/end events) and handles the request afterwards; errors are
  // captured after that await. This mirrors that order.
  _resetForTesting();
  sent.length = 0;
  expect(await initErrorReporting('https://key@bugs.example.invalid/1')).toBe(true);

  const bodyValue = 'e'.repeat(64);
  const cookieValue = 'f'.repeat(64);
  const bearerValue = 'g'.repeat(64);
  const readBody = (req: http.IncomingMessage): Promise<string> => new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
  const server = http.createServer((req, res) => {
    void (async () => {
      await readBody(req);
      captureError(new Error('failure after reading the body'));
      res.writeHead(500);
      res.end();
    })();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  await new Promise<void>((resolve, reject) => {
    const rq = http.request(
      {
        host: '127.0.0.1', port, method: 'POST', path: '/api/run?q=hello',
        headers: { 'content-type': 'application/json', cookie: `session=${cookieValue}`, authorization: `Bearer ${bearerValue}` },
      },
      (r) => { r.resume(); r.on('end', resolve); },
    );
    rq.on('error', reject);
    rq.end(JSON.stringify({ prompt: bodyValue }));
  });

  const Sentry = await import('@sentry/node');
  await Sentry.flush(3000);

  type Payload = { exception?: unknown; request?: { url?: string; method?: string } };
  const events = sent
    .map((s) => JSON.parse(s) as [unknown, [unknown, Payload][]])
    .flatMap(([, items]) => items.map(([, payload]) => payload))
    .filter((p) => p.exception !== undefined);
  expect(events, 'exactly one error event was captured').toHaveLength(1);
  // Positive control on the event's own field: the request this error happened in is attached.
  expect(events[0]?.request?.method).toBe('POST');
  expect(events[0]?.request?.url, 'the event carries its request URL').toContain('/api/run?q=hello');
  // None of the three leaves, anywhere in what would be sent. Measured on
  // @sentry/node 11: the SDK itself already omits the cookie and authorization
  // headers here, so those two lines guard the SDK's behaviour; the deletes in
  // `beforeSend` that drop them are proven by the unit suite ("drops request
  // headers and cookies outright"). The body IS captured by the SDK, and the
  // `beforeSend` delete is what keeps it out.
  const all = sent.join('\n');
  expect(all, 'the request body').not.toContain(bodyValue);
  expect(all, 'the cookie').not.toContain(cookieValue);
  expect(all, 'the bearer').not.toContain(bearerValue);
});
