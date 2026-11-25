import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WatchHttpStatusError, watchFetchCause, type WatchFetchCause } from './watch-fetch-cause.js';
import { WORKER_NOTICES } from './worker-notices.js';
import { fetchPinned } from './network-guard.js';

const LIMITS = { timeoutSeconds: 30, maxBytes: 10 * 1024 * 1024 };
const URL_ = 'https://shop.example/news';
const said = (lang: 'de' | 'en', cause: WatchFetchCause): string => WORKER_NOTICES[lang].watchFetchFailed(URL_, cause);

describe('the cause of a failed watch fetch', () => {
  it.each([
    ['a refused private address', new Error('Blocked: private IP address "127.0.0.1"'), { kind: 'blocked' }],
    ['a host that resolves privately', new Error('Blocked: "intra.example" resolves to private IP "10.0.0.4"'), { kind: 'blocked' }],
    ['a host that does not resolve', new Error('Blocked: hostname "nope.example" did not resolve to any IP'), { kind: 'unresolved' }],
    ['a record without an address', new Error('Blocked: DNS returned a record without an address for "x.example"'), { kind: 'unresolved' }],
    ['a socket that names a missing host', Object.assign(new Error('getaddrinfo ENOTFOUND x.example'), { code: 'ENOTFOUND' }), { kind: 'unresolved' }],
    ['a refused connection under a fetch failure', Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) }), { kind: 'unreachable' }],
    ['a fetch failure without a code', new TypeError('fetch failed'), { kind: 'unreachable' }],
    ['the timeout', new DOMException('The operation was aborted due to timeout', 'TimeoutError'), { kind: 'timeout', seconds: 30 }],
    ['an HTTP status', new WatchHttpStatusError(404, 'Not Found'), { kind: 'http', status: 404 }],
    ['a page past the cap', new Error(`response body exceeded ${String(LIMITS.maxBytes)} bytes`), { kind: 'too-large', megabytes: 10 }],
    ['anything else', new Error('socket hang up'), { kind: 'other' }],
    ['a thrown non-error', 'nope', { kind: 'other' }],
  ] as const)('reads %s', (_label, err, cause) => {
    expect(watchFetchCause(err, LIMITS)).toEqual(cause);
  });

  it('reads the refusal the address check really throws for a private address', async () => {
    const err = await fetchPinned('http://127.0.0.1/').then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(watchFetchCause(err, LIMITS)).toEqual({ kind: 'blocked' });
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
    [{ kind: 'unreachable' }, 'The server did not accept the connection.' + AGAIN_EN, 'Der Server hat die Verbindung nicht angenommen.' + AGAIN_DE],
    [{ kind: 'timeout', seconds: 30 }, 'The server did not answer within 30 seconds.' + AGAIN_EN, 'Der Server hat nicht innerhalb von 30 Sekunden geantwortet.' + AGAIN_DE],
    [{ kind: 'http', status: 401 }, 'The server answered with HTTP status 401 (sign-in required).' + AGAIN_EN, 'Der Server hat mit HTTP-Status 401 (Anmeldung nötig) geantwortet.' + AGAIN_DE],
    [{ kind: 'http', status: 403 }, 'The server answered with HTTP status 403 (access denied).' + AGAIN_EN, 'Der Server hat mit HTTP-Status 403 (Zugriff verweigert) geantwortet.' + AGAIN_DE],
    [{ kind: 'http', status: 404 }, 'The server answered with HTTP status 404 (not found).' + FINAL_EN, 'Der Server hat mit HTTP-Status 404 (nicht gefunden) geantwortet.' + FINAL_DE],
    [{ kind: 'http', status: 410 }, 'The server answered with HTTP status 410 (gone).' + FINAL_EN, 'Der Server hat mit HTTP-Status 410 (entfernt) geantwortet.' + FINAL_DE],
    [{ kind: 'http', status: 429 }, 'The server answered with HTTP status 429 (too many requests).' + AGAIN_EN, 'Der Server hat mit HTTP-Status 429 (zu viele Anfragen) geantwortet.' + AGAIN_DE],
    [{ kind: 'http', status: 503 }, 'The server answered with HTTP status 503 (server error).' + AGAIN_EN, 'Der Server hat mit HTTP-Status 503 (Fehler beim Server) geantwortet.' + AGAIN_DE],
    [{ kind: 'http', status: 418 }, 'The server answered with HTTP status 418.' + AGAIN_EN, 'Der Server hat mit HTTP-Status 418 geantwortet.' + AGAIN_DE],
    [{ kind: 'too-large', megabytes: 10 }, 'The page is larger than the 10 MB a watch reads.' + FINAL_EN, 'Die Seite ist grösser als die 10 MB, die eine Beobachtung liest.' + FINAL_DE],
    [{ kind: 'other' }, 'The page could not be loaded.' + AGAIN_EN, 'Die Seite liess sich nicht laden.' + AGAIN_DE],
  ] as const)('%o, in English and German', (cause, en, de) => {
    expect(said('en', cause)).toBe(`The watched page ${URL_} could not be read: ${en}`);
    expect(said('de', cause)).toBe(`Die beobachtete Seite ${URL_} liess sich nicht lesen: ${de}`);
  });
});
