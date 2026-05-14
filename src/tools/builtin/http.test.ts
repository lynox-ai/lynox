import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node:dns/promises', () => ({
  default: {
    lookup: vi.fn(),
  },
}));

import dns from 'node:dns/promises';
import { httpRequestTool, detectSecretInContent } from './http.js';
import { applyHttpRateLimits, createToolContext } from '../../core/tool-context.js';
import type { ToolCallCountProvider, ToolContext } from '../../core/tool-context.js';
import type { LynoxUserConfig, SessionCounters } from '../../types/index.js';

const handler = httpRequestTool.handler;

// Each test gets a fresh ToolContext + a fresh SessionCounters object via
// beforeEach. The handler reads network policy / rate-limits from
// `agent.toolContext` and the per-session http counter from
// `agent.sessionCounters`. Both flow into the agent stub via `makeAgent()`.
const TEST_USER_CONFIG = {} as LynoxUserConfig;
let testCtx: ToolContext;
let testCounters: SessionCounters;

function makeAgent(extras: { promptUser?: ReturnType<typeof vi.fn> } = {}): never {
  return {
    promptUser: extras.promptUser,
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
  testCtx = createToolContext(TEST_USER_CONFIG);
  testCounters = {
    httpRequests: 0,
    writeBytes: 0,
    approvedOutboundDomains: new Set<string>(),
    pendingOutboundPrompts: new Map<string, Promise<boolean>>(),
  };
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
      expect(result.length).toBeLessThan(150_000);
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
});
