import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseCustomServers } from './custom-server-input.js';
import { describePreset } from './providers/presets.js';

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

  it('derives an omitted PORT from an explicit `secure`, in the other direction', () => {
    // The combination this exists to prevent: `secure: true` with the port left
    // out used to produce 587 + implicit TLS — an implicit-TLS handshake against
    // a STARTTLS port, which is broken on every server in the world, not just
    // ours. Port and secure are two halves of one decision; whichever half the
    // client supplied has to win.
    expect(parseCustomServers({ smtp: { host: 'h', secure: true } }).smtp).toEqual({
      host: 'h', port: 465, secure: true,
    });
    expect(parseCustomServers({ smtp: { host: 'h', secure: false } }).smtp).toEqual({
      host: 'h', port: 587, secure: false,
    });
  });

  it('treats a non-numeric port as not supplied, which is what an emptied form field sends', () => {
    // `<input type="number">` binds an empty field to null, and API clients
    // send '465' as a string. Both used to slip past the number check and land
    // on the default port while an explicit `secure: true` was still honoured.
    // NaN is in here because `typeof NaN === 'number'` — it passed the original
    // check and became the port, and the route then rejected it with a range
    // error about a value the client never sent. (Its label prints as "null"
    // because that is what JSON.stringify makes of NaN, which is how it hid.)
    for (const [label, port] of [['null', null], ['undefined', undefined], ['string', '465'], ['NaN', Number.NaN]] as Array<[string, unknown]>) {
      expect(parseCustomServers({ smtp: { host: 'h', port, secure: true } }).smtp, `port=${label}`)
        .toEqual({ host: 'h', port: 465, secure: true });
    }
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

// The same suggestion exists in three independent places, and nothing used to
// assert they agree. `custom-server-input.ts` de-duplicated the two HTTP routes;
// the preset descriptor and the form's own state are still separate copies, and
// a fix applied to one of them is exactly the shape of the original defect.
describe('the 587 suggestion agrees across every place that makes it', () => {
  const uiSource = readFileSync(
    fileURLToPath(new URL('../../../packages/web-ui/src/lib/components/MailSettings.svelte', import.meta.url)),
    'utf8',
  );

  it('matches between the preset descriptor and the request parser', () => {
    expect(describePreset('custom').smtp.port).toBe(parseCustomServers({}).smtp.port);
    expect(describePreset('custom').smtp.secure).toBe(parseCustomServers({}).smtp.secure);
  });

  it('matches in the settings form, which keeps its own state', () => {
    const ports = [...uiSource.matchAll(/customSmtpPort\s*=\s*(?:\$state\(\s*)?(\d+)/g)].map(m => m[1]);
    expect(ports.length, 'no customSmtpPort literal found — did the field get renamed?').toBeGreaterThanOrEqual(2);
    expect([...new Set(ports)]).toEqual([String(parseCustomServers({}).smtp.port)]);
  });
});

// Structural, not behavioural: these read the route source rather than driving
// the routes. The behavioural check lives in http-api.test.ts, which runs both
// routes with one body and compares — because a re-inlined default under a
// different variable name reads as clean here and behaves as broken there.
// What these still add is a cheap tripwire on the wording that got it wrong.
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
