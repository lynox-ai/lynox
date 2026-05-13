import { describe, it, expect, vi } from 'vitest';
import { isPrivateIP, assertPublicHost, assertPublicUrl, fetchWithPublicRedirects } from './network-guard.js';

describe('isPrivateIP', () => {
  describe('IPv4', () => {
    it.each([
      ['127.0.0.1', true],
      ['127.255.255.255', true],
      ['10.0.0.1', true],
      ['172.16.0.1', true],
      ['172.31.255.255', true],
      ['172.15.0.1', false],
      ['172.32.0.1', false],
      ['192.168.1.1', true],
      ['169.254.169.254', true], // AWS / GCP metadata
      ['100.64.0.1', true],      // CGNAT
      ['198.18.0.1', true],      // benchmarking
      ['0.0.0.0', true],
      ['224.0.0.1', true],       // multicast
      ['8.8.8.8', false],
      ['1.1.1.1', false],
    ])('isPrivateIP(%s) → %s', (ip, expected) => {
      expect(isPrivateIP(ip)).toBe(expected);
    });

    it('rejects malformed v4 with out-of-range octets', () => {
      expect(isPrivateIP('999.0.0.1')).toBe(false);
    });
  });

  describe('IPv6', () => {
    it.each([
      ['::1', true],
      ['::', true],
      ['fe80::1', true],
      ['fc00::1', true],
      ['fd12::34', true],
      ['ff02::1', true],
      ['2001:4860:4860::8888', false],
    ])('isPrivateIP(%s) → %s', (ip, expected) => {
      expect(isPrivateIP(ip)).toBe(expected);
    });

    it('catches IPv4-mapped IPv6 loopback', () => {
      // Both lower and upper hex forms.
      expect(isPrivateIP('::ffff:127.0.0.1')).toBe(true);
      expect(isPrivateIP('::FFFF:127.0.0.1')).toBe(true);
    });

    it('catches IPv4-mapped IPv6 private ranges', () => {
      expect(isPrivateIP('::ffff:10.0.0.1')).toBe(true);
      expect(isPrivateIP('::ffff:192.168.1.1')).toBe(true);
      expect(isPrivateIP('::ffff:169.254.169.254')).toBe(true);
    });

    it('catches IPv4-mapped IPv6 in hex-pair form (::ffff:7f00:1 = 127.0.0.1)', () => {
      // WHATWG URL parser keeps these in hex; the dotted-only check would miss them.
      expect(isPrivateIP('::ffff:7f00:1')).toBe(true);     // 127.0.0.1
      expect(isPrivateIP('::ffff:7f00:0001')).toBe(true);
      expect(isPrivateIP('::ffff:a00:1')).toBe(true);      // 10.0.0.1
      expect(isPrivateIP('::ffff:a9fe:a9fe')).toBe(true);  // 169.254.169.254 (metadata)
      expect(isPrivateIP('::FFFF:7F00:1')).toBe(true);     // upper-case
      // A public IPv4-mapped address must still pass the check.
      expect(isPrivateIP('::ffff:808:808')).toBe(false);   // 8.8.8.8
    });
  });
});

describe('assertPublicHost', () => {
  it('rejects literal private IPv4', async () => {
    await expect(assertPublicHost('169.254.169.254')).rejects.toThrow(/private IP/i);
  });

  it('rejects literal IPv6 loopback', async () => {
    await expect(assertPublicHost('::1')).rejects.toThrow(/private IP/i);
  });

  it('rejects bracketed IPv6 literal', async () => {
    await expect(assertPublicHost('[::1]')).rejects.toThrow(/private IP/i);
  });

  it('accepts a public hostname (or DNS failure — which is treated as inconclusive, callers must follow up)', async () => {
    // Use an obviously-non-resolvable hostname so we don't depend on real DNS in CI.
    // The catch(()=>[]) inside makes "no records" pass the check — DNS failures
    // are not the SSRF guard's responsibility; the subsequent fetch handles them.
    await expect(assertPublicHost('this-hostname-does-not-exist.invalid')).resolves.toBeUndefined();
  });
});

describe('assertPublicUrl', () => {
  it('rejects non-http(s) protocols', async () => {
    await expect(assertPublicUrl('file:///etc/passwd')).rejects.toThrow(/protocol/i);
    await expect(assertPublicUrl('ftp://example.com/x')).rejects.toThrow(/protocol/i);
  });

  it('rejects private-IP URLs', async () => {
    await expect(assertPublicUrl('http://10.0.0.1/admin')).rejects.toThrow(/private IP/i);
    await expect(assertPublicUrl('https://169.254.169.254/latest/meta-data/')).rejects.toThrow(/private IP/i);
  });
});

describe('fetchWithPublicRedirects', () => {
  it('rejects an initial private-IP target before fetching', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new Error('fetch should never be called'),
    );
    try {
      await expect(
        fetchWithPublicRedirects('http://169.254.169.254/latest/meta-data/'),
      ).rejects.toThrow(/private IP/i);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('rejects a redirect to a private IP', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: 'http://10.0.0.1/internal' } }),
    );
    try {
      await expect(
        fetchWithPublicRedirects('https://api.fake.test/start'),
      ).rejects.toThrow(/private IP/i);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('returns the final response after a public→public redirect', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: 'https://api2.fake.test/final' } }),
      )
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    try {
      const res = await fetchWithPublicRedirects('https://api1.fake.test/start');
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('ok');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('honours maxRedirects override', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 302, headers: { location: 'https://b.fake.test/' } }),
    );
    try {
      await expect(
        fetchWithPublicRedirects('https://a.fake.test/', {}, { maxRedirects: 1 }),
      ).rejects.toThrow(/too many redirects/i);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
