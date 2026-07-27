import { describe, it, expect } from 'vitest';
import {
  extractHtmlText,
  isHtmlContentType,
  DEFAULT_HTML_EXTRACT_MAX_CHARS,
  MIN_USEFUL_EXTRACT_CHARS,
} from './html-extract.js';

describe('isHtmlContentType', () => {
  it('accepts html and xhtml, with charset suffixes', () => {
    expect(isHtmlContentType('text/html')).toBe(true);
    expect(isHtmlContentType('text/html; charset=utf-8')).toBe(true);
    expect(isHtmlContentType('TEXT/HTML')).toBe(true);
    expect(isHtmlContentType('application/xhtml+xml')).toBe(true);
  });

  it('rejects non-markup types — a plain-text or CSV body must not be mangled', () => {
    expect(isHtmlContentType('text/plain')).toBe(false);
    expect(isHtmlContentType('text/csv')).toBe(false);
    expect(isHtmlContentType('application/json')).toBe(false);
    expect(isHtmlContentType('')).toBe(false);
  });
});

describe('extractHtmlText', () => {
  it('keeps title and the meta tags that carry positioning copy', () => {
    const html = `<html><head>
      <title>Dein Musiker-Magazin seit 1999 - AMAZONA.de</title>
      <meta name="description" content="AMAZONA.de testet Synthesizer, Keyboards, Gitarren"/>
      <meta property="og:site_name" content="Amazona.de" />
      <meta name="viewport" content="width=device-width" />
      <meta name="robots" content="noindex" />
    </head><body><p>Hallo</p></body></html>`;

    const { text } = extractHtmlText(html);

    expect(text).toContain('title: Dein Musiker-Magazin seit 1999 - AMAZONA.de');
    expect(text).toContain('description: AMAZONA.de testet Synthesizer, Keyboards, Gitarren');
    expect(text).toContain('og:site_name: Amazona.de');
    // Not positioning copy — must not survive.
    expect(text).not.toContain('width=device-width');
    expect(text).not.toContain('noindex');
  });

  it('reads meta attributes in either order', () => {
    const html = `<meta content="Reversed attribute order" name="description">`;
    expect(extractHtmlText(html).text).toContain('description: Reversed attribute order');
  });

  it('drops script and style CONTENT, not just their tags', () => {
    const html = `<html><head>
      <style>body{color:#fff;background:url(x)}</style>
      <script>var tracking={id:"GTM-XYZ"};function boot(){}</script>
    </head><body><h1>Echte Überschrift</h1><p>Sichtbarer Text</p></body></html>`;

    const { text } = extractHtmlText(html);

    expect(text).toContain('Echte Überschrift');
    expect(text).toContain('Sichtbarer Text');
    expect(text).not.toContain('GTM-XYZ');
    expect(text).not.toContain('color:#fff');
    expect(text).not.toContain('function boot');
  });

  it('drops an UNTERMINATED script block — the byte-truncated-body case', () => {
    // readBodyLimited cuts at the read limit, which can land inside a <script>.
    // The paired regex cannot match that, so the tail needs its own removal or
    // raw JS leaks into the extracted text.
    const html = `<body><p>Sichtbar</p><script>var leak="SHOULD_NOT_APPEAR";var more=1;`;
    const { text } = extractHtmlText(html);

    expect(text).toContain('Sichtbar');
    expect(text).not.toContain('SHOULD_NOT_APPEAR');
  });

  it('marks h1-h3 so the information architecture survives as text', () => {
    const html = `<body><h1>Haupttitel</h1><p>Fliesstext</p><h2>Abschnitt</h2><h4>Klein</h4></body>`;
    const { text } = extractHtmlText(html);

    expect(text).toContain('## Haupttitel');
    expect(text).toContain('## Abschnitt');
    // h4 is not marked, but its text is still kept.
    expect(text).toContain('Klein');
  });

  it('decodes named, decimal and hex entities', () => {
    const html = `<body><p>Gitarren &amp; B&auml;sse &#8211; 5&#x20AC; &hellip;</p></body>`;
    const { text } = extractHtmlText(html);

    expect(text).toContain('Gitarren & Bässe – 5€ …');
  });

  it('leaves an unknown entity alone rather than mangling it', () => {
    const { text } = extractHtmlText(`<body><p>&notarealentity; ok</p></body>`);
    expect(text).toContain('&notarealentity;');
  });

  it('does not fuse words across block boundaries', () => {
    const html = `<body><p>erstes</p><p>zweites</p><li>drittes</li></body>`;
    const { text } = extractHtmlText(html);

    expect(text).not.toContain('ersteszweites');
    expect(text).toMatch(/erstes\s+zweites\s+drittes/);
  });

  it('caps at maxChars and flags truncation', () => {
    const html = `<body><p>${'wort '.repeat(5_000)}</p></body>`;
    const { text, truncated, afterChars } = extractHtmlText(html, 500);

    expect(truncated).toBe(true);
    expect(text.length).toBe(500);
    expect(afterChars).toBe(500);
  });

  it('reports no truncation when the page fits', () => {
    const { truncated } = extractHtmlText(`<body><p>kurz</p></body>`);
    expect(truncated).toBe(false);
  });

  it('defaults maxChars to the shared context budget', () => {
    const html = `<body><p>${'x'.repeat(DEFAULT_HTML_EXTRACT_MAX_CHARS * 2)}</p></body>`;
    expect(extractHtmlText(html).afterChars).toBe(DEFAULT_HTML_EXTRACT_MAX_CHARS);
  });

  it('yields under MIN_USEFUL_EXTRACT_CHARS for a JS-rendered shell, so the caller can keep raw', () => {
    // An SPA shell: no server-side text worth having. The caller falls back to
    // raw markup, which at least still carries the inline JSON payload.
    const html = `<html><head><script>window.__DATA__={"a":1,"b":2}</script></head>
      <body><div id="root"></div></body></html>`;
    expect(extractHtmlText(html).afterChars).toBeLessThan(MIN_USEFUL_EXTRACT_CHARS);
  });

  it('collapses a script-and-markup-heavy page by well over 90%', () => {
    // Shaped like the amazona.de scan that motivated this module: a little real
    // copy buried in inline scripts, styles and nav markup.
    const noise = `<script>${'var pad=1;'.repeat(2_000)}</script><style>${'.a{b:c}'.repeat(2_000)}</style>`;
    const html = `<html><head><title>Musiker-Magazin</title>
      <meta name="description" content="Tests zu Synthesizern und Gitarren"/>
      ${noise}</head><body><h1>Aktuelle Tests</h1><p>Wir testen Synthesizer seit 1999.</p>
      ${'<div class="nav-item"><a href="/x">Link</a></div>'.repeat(500)}</body></html>`;

    const { text, beforeChars, afterChars } = extractHtmlText(html);

    expect(beforeChars).toBeGreaterThan(40_000);
    expect(afterChars / beforeChars).toBeLessThan(0.1);
    // The findings a website analysis actually needs all survive.
    expect(text).toContain('title: Musiker-Magazin');
    expect(text).toContain('description: Tests zu Synthesizern und Gitarren');
    expect(text).toContain('## Aktuelle Tests');
    expect(text).toContain('Wir testen Synthesizer seit 1999.');
  });

  it('handles empty and tagless input without throwing', () => {
    expect(extractHtmlText('').text).toBe('');
    expect(extractHtmlText('nur text').text).toContain('nur text');
  });
});
