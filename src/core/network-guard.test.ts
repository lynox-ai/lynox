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
  redirectHopHeaders,
  isCrossOriginHop,
  assertHostPolicy,
  __pinnedAgentForTests,
} from './network-guard.js';
import type { PinnedTransportInput, HostPolicyContext } from './network-guard.js';
import type { NetworkPolicy } from '../types/index.js';

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
      // Non-canonical representations of loopback must ALSO be rejected — an
      // exact-string `=== '::1'` check let these reach loopback (SSRF).
      ['0::1', true],
      ['0:0:0:0:0:0:0:1', true],
      ['0000:0000:0000:0000:0000:0000:0000:0001', true],
      ['0:0::1', true],
      ['0000::', true],                       // non-canonical unspecified
      ['fe80:0:0:0:0:0:0:1', true],           // expanded link-local
      ['fd00:0:0:0:0:0:0:34', true],          // expanded unique-local
      // Public IPv6 in various forms stays allowed (no over-block).
      ['2001:4860:4860:0:0:0:0:8888', false],
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

  it('fetchWithPublicRedirects: drops Authorization/Cookie on a CROSS-origin redirect (mirror fetch)', async () => {
    mockDns([{ address: '93.184.216.34', family: 4 }]);
    transportResponses.push(
      new Response(null, { status: 302, headers: { location: 'https://api2.fake.test/final' } }),
      new Response('ok', { status: 200 }),
    );

    const res = await fetchWithPublicRedirects('https://api1.fake.test/start', {
      headers: { Authorization: 'Bearer secret-token', Cookie: 'sid=abc', 'X-Keep': 'yes' },
    });
    expect(res.status).toBe(200);
    expect(captured).toHaveLength(2);
    // First hop (same origin as the request) carries the credentials.
    const hop0 = Object.fromEntries(Object.entries(captured[0]!.headers).map(([k, v]) => [k.toLowerCase(), v]));
    expect(hop0['authorization']).toBe('Bearer secret-token');
    expect(hop0['cookie']).toBe('sid=abc');
    // Second hop crossed origin (api1 → api2): credentials stripped, others kept.
    const hop1 = Object.fromEntries(Object.entries(captured[1]!.headers).map(([k, v]) => [k.toLowerCase(), v]));
    expect(hop1['authorization']).toBeUndefined();
    expect(hop1['cookie']).toBeUndefined();
    expect(hop1['x-keep']).toBe('yes');
  });

  it('fetchWithPublicRedirects: KEEPS Authorization on a SAME-origin redirect', async () => {
    mockDns([{ address: '93.184.216.34', family: 4 }]);
    transportResponses.push(
      new Response(null, { status: 302, headers: { location: 'https://api1.fake.test/final' } }),
      new Response('ok', { status: 200 }),
    );

    const res = await fetchWithPublicRedirects('https://api1.fake.test/start', {
      headers: { Authorization: 'Bearer secret-token' },
    });
    expect(res.status).toBe(200);
    expect(captured).toHaveLength(2);
    const hop1 = Object.fromEntries(Object.entries(captured[1]!.headers).map(([k, v]) => [k.toLowerCase(), v]));
    // Same origin (api1/start → api1/final) → Authorization is retained.
    expect(hop1['authorization']).toBe('Bearer secret-token');
  });

  it('fetchWithPublicRedirects: drops the BODY + downgrades to GET on a CROSS-origin 307 (a 307 preserves the body)', async () => {
    mockDns([{ address: '93.184.216.34', family: 4 }]);
    transportResponses.push(
      // 307 keeps method+body; the hop crosses origin (api1 → api2).
      new Response(null, { status: 307, headers: { location: 'https://api2.fake.test/token' } }),
      new Response('ok', { status: 200 }),
    );

    const res = await fetchWithPublicRedirects('https://api1.fake.test/token', {
      method: 'POST',
      body: 'client_id=x&client_secret=super-secret',
    });
    expect(res.status).toBe(200);
    expect(captured).toHaveLength(2);
    // First hop (same origin) carries the secret body as POST.
    expect(captured[0]!.method).toBe('POST');
    expect(captured[0]!.body?.toString()).toContain('client_secret=super-secret');
    // Second hop crossed origin: body dropped, method degraded to GET — the
    // secret is NOT replayed to api2.
    expect(captured[1]!.method).toBe('GET');
    expect(captured[1]!.body).toBeUndefined();
  });

  it('fetchWithPublicRedirects: KEEPS the BODY on a SAME-origin 307', async () => {
    mockDns([{ address: '93.184.216.34', family: 4 }]);
    transportResponses.push(
      new Response(null, { status: 307, headers: { location: 'https://api1.fake.test/token-2' } }),
      new Response('ok', { status: 200 }),
    );

    const res = await fetchWithPublicRedirects('https://api1.fake.test/token', {
      method: 'POST',
      body: 'client_secret=super-secret',
    });
    expect(res.status).toBe(200);
    expect(captured).toHaveLength(2);
    // Same origin (api1 → api1) → the 307 legitimately replays the POST body.
    expect(captured[1]!.method).toBe('POST');
    expect(captured[1]!.body?.toString()).toContain('client_secret=super-secret');
  });

  it('fetchWithPublicRedirects: drops the BODY + downgrades to GET on a CROSS-origin 308 (308 also preserves the body)', async () => {
    mockDns([{ address: '93.184.216.34', family: 4 }]);
    transportResponses.push(
      new Response(null, { status: 308, headers: { location: 'https://api2.fake.test/token' } }),
      new Response('ok', { status: 200 }),
    );

    const res = await fetchWithPublicRedirects('https://api1.fake.test/token', {
      method: 'POST',
      body: 'client_secret=super-secret',
    });
    expect(res.status).toBe(200);
    expect(captured).toHaveLength(2);
    // 308 (like 307) keeps method+body; the cross-origin hop must still drop both.
    expect(captured[1]!.method).toBe('GET');
    expect(captured[1]!.body).toBeUndefined();
  });
});

describe('isCrossOriginHop', () => {
  it('is false for a same-origin hop (path change only)', () => {
    expect(isCrossOriginHop('https://h.test/a', 'https://h.test/b')).toBe(false);
  });
  it('is true when host, port, or scheme changes', () => {
    expect(isCrossOriginHop('https://h.test/', 'https://other.test/')).toBe(true);
    expect(isCrossOriginHop('https://h.test/', 'https://h.test:8443/')).toBe(true);
    expect(isCrossOriginHop('https://h.test/', 'http://h.test/')).toBe(true);
  });
  it('fails closed (cross-origin) on an unparseable URL', () => {
    expect(isCrossOriginHop('not a url', 'https://h.test/')).toBe(true);
  });
});

describe('redirectHopHeaders', () => {
  it('keeps all headers on a same-origin hop', () => {
    const h = { Authorization: 'Bearer x', Cookie: 'a=b', 'X-Other': 'y' };
    expect(redirectHopHeaders(h, 'https://h.test/a', 'https://h.test/b')).toEqual(h);
  });

  it('drops all credential headers (case-insensitive) on a cross-origin hop', () => {
    const out = redirectHopHeaders(
      {
        authorization: 'Bearer x', COOKIE: 'a=b', 'Proxy-Authorization': 'z',
        'X-API-Key': 'k', 'x-auth-token': 't', 'X-Csrf-Token': 'c', 'X-Keep': 'y',
      },
      'https://h.test/a',
      'https://evil.test/b',
    );
    expect(out).toEqual({ 'X-Keep': 'y' });
  });

  it('treats a different port/scheme as cross-origin (strips)', () => {
    expect(redirectHopHeaders({ authorization: 'x' }, 'https://h.test/', 'https://h.test:8443/')).toEqual({});
    expect(redirectHopHeaders({ authorization: 'x' }, 'https://h.test/', 'http://h.test/')).toEqual({});
  });

  it('fails closed (strips) when a URL cannot be parsed', () => {
    expect(redirectHopHeaders({ authorization: 'x', 'X-Keep': 'y' }, 'not a url', 'https://h.test/')).toEqual({ 'X-Keep': 'y' });
  });
});

// Regression for the 2026-05-23 staging bug where web_research action=read
// failed universally with `ERR_INVALID_IP_ADDRESS: Invalid IP address:
// undefined` on every URL. pinnedAgent's lookup callback used the legacy
// 3-arg signature `cb(null, address, family)`, but Node 22's
// `net.Socket.connect` (via `lookupAndConnectMultiple`) always invokes
// lookup with `{ all: true }` and iterates the 2nd callback arg as an
// addresses array. With a plain string the iteration produces `undefined`
// records and throws before connect. The stub-transport tests above bypass
// pinnedAgent entirely, so they could not have caught this. The seam
// (__pinnedAgentForTests) exists to assert the lookup-callback shape
// directly without spinning up a socket — node:net's internal call-shape
// is the contract we lock in.
describe('pinnedAgent.lookup callback shape (Node 22 staging-fail regression)', () => {
  type LookupFn = (
    hostname: string,
    options: { all?: boolean | undefined } | undefined,
    cb: (err: NodeJS.ErrnoException | null, ...rest: unknown[]) => void,
  ) => void;
  // node:http.Agent stores the lookup we passed at construction time. Centralise
  // the unsafe cast so individual tests stay readable. `unknown` here avoids
  // pulling node:http / node:https types into the test file just for this.
  const getAgentLookup = (agent: unknown): LookupFn =>
    (agent as { options: { lookup: LookupFn } }).options.lookup;

  it('emits an addresses array when called with { all: true } (the shape Node 22 connect uses)', async () => {
    const agent = __pinnedAgentForTests('https:', '93.184.216.34', 4);
    const lookup = getAgentLookup(agent);
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
    const lookup = getAgentLookup(agent);
    const received: unknown[] = await new Promise((resolve) => {
      lookup('example.com', { all: false }, (_err, ...rest) => resolve(rest));
    });
    // { all: false } → callback gets (address, family) — two args.
    expect(received).toHaveLength(2);
    expect(received[0]).toBe('93.184.216.34');
    expect(received[1]).toBe(4);
    agent.destroy();
  });

  it('emits the legacy tuple when options/all are undefined (production callers omit options)', async () => {
    // Defense against a future "tighten this to require options.all explicitly"
    // refactor — Node's default-behaviour contract is `{ all: false }` when
    // the caller omits the option, and a fair number of legacy node:net call
    // sites rely on the tuple form.
    const agent = __pinnedAgentForTests('http:', '93.184.216.34', 4);
    const lookup = getAgentLookup(agent);
    const received: unknown[] = await new Promise((resolve) => {
      lookup('example.com', undefined, (_err, ...rest) => resolve(rest));
    });
    expect(received).toHaveLength(2);
    expect(received[0]).toBe('93.184.216.34');
    expect(received[1]).toBe(4);
    agent.destroy();
  });

  it('does not crash net.Socket.connect with ERR_INVALID_IP_ADDRESS (replays the staging-fail scenario)', async () => {
    // Replay the exact code path that broke staging: build the agent and
    // launch an http.request via it. The buggy lookup threw
    // ERR_INVALID_IP_ADDRESS *before* the network round-trip, so any other
    // error (ECONNREFUSED / EACCES / socket hang up) proves the fix.
    const http = await import('node:http');
    const agent = __pinnedAgentForTests('http:', '127.0.0.1', 4);
    const err: NodeJS.ErrnoException | undefined = await new Promise((resolve) => {
      // Port 65000 is unprivileged + almost certainly unbound, so the connect
      // fails fast without privilege-related EACCES masking the assertion.
      const req = http.request(
        { hostname: 'example.com', port: 65000, agent, method: 'HEAD', path: '/', timeout: 2000 },
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

describe('assertHostPolicy (network_policy SSOT)', () => {
  function policyCtx(overrides: Partial<HostPolicyContext> = {}): HostPolicyContext {
    return {
      networkPolicy: undefined,
      allowedHosts: undefined,
      allowedWildcards: [],
      enforceHttps: false,
      ...overrides,
    };
  }

  it('allow-all / unset lets any host through on either surface', () => {
    for (const ctx of [undefined, policyCtx({ networkPolicy: 'allow-all' })]) {
      expect(() => assertHostPolicy('https://anything.example.com', 'full-control', ctx)).not.toThrow();
      expect(() => assertHostPolicy('https://anything.example.com', 'discovery', ctx)).not.toThrow();
    }
  });

  it('deny-all blocks BOTH surfaces incl. discovery (air-gap, P4)', () => {
    const ctx = policyCtx({ networkPolicy: 'deny-all' });
    expect(() => assertHostPolicy('https://api.example.com', 'full-control', ctx)).toThrow(/air-gapped isolation/);
    // web_research (discovery) must NOT be a deny-all bypass.
    expect(() => assertHostPolicy('https://api.example.com', 'discovery', ctx)).toThrow(/air-gapped isolation/);
  });

  it('allow-list stays authoritative + uniform across surfaces', () => {
    const ctx = policyCtx({ networkPolicy: 'allow-list', allowedHosts: new Set(['api.example.com']) });
    expect(() => assertHostPolicy('https://api.example.com/v1', 'full-control', ctx)).not.toThrow();
    expect(() => assertHostPolicy('https://evil.com', 'full-control', ctx)).toThrow(/not in network allow-list/);
    // discovery is NOT auto-opened under allow-list (only guarded opens it).
    expect(() => assertHostPolicy('https://evil.com', 'discovery', ctx)).toThrow(/not in network allow-list/);
  });

  describe('guarded', () => {
    it('opens discovery to an off-baseline host (web_research read/search)', () => {
      const ctx = policyCtx({ networkPolicy: 'guarded' });
      expect(() => assertHostPolicy('https://some-random-blog.example', 'discovery', ctx)).not.toThrow();
    });

    it('blocks a full-control off-baseline host with no floor/ack', () => {
      const ctx = policyCtx({ networkPolicy: 'guarded' });
      expect(() => assertHostPolicy('https://attacker.example.org/v1', 'full-control', ctx))
        .toThrow(/not permitted under guarded egress policy/);
    });

    it('allows a baseline (vetted) host on full-control', () => {
      const ctx = policyCtx({ networkPolicy: 'guarded' });
      expect(() => assertHostPolicy('https://api.anthropic.com/v1/messages', 'full-control', ctx)).not.toThrow();
    });

    it('allows an operator-floor host on full-control (exact + wildcard)', () => {
      const exact = policyCtx({ networkPolicy: 'guarded', allowedHosts: new Set(['ops.example.com']) });
      expect(() => assertHostPolicy('https://ops.example.com/x', 'full-control', exact)).not.toThrow();
      const wild = policyCtx({ networkPolicy: 'guarded', allowedWildcards: ['example.com'] });
      expect(() => assertHostPolicy('https://sub.example.com', 'full-control', wild)).not.toThrow();
      expect(() => assertHostPolicy('https://example.com', 'full-control', wild)).not.toThrow();
    });

    it('allows a human-accepted profile egress host — incl. a token_url ≠ base_url (P7)', () => {
      const ctx = policyCtx({ networkPolicy: 'guarded' });
      // guardedAckHosts is the union across profiles; a token endpoint on a
      // different host than base_url is admitted iff it is in the accepted set.
      const ackHosts = new Set(['token.provider.net']);
      expect(() => assertHostPolicy('https://token.provider.net/oauth/token', 'full-control', ctx, ackHosts)).not.toThrow();
      // A host NOT in the accepted set is still blocked.
      expect(() => assertHostPolicy('https://api.provider.net/data', 'full-control', ctx, ackHosts))
        .toThrow(/not permitted under guarded egress policy/);
    });

    it('still enforces the private-IP early-out on the open discovery surface', () => {
      const ctx = policyCtx({ networkPolicy: 'guarded' });
      expect(() => assertHostPolicy('http://10.0.0.1/', 'discovery', ctx)).toThrow(/private IP/);
    });

    it('still enforces enforce_https on full-control', () => {
      const ctx = policyCtx({ networkPolicy: 'guarded', enforceHttps: true });
      expect(() => assertHostPolicy('http://api.anthropic.com/x', 'full-control', ctx)).toThrow(/enforce_https/);
    });
  });

  it('fails CLOSED on an unrecognised policy value (version skew / malformed)', () => {
    const ctx = policyCtx({ networkPolicy: 'bogus' as unknown as NetworkPolicy });
    expect(() => assertHostPolicy('https://api.example.com', 'full-control', ctx))
      .toThrow(/unrecognised egress policy/);
    expect(() => assertHostPolicy('https://api.example.com', 'discovery', ctx))
      .toThrow(/unrecognised egress policy/);
  });

  it('rejects a non-http(s) protocol regardless of policy', () => {
    expect(() => assertHostPolicy('ftp://api.example.com', 'full-control', policyCtx({ networkPolicy: 'guarded' })))
      .toThrow(/unsupported protocol/);
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
