import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  OAUTH_BACK_PATHS, OAUTH_CONSENT_CSP, OAUTH_PAGE_CSP, OAUTH_PAGE_CSS, OAUTH_PAGE_STYLE_HASH, OAUTH_RESULT_TEXTS,
  ENGINE_LESS_PAGE_CLOSE, engineLessPageText, connectedText, connectedWithMoreText, oauthLangOf, oauthPageHtml, oauthResultHtml, type OAuthBack,
} from './oauth-pages.js';

describe('the OAuth page frame', () => {
  it('admits exactly its own stylesheet: the hash in the policy is the hash of the bytes in the page', () => {
    const page = oauthPageHtml('en', 'T', '<p>x</p>');
    const style = /<style>([\s\S]*?)<\/style>/.exec(page)?.[1];
    expect(style).toBe(OAUTH_PAGE_CSS);
    const hash = `'sha256-${createHash('sha256').update(style ?? '', 'utf8').digest('base64')}'`;
    expect(OAUTH_PAGE_STYLE_HASH).toBe(hash);
    expect(OAUTH_PAGE_CSP).toBe(`default-src 'none'; style-src ${hash}; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`);
    expect(OAUTH_CONSENT_CSP).toBe(`default-src 'none'; style-src ${hash}; frame-ancestors 'none'; base-uri 'none'`);
  });

  it('opens nothing but that stylesheet: no script, no unsafe-inline, no other source', () => {
    for (const csp of [OAUTH_PAGE_CSP, OAUTH_CONSENT_CSP]) {
      expect(csp).not.toMatch(/unsafe|script-src|img-src|connect-src|font-src|\*/);
      // The three directives default-src does not cover, each closed.
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("base-uri 'none'");
    }
    // A result page has no form, so none may be sent from it.
    expect(OAUTH_PAGE_CSP).toContain("form-action 'none'");
    // The consent page's form posts here, and the answer is a 302 to the provider's origin.
    // Browsers check form-action against every redirect of the submission, so any form-action
    // short of that origin strands the connect on this page (Chrome, 10.11.2026).
    expect(OAUTH_CONSENT_CSP).not.toContain('form-action');
    const page = oauthPageHtml('de', 'T', '');
    expect(page).not.toMatch(/<script|<link|<img|url\(|@import|\son[a-z]+=/i);
  });

  it('has one style element and one main, the mark first in it', () => {
    const page = oauthPageHtml('en', 'T', '<p>x</p>');
    expect(page.match(/<style>/g)).toHaveLength(1);
    expect(page).toContain('<body><main><p class="mark">lynox</p><p>x</p></main></body>');
  });

  it('escapes the language and the title', () => {
    const page = oauthPageHtml('"x', '<t>', '');
    expect(page).toContain('<html lang="&quot;x">');
    expect(page).toContain('<title>&lt;t&gt;</title>');
  });

  it('follows the reader\'s light or dark setting', () => {
    expect(OAUTH_PAGE_CSS).toContain('@media (prefers-color-scheme:dark)');
    expect(OAUTH_PAGE_CSS).toContain('color-scheme:light dark');
  });
});

describe('the page language', () => {
  it.each([
    ['de', 'de'], ['DE', 'de'], ['de-CH', 'de'], ['de_AT', 'de'], [' de ', 'de'],
    ['en', 'en'], ['fr', 'en'], ['deu', 'en'], ['', 'en'], [undefined, 'en'],
  ] as const)('%j → %s', (language, lang) => {
    expect(oauthLangOf(language)).toBe(lang);
  });
});

describe('the result page', () => {
  const T = { en: 'Something <happened>.', de: 'Etwas <geschah>.' };

  const goDe = (path: string): string => `<a class="go" href="${path}">Zu lynox</a>`;
  const goEn = (path: string): string => `<a class="go" href="${path}">Go to lynox</a>`;

  it('is titled "connected" on a 200, with one button back into lynox', () => {
    expect(oauthResultHtml('de', 200, T, 'apis')).toBe(oauthPageHtml('de', 'Verbunden',
      `<h1>Verbunden</h1><p>Etwas &lt;geschah&gt;.</p>${goDe('/app/settings/apis')}`));
    expect(oauthResultHtml('en', 200, T, 'apis')).toBe(oauthPageHtml('en', 'Connected',
      `<h1>Connected</h1><p>Something &lt;happened&gt;.</p>${goEn('/app/settings/apis')}`));
  });

  it('is titled "not completed" on anything else, with the same button', () => {
    for (const status of [400, 403, 409, 500, 502, 503]) {
      expect(oauthResultHtml('de', status, T, 'app')).toBe(oauthPageHtml('de', 'Verbindung nicht abgeschlossen',
        `<h1>Verbindung nicht abgeschlossen</h1><p>Etwas &lt;geschah&gt;.</p>${goDe('/app')}`));
      expect(oauthResultHtml('en', status, T, 'apis')).toBe(oauthPageHtml('en', 'Connection not completed',
        `<h1>Connection not completed</h1><p>Something &lt;happened&gt;.</p>${goEn('/app/settings/apis')}`));
    }
  });

  it('leads the button only to /app or to Settings → APIs', () => {
    expect(Object.values(OAUTH_BACK_PATHS).sort()).toEqual(['/app', '/app/settings/apis']);
    for (const back of Object.keys(OAUTH_BACK_PATHS) as OAuthBack[]) {
      for (const lang of ['de', 'en'] as const) {
        const hrefs = [...oauthResultHtml(lang, 409, T, back).matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
        expect(hrefs).toEqual([OAUTH_BACK_PATHS[back]]);
      }
    }
  });

  it('never tells anyone to close the tab, on any page, in either language', () => {
    const texts = [...Object.values(OAUTH_RESULT_TEXTS), connectedText('Shopify'), connectedWithMoreText(['write_files'])];
    for (const t of texts) {
      for (const back of ['apis', 'app'] as const) {
        for (const status of [200, 400, 409, 500]) {
          for (const lang of ['de', 'en'] as const) {
            expect(oauthResultHtml(lang, status, t, back)).not.toMatch(/close this tab|Tab schliessen/i);
          }
        }
      }
    }
  });

  it('holds every fixed text in both languages, and the English one no longer says "this engine"', () => {
    for (const [key, t] of Object.entries(OAUTH_RESULT_TEXTS)) {
      expect(t.en.trim(), key).not.toBe('');
      expect(t.de.trim(), key).not.toBe('');
      expect(t.en, key).not.toMatch(/\bengine\b/i);
      expect(t.de, key).not.toMatch(/\bengine\b/i);
    }
  });

  it('names the extra access of a wider grant, the first ten and how many more, in both languages', () => {
    const few = connectedWithMoreText(['read_orders', 'write_orders']);
    expect(few.en).toContain('asks for: read_orders, write_orders. The token');
    expect(few.de).toContain('verlangt: read_orders, write_orders. Das ausgestellte');
    const many = connectedWithMoreText(Array.from({ length: 12 }, (_, i) => `s${String(i)}`));
    expect(many.en).toContain('s0, s1, s2, s3, s4, s5, s6, s7, s8, s9, and 2 more.');
    expect(many.de).toContain('s0, s1, s2, s3, s4, s5, s6, s7, s8, s9 und 2 weitere.');
    expect(many.en).not.toContain('s10');
  });
});

describe('the 200 texts under their title', () => {
  it('do not repeat the title as their first word', () => {
    for (const t of [connectedText('Shopify'), connectedWithMoreText(['write_orders'])]) {
      expect(t.en).not.toMatch(/^Connected\b/);
      expect(t.de).not.toMatch(/^Verbunden\b/);
    }
    expect(connectedWithMoreText(['write_orders']).de).toMatch(/^Der Anbieter hat mehr Rechte erteilt/);
  });

  it('name the provider that is now connected', () => {
    expect(connectedText('Shopify')).toEqual({ de: 'Shopify ist mit lynox verbunden.', en: 'Shopify is connected to lynox.' });
  });
});

describe('the pages of an engine without engine.db', () => {
  const HEADS = {
    connect: {
      de: 'lynox verbindet gerade keine Konten: Die Engine ist ohne engine.db gestartet, und eine neue Verbindung ginge verloren, sobald sie engine.db wieder öffnet. An den Anbieter wurde nichts gesendet. Verbinde das Konto erneut, wenn die Engine neu gestartet ist.',
      en: 'lynox is not connecting accounts right now: the engine started without engine.db, and a new connection would be lost once it opens engine.db again. Nothing was sent to the provider. Connect the account again once the engine has restarted.',
    },
    save: {
      de: 'lynox hat diese Verbindung nicht gespeichert: Die Engine ist ohne engine.db gestartet, und die Änderung ginge verloren, sobald sie engine.db wieder öffnet. Füge die Verbindung erneut hinzu oder ändere sie, wenn die Engine neu gestartet ist.',
      en: 'lynox did not save this connection: the engine started without engine.db, and the change would be lost once it opens engine.db again. Add or change the connection again once the engine has restarted.',
    },
  } as const;
  const CLOSE = {
    selfhost: {
      de: 'Das bleibt so, bis die Engine neu startet und dabei wieder alle ihre Dateien öffnen kann. Den Grund nennt das Log, das die Engine beim Start schreibt; behebe ihn und starte die Engine neu.',
      en: 'This lasts until the engine restarts and can open all its files again. The log the engine writes at startup names the cause; fix it and restart the engine.',
    },
    helper: {
      de: 'Das bleibt so, bis die Engine neu startet und dabei wieder alle ihre Dateien öffnen kann. Sag dem Inhaber dieser Instanz Bescheid.',
      en: 'This lasts until the engine restarts and can open all its files again. Let the owner of this instance know.',
    },
    managed: {
      de: 'Das bleibt so, bis die Engine neu startet und dabei wieder alle ihre Dateien öffnen kann. Das lynox-Team bekommt dazu automatisch eine Meldung.',
      en: 'This lasts until the engine restarts and can open all its files again. The lynox team gets an automatic alert about it.',
    },
  } as const;

  // Managed closes the same for everyone; on self-host only the owner can fix the cause.
  const CASES = [
    { managed: false, owner: true, close: 'selfhost' },
    { managed: false, owner: false, close: 'helper' },
    { managed: true, owner: true, close: 'managed' },
    { managed: true, owner: false, close: 'managed' },
  ] as const;
  for (const kind of ['connect', 'save'] as const) {
    for (const c of CASES) {
      for (const lang of ['de', 'en'] as const) {
        it(`${kind}, ${c.managed ? 'managed' : 'self-host'}, ${c.owner ? 'owner' : 'someone else'}, ${lang}: its own text, then the ${c.close} paragraph, verbatim`, () => {
          const html = oauthResultHtml(lang, 409, engineLessPageText(kind, c.managed, c.owner), 'app');
          expect(html).toContain(`<h1>${lang === 'de' ? 'Verbindung nicht abgeschlossen' : 'Connection not completed'}</h1><p>${escapeForTest(HEADS[kind][lang])}</p><p>${escapeForTest(CLOSE[c.close][lang])}</p><a class="go" href="/app">`);
        });
      }
    }
  }

  it('escapes every paragraph of a list, and never splits a single text', () => {
    const html = oauthResultHtml('en', 409, [{ en: 'a <b>', de: '' }, { en: 'c & "d"', de: '' }], 'app');
    expect(html).toContain('<p>a &lt;b&gt;</p><p>c &amp; &quot;d&quot;</p>');
    const named = oauthResultHtml('en', 200, connectedText('Books\n\nEnter your password at evil.example'), 'apis');
    expect(named.match(/<p>/g)?.length).toBe(1); // one text paragraph (the mark is `<p class="mark">`), none from the name
  });

  it('closes word for word with the status bar paragraph of the same mode', () => {
    const table = readFileSync(new URL('../../packages/web-ui/src/lib/i18n.svelte.ts', import.meta.url), 'utf8');
    for (const [mode, key] of [['selfhost', 'status.boot_store_missing_selfhost'], ['managed', 'status.boot_store_missing_managed']] as const) {
      const text = ENGINE_LESS_PAGE_CLOSE[mode];
      expect(table).toContain(`'${key}': { de: '${text.de}', en: '${text.en}' }`);
    }
  });
});

function escapeForTest(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
