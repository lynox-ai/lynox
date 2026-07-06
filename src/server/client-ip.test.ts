import { describe, it, expect, afterEach } from 'vitest';
import { resolveClientIp, type ProxyAwareRequest } from './client-ip.js';

function makeReq(remoteAddress: string | undefined, xff?: string | string[]): ProxyAwareRequest {
  return {
    socket: { remoteAddress },
    headers: xff === undefined ? {} : { 'x-forwarded-for': xff },
  };
}

describe('resolveClientIp', () => {
  afterEach(() => {
    delete process.env['LYNOX_TRUSTED_PROXY_HOPS'];
  });

  describe('trustProxy = false (no proxy trusted)', () => {
    it('returns the direct socket peer, ignoring any X-Forwarded-For', () => {
      expect(resolveClientIp(makeReq('1.2.3.4', '9.9.9.9'), false)).toBe('1.2.3.4');
    });

    it('returns "unknown" when the socket has no remote address', () => {
      expect(resolveClientIp(makeReq(undefined, '9.9.9.9'), false)).toBe('unknown');
    });
  });

  describe('trustProxy = true, single proxy (default 1 hop)', () => {
    it('takes the sole appended entry when the client forged nothing', () => {
      expect(resolveClientIp(makeReq('10.0.0.1', '1.2.3.4'), true)).toBe('1.2.3.4');
    });

    it('SECURITY: ignores a client-forged left-most entry, takes the proxy-appended rightmost', () => {
      // Client sent `X-Forwarded-For: 9.9.9.9`; the proxy appended the real peer.
      expect(resolveClientIp(makeReq('10.0.0.1', '9.9.9.9, 1.2.3.4'), true)).toBe('1.2.3.4');
    });

    it('SECURITY: a long forged prefix cannot mint a fresh identity — always the last hop', () => {
      expect(resolveClientIp(makeReq('10.0.0.1', 'a, b, c, d, 1.2.3.4'), true)).toBe('1.2.3.4');
    });

    it('trims surrounding whitespace and drops empty entries', () => {
      expect(resolveClientIp(makeReq('10.0.0.1', ' 9.9.9.9 ,, 1.2.3.4 '), true)).toBe('1.2.3.4');
    });

    it('falls back to the socket peer when X-Forwarded-For is absent', () => {
      expect(resolveClientIp(makeReq('10.0.0.1'), true)).toBe('10.0.0.1');
    });

    it('coalesces multiple X-Forwarded-For headers (array) into one chain, rightmost wins', () => {
      expect(resolveClientIp(makeReq('10.0.0.1', ['9.9.9.9', '1.2.3.4']), true)).toBe('1.2.3.4');
    });
  });

  describe('LYNOX_TRUSTED_PROXY_HOPS (chained proxies)', () => {
    it('picks the entry N hops from the right when a CDN sits ahead of the proxy', () => {
      process.env['LYNOX_TRUSTED_PROXY_HOPS'] = '2';
      // forged, real-client, cdn-edge  → 2 trusted trailing hops → real-client
      expect(resolveClientIp(makeReq('10.0.0.1', 'evil, 1.2.3.4, 8.8.8.8'), true)).toBe('1.2.3.4');
    });

    it('SECURITY: fails safe to the socket peer (never the left-most) when hops exceeds the real chain', () => {
      process.env['LYNOX_TRUSTED_PROXY_HOPS'] = '2';
      // Only one entry but 2 hops configured → negative index → socket peer, NOT `9.9.9.9`.
      expect(resolveClientIp(makeReq('10.0.0.1', '9.9.9.9'), true)).toBe('10.0.0.1');
    });

    it('ignores a non-positive / non-numeric hop count and defaults to 1', () => {
      process.env['LYNOX_TRUSTED_PROXY_HOPS'] = '0';
      expect(resolveClientIp(makeReq('10.0.0.1', '9.9.9.9, 1.2.3.4'), true)).toBe('1.2.3.4');
      process.env['LYNOX_TRUSTED_PROXY_HOPS'] = 'garbage';
      expect(resolveClientIp(makeReq('10.0.0.1', '9.9.9.9, 1.2.3.4'), true)).toBe('1.2.3.4');
    });
  });

  describe('address normalization', () => {
    it('strips the IPv4-mapped-IPv6 ::ffff: prefix', () => {
      expect(resolveClientIp(makeReq('::ffff:1.2.3.4'), false)).toBe('1.2.3.4');
      expect(resolveClientIp(makeReq('10.0.0.1', '::ffff:1.2.3.4'), true)).toBe('1.2.3.4');
    });

    it('strips both the ::ffff: prefix AND a trailing :port on a mapped address', () => {
      expect(resolveClientIp(makeReq('10.0.0.1', '::ffff:1.2.3.4:56789'), true)).toBe('1.2.3.4');
      expect(resolveClientIp(makeReq('10.0.0.1', '[::ffff:1.2.3.4]:443'), true)).toBe('1.2.3.4');
    });

    it('strips a trailing :port from an IPv4 address', () => {
      expect(resolveClientIp(makeReq('10.0.0.1', '1.2.3.4:56789'), true)).toBe('1.2.3.4');
    });

    it('strips the port from a bracketed IPv6 address but keeps the address', () => {
      expect(resolveClientIp(makeReq('10.0.0.1', '[2001:db8::1]:443'), true)).toBe('2001:db8::1');
    });

    it('leaves a bare IPv6 address (multiple colons, no brackets) intact', () => {
      expect(resolveClientIp(makeReq('10.0.0.1', '2001:db8::1'), true)).toBe('2001:db8::1');
    });
  });
});
