import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock dns before importing module. network-guard imports from
// node:dns/promises — we mock that path so the IP-pinning DNS resolution
// returns the canned public IP.
vi.mock('node:dns/promises', () => ({
  default: {
    lookup: vi.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]),
  },
}));

// Mock linkedom and readability for dynamic imports
vi.mock('linkedom', () => ({
  parseHTML: vi.fn().mockImplementation(() => ({
    document: { documentElement: {} },
  })),
}));

vi.mock('@mozilla/readability', () => {
  const mockParse = vi.fn().mockReturnValue({
    title: 'Extracted Title',
    textContent: 'Extracted content from the article.',
  });
  return {
    Readability: vi.fn().mockImplementation(function() {
      return { parse: mockParse };
    }),
    __mockParse: mockParse,
  };
});

const mockFetch = vi.fn();

// Install the pinned-transport shim before importing the module under test.
// The shim adapts the new fetchPinned contract to the legacy globalThis.fetch
// stub the existing tests rely on, AND records the pinned input so a
// dedicated rebind regression test can assert that DNS-pinning happened.
import {
  setPinnedTransportForTests,
} from '../../core/network-guard.js';
import type { PinnedTransportInput } from '../../core/network-guard.js';

const capturedTransportInputs: PinnedTransportInput[] = [];
let restorePinnedTransport: (() => void) | undefined;

beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal('fetch', mockFetch);
  capturedTransportInputs.length = 0;
  restorePinnedTransport = setPinnedTransportForTests(async (input) => {
    capturedTransportInputs.push(input);
    const init: RequestInit = { method: input.method, headers: input.headers };
    if (input.body !== undefined) init.body = input.body.toString('utf8');
    if (input.signal) init.signal = input.signal;
    return mockFetch(input.url, init);
  });
});

afterEach(() => {
  restorePinnedTransport?.();
  restorePinnedTransport = undefined;
  vi.restoreAllMocks();
});

// Import after mocks
const { extractContent } = await import('./content-extractor.js');
const dnsPromises = await import('node:dns/promises');
const dnsLookupMock = vi.mocked(dnsPromises.default.lookup);

function htmlResponse(html: string): ReturnType<typeof mockFetch> {
  return mockFetch.mockResolvedValue({
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'text/html' }),
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(html));
        controller.close();
      },
    }),
  });
}

describe('extractContent', () => {
  it('extracts content from HTML page', async () => {
    htmlResponse('<html><body><p>Hello</p></body></html>');

    const result = await extractContent('https://example.com');
    expect(result.title).toBe('Extracted Title');
    expect(result.content).toBe('Extracted content from the article.');
    expect(result.url).toBe('https://example.com');
    expect(result.wordCount).toBeGreaterThan(0);
    expect(result.truncated).toBe(false);
  });

  it('throws on non-OK response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      headers: new Headers(),
    });

    await expect(extractContent('https://example.com/404')).rejects.toThrow('HTTP 404');
  });

  it('throws on unsupported content type', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/pdf' }),
      body: null,
    });

    await expect(extractContent('https://example.com/file.pdf')).rejects.toThrow('Unsupported content type');
  });

  it('blocks private IP addresses', async () => {
    await expect(extractContent('http://127.0.0.1')).rejects.toThrow('Blocked');
    await expect(extractContent('http://10.0.0.1')).rejects.toThrow('Blocked');
    await expect(extractContent('http://192.168.1.1')).rejects.toThrow('Blocked');
  });

  it('blocks non-http protocols', async () => {
    await expect(extractContent('ftp://example.com')).rejects.toThrow('Blocked');
    await expect(extractContent('file:///etc/passwd')).rejects.toThrow('Blocked');
  });

  it('honors ToolContext.networkPolicy="deny-all"', async () => {
    // Regression: before this PR, extractContent ran its own validateUrl
    // that only checked private IPs. Air-gapped engines could still pull
    // arbitrary external URLs via web_research action="read". Now the ctx
    // propagates and deny-all blocks the request before fetch.
    const ctx = {
      networkPolicy: 'deny-all',
      allowedHosts: undefined,
      allowedWildcards: [] as string[],
      enforceHttps: false,
    } as never;
    await expect(extractContent('https://example.com', undefined, ctx))
      .rejects.toThrow(/air-gapped|denied|blocked/i);
  });

  it('honors ToolContext.networkPolicy="allow-list" — blocks unlisted hosts', async () => {
    const ctx = {
      networkPolicy: 'allow-list',
      allowedHosts: new Set(['allowed.example.com']),
      allowedWildcards: [] as string[],
      enforceHttps: false,
    } as never;
    await expect(extractContent('https://denied.example.com/path', undefined, ctx))
      .rejects.toThrow(/allow-list|blocked/i);
  });

  it('honors ToolContext.enforceHttps for plain-HTTP requests', async () => {
    const ctx = {
      networkPolicy: undefined,
      allowedHosts: undefined,
      allowedWildcards: [] as string[],
      enforceHttps: true,
    } as never;
    await expect(extractContent('http://example.com', undefined, ctx))
      .rejects.toThrow(/HTTPS|enforce_https|blocked/i);
  });

  it('truncates long content', async () => {
    // Override the mock for this test
    const readability = await import('@mozilla/readability');
    const mockParse = (readability as Record<string, unknown>)['__mockParse'] as ReturnType<typeof vi.fn>;
    const longContent = 'word '.repeat(20_000);
    mockParse.mockReturnValueOnce({ title: 'Long', textContent: longContent });

    htmlResponse('<html><body></body></html>');

    const result = await extractContent('https://example.com', 100);
    expect(result.truncated).toBe(true);
    expect(result.content.length).toBeLessThanOrEqual(100);
  });

  // --- Advanced edge cases ---

  it('falls back to tag stripping when Readability returns null', async () => {
    const readability = await import('@mozilla/readability');
    const mockParse = (readability as Record<string, unknown>)['__mockParse'] as ReturnType<typeof vi.fn>;
    mockParse.mockReturnValueOnce(null);

    htmlResponse('<html><head><title>Fallback Title</title></head><body><p>Fallback content here</p></body></html>');

    const result = await extractContent('https://example.com');
    expect(result.title).toBe('Fallback Title');
    expect(result.content).toContain('Fallback content here');
  });

  it('uses hostname as title when no title found', async () => {
    const readability = await import('@mozilla/readability');
    const mockParse = (readability as Record<string, unknown>)['__mockParse'] as ReturnType<typeof vi.fn>;
    mockParse.mockReturnValueOnce(null);

    htmlResponse('<html><body>No title anywhere</body></html>');

    const result = await extractContent('https://notitle.example.com');
    expect(result.title).toBe('notitle.example.com');
  });

  it('blocks 172.16.x.x private range', async () => {
    await expect(extractContent('http://172.16.0.1')).rejects.toThrow('Blocked');
  });

  it('blocks 169.254.x.x link-local', async () => {
    await expect(extractContent('http://169.254.1.1')).rejects.toThrow('Blocked');
  });

  it('blocks 100.64.x.x CGNAT range', async () => {
    await expect(extractContent('http://100.64.0.1')).rejects.toThrow('Blocked');
  });

  it('blocks IPv6 loopback ::1', async () => {
    await expect(extractContent('http://[::1]:8080')).rejects.toThrow('Blocked');
  });

  it('handles text/plain content type', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/plain' }),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('Plain text content'));
          controller.close();
        },
      }),
    });

    // text/plain contains 'text' → should be accepted
    const result = await extractContent('https://example.com/readme.txt');
    expect(result.content).toBeTruthy();
  });

  it('rejects application/json content type', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: null,
    });

    await expect(extractContent('https://api.example.com/data')).rejects.toThrow('Unsupported content type');
  });

  it('rejects image content type', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'image/png' }),
      body: null,
    });

    await expect(extractContent('https://example.com/image.png')).rejects.toThrow('Unsupported content type');
  });

  it('handles empty body gracefully', async () => {
    const readability = await import('@mozilla/readability');
    const mockParse = (readability as Record<string, unknown>)['__mockParse'] as ReturnType<typeof vi.fn>;
    mockParse.mockReturnValueOnce(null);

    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/html' }),
      body: new ReadableStream({
        start(controller) { controller.close(); },
      }),
    });

    const result = await extractContent('https://example.com/empty');
    expect(result.content).toBe('');
  });

  it('handles response with no body at all', async () => {
    const readability = await import('@mozilla/readability');
    const mockParse = (readability as Record<string, unknown>)['__mockParse'] as ReturnType<typeof vi.fn>;
    mockParse.mockReturnValueOnce(null);

    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/html' }),
      body: null,
    });

    const result = await extractContent('https://example.com/nobody');
    expect(result.content).toBe('');
  });

  it('follows redirects and validates each hop', async () => {
    // First call: 301 redirect
    mockFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 301,
        headers: new Headers({ location: 'https://example.com/final' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'text/html' }),
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('<html><body>Redirected</body></html>'));
            controller.close();
          },
        }),
      });

    const result = await extractContent('https://example.com/old');
    expect(result.content).toBeTruthy();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('throws on too many redirects', async () => {
    // 6 redirects → exceeds MAX_REDIRECTS (5)
    for (let i = 0; i < 7; i++) {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 302,
        headers: new Headers({ location: `https://example.com/hop${i + 1}` }),
      });
    }

    await expect(extractContent('https://example.com/loop')).rejects.toThrow('Too many redirects');
  });

  it('throws on redirect without location header', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 301,
      headers: new Headers(),
    });

    await expect(extractContent('https://example.com/bad-redirect')).rejects.toThrow('location header');
  });

  it('counts words correctly', async () => {
    htmlResponse('<html><body></body></html>');

    const result = await extractContent('https://example.com');
    // Default mock returns "Extracted content from the article." = 5 words
    expect(result.wordCount).toBe(5);
  });

  // T1-4: DNS-rebinding regression. The legacy validate-then-fetch flow
  // re-resolved the hostname inside fetch(), so a low-TTL record could flip
  // public → loopback between validation and connect. The new fetchPinned
  // resolves DNS exactly once and pins the connection to that IP via the
  // http(s) Agent.lookup override; the test transport captures the pinned IP
  // so we can assert it was the FIRST (validated, public) record.
  it('rebind defense: pins to the first-resolved (public) IP even if a second resolve would return a private IP', async () => {
    dnsLookupMock.mockReset();
    dnsLookupMock
      .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }] as never)
      .mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }] as never);
    htmlResponse('<html><body>ok</body></html>');

    await extractContent('https://rebind.example.test');
    // Exactly ONE DNS resolution and the captured pinned IP is the public one.
    expect(dnsLookupMock).toHaveBeenCalledTimes(1);
    expect(capturedTransportInputs).toHaveLength(1);
    expect(capturedTransportInputs[0]!.pinnedIp).toBe('93.184.216.34');
    expect(capturedTransportInputs[0]!.pinnedIp).not.toBe('127.0.0.1');
    expect(capturedTransportInputs[0]!.hostname).toBe('rebind.example.test');
  });

  it('rebind defense: blocks the IPv4-mapped-IPv6 hex form of a private IP (::ffff:7f00:1 == 127.0.0.1)', async () => {
    // Pre-T1-4, both http.ts and content-extractor.ts only stripped the
    // dotted form. With the canonical isPrivateIP from network-guard the
    // hex form is decoded — this resolution must be blocked.
    dnsLookupMock.mockReset();
    dnsLookupMock.mockResolvedValueOnce([{ address: '::ffff:7f00:1', family: 6 }] as never);
    await expect(extractContent('http://hex-evil.example.test/'))
      .rejects.toThrow(/private IP|blocked/i);
    // Transport never invoked — the connection was blocked before connect.
    expect(capturedTransportInputs).toHaveLength(0);
  });
});
