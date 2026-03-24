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
});
