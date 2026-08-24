/**
 * What happens when the SCRUBBER itself fails.
 *
 * Its own file because the mock has to replace `secret-store` for the whole
 * module graph, and the main scrubbing suite needs the real masker.
 *
 * The behaviour under test is a deliberate choice with two wrong answers either
 * side of it. Returning the raw text on failure ships the credential the masker
 * exists to catch — a scrubber that fails open is worse than none, because the
 * pipeline reads as protected. Dropping the whole event loses an error report to
 * a bug in a scrubber, which is how a diagnostic surface quietly goes dark. So
 * the field is replaced and the event still arrives.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockInit = vi.fn();
vi.mock('@sentry/node', () => ({
  init: mockInit,
  addBreadcrumb: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  captureFeedback: vi.fn(),
  withScope: vi.fn(),
  flush: vi.fn().mockResolvedValue(true),
  close: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./secret-store.js', () => ({
  maskSecretPatterns: () => {
    throw new Error('masker exploded');
  },
}));

const { initErrorReporting, _resetForTesting } = await import('./error-reporting.js');

describe('error-reporting when the masker throws', () => {
  beforeEach(() => {
    _resetForTesting();
    vi.clearAllMocks();
  });

  it('redacts the field and still delivers the event', async () => {
    await initErrorReporting('https://key@bugs.example.com/1');
    const opts = mockInit.mock.calls[0]?.[0] as {
      beforeSend: (e: Record<string, unknown>) => Record<string, unknown> | null;
    };
    const key = `sk-ant-${'E'.repeat(40)}`;
    const out = opts.beforeSend({
      exception: { values: [{ type: 'Error', value: `failed with ${key}` }] },
      level: 'error',
    });

    expect(out, 'the event must survive a scrubber bug').not.toBeNull();
    const value = (out as { exception: { values: { value: string }[] } }).exception.values[0]?.value;
    expect(value, 'fail-open would ship the credential verbatim').not.toContain(key);
    expect(value).toBe('[redacted: masking failed]');
    expect((out as { level: string }).level, 'the rest of the event is untouched').toBe('error');
  });
});
