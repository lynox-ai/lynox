import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node:dns/promises', () => ({
  default: {
    lookup: vi.fn(),
  },
}));

import dns from 'node:dns/promises';
import { httpRequestTool, detectSecretInContent } from './http.js';
import { applyHttpRateLimits, createToolContext, applyNetworkPolicy } from '../../core/tool-context.js';
import type { ToolCallCountProvider, ToolContext } from '../../core/tool-context.js';
import type { LynoxUserConfig, SessionCounters } from '../../types/index.js';
import type { CapabilityContract } from '../../types/capability-contract.js';
import { setPinnedTransportForTests } from '../../core/network-guard.js';
import type { PinnedTransportInput } from '../../core/network-guard.js';

// fetchPinned replaces the legacy `fetch(currentUrl, init)` call in
// fetchWithValidatedRedirects. The pinned transport is the seam: tests stub
// globalThis.fetch as before; this transport adapts the pinned-input back
// onto the stubbed fetch, and additionally exposes `lastPinnedInputs` so a
// regression test can assert the IP-pinning happened.
const lastPinnedInputs: PinnedTransportInput[] = [];
let restorePinnedTransport: (() => void) | undefined;

const handler = httpRequestTool.handler;

// Each test gets a fresh ToolContext + a fresh SessionCounters object via
// beforeEach. The handler reads network policy / rate-limits from
// `agent.toolContext` and the per-session http counter from
// `agent.sessionCounters`. Both flow into the agent stub via `makeAgent()`.
const TEST_USER_CONFIG = {} as LynoxUserConfig;
let testCtx: ToolContext;
let testCounters: SessionCounters;

function makeAgent(extras: { promptUser?: ReturnType<typeof vi.fn>; capabilityContract?: CapabilityContract } = {}): never {
  return {
    promptUser: extras.promptUser,
    capabilityContract: extras.capabilityContract,
    toolContext: testCtx,
    sessionCounters: testCounters,
  } as never;
}

/** Mock agent with auto-approve promptUser for write method tests */
function agentWithPromptFn(): never {
  return makeAgent({ promptUser: vi.fn().mockResolvedValue('Allow') });
}

function mockDnsPublic(): void {
  vi.mocked(dns.lookup).mockResolvedValue(
    [{ address: '1.2.3.4', family: 4 }] as unknown as Awaited<ReturnType<typeof dns.lookup>>,
  );
}

function mockDnsPrivate(ip: string): void {
  vi.mocked(dns.lookup).mockResolvedValue(
    [{ address: ip, family: 4 }] as unknown as Awaited<ReturnType<typeof dns.lookup>>,
  );
}

function mockDnsIpv6Private(ip: string): void {
  vi.mocked(dns.lookup).mockResolvedValue(
    [{ address: ip, family: 6 }] as unknown as Awaited<ReturnType<typeof dns.lookup>>,
  );
}

function createMockResponse(options: {
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: string;
  json?: unknown;
}): Response {
  const {
    status = 200,
    statusText = 'OK',
    headers = {},
    body,
    json,
  } = options;

  const contentType = headers['content-type'] ?? (json ? 'application/json' : 'text/plain');
  const allHeaders = { ...headers, 'content-type': contentType };
  const responseBody = json !== undefined ? JSON.stringify(json) : body ?? '';
  return new Response(status === 204 ? null : responseBody, {
    status,
    statusText,
    headers: allHeaders,
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  // dns.lookup is a vi.fn() created at module-eval; restoreAllMocks does
  // NOT reset its queued mockResolvedValueOnce values. Reset it explicitly
  // AND re-install a sane public default so tests that don't call
  // mockDnsPublic() still see a public-IP resolution (matches the pre-T1-4
  // implicit inheritance behaviour that the existing test suite relies on).
  vi.mocked(dns.lookup).mockReset();
  vi.mocked(dns.lookup).mockResolvedValue(
    [{ address: '1.2.3.4', family: 4 }] as unknown as Awaited<ReturnType<typeof dns.lookup>>,
  );
  testCtx = createToolContext(TEST_USER_CONFIG);
  testCounters = {
    httpRequests: 0,
    writeBytes: 0,
    approvedOutboundDomains: new Set<string>(),
    pendingOutboundPrompts: new Map<string, Promise<boolean>>(),
  };
  lastPinnedInputs.length = 0;
  // Install the test transport: capture the pinned input + delegate to
  // whatever globalThis.fetch currently is (which existing tests stub via
  // vi.stubGlobal). This preserves the test contract — we still get to
  // assert via the fetch stub — AND verifies the pinning code path ran.
  restorePinnedTransport = setPinnedTransportForTests(async (input) => {
    lastPinnedInputs.push(input);
    // Reconstruct an init that matches the original fetch() shape callers used.
    // The pinned transport receives:
    //   - headers WITH an auto-added `host` entry (strip before delegating, the
    //     legacy fetch path didn't expose it)
    //   - body as Buffer (decode back to string — handler input was a string)
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(input.headers)) {
      if (k.toLowerCase() === 'host') continue;
      headers[k] = v;
    }
    const init: RequestInit = {
      method: input.method,
      headers,
    };
    if (input.body !== undefined) {
      init.body = input.body.toString('utf8');
    }
    if (input.signal) init.signal = input.signal;
    // Delegate to fetch — the stubbed mock returns the prepared Response.
    return (globalThis.fetch as typeof fetch)(input.url, init);
  });
});

afterEach(() => {
  restorePinnedTransport?.();
  restorePinnedTransport = undefined;
});

describe('httpRequestTool', () => {
  describe('SSRF Protection', () => {
    it('blocks ftp:// protocol', async () => {
      await expect(handler({ url: 'ftp://example.com' }, makeAgent()))
        .rejects.toThrow('Only HTTP and HTTPS');
    });

    it('blocks file:// protocol', async () => {
      await expect(handler({ url: 'file:///etc/passwd' }, makeAgent()))
        .rejects.toThrow('Only HTTP and HTTPS');
    });

    it('blocks direct private IP 127.0.0.1', async () => {
      await expect(handler({ url: 'http://127.0.0.1' }, makeAgent()))
        .rejects.toThrow('internal network');
    });

    it('blocks direct private IP 10.0.0.1', async () => {
      await expect(handler({ url: 'http://10.0.0.1' }, makeAgent()))
        .rejects.toThrow('internal network');
    });

    it('blocks direct private IP 172.16.0.1', async () => {
      await expect(handler({ url: 'http://172.16.0.1' }, makeAgent()))
        .rejects.toThrow('internal network');
    });

    it('blocks direct private IP 192.168.1.1', async () => {
      await expect(handler({ url: 'http://192.168.1.1' }, makeAgent()))
        .rejects.toThrow('internal network');
    });

    it('blocks direct private IP 169.254.1.1', async () => {
      await expect(handler({ url: 'http://169.254.1.1' }, makeAgent()))
        .rejects.toThrow('internal network');
    });

    it('blocks direct private IP 0.0.0.0', async () => {
      await expect(handler({ url: 'http://0.0.0.0' }, makeAgent()))
        .rejects.toThrow('internal network');
    });

    it('blocks IPv6 loopback [::1]', async () => {
      await expect(handler({ url: 'http://[::1]' }, makeAgent()))
        .rejects.toThrow('internal network');
    });

    it('blocks IPv6 link-local [fe80::1]', async () => {
      await expect(handler({ url: 'http://[fe80::1]' }, makeAgent()))
        .rejects.toThrow('internal network');
    });

    it('blocks IPv4-mapped IPv6 that resolves to 127.0.0.1', async () => {
      mockDnsIpv6Private('::ffff:127.0.0.1');
      await expect(handler({ url: 'http://evil.com' }, makeAgent()))
        .rejects.toThrow('internal network');
    });

    it('blocks DNS-resolved private IP (127.0.0.1)', async () => {
      mockDnsPrivate('127.0.0.1');
      await expect(handler({ url: 'http://evil.com' }, makeAgent()))
        .rejects.toThrow('internal network');
    });

    it('blocks DNS-resolved private IP (10.0.0.1)', async () => {
      mockDnsPrivate('10.0.0.1');
      await expect(handler({ url: 'http://evil.com' }, makeAgent()))
        .rejects.toThrow('internal network');
    });

    it('blocks DNS-resolved private IP (192.168.1.100)', async () => {
      mockDnsPrivate('192.168.1.100');
      await expect(handler({ url: 'http://evil.com' }, makeAgent()))
        .rejects.toThrow('internal network');
    });

    it('blocks DNS-resolved IPv4-mapped-IPv6 hex form (::ffff:7f00:1 == 127.0.0.1)', async () => {
      // Pre-T1-4: the local isPrivateIP only stripped the dotted form, so the
      // hex form passed validation. With the canonical isPrivateIP from
      // network-guard, the hex form decodes to 127.0.0.1 and is rejected.
      mockDnsIpv6Private('::ffff:7f00:1');
      await expect(handler({ url: 'http://hex-evil.example.test' }, makeAgent()))
        .rejects.toThrow('internal network');
    });

    it('blocks DNS-resolved IPv4-mapped-IPv6 hex form for cloud metadata (::ffff:a9fe:a9fe == 169.254.169.254)', async () => {
      mockDnsIpv6Private('::ffff:a9fe:a9fe');
      await expect(handler({ url: 'http://meta.example.test' }, makeAgent()))
        .rejects.toThrow('internal network');
    });

    // T1-4 rebind regression: validate-then-fetch flow allowed a re-resolved
    // address to slip through. fetchPinned closes the window: resolve DNS
    // ONCE, validate it, pin the connection to that IP. The test transport
    // (installed in beforeEach) captures the pinned IP so we can assert the
    // pinning happened and no second DNS lookup leaked through.
    it('rebind defense: pins to first-resolved (public) IP even if a 2nd resolve would return loopback', async () => {
      vi.mocked(dns.lookup).mockReset();
      vi.mocked(dns.lookup)
        .mockResolvedValueOnce(
          [{ address: '93.184.216.34', family: 4 }] as unknown as Awaited<ReturnType<typeof dns.lookup>>,
        )
        .mockResolvedValueOnce(
          [{ address: '127.0.0.1', family: 4 }] as unknown as Awaited<ReturnType<typeof dns.lookup>>,
        );
      const mockResp = createMockResponse({ body: 'ok' });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResp));

      await handler({ url: 'http://rebind.example.test' }, makeAgent());

      // Only the first DNS resolve happened — no rebind window.
      expect(vi.mocked(dns.lookup)).toHaveBeenCalledTimes(1);
      expect(lastPinnedInputs).toHaveLength(1);
      expect(lastPinnedInputs[0]!.pinnedIp).toBe('93.184.216.34');
      expect(lastPinnedInputs[0]!.pinnedIp).not.toBe('127.0.0.1');
    });
  });

  describe('Successful requests', () => {
    it('GET request returns status + headers + body', async () => {
      mockDnsPublic();
      const mockResp = createMockResponse({
        status: 200,
        statusText: 'OK',
        body: 'Hello World',
      });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResp));

      const result = await handler({ url: 'http://example.com' }, makeAgent());
      expect(result).toContain('HTTP 200 OK');
      expect(result).toContain('Hello World');
    });

    it('POST request sends body', async () => {
      mockDnsPublic();
      const mockResp = createMockResponse({
        status: 201,
        statusText: 'Created',
        body: 'created',
      });
      const fetchMock = vi.fn().mockResolvedValue(mockResp);
      vi.stubGlobal('fetch', fetchMock);

      await handler({ url: 'http://example.com/api', method: 'POST', body: '{"key":"value"}' }, agentWithPromptFn());

      expect(fetchMock).toHaveBeenCalledWith('http://example.com/api', expect.objectContaining({
        method: 'POST',
        body: '{"key":"value"}',
      }));
    });

    // Slice B: the capability-contract is the headless write's consent — without
    // this the http tool's own first-use-consent gate blocks every unattended
    // POST (no promptUser), making the isDangerous grant inert end-to-end.
    describe('capability-contract consent', () => {
      const contract: CapabilityContract = {
        version: 7,
        grantedTools: ['http_request'],
        httpMethods: ['POST'],
        hostPatterns: ['example.com'],
        pathPatterns: ['/v1/*'],
        paramConstraints: {},
      };

      it('a contract-granted POST executes headless WITHOUT a user-consent prompt', async () => {
        mockDnsPublic();
        const fetchMock = vi.fn().mockResolvedValue(createMockResponse({ status: 200, body: 'ok' }));
        vi.stubGlobal('fetch', fetchMock);
        // makeAgent has NO promptUser (headless), but the contract grants this call.
        const res = await handler(
          { url: 'https://example.com/v1/report', method: 'POST', body: '{}' },
          makeAgent({ capabilityContract: contract }),
        );
        expect(res).not.toContain('requires user consent');
        expect(fetchMock).toHaveBeenCalled();
      });

      it('a POST outside the contract is still blocked headless (the grant is call-specific)', async () => {
        mockDnsPublic();
        const res = await handler(
          { url: 'https://evil.test/v1/report', method: 'POST', body: '{}' },
          makeAgent({ capabilityContract: contract }),
        );
        expect(res).toContain('requires user consent');
      });

      it('blocks a redirect that leaves the contract (no body smuggled past the host/path pin)', async () => {
        mockDnsPublic();
        // The granted host 307-redirects to another host → the redirect guard trips
        // and the handler throws (like every other "Blocked:" network error).
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
          createMockResponse({ status: 307, headers: { location: 'https://evil.test/collect' } }),
        ));
        await expect(handler(
          { url: 'https://example.com/v1/report', method: 'POST', body: '{"secret":"x"}' },
          makeAgent({ capabilityContract: contract }),
        )).rejects.toThrow(/capability-contract/);
      });
    });

    it('GET suppresses body even if provided', async () => {
      mockDnsPublic();
      const mockResp = createMockResponse({ body: 'ok' });
      const fetchMock = vi.fn().mockResolvedValue(mockResp);
      vi.stubGlobal('fetch', fetchMock);

      await handler({ url: 'http://example.com', method: 'GET', body: 'should-be-ignored' }, makeAgent());

      const callArgs = fetchMock.mock.calls[0]![1] as RequestInit;
      expect(callArgs.body).toBeUndefined();
    });

    it('HEAD suppresses body even if provided', async () => {
      mockDnsPublic();
      const mockResp = createMockResponse({ body: '' });
      const fetchMock = vi.fn().mockResolvedValue(mockResp);
      vi.stubGlobal('fetch', fetchMock);

      await handler({ url: 'http://example.com', method: 'HEAD', body: 'should-be-ignored' }, makeAgent());

      const callArgs = fetchMock.mock.calls[0]![1] as RequestInit;
      expect(callArgs.body).toBeUndefined();
    });

    it('JSON response is pretty-printed', async () => {
      mockDnsPublic();
      const mockResp = createMockResponse({
        json: { name: 'test', value: 42 },
      });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResp));

      const result = await handler({ url: 'http://example.com/api' }, makeAgent());
      expect(result).toContain('"name": "test"');
      expect(result).toContain('"value": 42');
    });

    it('text response is returned as-is', async () => {
      mockDnsPublic();
      const mockResp = createMockResponse({
        body: 'plain text content here',
      });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResp));

      const result = await handler({ url: 'http://example.com/page' }, makeAgent());
      expect(result).toContain('plain text content here');
    });

    it('truncates body over 100K characters', async () => {
      mockDnsPublic();
      const longBody = 'x'.repeat(150_000);
      const mockResp = createMockResponse({ body: longBody });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResp));

      const result = await handler({ url: 'http://example.com/big' }, makeAgent());
      expect(result).toContain('[truncated');
      expect(result).toContain('http_response_limit');
      expect(result).toMatch(/spawn_agent.*role='collector'/);
      expect(result.length).toBeLessThan(150_000);
    });

    it('safety-net caps a large UNSHAPED JSON response (no profile shape)', async () => {
      mockDnsPublic();
      // ~38KB compact (< 100KB http cap, so it is parsed not truncated), but
      // pretty-printed > 30KB → the generic safety-net cap fires.
      const big = { results: Array.from({ length: 400 }, (_, i) => ({ keyword: `keyword-${i}-` + 'x'.repeat(60), volume: 1000 + i })) };
      const mockResp = createMockResponse({ json: big });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResp));

      const result = await handler({ url: 'http://api.example.com/search' }, makeAgent());
      expect(result).toContain('auto-capped');
      expect(result).toMatch(/response_shape|spawn_agent/);
      expect(result).toContain('keyword-0-');           // first items kept
      expect(result).not.toContain('keyword-399-');      // array capped to 25 items
      expect(result.length).toBeLessThan(20_000);        // far below the ~90KB raw
    });

    it('shapes a >100KB JSON instead of byte-truncating it (parses past the raw limit)', async () => {
      mockDnsPublic();
      // ~140KB compact — exceeds the 100KB raw read cap. On main this gets
      // byte-truncated to invalid JSON before shaping; the JSON read ceiling now
      // lets it parse + shape down to a few KB.
      const huge = { results: Array.from({ length: 1500 }, (_, i) => ({ keyword: `keyword-${i}-` + 'x'.repeat(60), volume: 1000 + i })) };
      expect(JSON.stringify(huge).length).toBeGreaterThan(100_000); // would truncate on main
      const mockResp = createMockResponse({ json: huge });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResp));

      const result = await handler({ url: 'http://api.example.com/bulk' }, makeAgent());
      expect(result).toContain('auto-capped');        // shaped, not...
      expect(result).not.toContain('[truncated');     // ...byte-truncated
      expect(result).toContain('keyword-0-');
      expect(result).not.toContain('keyword-1499-');  // array capped to 25
      expect(result.length).toBeLessThan(30_000);
    });

    it('leaves a SMALL JSON response untouched (below the safety-net threshold)', async () => {
      mockDnsPublic();
      const mockResp = createMockResponse({ json: { name: 'small', items: [1, 2, 3] } });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResp));

      const result = await handler({ url: 'http://api.example.com/small' }, makeAgent());
      expect(result).toContain('"name": "small"');
      expect(result).toContain('"items"');
      expect(result).not.toContain('auto-capped');
    });

    it('drops CORS / transport noise headers but keeps payload headers', async () => {
      mockDnsPublic();
      const mockResp = createMockResponse({
        json: { ok: true },
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
          'cache-control': 'no-cache, must-revalidate',
          'server': 'nginx',
          'x-ratelimit-remaining': '99',
        },
      });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResp));

      const result = await handler({ url: 'http://api.example.com/data' }, makeAgent());
      expect(result).not.toContain('access-control-allow-origin');
      expect(result).not.toContain('access-control-allow-methods');
      expect(result).not.toContain('cache-control');
      expect(result).not.toContain('server: nginx');
      expect(result).toContain('x-ratelimit-remaining: 99'); // payload header kept
      expect(result).toContain('content-type');              // payload header kept
    });

    it('PUT method sends body', async () => {
      mockDnsPublic();
      const mockResp = createMockResponse({ body: 'updated' });
      const fetchMock = vi.fn().mockResolvedValue(mockResp);
      vi.stubGlobal('fetch', fetchMock);

      await handler({ url: 'http://example.com/resource', method: 'PUT', body: 'data' }, agentWithPromptFn());

      expect(fetchMock).toHaveBeenCalledWith('http://example.com/resource', expect.objectContaining({
        method: 'PUT',
        body: 'data',
      }));
    });

    it('DELETE method works', async () => {
      mockDnsPublic();
      const mockResp = createMockResponse({ status: 204, statusText: 'No Content', body: '' });
      const fetchMock = vi.fn().mockResolvedValue(mockResp);
      vi.stubGlobal('fetch', fetchMock);

      const result = await handler({ url: 'http://example.com/resource', method: 'DELETE' }, makeAgent());
      expect(result).toContain('HTTP 204 No Content');
      expect(fetchMock).toHaveBeenCalledWith('http://example.com/resource', expect.objectContaining({
        method: 'DELETE',
      }));
    });

    it('PATCH method sends body', async () => {
      mockDnsPublic();
      const mockResp = createMockResponse({ body: 'patched' });
      const fetchMock = vi.fn().mockResolvedValue(mockResp);
      vi.stubGlobal('fetch', fetchMock);

      await handler({ url: 'http://example.com/resource', method: 'PATCH', body: '{"field":"new"}' }, agentWithPromptFn());

      expect(fetchMock).toHaveBeenCalledWith('http://example.com/resource', expect.objectContaining({
        method: 'PATCH',
        body: '{"field":"new"}',
      }));
    });

    it('custom headers are forwarded', async () => {
      mockDnsPublic();
      const mockResp = createMockResponse({ body: 'ok' });
      const fetchMock = vi.fn().mockResolvedValue(mockResp);
      vi.stubGlobal('fetch', fetchMock);

      await handler({
        url: 'http://example.com',
        headers: { 'Authorization': 'Bearer token', 'X-Custom': 'value' },
      }, makeAgent());

      const callArgs = fetchMock.mock.calls[0]![1] as RequestInit;
      expect(callArgs.headers).toEqual({ 'Authorization': 'Bearer token', 'X-Custom': 'value' });
    });

    it('response headers are included in output', async () => {
      mockDnsPublic();
      const mockResp = createMockResponse({
        headers: { 'x-request-id': 'abc-123', 'content-type': 'text/plain' },
        body: 'ok',
      });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResp));

      const result = await handler({ url: 'http://example.com' }, makeAgent());
      expect(result).toContain('x-request-id: abc-123');
    });

    it('defaults to GET when method is omitted', async () => {
      mockDnsPublic();
      const mockResp = createMockResponse({ body: 'ok' });
      const fetchMock = vi.fn().mockResolvedValue(mockResp);
      vi.stubGlobal('fetch', fetchMock);

      await handler({ url: 'http://example.com' }, makeAgent());

      expect(fetchMock).toHaveBeenCalledWith('http://example.com', expect.objectContaining({
        method: 'GET',
      }));
    });
  });

  // fetchWithValidatedRedirects must NOT replay credential headers across a
  // cross-origin redirect (mirror fetch()). Uses an opaque token that does NOT
  // match SECRET_PATTERNS, so the pre-flight egress header scan lets it through
  // to the redirect loop — exactly the case the per-hop scan misses.
  describe('cross-origin redirect credential strip', () => {
    const lc = (h: Record<string, string>): Record<string, string> =>
      Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));

    it('drops Authorization on a CROSS-origin redirect, keeps non-cred headers', async () => {
      mockDnsPublic();
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(createMockResponse({ status: 302, headers: { location: 'https://other.test/final' } }))
        .mockResolvedValueOnce(createMockResponse({ body: 'ok' }));
      vi.stubGlobal('fetch', fetchMock);

      await handler({
        url: 'https://api.example.test/start',
        headers: { Authorization: 'Bearer opaque-session-xyz', 'X-Keep': 'v' },
      }, makeAgent());

      expect(lastPinnedInputs.length).toBe(2);
      // Hop 0 (same origin as the request) carries the credential.
      expect(lc(lastPinnedInputs[0]!.headers)['authorization']).toBe('Bearer opaque-session-xyz');
      // Hop 1 crossed origin (api.example.test → other.test): credential stripped, others kept.
      const hop1 = lc(lastPinnedInputs[1]!.headers);
      expect(hop1['authorization']).toBeUndefined();
      expect(hop1['x-keep']).toBe('v');
    });

    it('KEEPS Authorization across a SAME-origin redirect', async () => {
      mockDnsPublic();
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(createMockResponse({ status: 302, headers: { location: 'https://api.example.test/final' } }))
        .mockResolvedValueOnce(createMockResponse({ body: 'ok' }));
      vi.stubGlobal('fetch', fetchMock);

      await handler({
        url: 'https://api.example.test/start',
        headers: { Authorization: 'Bearer opaque-session-xyz' },
      }, makeAgent());

      expect(lastPinnedInputs.length).toBe(2);
      expect(lc(lastPinnedInputs[1]!.headers)['authorization']).toBe('Bearer opaque-session-xyz');
    });

    // A 307/308 preserves the method + body, so a cross-origin hop would replay
    // a secret-bearing body (e.g. an OAuth token-exchange POST) to the new origin
    // even after the header strip. The body must be dropped too.
    it('drops the request BODY + downgrades to GET on a CROSS-origin 307', async () => {
      mockDnsPublic();
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(createMockResponse({ status: 307, headers: { location: 'https://other.test/token' } }))
        .mockResolvedValueOnce(createMockResponse({ body: 'ok' }));
      vi.stubGlobal('fetch', fetchMock);

      await handler({
        url: 'https://api.example.test/token',
        method: 'POST',
        body: 'grant_type=client_credentials&field=opaque-value-xyz',
      }, agentWithPromptFn());

      expect(lastPinnedInputs.length).toBe(2);
      // Hop 0 (same origin) carries the POST body.
      expect(lastPinnedInputs[0]!.method).toBe('POST');
      expect(lastPinnedInputs[0]!.body?.toString()).toContain('field=opaque-value-xyz');
      // Hop 1 crossed origin (api.example.test → other.test): body dropped, GET.
      expect(lastPinnedInputs[1]!.method).toBe('GET');
      expect(lastPinnedInputs[1]!.body).toBeUndefined();
    });

    it('KEEPS the body on a SAME-origin 307', async () => {
      mockDnsPublic();
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(createMockResponse({ status: 307, headers: { location: 'https://api.example.test/token-2' } }))
        .mockResolvedValueOnce(createMockResponse({ body: 'ok' }));
      vi.stubGlobal('fetch', fetchMock);

      await handler({
        url: 'https://api.example.test/token',
        method: 'POST',
        body: 'grant_type=client_credentials',
      }, agentWithPromptFn());

      expect(lastPinnedInputs.length).toBe(2);
      // Same origin → the 307 legitimately replays the POST body.
      expect(lastPinnedInputs[1]!.method).toBe('POST');
      expect(lastPinnedInputs[1]!.body?.toString()).toContain('grant_type=client_credentials');
    });
  });

  describe('Session rate limit', () => {
    it('under limit passes', async () => {
      mockDnsPublic();
      const mockResp = createMockResponse({ body: 'ok' });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResp));

      const result = await handler({ url: 'http://example.com' }, makeAgent());
      expect(result).toContain('HTTP 200');
    });

    it('at limit returns error string', async () => {
      mockDnsPublic();
      const mockResp = createMockResponse({ body: 'ok' });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResp));

      // Make 100 successful requests (counter incremented on each fetch)
      for (let i = 0; i < 100; i++) {
        await handler({ url: 'http://example.com' }, makeAgent());
      }
      // Next should be blocked (counter is at 100, >= MAX)
      const result = await handler({ url: 'http://example.com' }, makeAgent());
      expect(result).toContain('Request limit reached');
    });

    it('fresh Session counter object → counter starts at 0', async () => {
      // Replaces the legacy resetHttpRequestCount-based test. Counter now
      // lives on `agent.sessionCounters` (sourced from the per-test
      // `testCounters` fixture), so "resetting" a session means assigning
      // a new counters object — which is what a new Session would do in
      // production.
      mockDnsPublic();
      const mockResp = createMockResponse({ body: 'ok' });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResp));

      for (let i = 0; i < 100; i++) {
        await handler({ url: 'http://example.com' }, makeAgent());
      }
      // Swap in a fresh counters object — Session-equivalent of "new session".
      testCounters = {
        httpRequests: 0,
        writeBytes: 0,
        approvedOutboundDomains: new Set<string>(),
        pendingOutboundPrompts: new Map<string, Promise<boolean>>(),
      };
      const result = await handler({ url: 'http://example.com' }, makeAgent());
      expect(result).toContain('HTTP 200');
    });
  });

  describe('persistent cross-session rate limiting', () => {
    function mockProvider(counts: Record<number, number>): ToolCallCountProvider {
      return {
        getToolCallCountSince(_toolName: string, hours: number) {
          return counts[hours] ?? 0;
        },
      };
    }

    beforeEach(() => {
      // testCtx already reset by outer beforeEach; rate limits start unset.
    });

    it('blocks when hourly limit exceeded', async () => {
      applyHttpRateLimits(testCtx, mockProvider({ 1: 50 }), 50);
      const result = await handler({ url: 'http://example.com' }, makeAgent());
      expect(result).toContain('Hourly request limit reached');
    });

    it('blocks when daily limit exceeded', async () => {
      applyHttpRateLimits(testCtx, mockProvider({ 24: 200 }), undefined, 200);
      const result = await handler({ url: 'http://example.com' }, makeAgent());
      expect(result).toContain('Daily request limit reached');
    });

    it('allows when under limits', async () => {
      mockDnsPublic();
      const mockResp = createMockResponse({ body: 'ok' });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResp));
      applyHttpRateLimits(testCtx, mockProvider({ 1: 5, 24: 10 }), 50, 200);
      const result = await handler({ url: 'http://example.com' }, makeAgent());
      expect(result).toContain('HTTP 200');
    });

    it('allows when no explicit limits configured and counts are within defaults', async () => {
      mockDnsPublic();
      const mockResp = createMockResponse({ body: 'ok' });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResp));
      applyHttpRateLimits(testCtx, mockProvider({ 1: 100 }));
      const result = await handler({ url: 'http://example.com' }, makeAgent());
      expect(result).toContain('HTTP 200');
    });

    it('fresh ToolContext has no rate limits set (unlimited)', async () => {
      // Replaces the legacy `resetHttpRateLimits clears config` test —
      // because rate limits live on the ToolContext, the equivalent assertion
      // is "a freshly-created ctx never blocks". The provider is wired but
      // the limits remain Infinity unless applyHttpRateLimits sets them.
      mockDnsPublic();
      const mockResp = createMockResponse({ body: 'ok' });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResp));
      // ctx has rateLimitProvider=null + hourly/daily=Infinity by default,
      // so even an "exceeded" count provider can't trigger a block.
      const result = await handler({ url: 'http://example.com' }, makeAgent());
      expect(result).toContain('HTTP 200');
    });
  });

  describe('egress control: secret detection', () => {
    it('detects Anthropic API key', () => {
      expect(detectSecretInContent('key: sk-ant-api03-abc123def456ghi789jkl012mno345')).toBe('Anthropic API key');
    });

    it('detects GitHub personal access token', () => {
      expect(detectSecretInContent('token=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij')).toBe('GitHub personal access token');
    });

    it('detects AWS access key', () => {
      expect(detectSecretInContent('aws_key=AKIAIOSFODNN7EXAMPLE')).toBe('AWS access key');
    });

    it('detects private key header', () => {
      expect(detectSecretInContent('-----BEGIN RSA PRIVATE KEY-----')).toBe('private key');
    });

    it('detects JWT token', () => {
      expect(detectSecretInContent('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U')).toBe('JWT token');
    });

    it('returns null for clean content', () => {
      expect(detectSecretInContent('Hello world, this is a normal message')).toBeNull();
    });
  });

  describe('egress control: request body secret blocking', () => {
    beforeEach(() => {
    });

    it('blocks POST with API key in body', async () => {
      mockDnsPublic();
      const result = await handler({
        url: 'http://example.com/api',
        method: 'POST',
        body: JSON.stringify({ key: 'sk-ant-api03-abc123def456ghi789jkl012mno345pqr678' }),
      }, agentWithPromptFn());
      expect(result).toContain('Blocked');
      expect(result).toContain('Anthropic API key');
    });

    it('blocks PUT with private key in body', async () => {
      mockDnsPublic();
      const result = await handler({
        url: 'http://example.com/upload',
        method: 'PUT',
        body: '-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqh...',
      }, agentWithPromptFn());
      expect(result).toContain('Blocked');
      expect(result).toContain('private key');
    });

    it('allows POST with clean body', async () => {
      mockDnsPublic();
      const mockResp = createMockResponse({ body: 'ok' });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResp));
      const result = await handler({
        url: 'http://example.com/api',
        method: 'POST',
        body: JSON.stringify({ message: 'hello world' }),
      }, agentWithPromptFn());
      expect(result).toContain('HTTP 200');
    });
  });

  // T2-S1: egress secret scan must run over request HEADER values too —
  // not just the body. An `Authorization: Bearer sk-ant-…` on a GET to a
  // third-party host hands the credential over just as plainly as
  // POSTing it in JSON.
  describe('egress control: request header secret blocking (T2-S1)', () => {
    it('blocks POST with Anthropic API key in Authorization header', async () => {
      mockDnsPublic();
      const result = await handler({
        url: 'http://example.com/api',
        method: 'POST',
        headers: { Authorization: 'Bearer sk-ant-api03-abc123def456ghi789jkl012mno345pqr678' },
        body: JSON.stringify({ msg: 'hi' }),
      }, agentWithPromptFn());
      expect(result).toContain('Blocked');
      expect(result).toContain('Authorization');
      expect(result).toContain('Anthropic API key');
    });

    it('blocks GET with GitHub PAT in custom header (read-method exfil)', async () => {
      mockDnsPublic();
      const result = await handler({
        url: 'http://example.com/api',
        headers: { 'X-Forward-Token': 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij' },
      }, makeAgent());
      expect(result).toContain('Blocked');
      expect(result).toContain('GitHub personal access token');
    });

    it('allows POST when headers + body are clean', async () => {
      mockDnsPublic();
      const mockResp = createMockResponse({ body: 'ok' });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResp));
      const result = await handler({
        url: 'http://example.com/api',
        method: 'POST',
        headers: { 'X-Trace-Id': 'abc-123', Accept: 'application/json' },
        body: JSON.stringify({ message: 'hello' }),
      }, agentWithPromptFn());
      expect(result).toContain('HTTP 200');
    });
  });

  describe('egress control: GET exfiltration detection', () => {
    beforeEach(() => {
    });

    it('blocks GET with very long query string (no promptUser)', async () => {
      mockDnsPublic();
      const longParam = 'a'.repeat(600);
      const result = await handler({
        url: `http://example.com/api?data=${longParam}`,
      }, makeAgent());
      expect(result).toContain('Blocked');
      expect(result).toContain('query string');
    });

    it('blocks GET with base64 blob in params (no promptUser)', async () => {
      mockDnsPublic();
      const b64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/==';
      const result = await handler({
        url: `http://example.com/api?data=${b64}`,
      }, makeAgent());
      expect(result).toContain('Blocked');
      expect(result).toContain('base64');
    });

    it('allows GET exfil when user approves', async () => {
      mockDnsPublic();
      const mockResp = createMockResponse({ body: 'ok' });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResp));
      const longParam = 'a'.repeat(600);
      const result = await handler({
        url: `http://example.com/api?data=${longParam}`,
      }, agentWithPromptFn());
      expect(result).toContain('HTTP 200');
    });

    it('allows normal GET with short query', async () => {
      mockDnsPublic();
      const mockResp = createMockResponse({ body: 'ok' });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResp));
      const result = await handler({
        url: 'http://example.com/api?q=search+term',
      }, makeAgent());
      expect(result).toContain('HTTP 200');
    });
  });

  describe('enforce_https', () => {
    // No afterEach reset needed — the outer beforeEach gives each test a
    // fresh ToolContext with enforceHttps=false.

    it('blocks http:// when enforce_https is enabled', async () => {
      testCtx.enforceHttps = true;
      mockDnsPublic();
      await expect(handler({ url: 'http://example.com' }, makeAgent()))
        .rejects.toThrow('HTTPS connections are allowed');
    });

    it('allows https:// when enforce_https is enabled', async () => {
      testCtx.enforceHttps = true;
      mockDnsPublic();
      const mockResp = createMockResponse({ body: 'ok' });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResp));
      const result = await handler({ url: 'https://example.com' }, makeAgent());
      expect(result).toContain('HTTP 200');
    });

    it('allows http://localhost when enforce_https is enabled', async () => {
      testCtx.enforceHttps = true;
      const mockResp = createMockResponse({ body: 'ok' });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResp));
      const result = await handler({ url: 'http://localhost:3000' }, makeAgent());
      expect(result).toContain('HTTP 200');
    });

    it('allows http:// when enforce_https is not enabled (default)', async () => {
      mockDnsPublic();
      const mockResp = createMockResponse({ body: 'ok' });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResp));
      const result = await handler({ url: 'http://example.com' }, makeAgent());
      expect(result).toContain('HTTP 200');
    });
  });

  describe('network policy', () => {
    // Fresh ToolContext per test (outer beforeEach) → networkPolicy=undefined
    // (= 'allow-all' behaviour). applyNetworkPolicy mirrors the engine-init wiring.

    it('allows any host by default (allow-all / unset)', async () => {
      mockDnsPublic();
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(createMockResponse({ body: 'ok' })));
      const result = await handler({ url: 'https://anything.example.com' }, makeAgent());
      expect(result).toContain('HTTP 200');
    });

    it('blocks every host under deny-all (air-gapped)', async () => {
      applyNetworkPolicy(testCtx, 'deny-all', undefined);
      mockDnsPublic();
      // deny-all → friendly-rewritten via the 'Blocked:'-prefixed message.
      await expect(handler({ url: 'https://api.example.com' }, makeAgent()))
        .rejects.toThrow('Network access is disabled in this security mode');
    });

    it('allows a listed host under allow-list', async () => {
      applyNetworkPolicy(testCtx, 'allow-list', ['api.example.com']);
      mockDnsPublic();
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(createMockResponse({ body: 'ok' })));
      const result = await handler({ url: 'https://api.example.com/v1' }, makeAgent());
      expect(result).toContain('HTTP 200');
    });

    it('blocks an unlisted host under allow-list', async () => {
      applyNetworkPolicy(testCtx, 'allow-list', ['api.example.com']);
      mockDnsPublic();
      await expect(handler({ url: 'https://evil.com' }, makeAgent()))
        .rejects.toThrow('not in the allowed list');
    });

    it('matches subdomains AND the apex under a *. wildcard', async () => {
      applyNetworkPolicy(testCtx, 'allow-list', ['*.example.com']);
      mockDnsPublic();
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(createMockResponse({ body: 'ok' })));
      expect(await handler({ url: 'https://sub.example.com' }, makeAgent())).toContain('HTTP 200');
      expect(await handler({ url: 'https://example.com' }, makeAgent())).toContain('HTTP 200');
    });

    it('does not let an api_setup-style host bypass the allow-list (authoritative)', async () => {
      // The allow-list is NOT auto-extended by configured API profiles — register
      // a profile for a host that is NOT on the list and confirm it stays blocked.
      const { ApiStore } = await import('../../core/api-store.js');
      const store = new ApiStore();
      store.register({
        id: 'evil',
        name: 'Evil',
        base_url: 'https://attacker.example.org/v1',
        description: 'profile for an off-list host',
      });
      testCtx.apiStore = store;
      applyNetworkPolicy(testCtx, 'allow-list', ['api.example.com']);
      mockDnsPublic();
      await expect(handler({ url: 'https://attacker.example.org/v1' }, makeAgent()))
        .rejects.toThrow('not in the allowed list');
    });
  });

  describe('Response shaping via API profile', () => {
    it('applies response_shape when the hostname has a profile', async () => {
      const { ApiStore } = await import('../../core/api-store.js');
      const store = new ApiStore();
      store.register({
        id: 'example',
        name: 'Example',
        base_url: 'https://api.example.com/v1',
        description: 'Test API',
        response_shape: {
          kind: 'reduce',
          include: ['items[].keyword', 'items[].search_volume'],
        },
      });

      mockDnsPublic();
      const mockResp = createMockResponse({
        headers: { 'content-type': 'application/json' },
        json: {
          items: [
            { keyword: 'alpha', search_volume: 100, cost: 1.5, noise: 'drop-me' },
            { keyword: 'beta', search_volume: 200, cost: 2.5, noise: 'drop-me' },
          ],
        },
      });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResp));

      const agent = { toolContext: { apiStore: store }, sessionCounters: testCounters } as never;
      const result = await handler({ url: 'https://api.example.com/v1/search' }, agent);

      expect(result).toContain('keyword');
      expect(result).toContain('alpha');
      expect(result).not.toContain('drop-me');
      expect(result).not.toContain('cost');
    });

    it('passthrough leaves the JSON body unchanged', async () => {
      const { ApiStore } = await import('../../core/api-store.js');
      const store = new ApiStore();
      store.register({
        id: 'example',
        name: 'Example',
        base_url: 'https://api.example.com/v1',
        description: 'Test API',
        response_shape: { kind: 'passthrough' },
      });

      mockDnsPublic();
      const mockResp = createMockResponse({
        headers: { 'content-type': 'application/json' },
        json: { foo: 'bar', baz: [1, 2, 3] },
      });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResp));

      const agent = { toolContext: { apiStore: store }, sessionCounters: testCounters } as never;
      const result = await handler({ url: 'https://api.example.com/v1/any' }, agent);

      expect(result).toContain('"foo": "bar"');
      expect(result).toContain('"baz"');
    });

    it('falls back to raw JSON when no profile is registered for the host', async () => {
      const { ApiStore } = await import('../../core/api-store.js');
      const store = new ApiStore();

      mockDnsPublic();
      const mockResp = createMockResponse({
        headers: { 'content-type': 'application/json' },
        json: { a: 1, b: 2 },
      });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResp));

      const agent = { toolContext: { apiStore: store }, sessionCounters: testCounters } as never;
      const result = await handler({ url: 'https://api.example.com/v1/x' }, agent);

      expect(result).toContain('"a": 1');
      expect(result).toContain('"b": 2');
    });
  });

  // Regression: parallel POSTs to the same (not-yet-approved) hostname used
  // to race on the outbound-consent prompt. The PromptStore enforces a unique
  // pending prompt per session, so only the first insertAskUser succeeded and
  // calls 2..N threw PromptConflictError. Real-world hit: a 5-way parallel
  // http_request batch against api.dataforseo.com (keyword-research run,
  // 2026-04-23) where 4 of 5 tool_uses came back as errors.
  describe('Parallel outbound-consent prompt', () => {
    it('shares one prompt across concurrent POSTs to the same hostname', async () => {
      mockDnsPublic();
      // Fresh Response per call — body streams can only be consumed once.
      const fetchMock = vi.fn().mockImplementation(
        () => Promise.resolve(createMockResponse({ json: { ok: true } })),
      );
      vi.stubGlobal('fetch', fetchMock);

      // promptUser resolves only after all three calls are in flight.
      // Deferred resolve lets us prove parallel calls await one shared promise.
      let resolvePrompt: (ans: string) => void = () => {};
      const promptUser = vi.fn<(q: string, opts?: string[]) => Promise<string>>(() =>
        new Promise<string>((res) => {
          resolvePrompt = res;
        }),
      );
      const agent = { promptUser, sessionCounters: testCounters } as never;

      const url = `https://api-parallel-consent-${Date.now()}.example.com/v1/x`;
      const results = Promise.all([
        handler({ url, method: 'POST', body: '{"a":1}' }, agent),
        handler({ url, method: 'POST', body: '{"b":2}' }, agent),
        handler({ url, method: 'POST', body: '{"c":3}' }, agent),
      ]);

      // Give the concurrent handlers a tick to all subscribe before we approve.
      await new Promise((r) => setTimeout(r, 5));
      resolvePrompt('Allow');

      const [r1, r2, r3] = await results;
      expect(r1).toContain('HTTP 200');
      expect(r2).toContain('HTTP 200');
      expect(r3).toContain('HTTP 200');
      // Only ONE prompt despite three calls.
      expect(promptUser).toHaveBeenCalledTimes(1);
      // All three requests fired.
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('denies all concurrent callers if the shared prompt is denied', async () => {
      mockDnsPublic();
      const fetchMock = vi.fn().mockImplementation(
        () => Promise.resolve(createMockResponse({ json: { ok: true } })),
      );
      vi.stubGlobal('fetch', fetchMock);

      let resolvePrompt: (ans: string) => void = () => {};
      const promptUser = vi.fn<(q: string, opts?: string[]) => Promise<string>>(() =>
        new Promise<string>((res) => { resolvePrompt = res; }),
      );
      const agent = { promptUser, sessionCounters: testCounters } as never;

      const url = `https://api-parallel-deny-${Date.now()}.example.com/v1/x`;
      const results = Promise.all([
        handler({ url, method: 'POST', body: '{}' }, agent),
        handler({ url, method: 'POST', body: '{}' }, agent),
      ]);

      await new Promise((r) => setTimeout(r, 5));
      resolvePrompt('Deny');

      const [r1, r2] = await results;
      expect(r1).toContain('denied by user');
      expect(r2).toContain('denied by user');
      expect(promptUser).toHaveBeenCalledTimes(1);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('re-prompts after a denial (no stale approval in the pending map)', async () => {
      mockDnsPublic();
      vi.stubGlobal('fetch', vi.fn().mockImplementation(
        () => Promise.resolve(createMockResponse({ json: { ok: true } })),
      ));

      const promptUser = vi.fn<(q: string, opts?: string[]) => Promise<string>>()
        .mockResolvedValueOnce('Deny')
        .mockResolvedValueOnce('Allow');
      const agent = { promptUser, sessionCounters: testCounters } as never;

      const url = `https://api-reprompt-${Date.now()}.example.com/v1/x`;
      const first = await handler({ url, method: 'POST', body: '{}' }, agent);
      expect(first).toContain('denied');

      // Second call (sequential, not concurrent) should prompt again — the
      // first call's prompt entry was cleaned up from the pending map.
      const second = await handler({ url, method: 'POST', body: '{}' }, agent);
      expect(second).toContain('HTTP 200');
      expect(promptUser).toHaveBeenCalledTimes(2);
    });
  });

  describe('Phase E: api_cost emission', () => {
    // Snapshot the env var inside beforeEach so a stray mutation from another
    // describe block earlier in the file can't taint our restore baseline.
    let originalFlag: string | undefined;

    beforeEach(() => {
      originalFlag = process.env.LYNOX_FEATURE_API_COST_DISPLAY;
    });

    afterEach(() => {
      if (originalFlag === undefined) delete process.env.LYNOX_FEATURE_API_COST_DISPLAY;
      else process.env.LYNOX_FEATURE_API_COST_DISPLAY = originalFlag;
    });

    it('emits api_cost when hostname has a profiled per_call cost and the flag is on', async () => {
      process.env.LYNOX_FEATURE_API_COST_DISPLAY = '1';
      const { ApiStore } = await import('../../core/api-store.js');
      const store = new ApiStore();
      store.register({
        id: 'dataforseo',
        name: 'DataForSEO',
        base_url: 'https://api.dataforseo.com',
        description: 'SEO API',
        cost: { model: 'per_call', rate_usd: 0.0006 },
      });

      mockDnsPublic();
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(createMockResponse({
        headers: { 'content-type': 'application/json' },
        json: { ok: true },
      })));

      const events: Array<Record<string, unknown>> = [];
      const agent = {
        name: 'main',
        toolContext: {
          apiStore: store,
          streamHandler: (e: Record<string, unknown>) => { events.push(e); },
        },
        sessionCounters: testCounters,
      } as never;

      await handler({ url: 'https://api.dataforseo.com/v3/serp/google' }, agent);
      const cost = events.find(e => e['type'] === 'api_cost');
      expect(cost).toBeDefined();
      expect(cost?.['profileId']).toBe('dataforseo');
      expect(cost?.['profileName']).toBe('DataForSEO');
      expect(cost?.['costUsd']).toBe(0.0006);
      expect(cost?.['endpoint']).toBe('/v3/serp/google');
      expect(cost?.['tool']).toBe('http_request');
    });

    it('does not emit api_cost when the api-cost-display flag is off', async () => {
      // Explicitly disable — the default flipped to ON for HN-launch (B-011),
      // so deleting the env var would now resolve to enabled. We assert the
      // disabled-state behavior, not the default value.
      process.env.LYNOX_FEATURE_API_COST_DISPLAY = '0';
      const { ApiStore } = await import('../../core/api-store.js');
      const store = new ApiStore();
      store.register({
        id: 'dataforseo',
        name: 'DataForSEO',
        base_url: 'https://api.dataforseo.com',
        description: 'SEO API',
        cost: { model: 'per_call', rate_usd: 0.0006 },
      });

      mockDnsPublic();
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(createMockResponse({
        headers: { 'content-type': 'application/json' },
        json: { ok: true },
      })));

      const events: Array<Record<string, unknown>> = [];
      const agent = {
        name: 'main',
        toolContext: {
          apiStore: store,
          streamHandler: (e: Record<string, unknown>) => { events.push(e); },
        },
        sessionCounters: testCounters,
      } as never;

      await handler({ url: 'https://api.dataforseo.com/v3/serp/google' }, agent);
      expect(events.some(e => e['type'] === 'api_cost')).toBe(false);
    });

    it('does not emit api_cost for a profile without a cost field even with flag on', async () => {
      process.env.LYNOX_FEATURE_API_COST_DISPLAY = '1';
      const { ApiStore } = await import('../../core/api-store.js');
      const store = new ApiStore();
      store.register({
        id: 'free-api',
        name: 'Free API',
        base_url: 'https://api.free.example.com',
        description: 'No cost set',
      });

      mockDnsPublic();
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(createMockResponse({
        headers: { 'content-type': 'application/json' },
        json: { ok: true },
      })));

      const events: Array<Record<string, unknown>> = [];
      const agent = {
        name: 'main',
        toolContext: {
          apiStore: store,
          streamHandler: (e: Record<string, unknown>) => { events.push(e); },
        },
        sessionCounters: testCounters,
      } as never;

      await handler({ url: 'https://api.free.example.com/v1/x' }, agent);
      expect(events.some(e => e['type'] === 'api_cost')).toBe(false);
    });

    it('does not emit api_cost when hostname differs from any registered profile', async () => {
      process.env.LYNOX_FEATURE_API_COST_DISPLAY = '1';
      const { ApiStore } = await import('../../core/api-store.js');
      const store = new ApiStore();
      store.register({
        id: 'dataforseo',
        name: 'DataForSEO',
        base_url: 'https://api.dataforseo.com',
        description: 'SEO API',
        cost: { model: 'per_call', rate_usd: 0.0006 },
      });

      mockDnsPublic();
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(createMockResponse({
        headers: { 'content-type': 'application/json' },
        json: { ok: true },
      })));

      const events: Array<Record<string, unknown>> = [];
      const agent = {
        name: 'main',
        toolContext: {
          apiStore: store,
          streamHandler: (e: Record<string, unknown>) => { events.push(e); },
        },
        sessionCounters: testCounters,
      } as never;

      // Hit an unrelated host — profile lookup must miss.
      await handler({ url: 'https://api.unrelated.example.com/v1/x' }, agent);
      expect(events.some(e => e['type'] === 'api_cost')).toBe(false);
    });

    it('emits api_cost with costUsd=0 for a free-tier per_call profile', async () => {
      process.env.LYNOX_FEATURE_API_COST_DISPLAY = '1';
      const { ApiStore } = await import('../../core/api-store.js');
      const store = new ApiStore();
      store.register({
        id: 'free-tier-api',
        name: 'Free Tier API',
        base_url: 'https://api.free-tier.example.com',
        description: 'Free per-call API',
        cost: { model: 'per_call', rate_usd: 0 },
      });

      mockDnsPublic();
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(createMockResponse({
        headers: { 'content-type': 'application/json' },
        json: { ok: true },
      })));

      const events: Array<Record<string, unknown>> = [];
      const agent = {
        name: 'main',
        toolContext: {
          apiStore: store,
          streamHandler: (e: Record<string, unknown>) => { events.push(e); },
        },
        sessionCounters: testCounters,
      } as never;

      await handler({ url: 'https://api.free-tier.example.com/v1/ping' }, agent);
      const cost = events.find(e => e['type'] === 'api_cost');
      // Free-tier emits — the UI's >$0.001 threshold filters the rollup row,
      // but the per-call event must still fire so future per-call inline
      // annotations can render "$0" deliberately.
      expect(cost).toBeDefined();
      expect(cost?.['costUsd']).toBe(0);
      expect(cost?.['profileId']).toBe('free-tier-api');
    });

    it('does not emit api_cost for a per_token cost model (deferred)', async () => {
      process.env.LYNOX_FEATURE_API_COST_DISPLAY = '1';
      const { ApiStore } = await import('../../core/api-store.js');
      const store = new ApiStore();
      store.register({
        id: 'tokenized',
        name: 'Tokenized',
        base_url: 'https://api.tokenized.example.com',
        description: 'Per-token API',
        cost: { model: 'per_token', rate_usd: 0.000001 },
      });

      mockDnsPublic();
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(createMockResponse({
        headers: { 'content-type': 'application/json' },
        json: { ok: true },
      })));

      const events: Array<Record<string, unknown>> = [];
      const agent = {
        name: 'main',
        toolContext: {
          apiStore: store,
          streamHandler: (e: Record<string, unknown>) => { events.push(e); },
        },
        sessionCounters: testCounters,
      } as never;

      await handler({ url: 'https://api.tokenized.example.com/v1/x' }, agent);
      expect(events.some(e => e['type'] === 'api_cost')).toBe(false);
    });
  });

  // Cat 2026-05-19: a hanging Shopify endpoint locked her session for 28 min
  // because readBodyLimited's reader doesn't honour AbortController.signal
  // once headers have arrived (Node fetch quirk). The session-lock cascade
  // produced 30+ min of POST /run 409 from her browser. Hard cap + wall-clock
  // race below is the wrap-around guarantee.
  describe('hard timeout cap (wall-clock)', () => {
    it('caps an above-cap timeout_ms (5s test cap) — hung fetch resolves within cap+1s', async () => {
      // To keep tests fast we use a 5s value below the 60s production cap; the
      // important invariant is that Promise.race(fetch, wallTimeout) rejects
      // even when fetch never resolves.
      mockDnsPublic();
      vi.stubGlobal('fetch', vi.fn(() => new Promise<never>(() => { /* never */ })));

      const agent = { sessionCounters: testCounters } as never;
      const started = Date.now();
      let err: Error | undefined;
      try {
        await handler({ url: 'https://hung.example.com/x', timeout_ms: 5000 }, agent);
      } catch (e) {
        err = e as Error;
      }
      const elapsed = Date.now() - started;
      expect(err).toBeDefined();
      expect(err!.message).toMatch(/timed out/i);
      expect(elapsed).toBeGreaterThan(5000);
      expect(elapsed).toBeLessThan(7500);
    }, 10_000);

    it('honours sub-cap timeout_ms (2s) without waiting for the 60s production cap', async () => {
      mockDnsPublic();
      vi.stubGlobal('fetch', vi.fn(() => new Promise<never>(() => { /* hang */ })));

      const agent = { sessionCounters: testCounters } as never;
      const started = Date.now();
      let err: Error | undefined;
      try {
        await handler({ url: 'https://hung.example.com/x', timeout_ms: 2000 }, agent);
      } catch (e) {
        err = e as Error;
      }
      const elapsed = Date.now() - started;
      expect(err).toBeDefined();
      expect(elapsed).toBeLessThan(4500);
    }, 8000);

    it('clamps a zero/negative timeout_ms to a sane minimum (1ms)', async () => {
      mockDnsPublic();
      vi.stubGlobal('fetch', vi.fn(() => new Promise<never>(() => { /* hang */ })));

      const agent = { sessionCounters: testCounters } as never;
      const started = Date.now();
      let err: Error | undefined;
      try {
        await handler({ url: 'https://hung.example.com/x', timeout_ms: 0 }, agent);
      } catch (e) {
        err = e as Error;
      }
      expect(err).toBeDefined();
      expect(Date.now() - started).toBeLessThan(3000);
    }, 5000);
  });

  // Staging 2026-05-18 (lynox-chat-2026-05-18.md): http_request hit 401
  // against the Shopify API profile. Vault had a stale access_token from a
  // previous client_credentials grant. The agent treated it as a long-lived
  // token, told the user to "re-paste from Shopify Admin", and looped on
  // 401s — Shopify Dev Dashboard doesn't expose long-lived tokens anymore.
  // Fix: when a 401 lands on an URL matched by an OAuth2-managed profile,
  // append a system hint pointing at `api_setup fetch_token`.
  describe('OAuth2 401 hint', () => {
    it('appends fetch_token hint on 401 for an oauth2 profile with token_url', async () => {
      const { ApiStore } = await import('../../core/api-store.js');
      const store = new ApiStore();
      store.register({
        id: 'shopify_seo',
        name: 'Shopify',
        base_url: 'https://shop.myshopify.com/admin/api/2026-04',
        description: 'Shopify Admin',
        auth: {
          type: 'oauth2',
          vault_keys: ['SHOPIFY_CLIENT_ID', 'SHOPIFY_CLIENT_SECRET'],
          oauth: {
            token_url: 'https://shop.myshopify.com/admin/oauth/access_token',
            grant_type: 'client_credentials',
            client_id_key: 'SHOPIFY_CLIENT_ID',
            client_secret_key: 'SHOPIFY_CLIENT_SECRET',
          },
        },
      });

      mockDnsPublic();
      const mockResp = createMockResponse({
        status: 401,
        headers: { 'content-type': 'application/json' },
        json: {},
      });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResp));

      const agent = { toolContext: { apiStore: store }, sessionCounters: testCounters } as never;
      const result = await handler({ url: 'https://shop.myshopify.com/admin/api/2026-04/graphql.json', method: 'GET' }, agent);

      // Hint must be OUTSIDE the untrusted_data wrap so the agent treats
      // it as system guidance, not response content.
      expect(result).toMatch(/Agent reminder.*OAuth2 401/i);
      expect(result).toContain('api_setup');
      expect(result).toContain('fetch_token');
      expect(result).toContain('shopify_seo');
      // The negative-rule guard against the failure mode:
      expect(result).toMatch(/re-paste a token/i);
      // Sanity: the hint appears AFTER the untrusted_data close tag.
      const dataEnd = result.lastIndexOf('</untrusted_data>');
      const hintAt = result.indexOf('Agent reminder');
      expect(dataEnd).toBeGreaterThan(-1);
      expect(hintAt).toBeGreaterThan(dataEnd);
    });

    it('does NOT append the hint when the 401 is on a non-oauth2 profile', async () => {
      const { ApiStore } = await import('../../core/api-store.js');
      const store = new ApiStore();
      store.register({
        id: 'plain_bearer',
        name: 'Plain Bearer',
        base_url: 'https://api.example.com/v1',
        description: 'Bearer token API',
        auth: { type: 'bearer', vault_keys: ['EXAMPLE_API_KEY'] },
      });

      mockDnsPublic();
      const mockResp = createMockResponse({ status: 401, headers: {}, json: {} });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResp));

      const agent = { toolContext: { apiStore: store }, sessionCounters: testCounters } as never;
      const result = await handler({ url: 'https://api.example.com/v1/me' }, agent);

      expect(result).not.toMatch(/Agent reminder.*OAuth2/i);
      expect(result).not.toContain('fetch_token');
    });

    it('does NOT append the hint on 401 when no profile matches the hostname', async () => {
      const { ApiStore } = await import('../../core/api-store.js');
      const store = new ApiStore();

      mockDnsPublic();
      const mockResp = createMockResponse({ status: 401, headers: {}, json: {} });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResp));

      const agent = { toolContext: { apiStore: store }, sessionCounters: testCounters } as never;
      const result = await handler({ url: 'https://no-profile-host.example.com/x' }, agent);

      expect(result).not.toMatch(/Agent reminder.*OAuth2/i);
    });

    it('does NOT append the hint on a non-401 response from an oauth2 profile', async () => {
      const { ApiStore } = await import('../../core/api-store.js');
      const store = new ApiStore();
      store.register({
        id: 'oauth_profile',
        name: 'OAuth Profile',
        base_url: 'https://o.example.com/v1',
        description: 'OAuth-managed API',
        auth: {
          type: 'oauth2',
          vault_keys: ['CID', 'CSEC'],
          oauth: { token_url: 'https://o.example.com/oauth/token', grant_type: 'client_credentials' as const, client_id_key: 'CID', client_secret_key: 'CSEC' },
        },
      });

      mockDnsPublic();
      // 200 OK — happy path, no hint expected.
      const mockResp = createMockResponse({ status: 200, headers: { 'content-type': 'application/json' }, json: { ok: true } });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResp));

      const agent = { toolContext: { apiStore: store }, sessionCounters: testCounters } as never;
      const result = await handler({ url: 'https://o.example.com/v1/data' }, agent);

      expect(result).not.toMatch(/Agent reminder.*OAuth2 401/i);
    });
  });

  // Staging 2026-05-18 (lynox-chat-2026-05-18 (2).md):
  // fetch_token successfully minted a fresh token and wrote it to
  // SHOPIFY_SEO_ACCESS_TOKEN, but the agent's subsequent http_request kept
  // pulling Authorization from the OLD vault key SHOPIFY_ACCESS_TOKEN
  // (left over from an earlier setup attempt). 401 forever.
  // Fix: for oauth2 profiles, the engine auto-injects Authorization from
  // the canonical `${id}_ACCESS_TOKEN` vault key. The agent doesn't need
  // to wire bearer auth at all — and even if it tries, we override.
  describe('OAuth2 engine-managed bearer injection', () => {
    function makeSecretStore(secrets: Record<string, string>): import('../../types/index.js').SecretStoreLike {
      return {
        getMasked: (n) => secrets[n] ? '****' : null,
        resolve: (n) => secrets[n] ?? null,
        listNames: () => Object.keys(secrets),
        containsSecret: () => false,
        maskSecrets: (t) => t,
        recordConsent: () => {},
        hasConsent: () => true,
        isExpired: () => false,
        extractSecretNames: () => [],
        resolveSecretRefs: (i) => i,
        findUnresolvedSecretRefs: () => [],
      };
    }

    it('auto-injects Authorization: Bearer from vault when oauth2 profile matches', async () => {
      const { ApiStore } = await import('../../core/api-store.js');
      const store = new ApiStore();
      store.register({
        id: 'shopify_seo',
        name: 'Shopify',
        base_url: 'https://shop.myshopify.com/admin/api/2026-04',
        description: 'Shopify Admin',
        auth: {
          type: 'oauth2',
          vault_keys: ['SHOPIFY_SEO_ACCESS_TOKEN'],
          oauth: { token_url: 'https://shop.myshopify.com/admin/oauth/access_token', grant_type: 'client_credentials', client_id_key: 'SHOPIFY_CLIENT_ID', client_secret_key: 'SHOPIFY_CLIENT_SECRET' },
        },
      });

      mockDnsPublic();
      const fetchMock = vi.fn().mockResolvedValue(createMockResponse({ status: 200, headers: { 'content-type': 'application/json' }, json: { ok: true } }));
      vi.stubGlobal('fetch', fetchMock);

      const secretStore = makeSecretStore({ SHOPIFY_SEO_ACCESS_TOKEN: 'fresh-token-xyz' });
      const agent = { toolContext: { apiStore: store }, sessionCounters: testCounters, secretStore } as never;
      await handler({ url: 'https://shop.myshopify.com/admin/api/2026-04/graphql.json', method: 'GET' }, agent);

      const callArgs = fetchMock.mock.calls[0][1];
      expect(callArgs.headers).toEqual(expect.objectContaining({ Authorization: 'Bearer fresh-token-xyz' }));
    });

    it('overrides stale Authorization header the agent set with the canonical token', async () => {
      const { ApiStore } = await import('../../core/api-store.js');
      const store = new ApiStore();
      store.register({
        id: 'shopify_seo',
        name: 'Shopify',
        base_url: 'https://shop.myshopify.com/admin/api/2026-04',
        description: 'Shopify Admin',
        auth: {
          type: 'oauth2',
          oauth: { token_url: 'https://shop.myshopify.com/admin/oauth/access_token', grant_type: 'client_credentials', client_id_key: 'SHOPIFY_CLIENT_ID', client_secret_key: 'SHOPIFY_CLIENT_SECRET' },
        },
      });

      mockDnsPublic();
      const fetchMock = vi.fn().mockResolvedValue(createMockResponse({ status: 200, headers: { 'content-type': 'application/json' }, json: { ok: true } }));
      vi.stubGlobal('fetch', fetchMock);

      const secretStore = makeSecretStore({ SHOPIFY_SEO_ACCESS_TOKEN: 'fresh-token-xyz' });
      const agent = { toolContext: { apiStore: store }, sessionCounters: testCounters, secretStore } as never;
      await handler({
        url: 'https://shop.myshopify.com/admin/api/2026-04/graphql.json',
        method: 'GET',
        headers: { Authorization: 'Bearer stale-old-token-from-previous-profile' },
      }, agent);

      const callArgs = fetchMock.mock.calls[0][1];
      expect(callArgs.headers.Authorization).toBe('Bearer fresh-token-xyz');
      expect(callArgs.headers.Authorization).not.toContain('stale-old-token');
    });

    it('strips lowercase authorization header on override (no duplicate header)', async () => {
      const { ApiStore } = await import('../../core/api-store.js');
      const store = new ApiStore();
      store.register({
        id: 'shopify_seo',
        name: 'Shopify',
        base_url: 'https://shop.myshopify.com/admin/api/2026-04',
        description: 'Shopify Admin',
        auth: {
          type: 'oauth2',
          oauth: { token_url: 'https://shop.myshopify.com/admin/oauth/access_token', grant_type: 'client_credentials', client_id_key: 'CID', client_secret_key: 'CSEC' },
        },
      });

      mockDnsPublic();
      const fetchMock = vi.fn().mockResolvedValue(createMockResponse({ status: 200, headers: {}, json: {} }));
      vi.stubGlobal('fetch', fetchMock);

      const secretStore = makeSecretStore({ SHOPIFY_SEO_ACCESS_TOKEN: 'fresh' });
      const agent = { toolContext: { apiStore: store }, sessionCounters: testCounters, secretStore } as never;
      await handler({
        url: 'https://shop.myshopify.com/admin/api/2026-04/x',
        headers: { authorization: 'Bearer stale-lowercase' },
      }, agent);

      const sentHeaders = fetchMock.mock.calls[0][1].headers as Record<string, string>;
      const authKeys = Object.keys(sentHeaders).filter((k) => k.toLowerCase() === 'authorization');
      expect(authKeys).toEqual(['Authorization']);
      expect(sentHeaders['Authorization']).toBe('Bearer fresh');
    });

    it('fail-loud when oauth2 profile matches but vault has no access_token', async () => {
      const { ApiStore } = await import('../../core/api-store.js');
      const store = new ApiStore();
      store.register({
        id: 'shopify_seo',
        name: 'Shopify',
        base_url: 'https://shop.myshopify.com/admin/api/2026-04',
        description: 'Shopify Admin',
        auth: {
          type: 'oauth2',
          oauth: { token_url: 'https://shop.myshopify.com/admin/oauth/access_token', grant_type: 'client_credentials', client_id_key: 'CID', client_secret_key: 'CSEC' },
        },
      });

      mockDnsPublic();
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      const secretStore = makeSecretStore({});
      const agent = { toolContext: { apiStore: store }, sessionCounters: testCounters, secretStore } as never;
      const result = await handler({ url: 'https://shop.myshopify.com/admin/api/2026-04/graphql.json', method: 'GET' }, agent);

      expect(result).toContain('SHOPIFY_SEO_ACCESS_TOKEN');
      expect(result).toContain('fetch_token');
      expect(result).toContain('shopify_seo');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('does NOT inject for non-oauth2 profiles (bearer auth left to the agent)', async () => {
      const { ApiStore } = await import('../../core/api-store.js');
      const store = new ApiStore();
      store.register({
        id: 'plain_bearer',
        name: 'Plain Bearer',
        base_url: 'https://api.example.com/v1',
        description: 'Bearer token API',
        auth: { type: 'bearer', vault_keys: ['EXAMPLE_API_KEY'] },
      });

      mockDnsPublic();
      const fetchMock = vi.fn().mockResolvedValue(createMockResponse({ status: 200, headers: {}, json: {} }));
      vi.stubGlobal('fetch', fetchMock);

      const secretStore = makeSecretStore({ PLAIN_BEARER_ACCESS_TOKEN: 'should-be-ignored' });
      const agent = { toolContext: { apiStore: store }, sessionCounters: testCounters, secretStore } as never;
      await handler({
        url: 'https://api.example.com/v1/me',
        headers: { Authorization: 'Bearer agent-set-token' },
      }, agent);

      const callArgs = fetchMock.mock.calls[0][1];
      expect(callArgs.headers.Authorization).toBe('Bearer agent-set-token');
    });
  });
});
