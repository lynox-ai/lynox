import { describe, expect, it } from 'vitest';
import { MailError, listIdFromHeader, type MailErrorCode } from './provider.js';

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

describe('listIdFromHeader', () => {
  it('takes the list identifier between the brackets (RFC 2919)', () => {
    expect(listIdFromHeader('Acme News <news.acme.example>')).toBe('news.acme.example');
    expect(listIdFromHeader('<announcements.example.com>')).toBe('announcements.example.com');
  });

  it('takes the last bracketed part when the phrase holds brackets of its own', () => {
    expect(listIdFromHeader('"Team <dev>" <dev.acme.example>')).toBe('dev.acme.example');
  });

  it('takes a bare value whole', () => {
    expect(listIdFromHeader('  news.acme.example ')).toBe('news.acme.example');
  });

  it('gives nothing for a missing, empty, spaced, too long or control-carrying value', () => {
    expect(listIdFromHeader(undefined)).toBeUndefined();
    expect(listIdFromHeader('<>')).toBeUndefined();
    expect(listIdFromHeader('two words')).toBeUndefined();
    expect(listIdFromHeader(`<${'a'.repeat(256)}>`)).toBeUndefined();
    expect(listIdFromHeader('<a\u0007b.example>')).toBeUndefined();
    expect(listIdFromHeader(`<${'a'.repeat(255)}>`), 'CONTROL: 255 is allowed').toBe('a'.repeat(255));
    expect(listIdFromHeader(`<${'ä'.repeat(128)}>`), '256 octets in 128 characters').toBeUndefined();
    expect(listIdFromHeader(`<${'ä'.repeat(127)}>`), 'CONTROL: 254 octets').toBe('ä'.repeat(127));
    expect(listIdFromHeader('<news\u200B.acme.example>'), 'an invisible character').toBeUndefined();
    expect(listIdFromHeader('<news\u202E.acme.example>'), 'a direction override').toBeUndefined();
  });
});
