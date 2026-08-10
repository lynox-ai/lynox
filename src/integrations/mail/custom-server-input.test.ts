import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseCustomServers } from './custom-server-input.js';

describe('parseCustomServers', () => {
  it('defaults SMTP to submission on 587 with STARTTLS, not implicit TLS on 465', () => {
    // The defect: a client that omits the port got 465 filled in server-side,
    // which on a hosted instance is unreachable — and the failure only showed
    // up at the first send.
    expect(parseCustomServers({ smtp: { host: 'smtp.example.com' } }).smtp).toEqual({
      host: 'smtp.example.com',
      port: 587,
      secure: false,
    });
  });

  it('defaults IMAP to implicit TLS on 993 — the preference is per protocol', () => {
    expect(parseCustomServers({ imap: { host: 'imap.example.com' } }).imap).toEqual({
      host: 'imap.example.com',
      port: 993,
      secure: true,
    });
  });

  it('derives an omitted SMTP `secure` from the port instead of assuming true', () => {
    // An implicit-TLS handshake against a STARTTLS port hangs until the
    // timeout, so "port given, secure omitted" must not resolve to true.
    expect(parseCustomServers({ smtp: { host: 'h', port: 587 } }).smtp.secure).toBe(false);
    expect(parseCustomServers({ smtp: { host: 'h', port: 25 } }).smtp.secure).toBe(false);
    expect(parseCustomServers({ smtp: { host: 'h', port: 2525 } }).smtp.secure).toBe(false);
    expect(parseCustomServers({ smtp: { host: 'h', port: 465 } }).smtp.secure).toBe(true);
  });

  it('keeps an explicit choice, including 465 — the default is not a ban', () => {
    // A self-hoster on their own network can still run implicit TLS, and
    // somebody who explicitly wants no implicit TLS on 465 gets that too.
    expect(parseCustomServers({ smtp: { host: 'h', port: 465, secure: true } }).smtp).toEqual({
      host: 'h', port: 465, secure: true,
    });
    expect(parseCustomServers({ smtp: { host: 'h', port: 465, secure: false } }).smtp.secure).toBe(false);
    expect(parseCustomServers({ imap: { host: 'h', port: 143, secure: false } }).imap.secure).toBe(false);
  });

  it('leaves hosts empty rather than inventing one, so the caller can reject', () => {
    const parsed = parseCustomServers(undefined);
    expect(parsed.imap.host).toBe('');
    expect(parsed.smtp.host).toBe('');
  });

  it('survives junk without throwing', () => {
    for (const junk of [null, undefined, 'nope', 42, [], { smtp: 'string' }, { smtp: { port: '587' } }]) {
      const parsed = parseCustomServers(junk);
      expect(parsed.smtp.port).toBe(587);
      expect(parsed.imap.port).toBe(993);
    }
  });
});

// Structural, not behavioural: these read the route source rather than driving
// the routes. They exist because the defect was DUPLICATION — two routes parsed
// the same block independently, so fixing one left the other on 465 — and the
// unit tests above cannot see a route that stops calling the shared parser.
// What they kill is a re-inlined default, which is exactly how the bug got in.
describe('parseCustomServers is the only source of custom-server defaults', () => {
  const httpApi = readFileSync(
    fileURLToPath(new URL('../../server/http-api.ts', import.meta.url)),
    'utf8',
  );

  it('is reached by both routes that accept a custom block', () => {
    // POST /api/mail/accounts and POST /api/mail/accounts/test. More call sites
    // are fine; fewer means a route went back to parsing the block itself.
    const calls = httpApi.match(/parseCustomServers\(/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  it('leaves no hand-rolled custom-server default behind in the routes', () => {
    expect(httpApi).not.toMatch(/custom\?\.smtp\?\.port/);
    expect(httpApi).not.toMatch(/custom\?\.smtp\?\.secure/);
    expect(httpApi).not.toMatch(/custom\?\.imap\?\.port/);
    // Non-vacuity: if the file ever stops mentioning the routes at all, these
    // negatives would pass for the wrong reason.
    expect(httpApi).toContain('/api/mail/accounts/test');
  });
});
