import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node:dns/promises', () => ({
  default: {
    lookup: vi.fn(),
  },
}));

import dns from 'node:dns/promises';
import {
  isPrivateIP,
  assertPublicHost,
  assertPublicUrl,
  fetchPinned,
  fetchWithPublicRedirects,
  setPinnedTransportForTests,
  __pinnedAgentForTests,
} from './network-guard.js';
import type { PinnedTransportInput } from './network-guard.js';

function mockDns(records: Array<{ address: string; family: 4 | 6 }>): void {
  vi.mocked(dns.lookup).mockResolvedValue(
    records as unknown as Awaited<ReturnType<typeof dns.lookup>>,
  );
}

function mockDnsSequence(seqs: Array<Array<{ address: string; family: 4 | 6 }>>): void {
  const mocked = vi.mocked(dns.lookup);
  mocked.mockReset();
  for (const seq of seqs) {
    mocked.mockResolvedValueOnce(seq as unknown as Awaited<ReturnType<typeof dns.lookup>>);
  }
}

describe('isPrivateIP', () => {
  describe('IPv4', () => {
    it.each([
      ['127.0.0.1', true],
      ['127.255.255.255', true],
      ['10.0.0.1', true],
      ['172.16.0.1', true],
      ['172.31.255.255', true],
      ['172.15.0.1', false],
      ['172.32.0.1', false],
      ['192.168.1.1', true],
      ['169.254.169.254', true], // AWS / GCP metadata
      ['100.64.0.1', true],      // CGNAT
      ['198.18.0.1', true],      // benchmarking
      ['0.0.0.0', true],
      ['224.0.0.1', true],       // multicast
      ['8.8.8.8', false],
      ['1.1.1.1', false],
    ])('isPrivateIP(%s) → %s', (ip, expected) => {
      expect(isPrivateIP(ip)).toBe(expected);
    });

    it('rejects malformed v4 with out-of-range octets', () => {
      expect(isPrivateIP('999.0.0.1')).toBe(false);
    });
  });

  describe('IPv6', () => {
    it.each([
      ['::1', true],
      ['::', true],
      ['fe80::1', true],
      ['fc00::1', true],
      ['fd12::34', true],
      ['ff02::1', true],
      ['2001:4860:4860::8888', false],
    ])('isPrivateIP(%s) → %s', (ip, expected) => {
      expect(isPrivateIP(ip)).toBe(expected);
    });

    it('catches IPv4-mapped IPv6 loopback', () => {
      // Both lower and upper hex forms.
      expect(isPrivateIP('::ffff:127.0.0.1')).toBe(true);
      expect(isPrivateIP('::FFFF:127.0.0.1')).toBe(true);
    });

    it('catches IPv4-mapped IPv6 private ranges', () => {
      expect(isPrivateIP('::ffff:10.0.0.1')).toBe(true);
      expect(isPrivateIP('::ffff:192.168.1.1')).toBe(true);
      expect(isPrivateIP('::ffff:169.254.169.254')).toBe(true);
    });

    it('catches IPv4-mapped IPv6 in hex-pair form (::ffff:7f00:1 = 127.0.0.1)', () => {
      // WHATWG URL parser keeps these in hex; the dotted-only check would miss them.
      expect(isPrivateIP('::ffff:7f00:1')).toBe(true);     // 127.0.0.1
      expect(isPrivateIP('::ffff:7f00:0001')).toBe(true);
      expect(isPrivateIP('::ffff:a00:1')).toBe(true);      // 10.0.0.1
      expect(isPrivateIP('::ffff:a9fe:a9fe')).toBe(true);  // 169.254.169.254 (metadata)
      expect(isPrivateIP('::FFFF:7F00:1')).toBe(true);     // upper-case
      // A public IPv4-mapped address must still pass the check.
      expect(isPrivateIP('::ffff:808:808')).toBe(false);   // 8.8.8.8
    });
  });
});

describe('assertPublicHost', () => {
  it('rejects literal private IPv4', async () => {
    await expect(assertPublicHost('169.254.169.254')).rejects.toThrow(/private IP/i);
  });

  it('rejects literal IPv6 loopback', async () => {
    await expect(assertPublicHost('::1')).rejects.toThrow(/private IP/i);
  });

  it('rejects bracketed IPv6 literal', async () => {
    await expect(assertPublicHost('[::1]')).rejects.toThrow(/private IP/i);
  });

  it('accepts a public hostname (or DNS failure — which is treated as inconclusive, callers must follow up)', async () => {
    // DNS lookup fails / returns no records → assertPublicHost still resolves;
    // DNS failures are not the SSRF guard's responsibility (the subsequent
    // fetch / connect will report the real error).
    vi.mocked(dns.lookup).mockRejectedValueOnce(new Error('ENOTFOUND'));
    await expect(assertPublicHost('this-hostname-does-not-exist.invalid')).resolves.toBeUndefined();
  });
});

describe('assertPublicUrl', () => {
  it('rejects non-http(s) protocols', async () => {
    await expect(assertPublicUrl('file:///etc/passwd')).rejects.toThrow(/protocol/i);
    await expect(assertPublicUrl('ftp://example.com/x')).rejects.toThrow(/protocol/i);
  });

  it('rejects private-IP URLs', async () => {
    await expect(assertPublicUrl('http://10.0.0.1/admin')).rejects.toThrow(/private IP/i);
    await expect(assertPublicUrl('https://169.254.169.254/latest/meta-data/')).rejects.toThrow(/private IP/i);
  });
});

// fetchPinned + fetchWithPublicRedirects tests use the transport seam — the
// transport captures the pinned input (so we can assert which IP the
// connection actually pinned to) and returns a stubbed Response. This is the
// right contract for the DNS-rebinding defense: validate that the IP the
// transport receives is the one we resolved (not a re-resolved value).
describe('fetchPinned / fetchWithPublicRedirects', () => {
  let captured: PinnedTransportInput[];
  let transportResponses: Array<Response | (() => Response)>;
  let restore: () => void;

  beforeEach(() => {
    vi.mocked(dns.lookup).mockReset();
    captured = [];
    transportResponses = [];
    restore = setPinnedTransportForTests(async (input) => {
      captured.push(input);
      const next = transportResponses.shift();
      if (next === undefined) {
        throw new Error('test transport: no response queued');
      }
      return typeof next === 'function' ? next() : next;
    });
  });
  afterEach(() => {
    restore();
    vi.mocked(dns.lookup).mockReset();
  });

  it('fetchPinned: resolves DNS once and pins the connection to that IP', async () => {
    mockDns([{ address: '93.184.216.34', family: 4 }]);
    transportResponses.push(new Response('ok', { status: 200 }));

    const res = await fetchPinned('https://example.com/path');
    expect(res.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.pinnedIp).toBe('93.184.216.34');
    expect(captured[0]!.hostname).toBe('example.com');
    expect(captured[0]!.headers['host']).toBe('example.com');
    expect(vi.mocked(dns.lookup)).toHaveBeenCalledTimes(1);
  });

  it('fetchPinned: rejects a literal private-IP host (no DNS call)', async () => {
    await expect(fetchPinned('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(/private IP/i);
    expect(vi.mocked(dns.lookup)).not.toHaveBeenCalled();
    expect(captured).toHaveLength(0);
  });

  it('fetchPinned: rejects a hostname that resolves to a private IP', async () => {
    mockDns([{ address: '10.0.0.5', family: 4 }]);
    await expect(fetchPinned('http://internal.example.test/')).rejects.toThrow(/private IP/i);
    expect(captured).toHaveLength(0);
  });

  it('fetchPinned: rejects a hostname that resolves to the IPv4-mapped-IPv6 hex form of a private IP', async () => {
    // ::ffff:7f00:1 == 127.0.0.1 — must be caught by the hex-decoding branch
    // of isPrivateIP, which used to be missing in the legacy http.ts/content-
    // extractor.ts copies.
    mockDns([{ address: '::ffff:7f00:1', family: 6 }]);
    await expect(fetchPinned('http://evil.example.test/')).rejects.toThrow(/private IP/i);
  });

  it('fetchPinned: blocks DNS-rebinding — pinned IP stays even if a second resolve would return a different IP', async () => {
    // 1st lookup: public 93.184.216.34 (validation passes)
    // 2nd lookup: 127.0.0.1 (the rebind — a re-resolving fetch() would
    //   connect here). Our pinned transport must receive the FIRST IP only.
    mockDnsSequence([
      [{ address: '93.184.216.34', family: 4 }],
      [{ address: '127.0.0.1', family: 4 }],
    ]);
    transportResponses.push(new Response('ok', { status: 200 }));

    const res = await fetchPinned('https://rebind.example.test/');
    expect(res.status).toBe(200);
    // The DNS-rebind defense: only ONE resolve happened, and the connection
    // was pinned to the result. A naive `validate → fetch()` flow would have
    // resolved twice and connected to 127.0.0.1.
    expect(vi.mocked(dns.lookup)).toHaveBeenCalledTimes(1);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.pinnedIp).toBe('93.184.216.34');
    expect(captured[0]!.pinnedIp).not.toBe('127.0.0.1');
  });

  it('fetchWithPublicRedirects: rejects an initial private-IP target before any transport call', async () => {
    await expect(
      fetchWithPublicRedirects('http://169.254.169.254/latest/meta-data/'),
    ).rejects.toThrow(/private IP/i);
    expect(captured).toHaveLength(0);
  });

  it('fetchWithPublicRedirects: rejects a redirect to a private IP', async () => {
    mockDns([{ address: '93.184.216.34', family: 4 }]);
    transportResponses.push(
      new Response(null, { status: 302, headers: { location: 'http://10.0.0.1/internal' } }),
    );
    await expect(
      fetchWithPublicRedirects('https://api.fake.test/start'),
    ).rejects.toThrow(/private IP/i);
  });

  it('fetchWithPublicRedirects: returns the final response after a public→public redirect, pinning each hop', async () => {
    mockDns([{ address: '93.184.216.34', family: 4 }]);
    transportResponses.push(
      new Response(null, { status: 302, headers: { location: 'https://api2.fake.test/final' } }),
      new Response('ok', { status: 200 }),
    );

    const res = await fetchWithPublicRedirects('https://api1.fake.test/start');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
    expect(captured).toHaveLength(2);
    // Each hop is re-resolved + re-pinned (so a redirect to a host with a
    // private record is caught by the validation, not allowed to slip in).
    expect(captured[0]!.hostname).toBe('api1.fake.test');
    expect(captured[1]!.hostname).toBe('api2.fake.test');
  });

  it('fetchWithPublicRedirects: honours maxRedirects override', async () => {
    mockDns([{ address: '93.184.216.34', family: 4 }]);
    // Queue 3 redirect responses — but maxRedirects=1 should bail out after 1.
    for (let i = 0; i < 3; i++) {
      transportResponses.push(
        new Response(null, { status: 302, headers: { location: 'https://b.fake.test/' } }),
      );
    }
    await expect(
      fetchWithPublicRedirects('https://a.fake.test/', {}, { maxRedirects: 1 }),
    ).rejects.toThrow(/too many redirects/i);
  });
});

// Regression test for the 2026-05-23 staging bug where web_research action=read
// failed universally with `ERR_INVALID_IP_ADDRESS: Invalid IP address: undefined`
// on every URL. Root cause: pinnedAgent's lookup callback used the legacy
// 3-arg signature `cb(null, address, family)`, but Node 22's
// `net.Socket.connect` always calls the lookup with `{ all: true }` and then
// iterates the 2nd callback argument as an addresses array. Passing a plain
// string made it walk the string char-by-char, pulling `undefined` for
// `record.address` and throwing the cryptic error above on connect.
//
// Tests above ALL stub the transport, so the real pinnedAgent + node:http
// path is never exercised. This test deliberately uses the DEFAULT transport
// against an in-process HTTP server to catch any future regression in the
// lookup-callback shape.
// Drive the REAL defaultTransport (not the test stub) end-to-end against a
// loopback HTTP server. This is the path that broke on staging — the stub
// transport tests above bypass pinnedAgent.lookup entirely and so could not
// have caught the Node 22 callback-shape regression.
//
// The staging-fail symptom: every fetchPinned() threw
//   `ERR_INVALID_IP_ADDRESS: Invalid IP address: undefined`
// because Node 22's net.Socket.connect always calls the Agent.lookup with
// `{ all: true }` and the old code returned `cb(null, pinnedIp, family)` —
// Node then treated the string as the `addresses` array and iterated its
// chars, surfacing `undefined` records.
// Direct unit-test of pinnedAgent's lookup callback shape. This is the path
// that broke on staging 2026-05-23 — every fetchPinned() call threw
//   `ERR_INVALID_IP_ADDRESS: Invalid IP address: undefined`
// because the lookup callback used the legacy 3-arg signature
//   `cb(null, address, family)`
// but Node 22's net.Socket.connect always invokes the lookup with
// `{ all: true }` and then iterates the 2nd callback arg as an addresses
// array. With a plain string the iteration produces `undefined` records,
// triggering the error before connect even runs.
//
// The stub-transport tests above bypass pinnedAgent entirely, so they
// could not have caught this. The seam (__pinnedAgentForTests) exists to
// let us assert the lookup-callback shape directly without spinning up a
// real socket — node:net's internal call-shape is the contract we lock in.
describe('pinnedAgent.lookup callback shape (Node 22 staging-fail regression)', () => {
  it('emits an addresses array when called with { all: true } (the shape Node 22 connect uses)', async () => {
    const agent = __pinnedAgentForTests('https:', '93.184.216.34', 4);
    // node:http.Agent stores the lookup we passed at construction time.
    const lookup = (agent as unknown as { options: { lookup: unknown } }).options.lookup as (
      hostname: string,
      options: { all?: boolean | undefined } | undefined,
      cb: (err: NodeJS.ErrnoException | null, ...rest: unknown[]) => void,
    ) => void;
    expect(typeof lookup).toBe('function');

    const received: unknown[] = await new Promise((resolve) => {
      lookup('example.com', { all: true }, (_err, ...rest) => resolve(rest));
    });
    // { all: true } → callback gets ONE addresses-array arg.
    expect(received).toHaveLength(1);
    expect(Array.isArray(received[0])).toBe(true);
    const records = received[0] as Array<{ address: string; family: number }>;
    expect(records).toHaveLength(1);
    expect(records[0]!.address).toBe('93.184.216.34');
    expect(records[0]!.family).toBe(4);
    agent.destroy();
  });

  it('emits (address, family) when called with { all: false } (legacy single-result signature, still supported by Node)', async () => {
    const agent = __pinnedAgentForTests('http:', '93.184.216.34', 4);
    const lookup = (agent as unknown as { options: { lookup: unknown } }).options.lookup as (
      hostname: string,
      options: { all?: boolean | undefined } | undefined,
      cb: (err: NodeJS.ErrnoException | null, ...rest: unknown[]) => void,
    ) => void;
    const received: unknown[] = await new Promise((resolve) => {
      lookup('example.com', { all: false }, (_err, ...rest) => resolve(rest));
    });
    // { all: false } → callback gets (address, family) — two args.
    expect(received).toHaveLength(2);
    expect(received[0]).toBe('93.184.216.34');
    expect(received[1]).toBe(4);
    agent.destroy();
  });

  it('does not crash net.Socket.connect with ERR_INVALID_IP_ADDRESS (replays the staging-fail scenario)', async () => {
    // Replay the exact code path that broke staging: build the agent and
    // launch an http.request via it. We can't reach a real public host in
    // CI, so we settle for asserting that whatever error surfaces is NOT
    // the synchronous lookup-shape bug. The buggy lookup threw
    // ERR_INVALID_IP_ADDRESS *before* the network round-trip, so any other
    // error (ECONNREFUSED / ETIMEDOUT / socket hang up) proves the fix.
    const http = await import('node:http');
    const agent = __pinnedAgentForTests('http:', '127.0.0.1', 4);
    const err: NodeJS.ErrnoException | undefined = await new Promise((resolve) => {
      // Point at a definitely-closed port on loopback so the connect fails
      // FAST. The lookup will say 127.0.0.1, the connect will try 127.0.0.1:1
      // and reject with ECONNREFUSED — proving the lookup path succeeded.
      const req = http.request(
        { hostname: 'example.com', port: 1, agent, method: 'HEAD', path: '/', timeout: 2000 },
        () => resolve(undefined),
      );
      req.on('error', (e: NodeJS.ErrnoException) => resolve(e));
      req.on('timeout', () => { req.destroy(); resolve(undefined); });
      req.end();
    });
    agent.destroy();
    if (err) {
      expect(err.code).not.toBe('ERR_INVALID_IP_ADDRESS');
      expect(err.message).not.toMatch(/Invalid IP address/);
    }
  });
});

describe('resolveAndValidate defense-in-depth', () => {
  beforeEach(() => {
    vi.mocked(dns.lookup).mockReset();
  });

  it('throws a clear "Blocked: ..." error if DNS returns a record with an empty address (rather than feeding undefined into the connect path)', async () => {
    // Production should never see this — dns.lookup always sets address — but
    // we used to silently propagate this all the way to net.Socket.connect,
    // which threw `ERR_INVALID_IP_ADDRESS: Invalid IP address: undefined` (the
    // exact symptom of the staging bug). Make sure we now fail closed with a
    // message an operator can act on.
    mockDns([{ address: '' as unknown as string, family: 4 }]);
    await expect(fetchPinned('https://example.test/')).rejects.toThrow(/Blocked: DNS returned a record without an address/);
  });
});
