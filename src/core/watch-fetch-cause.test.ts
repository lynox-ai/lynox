import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WatchHttpStatusError, watchFetchCause, type WatchFetchCause } from './watch-fetch-cause.js';
import { WORKER_NOTICES } from './worker-notices.js';
import { fetchPinned } from './network-guard.js';

const LIMITS = { timeoutSeconds: 30, maxBytes: 10 * 1024 * 1024, timedOut: false };
const URL_ = 'https://shop.example/news';
const said = (lang: 'de' | 'en', cause: WatchFetchCause): string => WORKER_NOTICES[lang].watchFetchFailed(URL_, cause);

describe('the cause of a failed watch fetch', () => {
  it.each([
    ['a refused private address', new Error('Blocked: private IP address "127.0.0.1"'), { kind: 'blocked' }],
    ['a host that resolves privately', new Error('Blocked: "intra.example" resolves to private IP "10.0.0.4"'), { kind: 'blocked' }],
    ['a host that does not resolve', new Error('Blocked: hostname "nope.example" did not resolve to any IP'), { kind: 'unresolved' }],
    ['a record without an address', new Error('Blocked: DNS returned a record without an address for "x.example"'), { kind: 'unresolved' }],
    ['a socket that names a missing host', Object.assign(new Error('getaddrinfo ENOTFOUND x.example'), { code: 'ENOTFOUND' }), { kind: 'unresolved' }],
    ['a refused connection', Object.assign(new Error('connect ECONNREFUSED 203.0.113.9:443'), { code: 'ECONNREFUSED' }), { kind: 'unreachable' }],
    ['no route to the host', Object.assign(new Error('connect EHOSTUNREACH'), { code: 'EHOSTUNREACH' }), { kind: 'other' }],
    ['a handshake without a certificate fault', Object.assign(new Error('wrong version number'), { code: 'ERR_SSL_WRONG_VERSION_NUMBER' }), { kind: 'other' }],
    ['a protocol mismatch', Object.assign(new Error('invalid protocol version'), { code: 'ERR_TLS_INVALID_PROTOCOL_VERSION' }), { kind: 'other' }],
    ['a certificate not yet valid', Object.assign(new Error('certificate is not yet valid'), { code: 'CERT_NOT_YET_VALID' }), { kind: 'tls' }],
    ['a certificate from an issuer it could not get', Object.assign(new Error('unable to get local issuer certificate'), { code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' }), { kind: 'tls' }],
    ['a private address after the deadline fired', new Error('Blocked: private IP address "10.0.0.4"'), { kind: 'blocked' }, true],
    ['a connection not made in time', Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }), { kind: 'timeout', seconds: 30 }],
    ['a connection cut off after it was accepted', Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }), { kind: 'other' }],
    ['an expired certificate', Object.assign(new Error('certificate has expired'), { code: 'CERT_HAS_EXPIRED' }), { kind: 'tls' }],
    ['a certificate for another name', Object.assign(new Error("Hostname/IP does not match certificate's altnames"), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' }), { kind: 'tls' }],
    ['a self-signed certificate', Object.assign(new Error('self-signed certificate'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }), { kind: 'tls' }],
    ['an unknown issuer', Object.assign(new Error('unable to verify the first certificate'), { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }), { kind: 'tls' }],
    ['a store host lynox does not open', new Error('Blocked: lynox does not open pages on Shopify store hosts (*.myshopify.com).'), { kind: 'refused' }],
    ['the timeout', new DOMException('The operation was aborted due to timeout', 'TimeoutError'), { kind: 'timeout', seconds: 30 }],
    ['an HTTP status', new WatchHttpStatusError(404, 'Not Found'), { kind: 'http', status: 404 }],
    ['a page past the cap', new Error(`response body exceeded ${String(LIMITS.maxBytes)} bytes`), { kind: 'too-large', megabytes: 10 }],
    ['anything else', new Error('socket hang up'), { kind: 'other' }],
    ['a thrown non-error', 'nope', { kind: 'other' }],
  ] as const)('reads %s', (_label, err, cause, timedOut?: boolean) => {
    expect(watchFetchCause(err, { ...LIMITS, timedOut: timedOut === true })).toEqual(cause);
  });

  it('reads the end of a page whose deadline fired while it arrived as the timeout, whatever the error says', () => {
    expect(watchFetchCause(Object.assign(new Error('aborted'), { code: 'ECONNRESET' }), { ...LIMITS, timedOut: true })).toEqual({ kind: 'timeout', seconds: 30 });
  });

  it('reads the refusal the address check really throws for a private address', async () => {
    const err = await fetchPinned('http://127.0.0.1/').then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(watchFetchCause(err, LIMITS)).toEqual({ kind: 'blocked' });
  });

  it('reads the refusal the address check really throws for a store host as one lynox does not read', async () => {
    const err = await fetchPinned('https://x.myshopify.com/products/a').then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(watchFetchCause(err, LIMITS)).toEqual({ kind: 'refused' });
  });

  it('keeps the words of the address check it reads: an unresolved host and the refusal prefix', () => {
    const guard = readFileSync(join(__dirname, 'network-guard.ts'), 'utf8');
    expect(guard).toContain('throw new Error(`Blocked: hostname "${cleaned}" did not resolve to any IP`);');
    expect(guard).toContain('throw new Error(`Blocked: DNS returned a record without an address for "${cleaned}"`);');
    const sanitize = readFileSync(join(__dirname, 'sanitize.ts'), 'utf8');
    expect(sanitize).toContain('throw new Error(`response body exceeded ${String(maxBytes)} bytes`);');
  });
});

describe('the sentence an owner reads for a page a watch could not read', () => {
  const AGAIN_EN = ' The watch checks the page again next time.';
  const AGAIN_DE = ' Die Beobachtung prüft die Seite beim nächsten Mal wieder.';
  const FINAL_EN = " Trying again will not change that. Change the watch's address or delete the watch.";
  const FINAL_DE = ' Daran ändert ein neuer Versuch nichts. Ändere die Adresse der Beobachtung oder lösche sie.';
  it.each([
    [{ kind: 'blocked' }, 'The address leads into a private or internal network, which a watch does not read.' + FINAL_EN,
      'Die Adresse führt in ein privates oder internes Netz, das eine Beobachtung nicht liest.' + FINAL_DE],
    [{ kind: 'unresolved' }, 'The host name does not resolve.' + AGAIN_EN, 'Der Hostname lässt sich nicht auflösen.' + AGAIN_DE],
    [{ kind: 'refused' }, 'lynox does not read pages at this address.' + FINAL_EN, 'lynox liest Seiten an dieser Adresse nicht.' + FINAL_DE],
    [{ kind: 'tls' }, "The server's certificate could not be verified. It may be misconfigured, or the connection may be intercepted." + AGAIN_EN,
      'Das Zertifikat des Servers liess sich nicht prüfen. Es könnte falsch eingerichtet oder die Verbindung abgefangen sein.' + AGAIN_DE],
    [{ kind: 'unreachable' }, 'The server did not accept the connection.' + AGAIN_EN, 'Der Server hat die Verbindung nicht angenommen.' + AGAIN_DE],
    [{ kind: 'timeout', seconds: 30 }, 'The server did not answer within 30 seconds.' + AGAIN_EN, 'Der Server hat nicht innerhalb von 30 Sekunden geantwortet.' + AGAIN_DE],
    [{ kind: 'http', status: 401 }, 'The server answered with HTTP status 401 (sign-in required).' + AGAIN_EN, 'Der Server hat mit HTTP-Status 401 (Anmeldung nötig) geantwortet.' + AGAIN_DE],
    [{ kind: 'http', status: 403 }, 'The server answered with HTTP status 403 (access denied).' + AGAIN_EN, 'Der Server hat mit HTTP-Status 403 (Zugriff verweigert) geantwortet.' + AGAIN_DE],
    [{ kind: 'http', status: 404 }, 'The server answered with HTTP status 404 (not found).' + FINAL_EN, 'Der Server hat mit HTTP-Status 404 (nicht gefunden) geantwortet.' + FINAL_DE],
    [{ kind: 'http', status: 410 }, 'The server answered with HTTP status 410 (gone).' + FINAL_EN, 'Der Server hat mit HTTP-Status 410 (entfernt) geantwortet.' + FINAL_DE],
    [{ kind: 'http', status: 429 }, 'The server answered with HTTP status 429 (too many requests).' + AGAIN_EN, 'Der Server hat mit HTTP-Status 429 (zu viele Anfragen) geantwortet.' + AGAIN_DE],
    [{ kind: 'http', status: 500 }, 'The server answered with HTTP status 500 (server error).' + AGAIN_EN, 'Der Server hat mit HTTP-Status 500 (Fehler beim Server) geantwortet.' + AGAIN_DE],
    [{ kind: 'http', status: 599 }, 'The server answered with HTTP status 599 (server error).' + AGAIN_EN, 'Der Server hat mit HTTP-Status 599 (Fehler beim Server) geantwortet.' + AGAIN_DE],
    [{ kind: 'http', status: 600 }, 'The server answered with HTTP status 600.' + AGAIN_EN, 'Der Server hat mit HTTP-Status 600 geantwortet.' + AGAIN_DE],
    ...([301, 302, 303, 307, 308] as const).map((status) => [{ kind: 'http', status },
      `The server answered with HTTP status ${String(status)} (redirected). A watch does not follow a redirect. Open the address in a browser and enter the address you end up at, or delete the watch.`,
      `Der Server hat mit HTTP-Status ${String(status)} (weitergeleitet) geantwortet. Eine Beobachtung folgt keiner Weiterleitung. Öffne die Adresse im Browser und trage die Adresse ein, bei der du landest, oder lösche die Beobachtung.`] as const),
    [{ kind: 'http', status: 418 }, 'The server answered with HTTP status 418.' + AGAIN_EN, 'Der Server hat mit HTTP-Status 418 geantwortet.' + AGAIN_DE],
    [{ kind: 'too-large', megabytes: 10 }, 'The page is larger than the 10 MB a watch reads.' + FINAL_EN, 'Die Seite ist grösser als die 10 MB, die eine Beobachtung liest.' + FINAL_DE],
    [{ kind: 'other' }, 'The page could not be loaded.' + AGAIN_EN, 'Die Seite liess sich nicht laden.' + AGAIN_DE],
  ] as const)('%o, in English and German', (cause, en, de) => {
    expect(said('en', cause)).toBe(`The watched page ${URL_} could not be read: ${en}`);
    expect(said('de', cause)).toBe(`Die beobachtete Seite ${URL_} liess sich nicht lesen: ${de}`);
  });
});
