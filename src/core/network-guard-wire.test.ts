import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { defaultPinnedTransportForTests, type PinnedTransportInput } from './network-guard.js';

// What the default transport actually puts on the wire. Every other network-guard test
// replaces the transport, so a header Node adds or leaves out while sending is invisible to
// them — a body went out chunked to a receiver that refuses chunked bodies, all tests green.
// These run the real transport against a real `node:http` server on loopback. The address
// validation `fetchPinned` performs is skipped on purpose: it would refuse loopback, and what
// is under test here is the send, not the validation.

interface Seen { method: string; te: string | null; cl: string | null; bytes: number; clLines: number }

const NO_BODY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

let server: http.Server;
let port = 0;
let last: Seen | undefined;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const te = req.headers['transfer-encoding'] ?? null;
      last = {
        method: req.method ?? '',
        te,
        cl: req.headers['content-length'] ?? null,
        bytes: Buffer.concat(chunks).length,
        // Header LINES, not the parsed value: Node joins or drops duplicates while parsing,
        // so a second `content-length` line is only visible in the raw list.
        clLines: req.rawHeaders.filter((h, i) => i % 2 === 0 && h.toLowerCase() === 'content-length').length,
      };
      // The control plane's body gate, as its predicate reads (pro
      // `packages/managed/src/server.ts`, the `NO_BODY_METHODS` middleware): a chunked
      // request on any method that may carry a body is refused with 411.
      if (!NO_BODY_METHODS.has(req.method ?? '') && te && /\bchunked\b/i.test(te)) {
        res.writeHead(411, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Chunked transfer-encoding not accepted on this endpoint' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function input(method: string, body: Buffer | undefined, headers: Record<string, string> = {}): PinnedTransportInput {
  return {
    url: `http://127.0.0.1:${port}/internal/claim`,
    hostname: '127.0.0.1',
    pinnedIp: '127.0.0.1',
    family: 4,
    port,
    method,
    headers: { host: `127.0.0.1:${port}`, ...headers },
    body,
    signal: undefined,
    protocol: 'http:',
  };
}

describe('default pinned transport — what reaches the wire', () => {
  it('sends a body with content-length in BYTES and without chunked encoding', async () => {
    // Non-ASCII on purpose: `ü` is one character and two bytes, so a length taken from the
    // string instead of the Buffer would be one short.
    const body = Buffer.from(JSON.stringify({ name: 'Zürich' }), 'utf8');
    const res = await defaultPinnedTransportForTests()(input('POST', body, { 'content-type': 'application/json' }));
    expect(res.status).toBe(200);
    expect(last).toEqual({ method: 'POST', te: null, cl: String(body.length), bytes: body.length, clLines: 1 });
  });

  it('gets past a receiver that refuses chunked bodies, which a chunked send does not', async () => {
    // The control: the same server refuses a POST that Node sends chunked, so the 200 above
    // is the fix and not a lenient fixture.
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/' }, (r) => {
        r.resume();
        resolve(r.statusCode ?? 0);
      });
      req.on('error', reject);
      req.write(Buffer.from('{}'));
      req.end();
    });
    expect(status).toBe(411);
    expect(last?.te).toBe('chunked');

    const res = await defaultPinnedTransportForTests()(input('PUT', Buffer.from('{"a":1}')));
    expect(res.status).toBe(200);
  });

  it('replaces any framing the caller set with the body\'s real length', async () => {
    const body = Buffer.from('abc');
    // A stale length, in another case spelling: replaced and sent once. Kept, it would make
    // the receiver wait for 99 bytes that never come.
    let res = await defaultPinnedTransportForTests()(input('POST', body, { 'Content-Length': '99' }));
    expect(res.status).toBe(200);
    expect(last).toMatchObject({ te: null, cl: '3', bytes: 3, clLines: 1 });

    // A transfer encoding next to a length is the shape where a receiver and a proxy in front
    // of it disagree about where the body ends. Both are dropped; only the real length goes out.
    res = await defaultPinnedTransportForTests()(input('POST', body, { 'transfer-encoding': 'chunked', 'Content-Length': '3' }));
    expect(res.status).toBe(200);
    expect(last).toMatchObject({ te: null, cl: '3', bytes: 3, clLines: 1 });

    // An encoding Node does not frame would send the raw bytes with no framing at all.
    res = await defaultPinnedTransportForTests()(input('POST', body, { 'Transfer-Encoding': 'gzip' }));
    expect(res.status).toBe(200);
    expect(last).toMatchObject({ te: null, cl: '3', bytes: 3, clLines: 1 });
  });

  it('drops framing the caller set on a request WITHOUT a body too', async () => {
    // A body-dropping redirect hop, or an http_request POST with an empty body, reaches here
    // with the caller's headers and no Buffer. A kept length would stall the receiver waiting
    // for bytes; a kept encoding next to it is the shape the case above refuses.
    let res = await defaultPinnedTransportForTests()(input('POST', undefined, { 'Content-Length': '5', 'Transfer-Encoding': 'chunked' }));
    expect(res.status).toBe(200);
    expect(last).toMatchObject({ method: 'POST', te: null, cl: '0', bytes: 0, clLines: 1 });

    res = await defaultPinnedTransportForTests()(input('GET', undefined, { 'Content-Length': '5' }));
    expect(res.status).toBe(200);
    expect(last).toMatchObject({ method: 'GET', te: null, cl: null, bytes: 0 });
  });

  it('adds nothing to a request without a body', async () => {
    const res = await defaultPinnedTransportForTests()(input('GET', undefined));
    expect(res.status).toBe(200);
    expect(last).toMatchObject({ method: 'GET', te: null, cl: null, bytes: 0 });
  });

  it('is not reachable outside a test process', () => {
    const saved = { NODE_ENV: process.env['NODE_ENV'], VITEST: process.env['VITEST'] };
    process.env['NODE_ENV'] = 'production';
    delete process.env['VITEST'];
    try {
      expect(() => defaultPinnedTransportForTests()).toThrow(/tests only/);
    } finally {
      // Assigning `undefined` to an env var stores the STRING "undefined", so an unset value is
      // restored by deleting it.
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
