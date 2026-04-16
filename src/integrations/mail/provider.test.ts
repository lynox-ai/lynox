import { describe, expect, it } from 'vitest';
import { MailError, type MailErrorCode } from './provider.js';

describe('MailError', () => {
  it('carries code and message', () => {
    const err = new MailError('auth_failed', 'bad password');
    expect(err.code).toBe('auth_failed');
    expect(err.message).toBe('bad password');
    expect(err.name).toBe('MailError');
    expect(err).toBeInstanceOf(Error);
  });

  it('preserves cause', () => {
    const inner = new Error('underlying');
    const err = new MailError('connection_failed', 'failed to connect', { cause: inner });
    expect(err.cause).toBe(inner);
  });

  it('accepts every documented code', () => {
    const codes: MailErrorCode[] = [
      'auth_failed',
      'connection_failed',
      'tls_failed',
      'not_found',
      'send_rejected',
      'rate_limited',
      'timeout',
      'unsupported',
      'unknown',
    ];
    for (const code of codes) {
      const err = new MailError(code, code);
      expect(err.code).toBe(code);
    }
  });
});
