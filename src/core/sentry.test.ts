import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  initSentry,
  shutdownSentry,
  addToolBreadcrumb,
  addLLMBreadcrumb,
  captureLynoxError,
  captureError,
  captureUserFeedback,
  isSentryEnabled,
  _resetForTesting,
} from './sentry.js';

// Mock @sentry/node
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

describe('sentry', () => {
  beforeEach(() => {
    _resetForTesting();
    vi.clearAllMocks();
    delete process.env['LYNOX_SENTRY_DSN'];
  });

  afterEach(() => {
    delete process.env['LYNOX_SENTRY_DSN'];
  });

  describe('initSentry', () => {
    it('returns false when no DSN is provided', async () => {
      const result = await initSentry();
      expect(result).toBe(false);
      expect(isSentryEnabled()).toBe(false);
      expect(mockInit).not.toHaveBeenCalled();
    });

    it('returns true when DSN is provided as argument', async () => {
      const result = await initSentry('https://key@sentry.io/123');
      expect(result).toBe(true);
      expect(isSentryEnabled()).toBe(true);
      expect(mockInit).toHaveBeenCalledOnce();
      expect(mockInit).toHaveBeenCalledWith(
        expect.objectContaining({
          dsn: 'https://key@sentry.io/123',
          sampleRate: 1.0,
          tracesSampleRate: 0,
          attachStacktrace: true,
          maxBreadcrumbs: 50,
        }),
      );
    });

    it('reads DSN from env var', async () => {
      process.env['LYNOX_SENTRY_DSN'] = 'https://env@sentry.io/456';
      const result = await initSentry();
      expect(result).toBe(true);
      expect(mockInit).toHaveBeenCalledWith(
        expect.objectContaining({ dsn: 'https://env@sentry.io/456' }),
      );
    });

    it('only initializes once', async () => {
      await initSentry('https://key@sentry.io/123');
      await initSentry('https://key@sentry.io/456');
      expect(mockInit).toHaveBeenCalledOnce();
    });

    it('sets release with lynox@ prefix', async () => {
      await initSentry('https://key@sentry.io/123');
      expect(mockInit).toHaveBeenCalledWith(
        expect.objectContaining({
          release: expect.stringMatching(/^lynox@/),
        }),
      );
    });

    it('configures beforeBreadcrumb to strip PII', async () => {
      await initSentry('https://key@sentry.io/123');
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
      await initSentry('https://key@sentry.io/123');
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
      await initSentry('https://key@sentry.io/123');
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
      await initSentry('https://key@sentry.io/123');
      const err = new Error('test');
      captureError(err);
      expect(mockCaptureException).toHaveBeenCalledWith(err);
    });

    it('captureLynoxError sets tags and safe extras', async () => {
      await initSentry('https://key@sentry.io/123');
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
      await initSentry('https://key@sentry.io/123');
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
      await expect(shutdownSentry()).resolves.toBeUndefined();
      expect(mockFlush).not.toHaveBeenCalled();
    });

    it('flushes and closes when enabled', async () => {
      await initSentry('https://key@sentry.io/123');
      await shutdownSentry();
      expect(mockFlush).toHaveBeenCalledWith(5000);
      expect(mockClose).toHaveBeenCalled();
    });
  });

  describe('isSentryEnabled', () => {
    it('false by default', () => {
      expect(isSentryEnabled()).toBe(false);
    });

    it('true after init with DSN', async () => {
      await initSentry('https://key@sentry.io/123');
      expect(isSentryEnabled()).toBe(true);
    });
  });
});
