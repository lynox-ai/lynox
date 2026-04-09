import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node:dns/promises', () => ({
  default: {
    lookup: vi.fn(),
  },
}));

import dns from 'node:dns/promises';
import { httpRequestTool, resetHttpRequestCount, configureHttpRateLimits, resetHttpRateLimits, detectSecretInContent, configureEnforceHttps, resetEnforceHttps } from './http.js';
import type { ToolCallCountProvider } from '../../core/tool-context.js';

const handler = httpRequestTool.handler;

/** Mock agent with auto-approve promptUser for write method tests */
const agentWithPrompt = { promptUser: vi.fn().mockResolvedValue('Allow') } as never;

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
  resetHttpRequestCount();
});

describe('httpRequestTool', () => {
  describe('SSRF Protection', () => {
    it('blocks ftp:// protocol', async () => {
      await expect(handler({ url: 'ftp://example.com' }, {} as never))
        .rejects.toThrow('Only HTTP and HTTPS');
    });

    it('blocks file:// protocol', async () => {
      await expect(handler({ url: 'file:///etc/passwd' }, {} as never))
        .rejects.toThrow('Only HTTP and HTTPS');
    });

    it('blocks direct private IP 127.0.0.1', async () => {
      await expect(handler({ url: 'http://127.0.0.1' }, {} as never))
        .rejects.toThrow('internal network');
    });

    it('blocks direct private IP 10.0.0.1', async () => {
      await expect(handler({ url: 'http://10.0.0.1' }, {} as never))
        .rejects.toThrow('internal network');
    });

    it('blocks direct private IP 172.16.0.1', async () => {
      await expect(handler({ url: 'http://172.16.0.1' }, {} as never))
        .rejects.toThrow('internal network');
    });

    it('blocks direct private IP 192.168.1.1', async () => {
      await expect(handler({ url: 'http://192.168.1.1' }, {} as never))
        .rejects.toThrow('internal network');
    });

    it('blocks direct private IP 169.254.1.1', async () => {
      await expect(handler({ url: 'http://169.254.1.1' }, {} as never))
        .rejects.toThrow('internal network');
    });

    it('blocks direct private IP 0.0.0.0', async () => {
      await expect(handler({ url: 'http://0.0.0.0' }, {} as never))
        .rejects.toThrow('internal network');
    });

    it('blocks IPv6 loopback [::1]', async () => {
      await expect(handler({ url: 'http://[::1]' }, {} as never))
        .rejects.toThrow('internal network');
    });

    it('blocks IPv6 link-local [fe80::1]', async () => {
      await expect(handler({ url: 'http://[fe80::1]' }, {} as never))
        .rejects.toThrow('internal network');
    });

    it('blocks IPv4-mapped IPv6 that resolves to 127.0.0.1', async () => {
      mockDnsIpv6Private('::ffff:127.0.0.1');
      await expect(handler({ url: 'http://evil.com' }, {} as never))
        .rejects.toThrow('internal network');
    });

    it('blocks DNS-resolved private IP (127.0.0.1)', async () => {
      mockDnsPrivate('127.0.0.1');
      await expect(handler({ url: 'http://evil.com' }, {} as never))
        .rejects.toThrow('internal network');
    });

    it('blocks DNS-resolved private IP (10.0.0.1)', async () => {
      mockDnsPrivate('10.0.0.1');
      await expect(handler({ url: 'http://evil.com' }, {} as never))
        .rejects.toThrow('internal network');
    });

    it('blocks DNS-resolved private IP (192.168.1.100)', async () => {
      mockDnsPrivate('192.168.1.100');
      await expect(handler({ url: 'http://evil.com' }, {} as never))
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

      const result = await handler({ url: 'http://example.com' }, {} as never);
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

      await handler({ url: 'http://example.com/api', method: 'POST', body: '{"key":"value"}' }, agentWithPrompt);

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

      await handler({ url: 'http://example.com', method: 'GET', body: 'should-be-ignored' }, {} as never);

      const callArgs = fetchMock.mock.calls[0]![1] as RequestInit;
      expect(callArgs.body).toBeUndefined();
    });

    it('HEAD suppresses body even if provided', async () => {
      mockDnsPublic();
      const mockResp = createMockResponse({ body: '' });
      const fetchMock = vi.fn().mockResolvedValue(mockResp);
      vi.stubGlobal('fetch', fetchMock);

      await handler({ url: 'http://example.com', method: 'HEAD', body: 'should-be-ignored' }, {} as never);

      const callArgs = fetchMock.mock.calls[0]![1] as RequestInit;
      expect(callArgs.body).toBeUndefined();
    });

    it('JSON response is pretty-printed', async () => {
      mockDnsPublic();
      const mockResp = createMockResponse({
        json: { name: 'test', value: 42 },
      });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResp));

      const result = await handler({ url: 'http://example.com/api' }, {} as never);
      expect(result).toContain('"name": "test"');
      expect(result).toContain('"value": 42');
    });

    it('text response is returned as-is', async () => {
      mockDnsPublic();
      const mockResp = createMockResponse({
        body: 'plain text content here',
      });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResp));

      const result = await handler({ url: 'http://example.com/page' }, {} as never);
      expect(result).toContain('plain text content here');
    });

    it('truncates body over 100K characters', async () => {
      mockDnsPublic();
      const longBody = 'x'.repeat(150_000);
      const mockResp = createMockResponse({ body: longBody });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResp));

      const result = await handler({ url: 'http://example.com/big' }, {} as never);
      expect(result).toContain('[truncated');
      expect(result).toContain('http_response_limit');
      expect(result.length).toBeLessThan(150_000);
    });

    it('PUT method sends body', async () => {
      mockDnsPublic();
      const mockResp = createMockResponse({ body: 'updated' });
      const fetchMock = vi.fn().mockResolvedValue(mockResp);
      vi.stubGlobal('fetch', fetchMock);

      await handler({ url: 'http://example.com/resource', method: 'PUT', body: 'data' }, agentWithPrompt);

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

      const result = await handler({ url: 'http://example.com/resource', method: 'DELETE' }, {} as never);
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

      await handler({ url: 'http://example.com/resource', method: 'PATCH', body: '{"field":"new"}' }, agentWithPrompt);

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
      }, {} as never);

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

      const result = await handler({ url: 'http://example.com' }, {} as never);
      expect(result).toContain('x-request-id: abc-123');
    });

    it('defaults to GET when method is omitted', async () => {
      mockDnsPublic();
      const mockResp = createMockResponse({ body: 'ok' });
      const fetchMock = vi.fn().mockResolvedValue(mockResp);
      vi.stubGlobal('fetch', fetchMock);

      await handler({ url: 'http://example.com' }, {} as never);

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

      const result = await handler({ url: 'http://example.com' }, {} as never);
      expect(result).toContain('HTTP 200');
    });

    it('at limit returns error string', async () => {
      mockDnsPublic();
      const mockResp = createMockResponse({ body: 'ok' });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResp));

      // Make 100 successful requests (counter incremented on each fetch)
      for (let i = 0; i < 100; i++) {
        await handler({ url: 'http://example.com' }, {} as never);
      }
      // Next should be blocked (counter is at 100, >= MAX)
      const result = await handler({ url: 'http://example.com' }, {} as never);
      expect(result).toContain('Request limit reached');
    });

    it('reset clears counter', async () => {
      mockDnsPublic();
      const mockResp = createMockResponse({ body: 'ok' });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResp));

      for (let i = 0; i < 100; i++) {
        await handler({ url: 'http://example.com' }, {} as never);
      }
      resetHttpRequestCount();
      const result = await handler({ url: 'http://example.com' }, {} as never);
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
      resetHttpRateLimits();
      resetHttpRequestCount();
    });

    it('blocks when hourly limit exceeded', async () => {
      configureHttpRateLimits({ provider: mockProvider({ 1: 50 }), hourlyLimit: 50 });
      const result = await handler({ url: 'http://example.com' }, {} as never);
      expect(result).toContain('Hourly request limit reached');
    });

    it('blocks when daily limit exceeded', async () => {
      configureHttpRateLimits({ provider: mockProvider({ 24: 200 }), dailyLimit: 200 });
      const result = await handler({ url: 'http://example.com' }, {} as never);
      expect(result).toContain('Daily request limit reached');
    });

    it('allows when under limits', async () => {
      mockDnsPublic();
      const mockResp = createMockResponse({ body: 'ok' });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResp));
      configureHttpRateLimits({ provider: mockProvider({ 1: 5, 24: 10 }), hourlyLimit: 50, dailyLimit: 200 });
      const result = await handler({ url: 'http://example.com' }, {} as never);
      expect(result).toContain('HTTP 200');
    });

    it('allows when no explicit limits configured and counts are within defaults', async () => {
      mockDnsPublic();
      const mockResp = createMockResponse({ body: 'ok' });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResp));
      configureHttpRateLimits({ provider: mockProvider({ 1: 100 }) });
      const result = await handler({ url: 'http://example.com' }, {} as never);
      expect(result).toContain('HTTP 200');
    });

    it('resetHttpRateLimits clears config', async () => {
      configureHttpRateLimits({ provider: mockProvider({ 1: 100 }), hourlyLimit: 10 });
      resetHttpRateLimits();
      mockDnsPublic();
      const mockResp = createMockResponse({ body: 'ok' });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResp));
      const result = await handler({ url: 'http://example.com' }, {} as never);
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
      resetHttpRequestCount();
      resetHttpRateLimits();
    });

    it('blocks POST with API key in body', async () => {
      mockDnsPublic();
      const result = await handler({
        url: 'http://example.com/api',
        method: 'POST',
        body: JSON.stringify({ key: 'sk-ant-api03-abc123def456ghi789jkl012mno345pqr678' }),
      }, agentWithPrompt);
      expect(result).toContain('Blocked');
      expect(result).toContain('Anthropic API key');
    });

    it('blocks PUT with private key in body', async () => {
      mockDnsPublic();
      const result = await handler({
        url: 'http://example.com/upload',
        method: 'PUT',
        body: '-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqh...',
      }, agentWithPrompt);
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
      }, agentWithPrompt);
      expect(result).toContain('HTTP 200');
    });
  });

  describe('egress control: GET exfiltration detection', () => {
    beforeEach(() => {
      resetHttpRequestCount();
      resetHttpRateLimits();
    });

    it('blocks GET with very long query string (no promptUser)', async () => {
      mockDnsPublic();
      const longParam = 'a'.repeat(600);
      const result = await handler({
        url: `http://example.com/api?data=${longParam}`,
      }, {} as never);
      expect(result).toContain('Blocked');
      expect(result).toContain('query string');
    });

    it('blocks GET with base64 blob in params (no promptUser)', async () => {
      mockDnsPublic();
      const b64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/==';
      const result = await handler({
        url: `http://example.com/api?data=${b64}`,
      }, {} as never);
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
      }, agentWithPrompt);
      expect(result).toContain('HTTP 200');
    });

    it('allows normal GET with short query', async () => {
      mockDnsPublic();
      const mockResp = createMockResponse({ body: 'ok' });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResp));
      const result = await handler({
        url: 'http://example.com/api?q=search+term',
      }, {} as never);
      expect(result).toContain('HTTP 200');
    });
  });

  describe('enforce_https', () => {
    afterEach(() => {
      resetEnforceHttps();
    });

    it('blocks http:// when enforce_https is enabled', async () => {
      configureEnforceHttps(true);
      mockDnsPublic();
      await expect(handler({ url: 'http://example.com' }, {} as never))
        .rejects.toThrow('HTTPS connections are allowed');
    });

    it('allows https:// when enforce_https is enabled', async () => {
      configureEnforceHttps(true);
      mockDnsPublic();
      const mockResp = createMockResponse({ body: 'ok' });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResp));
      const result = await handler({ url: 'https://example.com' }, {} as never);
      expect(result).toContain('HTTP 200');
    });

    it('allows http://localhost when enforce_https is enabled', async () => {
      configureEnforceHttps(true);
      const mockResp = createMockResponse({ body: 'ok' });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResp));
      const result = await handler({ url: 'http://localhost:3000' }, {} as never);
      expect(result).toContain('HTTP 200');
    });

    it('allows http:// when enforce_https is not enabled (default)', async () => {
      mockDnsPublic();
      const mockResp = createMockResponse({ body: 'ok' });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResp));
      const result = await handler({ url: 'http://example.com' }, {} as never);
      expect(result).toContain('HTTP 200');
    });
  });
});
