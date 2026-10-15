import { describe, it, expect } from 'vitest';
import { ambientCrossSiteRefusal, AMBIENT_CROSS_SITE_REFUSAL, crossSiteWriteRefusal, CROSS_SITE_WRITE_REFUSAL, droppedAllowedOrigins, droppedAllowedOriginWarning, hostRefusal, isOwnOriginByAddress, NO_SECRET_HOST_REFUSAL, normalizeAllowedOrigins } from './cross-site-write.js';

const base = { method: 'POST', origin: undefined, fetchSite: undefined, host: '127.0.0.1:3000', allowedOrigins: [] as string[] };
const decide = (over: Partial<typeof base> & { origin?: string; fetchSite?: string; host?: string }) =>
  crossSiteWriteRefusal({ ...base, ...over });

describe('crossSiteWriteRefusal — writes on a server without a secret', () => {
  it('refuses a write from another site', () => {
    expect(decide({ origin: 'https://evil.example' })).toBe(CROSS_SITE_WRITE_REFUSAL);
    expect(decide({ origin: 'null' })).toBe(CROSS_SITE_WRITE_REFUSAL);
    for (const method of ['PUT', 'PATCH', 'DELETE', 'post']) {
      expect(decide({ method, origin: 'https://evil.example' }), method).toBe(CROSS_SITE_WRITE_REFUSAL);
    }
  });

  it('does not judge a safe method, whatever its origin', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'get']) {
      expect(decide({ method, origin: 'https://evil.example', fetchSite: 'cross-site' }), method).toBeNull();
    }
  });

  it('accepts this server on localhost or by its IP address, and an allowed origin', () => {
    expect(decide({ origin: 'http://localhost:3000', host: 'localhost:3000' })).toBeNull();
    expect(decide({ origin: 'http://127.0.0.1:3000' })).toBeNull();
    expect(decide({ origin: 'http://[::1]:3000', host: '[::1]:3000' })).toBeNull();
    expect(decide({ origin: 'https://lynox.example.org', allowedOrigins: ['https://lynox.example.org'] })).toBeNull();
    expect(decide({ origin: 'http://192.168.1.20:3000', host: '192.168.1.20:3000' })).toBeNull();
    expect(decide({ origin: 'http://[fd00::20]:3000', host: '[fd00::20]:3000' })).toBeNull();
  });

  it('refuses another port on localhost: another program on this machine, not this server', () => {
    expect(decide({ origin: 'http://localhost:5173', host: 'localhost:3000' })).toBe(CROSS_SITE_WRITE_REFUSAL);
    expect(decide({ origin: 'http://127.0.0.1:5173' })).toBe(CROSS_SITE_WRITE_REFUSAL);
    expect(decide({ origin: 'http://[::1]:5173', host: '[::1]:3000' })).toBe(CROSS_SITE_WRITE_REFUSAL);
    // Listed, it counts: the Web UI's dev server is one such program.
    expect(decide({ origin: 'http://localhost:5173', host: 'localhost:3000', allowedOrigins: ['http://localhost:5173'] })).toBeNull();
  });

  it('refuses this server reached by a NAME unless the name is allowed', () => {
    // Host and Origin agree, and the name is not one the server was told to trust.
    expect(decide({ origin: 'http://lynox.lan:3000', host: 'lynox.lan:3000' })).toBe(CROSS_SITE_WRITE_REFUSAL);
    expect(decide({ origin: 'http://lynox.lan:3000', host: 'lynox.lan:3000', allowedOrigins: ['http://lynox.lan:3000'] })).toBeNull();
  });

  it('refuses an IP origin that is not this server', () => {
    expect(decide({ origin: 'http://192.168.1.21:3000', host: '192.168.1.20:3000' })).toBe(CROSS_SITE_WRITE_REFUSAL);
    // Same address, another port: another service on this machine, not this server.
    expect(decide({ origin: 'http://192.168.1.20:9999', host: '192.168.1.20:3000' })).toBe(CROSS_SITE_WRITE_REFUSAL);
    expect(decide({ origin: 'http://192.168.1.20:3000', host: undefined })).toBe(CROSS_SITE_WRITE_REFUSAL);
  });

  it('without Origin, reads Sec-Fetch-Site', () => {
    expect(decide({ fetchSite: 'cross-site' })).toBe(CROSS_SITE_WRITE_REFUSAL);
    expect(decide({ fetchSite: 'same-site' })).toBe(CROSS_SITE_WRITE_REFUSAL);
    expect(decide({ fetchSite: 'same-origin' })).toBeNull();
    expect(decide({ fetchSite: 'none' })).toBeNull();
  });

  it('ALLOWED ON PURPOSE: a write with neither header is not a browser and passes (curl, CLI, MCP)', () => {
    expect(decide({})).toBeNull();
    expect(decide({ origin: '' })).toBeNull();
  });
});

describe('hostRefusal — every request on a server without a secret', () => {
  const host = (h: string | undefined, allowed: string[] = []) => hostRefusal({ host: h, allowedOrigins: allowed });

  it('answers to localhost and to an IP address, any port', () => {
    for (const h of ['localhost', 'localhost:3000', '127.0.0.1:3000', '[::1]:3000', '192.168.1.20:3000', '[fd00::20]']) {
      expect(host(h), h).toBeNull();
    }
  });

  it('refuses a host NAME, which a page can point at this server', () => {
    for (const h of ['attacker.example', 'attacker.example:3000', 'lynox.lan:3000', '127.0.0.1.nip.io:3000', 'localhost.attacker.example']) {
      expect(host(h), h).toBe(NO_SECRET_HOST_REFUSAL);
    }
  });

  it('answers to the host of an allowed origin, on any port of it', () => {
    expect(host('lynox.lan:3000', ['http://lynox.lan:3000'])).toBeNull();
    expect(host('lynox.lan', ['https://lynox.lan'])).toBeNull();
    expect(host('other.lan:3000', ['http://lynox.lan:3000'])).toBe(NO_SECRET_HOST_REFUSAL);
  });

  it('ALLOWED ON PURPOSE: no Host header is not a browser and passes', () => {
    expect(host(undefined)).toBeNull();
    expect(host('')).toBeNull();
  });
});

describe('normalizeAllowedOrigins', () => {
  it('trims, drops empties, and reads a trailing slash as the origin', () => {
    expect(normalizeAllowedOrigins([' https://a.example/', '', 'http://b.example:8080', ' '])).toEqual(['https://a.example', 'http://b.example:8080']);
  });

  it('drops what is not an http(s) origin — a host without scheme would otherwise become `null`', () => {
    expect(new URL('lynox.lan:3000').origin).toBe('null'); // the trap, measured on the parser
    expect(normalizeAllowedOrigins(['lynox.lan:3000', 'localhost:3000', 'null', 'file:///x', 'chrome-extension://abc', 'not a url'])).toEqual([]);
  });
});

describe('Origin: null', () => {
  it('is refused even when an entry somehow reads `null`', () => {
    expect(crossSiteWriteRefusal({ method: 'POST', origin: 'null', fetchSite: 'cross-site', host: '127.0.0.1:3000', allowedOrigins: ['null'] })).toBe(CROSS_SITE_WRITE_REFUSAL);
  });
});

describe('ambientCrossSiteRefusal — a credential the browser attaches on its own', () => {
  const amb = { origin: undefined, fetchSite: undefined, host: 'tenant.example.org:3000', allowedOrigins: [] as string[], ownOrigins: ['https://tenant.example.org:3000'] as readonly string[] };
  const judge = (over: Partial<typeof amb> & { origin?: string; fetchSite?: string; host?: string }) =>
    ambientCrossSiteRefusal({ ...amb, ...over });

  it('refuses another site and a sibling host, with or without an Origin', () => {
    expect(judge({ fetchSite: 'cross-site' })).toBe(AMBIENT_CROSS_SITE_REFUSAL);
    expect(judge({ fetchSite: 'same-site' })).toBe(AMBIENT_CROSS_SITE_REFUSAL);
    expect(judge({ fetchSite: 'same-site', origin: 'https://other.example.org' })).toBe(AMBIENT_CROSS_SITE_REFUSAL);
    expect(judge({ origin: 'https://evil.example' })).toBe(AMBIENT_CROSS_SITE_REFUSAL);
  });

  it('lets through what the browser calls its own page or a direct visit, whatever the Origin', () => {
    expect(judge({ fetchSite: 'same-origin', origin: 'https://evil.example' })).toBeNull();
    expect(judge({ fetchSite: 'none' })).toBeNull();
    expect(judge({ fetchSite: 'none', origin: 'https://evil.example' })).toBeNull();
  });

  it('ALLOWED ON PURPOSE: neither header (curl, the CLI, a server-side fetch)', () => {
    expect(judge({})).toBeNull();
  });

  it('takes an allowed and its own Origin even from a sibling host', () => {
    expect(judge({ fetchSite: 'same-site', origin: 'https://ui.example.org', allowedOrigins: ['https://ui.example.org'] })).toBeNull();
    expect(judge({ fetchSite: 'same-site', origin: 'https://tenant.example.org:3000' })).toBeNull();
  });

  it('refuses a localhost Origin that is not this server, unless it is listed', () => {
    expect(judge({ fetchSite: 'cross-site', origin: 'http://localhost:5173' })).toBe(AMBIENT_CROSS_SITE_REFUSAL);
    expect(judge({ fetchSite: 'cross-site', origin: 'http://localhost:5173', host: 'localhost:3000' })).toBe(AMBIENT_CROSS_SITE_REFUSAL);
    expect(judge({ fetchSite: 'cross-site', origin: 'http://localhost:5173', allowedOrigins: ['http://localhost:5173'] })).toBeNull();
    expect(judge({ fetchSite: 'cross-site', origin: 'http://localhost:3000', host: 'localhost:3000' })).toBeNull();
  });

  it('takes its own host by NAME only with the cookie, and on the schemes the caller gives', () => {
    expect(judge({ fetchSite: 'same-site', origin: 'https://tenant.example.org:3000', ownOrigins: [] })).toBe(AMBIENT_CROSS_SITE_REFUSAL);
    expect(judge({ fetchSite: 'cross-site', origin: 'http://tenant.example.org:3000' })).toBe(AMBIENT_CROSS_SITE_REFUSAL);
    expect(judge({ fetchSite: 'cross-site', origin: 'https://tenant.example.org:3001' })).toBe(AMBIENT_CROSS_SITE_REFUSAL);
    // Both schemes, when the caller cannot tell which one the browser used.
    expect(judge({ fetchSite: 'cross-site', origin: 'http://tenant.example.org:3000', ownOrigins: ['https://tenant.example.org:3000', 'http://tenant.example.org:3000'] })).toBeNull();
    // Without the cookie the own origin counts as an IP address only.
    expect(judge({ fetchSite: 'cross-site', origin: 'http://192.168.1.5:3000', host: '192.168.1.5:3000', ownOrigins: [] })).toBeNull();
  });
});

// The Origin rule is one definition for both checks. Each case is asked of both callers, so a
// change to the shared rule shows in each.
describe('the Origin rule both checks share', () => {
  const write = (origin: string, host: string, allowedOrigins: string[] = []) =>
    crossSiteWriteRefusal({ method: 'POST', origin, fetchSite: 'cross-site', host, allowedOrigins });
  const ambient = (origin: string, host: string, allowedOrigins: string[] = []) =>
    ambientCrossSiteRefusal({ origin, fetchSite: 'cross-site', host, allowedOrigins, ownOrigins: [] });

  it('refuses `null`, even when an entry reads `null`', () => {
    expect(write('null', '127.0.0.1:3000', ['null'])).toBe(CROSS_SITE_WRITE_REFUSAL);
    expect(ambient('null', '127.0.0.1:3000', ['null'])).toBe(AMBIENT_CROSS_SITE_REFUSAL);
  });

  it('compares the port: its own address on another port is another origin', () => {
    expect(write('http://127.0.0.2:4000', '127.0.0.2:3000')).toBe(CROSS_SITE_WRITE_REFUSAL);
    expect(ambient('http://127.0.0.2:4000', '127.0.0.2:3000')).toBe(AMBIENT_CROSS_SITE_REFUSAL);
    expect(write('http://127.0.0.2:3000', '127.0.0.2:3000')).toBeNull();
    expect(ambient('http://127.0.0.2:3000', '127.0.0.2:3000')).toBeNull();
  });

  it('takes a listed origin, and a localhost origin only on its own port', () => {
    expect(write('https://ui.example.org', 'x:1', ['https://ui.example.org'])).toBeNull();
    expect(ambient('https://ui.example.org', 'x:1', ['https://ui.example.org'])).toBeNull();
    expect(write('http://localhost:5173', 'localhost:5173')).toBeNull();
    expect(ambient('http://localhost:5173', 'localhost:5173')).toBeNull();
    expect(write('http://localhost:5173', 'localhost:3000')).toBe(CROSS_SITE_WRITE_REFUSAL);
    expect(ambient('http://localhost:5173', 'localhost:3000')).toBe(AMBIENT_CROSS_SITE_REFUSAL);
  });
});

describe('isOwnOriginByAddress', () => {
  it('is this server on localhost or an IP address, port and all', () => {
    expect(isOwnOriginByAddress('http://localhost:3000', 'localhost:3000')).toBe(true);
    expect(isOwnOriginByAddress('http://localhost:3000', 'LOCALHOST:3000')).toBe(true);
    expect(isOwnOriginByAddress('http://10.0.0.5', '10.0.0.5')).toBe(true);
    expect(isOwnOriginByAddress('http://localhost:3001', 'localhost:3000')).toBe(false);
    expect(isOwnOriginByAddress('http://localhost:3000', '127.0.0.1:3000')).toBe(false);
    // A name is never "by address", even when Host agrees: a page can point a name of its own here.
    expect(isOwnOriginByAddress('http://lynox.lan:3000', 'lynox.lan:3000')).toBe(false);
    expect(isOwnOriginByAddress('http://localhost:3000', undefined)).toBe(false);
    expect(isOwnOriginByAddress('', 'localhost:3000')).toBe(false);
    expect(isOwnOriginByAddress('null', 'localhost:3000')).toBe(false);
  });
});

describe('droppedAllowedOrigins', () => {
  it('names each entry the list drops, as written, and nothing it keeps', () => {
    expect(droppedAllowedOrigins([' https://a.example/', 'lynox.lan:3000', '', 'chrome-extension://abc', ' '])).toEqual(['lynox.lan:3000', 'chrome-extension://abc']);
    expect(droppedAllowedOrigins(['https://a.example', 'http://b.example:8080'])).toEqual([]);
  });

  it('tells the operator what was ignored and how to write it', () => {
    const line = droppedAllowedOriginWarning('lynox.lan:3000');
    expect(line).toContain('"lynox.lan:3000"');
    expect(line).toContain('ignored');
    expect(line).toContain('http://lynox.local:3000');
  });
});
