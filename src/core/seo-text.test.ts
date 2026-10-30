import { describe, expect, it } from 'vitest';
import { checkSeoAfter, checkSeoText, seoFieldsOfListForm } from './seo-text.js';
import { verdictTextRefusal } from './bulk-judge.js';

const OWN = ['acme.myshopify.com', 'acmewater.ch'];
const meta = (value: unknown, before: string | null = null, own: readonly string[] = OWN) =>
  checkSeoText('shopify', 'seo_title', value, before, own);
const refused = (kind: string) => ({ ok: false, reason: 'seo_text_refused', kind });

describe('the SEO value rule (PRD shopify-preset §23.1 item 3)', () => {
  it.each([
    ['https://x.example', 'link'],
    ['Mehr unter http://x.example/a', 'link'],
    ['//x.example', 'link'],
    ['Siehe (//x.example)', 'link'],
    ['www.x.example', 'link'],
    ['WWW.x.example', 'link'],
    ['WWW.X.EXAMPLE', 'link'],
    ['evil.example', 'link'],
    ['EVIL.COM', 'link'],
    ['evil.COM', 'link'],
    ['info@x.example', 'address'],
    ['a@b@c.EXAMPLE', 'address'],
    ['<b>', 'markup'],
    ['Size < 40', 'markup'],
  ])('refuses %s as %s', (value, kind) => {
    expect(meta(value)).toEqual(refused(kind));
  });

  it.each([
    ['：／／x', 'link'],
    // Fullwidth throughout: no dot as written, so only the NFKC pass sees the host.
    ['ｗｗｗ．ｅｖｉｌ．ｅｘａｍｐｌｅ', 'link'],
    // An upper-case TLD outside the list: no domain as written, an address after NFKC.
    ['info＠x.EXAMPLE', 'address'],
    ['www。evil。com', 'link'],
    ['evil｡com', 'link'],
    ['＜b＞', 'markup'],
  ])('refuses %s after NFKC as %s', (value, kind) => {
    expect(meta(value)).toEqual(refused(kind));
  });

  it.each([
    [null], [''], ['Wasserfilter & Kalkschutz – 20 € günstiger'], ["Kinder's Shirt"], ['5.5 l für 0.5l-Flaschen, 1.5kg'],
    ['Inkl.MwSt'], ['Inkl.MWSt'], ['GmbH & Co.KG'], ['Gr.XL'], ['Vol.II'], ['2.OG'], ['Nr.CH-123'],
    ['Bio // vegan'], ['Rot//Blau'], ['Größe 38//40'], ['Evil.Com'], ['Preis @ 5 €'], ['Team@Home'], ['Team@Home @ Mo.Fr'], ['Pipe 2" wide > 1"'],
  ])('lets %s pass', (value) => {
    expect(meta(value)).toEqual({ ok: true });
  });

  it('checks every match, not the first', () => {
    expect(meta('Acmewater.ch – mehr auf evil.com')).toEqual(refused('link'));
    expect(meta('www.acmewater.ch oder WWW.EVIL.EXAMPLE')).toEqual(refused('link'));
  });

  it('finds a domain at the end of a dotted run and after stray dots', () => {
    expect(meta('Inkl.MwSt.evil.com')).toEqual(refused('link'));
    expect(meta('Siehe ..evil.com')).toEqual(refused('link'));
    expect(meta('x_evil.com')).toEqual(refused('link'));
  });

  it('reads a long run of short labels in linear time', () => {
    // A planner's after-state may be long; searched from every label, this took seconds.
    const long = `${'a.'.repeat(50_000)}a1`;
    const started = performance.now();
    expect(meta(long)).toEqual({ ok: true });
    expect(meta('x@'.repeat(50_000))).toEqual({ ok: true });
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe('own domains', () => {
  it.each([['Acmewater.ch – Wasserfilter'], ['www.acmewater.ch'], ['shop.acmewater.ch'], ['Mehr auf acme.myshopify.com']])('lets %s pass', (value) => {
    expect(meta(value)).toEqual({ ok: true });
  });

  it.each([['evilacmewater.ch'], ['acmewater.ch.evil.example'], ['www.evilacmewater.ch']])('refuses %s', (value) => {
    expect(meta(value)).toEqual(refused('link'));
  });

  it('never exempts a link with a scheme, a scheme-relative one or an address', () => {
    expect(meta('https://acmewater.ch')).toEqual(refused('link'));
    expect(meta('//acmewater.ch/x')).toEqual(refused('link'));
    expect(meta('info@acmewater.ch')).toEqual(refused('address'));
  });

  it('counts only what the caller gives', () => {
    expect(meta('Acmewater.ch – Wasserfilter', null, ['acme.myshopify.com'])).toEqual(refused('link'));
  });
});

describe('the before-image measure of a bare domain', () => {
  it('lets a field keep a dotted word it held and refuses one it did not', () => {
    expect(checkSeoText('shopify', 'title', 'Neuer Kurs für Node.js', 'Kurs für Node.js', OWN)).toEqual({ ok: true });
    expect(checkSeoText('shopify', 'title', 'Neuer Kurs für Node.js', 'Kurs', OWN)).toEqual(refused('link'));
    expect(checkSeoText('shopify', 'title', 'Node.js auf evil.com', 'Kurs für Node.js', OWN)).toEqual(refused('link'));
  });

  it('measures only the bare domain: a link, www. and an address stay refused where the before-image held them', () => {
    expect(meta('Neu: https://x.example', 'https://x.example')).toEqual(refused('link'));
    expect(meta('Neu: www.x.example', 'www.x.example')).toEqual(refused('link'));
    expect(meta('Neu: info@x.example', 'info@x.example')).toEqual(refused('address'));
    expect(meta('Neu: <b>', '<b>')).toEqual(refused('markup'));
  });
});

describe('which fields are checked', () => {
  it('reads the title and SEO fields of the Shopify form only', () => {
    expect(seoFieldsOfListForm('shopify')).toEqual(['title', 'seo_title', 'seo_description']);
    expect(checkSeoText('shopify', 'seo_description', 'evil.com', null, OWN)).toEqual(refused('link'));
    expect(checkSeoText('shopify', 'title', 'evil.com', null, OWN)).toEqual(refused('link'));
    expect(checkSeoText('shopify', 'vendor', 'evil.com', null, OWN)).toEqual({ ok: true });
    expect(checkSeoText('woocommerce', 'seo_title', 'evil.com', null, OWN)).toEqual({ ok: true });
    expect(checkSeoText(null, 'seo_title', 'evil.com', null, OWN)).toEqual({ ok: true });
  });
});

describe('only what the run writes (condition A)', () => {
  it('skips a field equal to its before-image and checks one that differs', () => {
    const before = { seo_title: 'Old', seo_description: 'Mehr auf https://evil.example' };
    expect(checkSeoAfter('shopify', { seo_title: 'New', seo_description: before.seo_description }, before, OWN)).toEqual({ ok: true });
    expect(checkSeoAfter('shopify', { seo_title: 'New' }, before, OWN)).toEqual({ ok: true });
    expect(checkSeoAfter('shopify', { seo_description: 'Neu auf https://evil.example' }, before, OWN)).toEqual(refused('link'));
    expect(checkSeoAfter('shopify', { seo_title: null, seo_description: 1 }, before, OWN)).toEqual({ ok: true });
  });
});

describe('order against markup_in_text (§23.1 item 5)', () => {
  const run = { listForm: 'shopify' as const, storeHost: 'acme.myshopify.com', startDomains: ['acmewater.ch'] };
  it('gives the SEO reason for a new `<` in a meta field, and S20-2 still for a `>`', () => {
    expect(verdictTextRefusal({ seo_title: 'New <b>x</b>' }, { seo_title: 'Old' }, run)).toBe('seo_text_refused');
    expect(verdictTextRefusal({ seo_title: 'A <> B, 2 m' }, { seo_title: 'A <> B' }, run)).toBe('seo_text_refused');
    expect(verdictTextRefusal({ seo_title: 'New > x' }, { seo_title: 'Old' }, run)).toBe('markup_in_text');
  });

  it('leaves a held `<` to S20-2 on a form outside the map (D-4)', () => {
    const woo = { listForm: 'woocommerce' as const, storeHost: 'shop.example', startDomains: [] };
    expect(verdictTextRefusal({ name: 'A <> B, 2 m' }, { name: 'A <> B' }, woo)).toBeNull();
    expect(verdictTextRefusal({ name: 'A <b> B' }, { name: 'A B' }, woo)).toBe('markup_in_text');
  });

  it('takes the store host and the start domains as own', () => {
    expect(verdictTextRefusal({ seo_title: 'Acmewater.ch – Wasserfilter' }, { seo_title: 'Old' }, run)).toBeNull();
    expect(verdictTextRefusal({ seo_title: 'acme.myshopify.com' }, { seo_title: 'Old' }, run)).toBeNull();
    expect(verdictTextRefusal({ seo_title: 'evil.com' }, { seo_title: 'Old' }, run)).toBe('seo_text_refused');
  });
});
