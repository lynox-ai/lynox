import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock dns before importing module. network-guard imports from
// node:dns/promises — we mock that path so the IP-pinning DNS resolution
// returns the canned public IP.
vi.mock('node:dns/promises', () => ({
  default: {
    lookup: vi.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]),
  },
}));

// NOTE: this file used to mock `linkedom` + `@mozilla/readability` and then
// assert that the MOCK's canned strings came back out. Those assertions passed
// no matter what the real extraction did — they stayed green through the
// measured 2026-07-28 failures (a Stripe quickstart reduced to 237 chars of nav,
// a GitHub reference reduced to a JSON payload). The extraction is now driven
// with real HTML end-to-end, so the assertions can actually fail.

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
    htmlResponse(
      '<html><head><title>Acme Robotics</title></head>' +
      '<body><p>We build warehouse robots.</p></body></html>',
    );

    const result = await extractContent('https://example.com');
    expect(result.title).toBe('Acme Robotics');
    expect(result.content).toContain('We build warehouse robots.');
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
    htmlResponse(`<html><head><title>Long</title></head><body><p>${'word '.repeat(20_000)}</p></body></html>`);

    const result = await extractContent('https://example.com', 100);
    expect(result.truncated).toBe(true);
    expect(result.content.length).toBeLessThanOrEqual(100);
  });

  // --- Advanced edge cases ---

  it('keeps the document title and the body prose', async () => {
    htmlResponse('<html><head><title>Fallback Title</title></head><body><p>Fallback content here</p></body></html>');

    const result = await extractContent('https://example.com');
    expect(result.title).toBe('Fallback Title');
    expect(result.content).toContain('Fallback content here');
  });

  it('uses hostname as title when no title found', async () => {
    htmlResponse('<html><body>No title anywhere</body></html>');

    const result = await extractContent('https://notitle.example.com');
    expect(result.title).toBe('notitle.example.com');
  });

  // --- Regression: no article SELECTION step (2026-07-28) ---

  it('keeps every region of a docs page, not just the one an article picker would choose', async () => {
    // Shaped after the real failures: a docs page whose biggest single element is
    // a JSON sample, with the actual guidance split across a sidebar, a heading
    // and body prose. Mozilla Readability scored the code block highest here and
    // returned it alone — docs.stripe.com/ and the GitHub REST reference both
    // came back as bare JSON payloads.
    //
    // MUTATION that kills this test: reintroduce a step that picks a subtree
    // BELOW <body> as "the article". The four regions below sit in four
    // different subtrees, so any such pick drops at least one assertion.
    htmlResponse(`<html><head><title>Send an email</title></head><body>
      <nav><a href="/docs/auth">Authentication</a><a href="/docs/webhooks">Webhooks</a></nav>
      <aside>Requires the emails.send scope.</aside>
      <main>
        <h2>Send an email</h2>
        <p>POST to the messages endpoint with a bearer token.</p>
        <pre>{"id":"1","object":"email","from":null,"to":null,"subject":null,
             "html":null,"text":null,"cc":null,"bcc":null,"reply_to":null,
             "created_at":null,"last_event":null,"headers":null,"tags":null}</pre>
      </main>
    </body></html>`);

    const result = await extractContent('https://example.com/docs/send');

    expect(result.content).toContain('Authentication');            // nav region
    expect(result.content).toContain('emails.send scope');          // aside region
    expect(result.content).toContain('bearer token');               // the actual guidance
    expect(result.content).toContain('## Send an email');           // heading structure survives
  });

  it('keeps meta description when the body carries no text', async () => {
    // Bot-walled and JS-rendered pages serve an empty body; the meta tags are
    // then the only description of the page that exists. Readability returned 0
    // characters for exactly this shape (measured on anthropic.com).
    // MUTATION: drop the meta-line block from the extractor.
    htmlResponse(
      '<html><head><title>Acme</title>' +
      '<meta name="description" content="Warehouse robotics for mid-size logistics.">' +
      '</head><body><div id="root"></div></body></html>',
    );

    const result = await extractContent('https://example.com');
    expect(result.content).toContain('Warehouse robotics for mid-size logistics.');
  });

  it('does not run the HTML extractor over a text/plain body', async () => {
    // The content-type gate admits text/plain. Prose containing `<` would lose
    // everything up to the next `>` if it went through tag-stripping.
    // MUTATION: drop the isHtmlContentType branch — `if 3 <b and b> 4 then` loses
    // its middle and the assertion fails.
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/plain' }),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('if 3 <b and b> 4 then stop'));
          controller.close();
        },
      }),
    });

    const result = await extractContent('https://example.com/readme.txt');
    expect(result.content).toBe('if 3 <b and b> 4 then stop');
  });

  it('still honours maxChars on a text/plain body', async () => {
    // MUTATION: `truncated = false; content = body` in the plain-text branch.
    // Without this test that passes 54/54, and a 500 KB text/plain body walks
    // straight into the model's context — the exact blowup this path caps.
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/plain; charset=utf-8' }),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('x'.repeat(5_000)));
          controller.close();
        },
      }),
    });

    const result = await extractContent('https://example.com/big.txt', 100);
    expect(result.content.length).toBe(100);
    expect(result.truncated).toBe(true);
  });

  it('keeps the raw body when a LARGE page extracts to almost nothing', async () => {
    // A JS-rendered shell, or a body byte-cut inside an open <script>, strips to
    // a few dozen characters — measured 197 for a 500 KB news homepage. The raw
    // markup still carries inline JSON and data attributes, so it beats the
    // boilerplate. MUTATION: drop the guard, and the assertion on the payload fails.
    const shell = `<html><head><title>News</title></head><body><div id="app"></div>` +
      `<script>window.__DATA__={"headline":"Marker aus dem Inline-JSON"};${'/*pad*/'.repeat(6_000)}` +
      `</body></html>`;
    expect(shell.length).toBeGreaterThan(30_000);
    htmlResponse(shell);

    const result = await extractContent('https://example.com');
    expect(result.content).toContain('Marker aus dem Inline-JSON');
  });

  it('does not let the LINK LIST fake a useful extraction', async () => {
    // A JS-rendered shell with a navigation menu is still a shell. If the guard
    // counts the whole extraction, the links alone push it past the threshold
    // and the raw markup — which still holds the data the shell renders — is
    // thrown away. MUTATION: gate on `afterChars` instead of `bodyChars`.
    const nav = Array.from({ length: 14 }, (_, i) => `<a href="/bereich-${i}">Bereich ${i}</a>`).join('');
    const shell = `<html><head><title>App</title></head><body><nav>${nav}</nav>`
      + `<div id="root"></div><script>window.__D={"marker":"Inline-Nutzdaten"};${'/*p*/'.repeat(8_000)}</script></body></html>`;
    expect(shell.length).toBeGreaterThan(30_000);
    htmlResponse(shell);

    const result = await extractContent('https://example.com/');
    expect(result.content).toContain('Inline-Nutzdaten');
  });

  it('does NOT keep raw markup just because a SMALL page is short', async () => {
    // The size condition is what turns "extraction was short" into a failure
    // signal. Without it a tiny document comes back as raw tags, which is
    // strictly worse than its own text.
    // MUTATION: drop `body.length > DEFAULT_HTML_EXTRACT_THRESHOLD_CHARS`.
    htmlResponse('<html><head><title>Kurz</title></head><body><p>Wenig Text.</p></body></html>');

    const result = await extractContent('https://example.com');
    expect(result.content).toContain('Wenig Text.');
    expect(result.content).not.toContain('<p>');
  });

  it('strips markup for content types beyond text/html', async () => {
    // The outer gate admits anything containing `html` or `text`, but
    // `isHtmlContentType` only matches text/html and application/xhtml. Routing
    // on it alone handed text/xml and application/html back as raw tags, which
    // the previous tag-stripping path never did.
    // MUTATION: route on isHtmlContentType instead of isMarkupContentType.
    for (const ct of ['text/xml', 'application/html']) {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': ct }),
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('<root><item>Nutzdaten</item></root>'));
            controller.close();
          },
        }),
      });

      const result = await extractContent('https://example.com/feed');
      expect(result.content).toContain('Nutzdaten');
      expect(result.content).not.toContain('<item>');
    }
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

  it('lists the page\'s links, resolved against the url that was fetched', async () => {
    // The wiring is the point: passing `undefined` as the base leaves this suite
    // green, so nothing would notice the links disappearing.
    // MUTATION: `extractHtmlText(body, { maxChars: limit })` at the call site.
    htmlResponse(
      `<html><head><title>T</title></head><body>` +
      '<a href="/kapitel-eins">Kapitel Eins</a><a href="unterseite">Relativ</a>' +
      `<p>${'Fliesstext. '.repeat(40)}</p></body></html>`,
    );

    const result = await extractContent('https://example.com/docs/');

    expect(result.content).toContain('/kapitel-eins — Kapitel Eins');
    expect(result.content).toContain('/docs/unterseite — Relativ');
  });

  it('resolves links against the FINAL hop, never the requested url', async () => {
    // A page reached through one redirect to another host had its links resolved
    // and origin-filtered against the ORIGINAL, trusted origin: the attacker's
    // own links were filtered out and only attacker-CHOSEN PATHS survived,
    // presented as same-site links of the host the agent trusts — which
    // http_request then calls with that host's credentials attached by hostname.
    // MUTATION: pass the requested `url` instead of `finalUrl`.
    let hop = 0;
    mockFetch.mockImplementation(() => {
      hop += 1;
      if (hop === 1) {
        return Promise.resolve({
          ok: false, status: 302, statusText: 'Found',
          headers: new Headers({ location: 'https://boese.example/seite' }),
          body: null,
        });
      }
      return Promise.resolve({
        ok: true, status: 200,
        headers: new Headers({ 'content-type': 'text/html' }),
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(
              '<html><head><title>T</title></head><body>' +
              // Absolute, on the host that actually served this: same-origin
              // against the FINAL hop, off-origin against the requested one.
              '<a href="https://boese.example/eigenes">Eigenes</a>' +
              // Absolute, on the TRUSTED host: the payload. Same-origin only if
              // the base is wrong, which is exactly the bug.
              '<a href="https://vertrauenswuerdig.example/v1/transfers?to=angreifer">Payouts</a>' +
              `<p>${'Fliesstext. '.repeat(40)}</p></body></html>`,
            ));
            controller.close();
          },
        }),
      });
    });

    const result = await extractContent('https://vertrauenswuerdig.example/v1/docs');

    // A relative-path assertion could not tell the two bases apart: the rendered
    // line is `pathname + search`, so both bases produce identical text. Only
    // ABSOLUTE links on each host distinguish them.
    expect(result.content).toContain('/eigenes — Eigenes');            // final hop wins
    expect(result.content).not.toContain('to=angreifer');              // trusted host is NOT ours
    expect(result.url).toBe('https://vertrauenswuerdig.example/v1/docs');
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
    htmlResponse('<html><body><p>Extracted content from the article.</p></body></html>');

    const result = await extractContent('https://example.com');
    expect(result.wordCount).toBe(5);
  });

  it('reports zero words for an empty document, not one', async () => {
    // `''.split(/\s+/)` is `['']` — a naive `.length` reports 1 word for a page
    // with no text at all. Mutation: drop the empty-string branch in countWords.
    htmlResponse('<html><body></body></html>');

    const result = await extractContent('https://example.com');
    expect(result.content).toBe('');
    expect(result.wordCount).toBe(0);
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
