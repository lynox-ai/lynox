import { describe, it, expect } from 'vitest';

import { resolveDefaultOrigin } from './index.js';

describe('resolveDefaultOrigin (--http-api boot)', () => {
  it('returns undefined when operator already set ORIGIN (override wins)', () => {
    expect(
      resolveDefaultOrigin({
        origin: 'https://my.example.com',
        allowedOrigins: undefined,
        tlsCert: undefined,
        port: 3100,
      }),
    ).toBeUndefined();
  });

  it('treats empty-string ORIGIN as unset (don\'t propagate ""):', () => {
    expect(
      resolveDefaultOrigin({
        origin: '',
        allowedOrigins: undefined,
        tlsCert: undefined,
        port: 3100,
      }),
    ).toBe('http://localhost:3100');
  });

  it('uses first entry of LYNOX_ALLOWED_ORIGINS when present', () => {
    expect(
      resolveDefaultOrigin({
        origin: undefined,
        allowedOrigins: 'https://a.example.com,https://b.example.com',
        tlsCert: undefined,
        port: 3100,
      }),
    ).toBe('https://a.example.com');
  });

  it('trims whitespace around the first allowed origin', () => {
    expect(
      resolveDefaultOrigin({
        origin: undefined,
        allowedOrigins: '   https://a.example.com ,https://b.example.com',
        tlsCert: undefined,
        port: 3100,
      }),
    ).toBe('https://a.example.com');
  });

  it('falls back to http://localhost:<port> when no allowed-origins and no TLS', () => {
    expect(
      resolveDefaultOrigin({
        origin: undefined,
        allowedOrigins: undefined,
        tlsCert: undefined,
        port: 3000,
      }),
    ).toBe('http://localhost:3000');
  });

  it('uses https when LYNOX_TLS_CERT is set', () => {
    expect(
      resolveDefaultOrigin({
        origin: undefined,
        allowedOrigins: undefined,
        tlsCert: '/etc/ssl/cert.pem',
        port: 8443,
      }),
    ).toBe('https://localhost:8443');
  });

  it('skips empty LYNOX_ALLOWED_ORIGINS string and uses localhost fallback', () => {
    expect(
      resolveDefaultOrigin({
        origin: undefined,
        allowedOrigins: '',
        tlsCert: undefined,
        port: 3100,
      }),
    ).toBe('http://localhost:3100');
  });

  it('uses the resolved port (not the LYNOX_HTTP_PORT default) in the fallback', () => {
    expect(
      resolveDefaultOrigin({
        origin: undefined,
        allowedOrigins: undefined,
        tlsCert: undefined,
        port: 9999,
      }),
    ).toBe('http://localhost:9999');
  });
});
