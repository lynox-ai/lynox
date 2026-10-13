import { describe, it, expect } from 'vitest';
import { crossSiteWriteRefusal, CROSS_SITE_WRITE_REFUSAL } from './cross-site-write.js';

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

  it('accepts localhost, an allowed origin, and this server reached by its IP address', () => {
    expect(decide({ origin: 'http://localhost:5173' })).toBeNull();
    expect(decide({ origin: 'http://127.0.0.1:3000' })).toBeNull();
    expect(decide({ origin: 'http://[::1]:3000' })).toBeNull();
    expect(decide({ origin: 'https://lynox.example.org', allowedOrigins: ['https://lynox.example.org'] })).toBeNull();
    expect(decide({ origin: 'http://192.168.1.20:3000', host: '192.168.1.20:3000' })).toBeNull();
    expect(decide({ origin: 'http://[fd00::20]:3000', host: '[fd00::20]:3000' })).toBeNull();
  });

  it('refuses this server reached by a NAME unless the name is allowed', () => {
    // Host and Origin agree, and the name is not one the server was told to trust.
    expect(decide({ origin: 'http://lynox.lan:3000', host: 'lynox.lan:3000' })).toBe(CROSS_SITE_WRITE_REFUSAL);
    expect(decide({ origin: 'http://lynox.lan:3000', host: 'lynox.lan:3000', allowedOrigins: ['http://lynox.lan:3000'] })).toBeNull();
  });

  it('refuses an IP origin that is not this server', () => {
    expect(decide({ origin: 'http://192.168.1.21:3000', host: '192.168.1.20:3000' })).toBe(CROSS_SITE_WRITE_REFUSAL);
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
