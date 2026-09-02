import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  initErrorReporting,
  shutdownErrorReporting,
  addToolBreadcrumb,
  addLLMBreadcrumb,
  captureLynoxError,
  captureError,
  captureUserFeedback,
  isErrorReportingEnabled,
  _resetForTesting,
} from './error-reporting.js';

// Mock @sentry/node (Bugsink is Sentry SDK compatible)
const mockInit = vi.fn();
const mockAddBreadcrumb = vi.fn();
const mockCaptureException = vi.fn();
const mockCaptureMessage = vi.fn().mockReturnValue('event-123');
const mockCaptureFeedback = vi.fn();
const mockWithScope = vi.fn((cb: (scope: unknown) => void) => {
  const scope = {
    setTag: vi.fn(),
    setExtra: vi.fn(),
  };
  cb(scope);
  return scope;
});
const mockFlush = vi.fn().mockResolvedValue(true);
const mockClose = vi.fn().mockResolvedValue(undefined);

vi.mock('@sentry/node', () => ({
  init: mockInit,
  addBreadcrumb: mockAddBreadcrumb,
  captureException: mockCaptureException,
  captureMessage: mockCaptureMessage,
  captureFeedback: mockCaptureFeedback,
  withScope: mockWithScope,
  flush: mockFlush,
  close: mockClose,
}));

describe('error-reporting (Bugsink)', () => {
  beforeEach(() => {
    _resetForTesting();
    vi.clearAllMocks();
    delete process.env['LYNOX_BUGSINK_DSN'];
  });

  afterEach(() => {
    delete process.env['LYNOX_BUGSINK_DSN'];
  });

  describe('initErrorReporting', () => {
    it('returns false when no DSN is provided', async () => {
      const result = await initErrorReporting();
      expect(result).toBe(false);
      expect(isErrorReportingEnabled()).toBe(false);
      expect(mockInit).not.toHaveBeenCalled();
    });

    it('returns true when DSN is provided as argument', async () => {
      const result = await initErrorReporting('https://key@bugsink.example.com/123');
      expect(result).toBe(true);
      expect(isErrorReportingEnabled()).toBe(true);
      expect(mockInit).toHaveBeenCalledOnce();
      expect(mockInit).toHaveBeenCalledWith(
        expect.objectContaining({
          dsn: 'https://key@bugsink.example.com/123',
          sampleRate: 1.0,
          tracesSampleRate: 0,
          attachStacktrace: true,
          maxBreadcrumbs: 50,
        }),
      );
    });

    it('reads DSN from env var', async () => {
      process.env['LYNOX_BUGSINK_DSN'] = 'https://env@bugsink.example.com/456';
      const result = await initErrorReporting();
      expect(result).toBe(true);
      expect(mockInit).toHaveBeenCalledWith(
        expect.objectContaining({ dsn: 'https://env@bugsink.example.com/456' }),
      );
    });

    it('only initializes once', async () => {
      await initErrorReporting('https://key@bugsink.example.com/123');
      await initErrorReporting('https://key@bugsink.example.com/456');
      expect(mockInit).toHaveBeenCalledOnce();
    });

    it('sets release with lynox@ prefix', async () => {
      await initErrorReporting('https://key@bugsink.example.com/123');
      expect(mockInit).toHaveBeenCalledWith(
        expect.objectContaining({
          release: expect.stringMatching(/^lynox@/),
        }),
      );
    });

    it('configures beforeBreadcrumb to strip PII', async () => {
      await initErrorReporting('https://key@bugsink.example.com/123');
      const config = mockInit.mock.calls[0]![0] as { beforeBreadcrumb: (b: Record<string, unknown>) => unknown };
      const breadcrumb = {
        data: { prompt: 'secret', response: 'also secret', content: 'pii', tool: 'bash' },
      };
      const result = config.beforeBreadcrumb(breadcrumb) as { data: Record<string, unknown> };
      expect(result.data['prompt']).toBeUndefined();
      expect(result.data['response']).toBeUndefined();
      expect(result.data['content']).toBeUndefined();
      expect(result.data['tool']).toBe('bash');
    });

    it('configures beforeSend to strip request data', async () => {
      await initErrorReporting('https://key@bugsink.example.com/123');
      const config = mockInit.mock.calls[0]![0] as { beforeSend: (e: Record<string, unknown>) => unknown };
      const event = { request: { data: 'user prompt', url: '/api' } };
      const result = config.beforeSend(event) as { request: Record<string, unknown> };
      expect(result.request['data']).toBeUndefined();
      expect(result.request['url']).toBe('/api');
    });
  });

  describe('breadcrumbs (no-op when disabled)', () => {
    it('addToolBreadcrumb is safe no-op', () => {
      addToolBreadcrumb('bash', true, 150);
      expect(mockAddBreadcrumb).not.toHaveBeenCalled();
    });

    it('addLLMBreadcrumb is safe no-op', () => {
      addLLMBreadcrumb('claude-sonnet', 1000, 500);
      expect(mockAddBreadcrumb).not.toHaveBeenCalled();
    });
  });

  describe('breadcrumbs (enabled)', () => {
    beforeEach(async () => {
      await initErrorReporting('https://key@bugsink.example.com/123');
    });

    it('addToolBreadcrumb records tool execution', () => {
      addToolBreadcrumb('bash', true, 150);
      expect(mockAddBreadcrumb).toHaveBeenCalledWith({
        category: 'tool',
        message: 'bash OK',
        level: 'info',
        data: { tool: 'bash', duration_ms: 150, success: true },
      });
    });

    it('addToolBreadcrumb records failure as warning', () => {
      addToolBreadcrumb('http_request', false, 3000);
      expect(mockAddBreadcrumb).toHaveBeenCalledWith({
        category: 'tool',
        message: 'http_request FAIL',
        level: 'warning',
        data: { tool: 'http_request', duration_ms: 3000, success: false },
      });
    });

    it('addLLMBreadcrumb records model and tokens', () => {
      addLLMBreadcrumb('claude-3-5-sonnet-20241022', 2000, 800);
      expect(mockAddBreadcrumb).toHaveBeenCalledWith({
        category: 'llm',
        message: 'claude-3-5-sonnet-20241022 in=2000 out=800',
        level: 'info',
        data: { model: 'claude-3-5-sonnet-20241022', input_tokens: 2000, output_tokens: 800 },
      });
    });
  });

  describe('error capture', () => {
    it('captureError is safe no-op when disabled', () => {
      captureError(new Error('test'));
      expect(mockCaptureException).not.toHaveBeenCalled();
    });

    it('captureError captures when enabled', async () => {
      await initErrorReporting('https://key@bugsink.example.com/123');
      const err = new Error('test');
      captureError(err);
      expect(mockCaptureException).toHaveBeenCalledWith(err);
    });

    it('captureLynoxError sets tags and safe extras', async () => {
      await initErrorReporting('https://key@bugsink.example.com/123');
      const { ExecutionError } = await import('./errors.js');
      const err = new ExecutionError('Tool failed', {
        toolName: 'bash',
        runId: 'run-123',
        // Unsafe key — should NOT be forwarded
        userInput: 'sensitive prompt',
      });
      captureLynoxError(err);

      expect(mockWithScope).toHaveBeenCalledOnce();
      const scope = (mockWithScope.mock.results[0]!.value) as { setTag: ReturnType<typeof vi.fn>; setExtra: ReturnType<typeof vi.fn> };
      expect(scope.setTag).toHaveBeenCalledWith('error.code', 'EXECUTION_ERROR');
      expect(scope.setTag).toHaveBeenCalledWith('error.type', 'ExecutionError');
      expect(scope.setExtra).toHaveBeenCalledWith('toolName', 'bash');
      expect(scope.setExtra).toHaveBeenCalledWith('runId', 'run-123');
      // userInput is NOT in SAFE_CONTEXT_KEYS — should not be sent
      expect(scope.setExtra).not.toHaveBeenCalledWith('userInput', expect.anything());
    });
  });

  describe('user feedback', () => {
    it('returns null when disabled', async () => {
      const result = await captureUserFeedback({ name: 'User', comments: 'Bug!' });
      expect(result).toBeNull();
    });

    it('captures feedback when enabled', async () => {
      await initErrorReporting('https://key@bugsink.example.com/123');
      const result = await captureUserFeedback({ name: 'Rafael', comments: 'Wrong result' });
      expect(result).toBe('event-123');
      expect(mockCaptureMessage).toHaveBeenCalledWith('User bug report', 'info');
      expect(mockCaptureFeedback).toHaveBeenCalledWith({
        name: 'Rafael',
        message: 'Wrong result',
        associatedEventId: 'event-123',
      });
    });
  });

  describe('shutdown', () => {
    it('is safe when not initialized', async () => {
      await expect(shutdownErrorReporting()).resolves.toBeUndefined();
      expect(mockFlush).not.toHaveBeenCalled();
    });

    it('flushes and closes when enabled', async () => {
      await initErrorReporting('https://key@bugsink.example.com/123');
      await shutdownErrorReporting();
      expect(mockFlush).toHaveBeenCalledWith(5000);
      expect(mockClose).toHaveBeenCalled();
    });
  });

  describe('isErrorReportingEnabled', () => {
    it('false by default', () => {
      expect(isErrorReportingEnabled()).toBe(false);
    });

    it('true after init with DSN', async () => {
      await initErrorReporting('https://key@bugsink.example.com/123');
      expect(isErrorReportingEnabled()).toBe(true);
    });
  });
});

/**
 * beforeSend/beforeBreadcrumb scrubbing.
 *
 * Bugsink is first-party and self-hosted, but `captureException(error)` ships
 * `error.message` verbatim, and the scrubbing that existed was a denylist over
 * four named breadcrumb keys plus `event.request.data`. A credential
 * interpolated into an error string left the instance untouched.
 *
 * The scope is deliberately credential SHAPES, not PII, and the last test pins
 * that boundary rather than leaving it to be inferred — a reader who assumed PII
 * was covered would draw exactly the wrong conclusion from a green suite.
 */
describe('error-reporting scrubbing', () => {
  const initMock = vi.mocked(mockInit);

  /** Init with a DSN and hand back the hooks Sentry was configured with. */
  async function hooks(): Promise<{
    beforeSend: (e: Record<string, unknown>) => Record<string, unknown> | null;
    beforeBreadcrumb: (b: Record<string, unknown>) => Record<string, unknown> | null;
  }> {
    _resetForTesting();
    vi.clearAllMocks();
    await initErrorReporting('https://key@bugs.example.com/1');
    const opts = initMock.mock.calls[0]?.[0] as {
      beforeSend: (e: Record<string, unknown>) => Record<string, unknown> | null;
      beforeBreadcrumb: (b: Record<string, unknown>) => Record<string, unknown> | null;
    };
    expect(opts, 'Sentry.init must have been called with hooks').toBeDefined();
    return opts;
  }

  /** Build an event whose exception message carries `text`. */
  const eventWith = (text: string): Record<string, unknown> => ({
    exception: { values: [{ type: 'Error', value: text }] },
  });

  const firstValue = (e: Record<string, unknown>): string =>
    ((e['exception'] as { values: { value: string }[] }).values[0] as { value: string }).value;

  it('masks a provider key interpolated into an exception message', async () => {
    const { beforeSend } = await hooks();
    const key = `sk-ant-${'A'.repeat(40)}`;
    const out = beforeSend(eventWith(`LLM call failed for key ${key} on attempt 2`));
    expect(out).not.toBeNull();
    const value = firstValue(out as Record<string, unknown>);
    expect(value, 'the raw key must not survive').not.toContain(key);
    expect(value, 'the masked form keeps the last four for correlation').toContain('***');
    expect(value, 'the surrounding message must survive — this is a scrubber, not a deleter').toContain(
      'on attempt 2',
    );
  });

  it('masks a bearer token and a JWT in the same message', async () => {
    const { beforeSend } = await hooks();
    const jwt = `eyJ${'a'.repeat(20)}.eyJ${'b'.repeat(20)}.${'c'.repeat(20)}`;
    const bearer = `Bearer ${'x'.repeat(40)}`;
    const out = beforeSend(eventWith(`upstream rejected: ${bearer} / ${jwt}`));
    const value = firstValue(out as Record<string, unknown>);
    expect(value).not.toContain('x'.repeat(40));
    expect(value).not.toContain(jwt);
  });

  it('masks every exception in the chain, not only the first', async () => {
    // A wrapped error ships as several `values`. Masking one of them and calling
    // it done is how a cause chain leaks what the outer message did not.
    const { beforeSend } = await hooks();
    const key = `sk-ant-${'B'.repeat(40)}`;
    const out = beforeSend({
      exception: {
        values: [
          { type: 'Error', value: 'wrapper: request failed' },
          { type: 'Error', value: `cause: bad key ${key}` },
        ],
      },
    });
    const values = (out as { exception: { values: { value: string }[] } }).exception.values;
    expect(values[1]?.value).not.toContain(key);
  });

  it('masks a captureMessage payload in both of its shapes', async () => {
    const { beforeSend } = await hooks();
    const key = `sk-ant-${'C'.repeat(40)}`;

    const plain = beforeSend({ message: `boot failed with ${key}` });
    expect((plain as { message: string }).message).not.toContain(key);

    const structured = beforeSend({ message: { message: `raw ${key}`, formatted: `fmt ${key}` } });
    const m = (structured as { message: { message: string; formatted: string } }).message;
    expect(m.message).not.toContain(key);
    expect(m.formatted).not.toContain(key);
  });

  it('masks a breadcrumb message', async () => {
    const { beforeBreadcrumb } = await hooks();
    const key = `sk-ant-${'D'.repeat(40)}`;
    const out = beforeBreadcrumb({ message: `calling provider with ${key}` });
    expect((out as { message: string }).message).not.toContain(key);
  });

  it('still strips request bodies', async () => {
    const { beforeSend } = await hooks();
    const out = beforeSend({ request: { data: { prompt: 'user text' }, url: 'https://x/y' } });
    const req = (out as { request: Record<string, unknown> }).request;
    expect(req['data']).toBeUndefined();
    expect(req['url'], 'only the body goes — the URL is diagnostic').toBe('https://x/y');
  });

  it('leaves an event with no exception, message or request untouched', async () => {
    const { beforeSend } = await hooks();
    const out = beforeSend({ level: 'info' });
    expect(out).toEqual({ level: 'info' });
  });

  it('masks the credential prefixes the first fixture happened to miss', async () => {
    // The original fixture was `sk-ant-` + 40 A's, which the alnum rule catches.
    // Real OpenAI project keys carry `-` and `_` INSIDE the token, so that rule
    // stopped after four characters and the key shipped verbatim. The fixture
    // was the reason it looked covered — measured 2026-08-24.
    const { beforeSend } = await hooks();
    const cases = [
      'sk-proj-Ab1Cd2Ef3Gh4Ij5_Kl6Mn7-Op8Qr9St0Uv1Wx2Yz3',
      'sk-svcacct-Ab1Cd2Ef3_Gh4Ij5-Kl6Mn7Op8Qr9St0',
      'postgres://lynox:Hunter2Pw@db.internal:5432/lynox',
      'https://admin:s3cretpw@ops.example.com/admin',
      'a'.repeat(64),
    ];
    for (const secret of cases) {
      const out = beforeSend(eventWith(`connect failed: ${secret}`));
      expect(firstValue(out as Record<string, unknown>), `still leaks: ${secret}`).not.toContain(secret);
    }
  });

  it('does not mask an ordinary URL or a stack frame path', async () => {
    // The counter-direction. Turning the generic catcher on for this path buys
    // the 64-hex case above; it must not cost every path and query in a trace.
    const { beforeSend } = await hooks();
    const msg = 'GET https://api.example.com/v1/users?id=3 failed at /app/dist/core/session.js:1237:14';
    const out = beforeSend(eventWith(msg));
    expect(firstValue(out as Record<string, unknown>)).toBe(msg);
  });

  it('drops request headers and cookies outright', async () => {
    // The @sentry/node http integration is default-on and attaches these. A
    // session cookie or a bearer in the error store is an account takeover for
    // anyone who can read it, and a MASKED session cookie has no diagnostic
    // value — so they go entirely rather than being scrubbed.
    const { beforeSend } = await hooks();
    const out = beforeSend({
      request: {
        headers: { cookie: 'lynox_session=abcdef', authorization: 'Bearer xyz', 'user-agent': 'curl' },
        cookies: { lynox_session: 'abcdef' },
        query_string: `key=sk-ant-${'F'.repeat(40)}`,
        url: 'https://x/y',
      },
    });
    const req = (out as { request: Record<string, unknown> }).request;
    expect(req['headers'], 'headers carry cookie and authorization').toBeUndefined();
    expect(req['cookies']).toBeUndefined();
    expect(req['query_string'], 'the query string is masked, not dropped — it is diagnostic').not.toContain('F'.repeat(40));
    expect(req['url'], 'the URL stays').toBe('https://x/y');
  });

  it('masks breadcrumb data, which the four named deletes never covered', async () => {
    // The http integration writes the raw query string under `http.query`, a key
    // the existing denylist does not name. Walking beats growing the list.
    const { beforeBreadcrumb } = await hooks();
    const key = `sk-ant-${'G'.repeat(40)}`;
    const out = beforeBreadcrumb({ data: { 'http.query': `token=${key}`, nested: { deep: [`${key}`] } } });
    expect(JSON.stringify(out), 'no credential anywhere in the breadcrumb').not.toContain(key);
  });

  it('masks extra, tags and contexts', async () => {
    const { beforeSend } = await hooks();
    const key = `sk-ant-${'H'.repeat(40)}`;
    const out = beforeSend({ extra: { conf: { dsn: key } }, tags: { k: key }, contexts: { app: { note: key } } });
    expect(JSON.stringify(out)).not.toContain(key);
  });

  it('survives a cyclic structure rather than hanging', async () => {
    // Event payloads are attacker-influenced in SHAPE as well as content.
    const { beforeSend } = await hooks();
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic['self'] = cyclic;
    expect(() => beforeSend({ extra: cyclic })).not.toThrow();
  });

  it('does NOT mask PII — the boundary, pinned so nobody infers otherwise', async () => {
    // Deliberate scope, not an oversight. A PII denylist over free text has an
    // unbounded form space while the set of `throw new Error(`…${…}`)` sites
    // feeding it keeps growing, and Bugsink is self-hosted — a stripped stack
    // trace is a diagnostic loss with no third party on the other side. Whether
    // to take that trade is tracked in the register as a risk decision.
    const { beforeSend } = await hooks();
    const out = beforeSend(eventWith('failed to send mail to angela.meier@example.com about Q3 invoice'));
    const value = firstValue(out as Record<string, unknown>);
    expect(value, 'if this ever starts failing, the scope changed and the register row must too').toContain(
      'angela.meier@example.com',
    );
  });
});
