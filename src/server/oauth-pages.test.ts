import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  OAUTH_PAGE_CSP, OAUTH_PAGE_CSS, OAUTH_PAGE_STYLE_HASH, OAUTH_RESULT_TEXTS,
  connectedWithMoreText, oauthLangOf, oauthPageHtml, oauthResultHtml,
} from './oauth-pages.js';

describe('the OAuth page frame', () => {
  it('admits exactly its own stylesheet: the hash in the policy is the hash of the bytes in the page', () => {
    const page = oauthPageHtml('en', 'T', '<p>x</p>');
    const style = /<style>([\s\S]*?)<\/style>/.exec(page)?.[1];
    expect(style).toBe(OAUTH_PAGE_CSS);
    const hash = `'sha256-${createHash('sha256').update(style ?? '', 'utf8').digest('base64')}'`;
    expect(OAUTH_PAGE_STYLE_HASH).toBe(hash);
    expect(OAUTH_PAGE_CSP).toBe(`default-src 'none'; style-src ${hash}`);
  });

  it('opens nothing but that stylesheet: no script, no unsafe-inline, no other source', () => {
    expect(OAUTH_PAGE_CSP).not.toMatch(/unsafe|script-src|img-src|connect-src|font-src|\*/);
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

  it('is titled "connected" on a 200 and leaves out the close line its text already carries', () => {
    expect(oauthResultHtml('de', 200, T)).toBe(oauthPageHtml('de', 'Verbunden', '<h1>Verbunden</h1><p>Etwas &lt;geschah&gt;.</p>'));
    expect(oauthResultHtml('en', 200, T)).toBe(oauthPageHtml('en', 'Connected', '<h1>Connected</h1><p>Something &lt;happened&gt;.</p>'));
  });

  it('is titled "not completed" on anything else, with the close line', () => {
    for (const status of [400, 403, 409, 500, 502, 503]) {
      expect(oauthResultHtml('de', status, T)).toBe(oauthPageHtml('de', 'Verbindung nicht abgeschlossen',
        '<h1>Verbindung nicht abgeschlossen</h1><p>Etwas &lt;geschah&gt;.</p><p class="close">Du kannst diesen Tab schliessen.</p>'));
      expect(oauthResultHtml('en', status, T)).toBe(oauthPageHtml('en', 'Connection not completed',
        '<h1>Connection not completed</h1><p>Something &lt;happened&gt;.</p><p class="close">You can close this tab.</p>'));
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
