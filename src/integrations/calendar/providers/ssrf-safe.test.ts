// Tests for the SSRF guard (PRD §S2). Pure-function path for IP-range
// rejection; assertSafeUrl exercises URL parsing + scheme check (DNS is
// mocked out so tests stay offline).

import { describe, expect, it, beforeEach } from 'vitest';
import { isBlockedAddress, assertSafeUrl } from './ssrf-safe.js';
import { CalendarError } from '../provider.js';

describe('isBlockedAddress', () => {
  describe('IPv4 — blocks private + loopback + link-local', () => {
    const blocked = [
      '0.0.0.0',
      '127.0.0.1',
      '127.255.255.255',
      '10.0.0.1',
      '10.255.255.255',
      '169.254.169.254', // cloud metadata
      '169.254.0.1',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.0.1',
      '192.168.1.1',
      '100.64.0.1',     // RFC6598 CGNAT
      '100.127.255.255',
    ];
    for (const ip of blocked) {
      it(`blocks ${ip}`, () => expect(isBlockedAddress(ip)).toBe(true));
    }
  });

  describe('IPv4 — allows public', () => {
    const allowed = [
      '8.8.8.8',
      '1.1.1.1',
      '172.32.0.1',     // outside 172.16/12
      '172.15.0.1',     // outside 172.16/12 (lower bound)
      '192.167.0.1',    // outside 192.168/16
      '100.63.0.1',     // outside 100.64/10
      '100.128.0.1',    // outside 100.64/10
      '93.184.216.34',  // example.com
    ];
    for (const ip of allowed) {
      it(`allows ${ip}`, () => expect(isBlockedAddress(ip)).toBe(false));
    }
  });

  describe('IPv6 — blocks private/loopback/link-local', () => {
    const blocked = [
      '::',
      '::1',
      '::ffff:127.0.0.1',
      '::ffff:10.0.0.1',
      '::ffff:169.254.169.254',
      'fe80::1',
      'fe9f::1',
      'fea0::1',
      'febf::1',
      'fc00::1',
      'fd00::1',
    ];
    for (const ip of blocked) {
      it(`blocks ${ip}`, () => expect(isBlockedAddress(ip)).toBe(true));
    }
  });

  describe('IPv6 — allows public', () => {
    const allowed = [
      '2001:db8::1',  // documentation block (not technically public but not in blocked ranges either)
      '2606:4700:4700::1111', // 1.1.1.1's v6
      '::ffff:8.8.8.8',
    ];
    for (const ip of allowed) {
      it(`allows ${ip}`, () => expect(isBlockedAddress(ip)).toBe(false));
    }
  });

  it('returns false for non-IP strings', () => {
    expect(isBlockedAddress('not-an-ip')).toBe(false);
    expect(isBlockedAddress('')).toBe(false);
  });
});

describe('assertSafeUrl', () => {
  beforeEach(() => {
    delete process.env['LYNOX_CALENDAR_ALLOW_PRIVATE'];
  });

  it('throws CalendarError(malformed_event) on invalid URL', async () => {
    await expect(assertSafeUrl('not a url', 'test')).rejects.toThrow(CalendarError);
  });

  it('rejects file:// schemes', async () => {
    await expect(assertSafeUrl('file:///etc/passwd', 'test'))
      .rejects.toThrow(/only http\(s\)/);
  });

  it('rejects gopher:// schemes', async () => {
    await expect(assertSafeUrl('gopher://example.com/', 'test'))
      .rejects.toThrow(/only http\(s\)/);
  });

  it('rejects IPv4-literal targets in private ranges (no DNS lookup needed)', async () => {
    await expect(assertSafeUrl('http://127.0.0.1:8200/', 'vault target'))
      .rejects.toThrow(/private\/loopback/);
    await expect(assertSafeUrl('http://169.254.169.254/latest/meta-data', 'metadata svc'))
      .rejects.toThrow(/private\/loopback/);
    await expect(assertSafeUrl('http://10.0.1.5/', 'rfc1918'))
      .rejects.toThrow(/private\/loopback/);
  });

  it('rejects IPv6-literal loopback', async () => {
    await expect(assertSafeUrl('http://[::1]/', 'test'))
      .rejects.toThrow(/private\/loopback/);
  });

  it('bypass via LYNOX_CALENDAR_ALLOW_PRIVATE=1 returns without throwing', async () => {
    process.env['LYNOX_CALENDAR_ALLOW_PRIVATE'] = '1';
    await expect(assertSafeUrl('http://127.0.0.1/', 'test')).resolves.toBeUndefined();
    await expect(assertSafeUrl('http://10.0.0.1/', 'test')).resolves.toBeUndefined();
  });
});
