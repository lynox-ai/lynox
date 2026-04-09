import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock dns before importing module
vi.mock('node:dns', () => ({
  promises: {
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

beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// Import after mocks
const { extractContent } = await import('./content-extractor.js');

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
});
