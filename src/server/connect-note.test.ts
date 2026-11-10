import { describe, it, expect } from 'vitest';
import { OAUTH_PRESETS } from '../core/oauth-presets.js';
import { connectNoteFor, noteButton, noteLang, noteText, noteTitle, noteVersionFor } from './connect-note.js';
import { consentPageHtml } from './http-api.js';

// The note a helper reads before connecting (the approved wording), word for word. A
// difference here is a text that was not approved; change it only with a new approval.
const NOTE1 = {
  de: 'Der Inhaber dieser Instanz sieht, welches Konto du hier verbindest. Ein Plan, den er bestätigt, kann diese Verbindung nutzen.',
  en: 'The owner of this instance sees which account you connect here. A plan they confirm can use this connection.',
};
const NOTE3 = {
  de: 'Der Inhaber dieser Instanz sieht, dass du hier Acme mit deinem eigenen Login verbindest, und, wenn Acme es lynox mitteilt, mit welchem Konto. Ein Plan, den er bestätigt, kann diese Verbindung nutzen.',
  en: 'The owner of this instance sees that you connect Acme here with your own login and, if Acme tells lynox, with which account. A plan they confirm can use this connection.',
};

describe('the note before a helper connects', () => {
  it('says the first note word for word, in both languages', () => {
    expect(noteText('1', 'de', 'Acme')).toBe(NOTE1.de);
    expect(noteText('1', 'en', 'Acme')).toBe(NOTE1.en);
  });

  it('says the third note word for word, in both languages, with the provider named', () => {
    expect(noteText('3', 'de', 'Acme')).toBe(NOTE3.de);
    expect(noteText('3', 'en', 'Acme')).toBe(NOTE3.en);
  });

  it('says title and button as agreed (U-180)', () => {
    expect([noteTitle('de', 'Acme'), noteTitle('en', 'Acme')]).toEqual(['Acme verbinden', 'Connect Acme']);
    expect([noteButton('de', 'Acme'), noteButton('en', 'Acme')]).toEqual(['Weiter zu Acme', 'Continue to Acme']);
  });

  it('gives the first note only where the callback reads the account from the store\'s origin', () => {
    const ids = OAUTH_PRESETS.ids();
    expect(ids.length).toBeGreaterThan(1);
    for (const id of ids) {
      const preset = OAUTH_PRESETS.get(id)!;
      expect([id, noteVersionFor(preset)]).toEqual([id, preset.callbackVerification === 'shopify-hmac' ? '1' : '3']);
    }
    // Both branches are reached by the register as it stands.
    expect(noteVersionFor(OAUTH_PRESETS.get('shopify')!)).toBe('1');
    expect(noteVersionFor(OAUTH_PRESETS.get('bexio')!)).toBe('3');
  });

  it('names the provider by the preset\'s label', () => {
    expect(connectNoteFor(OAUTH_PRESETS.get('bexio')!, 'de')).toEqual({ version: '3', lang: 'de', provider: 'bexio' });
  });

  it.each([
    [undefined, 'en'],
    ['', 'en'],
    ['de', 'de'],
    ['de-CH', 'de'],
    ['DE-de', 'de'],
    ['en-US,en;q=0.9,de;q=0.8', 'en'],
    ['de;q=0.5, en;q=0.6', 'en'],
    ['fr, de;q=0.3', 'de'],
    ['fr, it', 'en'],
    ['de;q=0, en;q=0.1', 'en'],
    ['de;q=x', 'en'],
    ['de;Q=0.1, en;q=0.9', 'en'],
  ] as const)('reads %j as %s', (header, want) => {
    expect(noteLang(header)).toBe(want);
  });
});

describe('the note page', () => {
  it('stands the first note before its one button, and holds the confirmation to it', () => {
    const html = consentPageHtml(undefined, ['read_products'], { version: '1', lang: 'de', provider: 'Shopify' });
    expect(html).toContain(`<p data-connect-note="1">${NOTE1.de}</p><form method="post" action="?shown_scopes=read_products&amp;shown_note=1"><button type="submit">Weiter zu Shopify</button></form>`);
    expect(html).toContain('<title>Shopify verbinden</title><');
    expect(html).toContain('<h1>Shopify verbinden</h1>');
    expect(html.match(/<button/g)).toHaveLength(1);
  });

  it('escapes the provider wherever it is written', () => {
    const html = consentPageHtml(undefined, [], { version: '3', lang: 'en', provider: '<b>&' });
    expect(html).not.toContain('<b>&');
    expect(html).toContain('Continue to &lt;b&gt;&amp;');
  });

  it('control: the customer text alone keeps its page, without a note', () => {
    const html = consentPageHtml({ lang: 'de', writeScopes: ['a_edit'], paragraphs: ['P.'] }, ['a_edit']);
    expect(html).not.toContain('data-connect-note');
    expect(html).toContain('action="?shown_scopes=a_edit"');
  });
});
