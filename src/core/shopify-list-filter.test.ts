/**
 * A Shopify list narrowed by product type and/or vendor: the value rule that decides what may
 * stand between the quotes of the store's search, the one refusal sentence that names it, the
 * body and grant each page is sent under, and where in the engine the stored form is read.
 * The read end to end is in `bulk-shopify.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SHOPIFY_LIST_FILTER_KEYS, SHOPIFY_LIST_FILTER_MAX_VALUES, SHOPIFY_LIST_PAGE_SIZE, SHOPIFY_READ_DOCUMENTS, isShopifyFilterValue, isShopifyFilterValues, isShopifyListFilters,
  SHOPIFY_READ_DETAIL_MAX, shopifyFilterListRefusal, shopifyFilterRefusal, shopifyListBody, shopifyReadRequest,
} from './shopify-graphql.js';
import { listPageUrl, listQueryParams, parseListSource, type BulkListSource } from './bulk-list.js';
import { shopifyInFilter } from './bulk-shopify.js';
import { contractGrants, withShopifyRead } from '../tools/permission-guard.js';
import type { CapabilityContract } from '../types/capability-contract.js';

const HOST = 'acme.myshopify.com';
const ENDPOINT = `https://${HOST}/admin/api/2026-10/graphql.json`;

describe('the value rule', () => {
  it.each([
    ['a word', 'Tee'],
    ['words with single spaces', 'Men Short Sleeve'],
    ['letters with diacritics and other scripts', 'Café Crème Ελληνικά 日本語'],
    ['digits, and a word that starts with one', '2024 Kollektion'],
    ['the punctuation inside a word', "Men's_A.B&C/D+E"],
    ['- between two letters or digits', 'T-Shirt 3-Pack'],
    ['a word that only holds OR/AND/NOT', 'ORANGE Andorra Nothing XOR'],
    ['one character', 'A'],
    ['the cases the rule names as taken', "Men's Shirts T-Shirt Nr.1"],
    ['a Unicode value in NFC', 'Gemüse'],
    ['- between a precomposed letter and a letter', 'Á-B'],
    ['255 code points', 'é'.repeat(255)],
    ['255 code points outside the BMP, counted as code points not UTF-16 units', '𠀀'.repeat(255)],
  ])('takes %s', (_name, value) => {
    expect(isShopifyFilterValue(value), value).toBe(true);
  });

  it.each([
    ['an empty value', ''],
    ['256 code points', 'a'.repeat(256)],
    ['a leading space', ' Tee'],
    ['a trailing space', 'Tee '],
    ['a double space', 'Short  Sleeve'],
    ['a tab or a newline', 'a\tb'],
    ['a newline', 'a\nb'],
    ['a quote', 'a"b'],
    ['a backslash', 'a\\b'],
    ['a star', 'Tee*'],
    ['a bracket', 'a)b'],
    ['a colon', 'vendor:x'],
    ['a comma, measured not literal', 'a,b'],
    ['- at the start', '-Tee'],
    ['- at the end', 'Tee-'],
    ['- after a space', 'a -b'],
    ['- next to punctuation', 'a.-b'],
    ['two - in a row', 'a--b'],
    ['a word that starts with punctuation', 'Rock & Roll'],
    ['a value that starts with punctuation', '.Tee'],
    ['OR as a word', 'Tee OR Mug'],
    ['and in lower case as a word', 'Salt and Pepper'],
    ['NoT in mixed case as a word', 'NoT'],
    ['OR as a word between punctuation', 'Color_or_Size'],
    ['a fullwidth letter (not NFKC-stable)', 'Ｔee'],
    ['a fullwidth OR as a word (not NFKC-stable)', 'a ＯＲ b'],
    ['a decomposed letter (not NFKC-stable)', 'Café'],
    ['a zero-width space', 'a​b'],
    ['a soft hyphen', 'a­b'],
    ['a modifier letter', 'Hawaiʻi'],
    ['a word that starts with a mark', 'a ́b'],
    ['a dash that is not -', 'a–b'],
    ['a control character', 'a\u0001b'],
    ['a line separator', 'a\u2028b'],
    ['a decomposed Gemüse (NFD)', 'Gemu\u0308se'],
    ['a fullwidth OR alone', 'ＯＲ'],
    ['a modifier letter double prime', 'a\u02BAb'],
    ['a superscript digit (not NFKC-stable)', 'a²'],
    ['- at the start of a later word', 'Bags -Cases'],
    ["' at a word start", "'X"],
    ['- after /', 'Bags/-Cases'],
    ['- after &', 'A&-B'],
    ['- after .', 'Nr.-1'],
    ['- with a space after it', 'A- B'],
    ['- before /', 'A-/B'],
    ['- at the very end', 'Shirts-'],
    ['- beside a letter that carries a combining mark', 'x\u0303-y'],
    ['OR between hyphens', 'Bags-OR-Cases'],
    ['and between slashes', 'a/and/b'],
    ['a combining grapheme joiner (default-ignorable mark)', 'a\u034Fb'],
    ['a Hangul filler (default-ignorable)', 'a\u3164b'],
    ['a Hangul choseong filler (default-ignorable letter, NFKC-stable)', 'a\u115Fb'],
    ['a variation selector', 'a\uFE00b'],
  ])('refuses %s', (_name, value) => {
    expect(isShopifyFilterValue(value), JSON.stringify(value)).toBe(false);
  });

  it('refuses what is not a string', () => {
    for (const value of [5, null, undefined, ['Tee'], { v: 'Tee' }, true]) expect(isShopifyFilterValue(value), String(value)).toBe(false);
  });

  it('takes a set of filters naming known keys only, at least one, each with a value it takes', () => {
    expect(isShopifyListFilters({ product_type: 'Tee' })).toBe(true);
    expect(isShopifyListFilters({ product_type: 'Tee', vendor: 'Acme' })).toBe(true);
    for (const f of [{}, { tag: 'x' }, { product_type: 'Tee', tag: 'x' }, { vendor: '' }, { vendor: 'a OR b' }, [], null, 'Tee']) {
      expect(isShopifyListFilters(f), JSON.stringify(f)).toBe(false);
    }
  });
});

describe('the refusal sentence', () => {
  const SENTENCE = shopifyFilterRefusal('vendor');
  const listed = (): Set<string> => {
    const m = /may hold letters, digits, single spaces and (.*) ; every word/.exec(SENTENCE)!;
    return new Set(m[1]!.split(' '));
  };

  it('is the one fixed sentence, with the key and never the value', () => {
    expect(SENTENCE).toBe("source_list.filters.vendor may hold letters, digits, single spaces and _ . & ' / + ; every word starts with a letter or digit, - stands only between two letters or digits, no run of letters and digits is OR, AND or NOT in any letter case (so Forget-Me-Not and Salt and Pepper are refused), and at most 255 characters.");
  });

  // The sentence is prompt surface: each case it names is what the rule does.
  it('names cases the rule refuses and one it takes, as the rule decides them', () => {
    for (const v of ['Forget-Me-Not', 'Salt and Pepper', 'Rock/Or', 'x'.repeat(256)]) expect(isShopifyFilterValue(v), v).toBe(false);
    for (const v of ['Andorra', 'Notebook', 'x'.repeat(255)]) expect(isShopifyFilterValue(v), v).toBe(true);
    expect(SENTENCE).toContain('Forget-Me-Not and Salt and Pepper are refused');
    expect(SENTENCE).toContain('at most 255 characters');
  });

  it('names exactly the punctuation the rule takes inside a word, checked against the rule for every ASCII character', () => {
    const named = listed();
    for (let code = 0x21; code < 0x7f; code++) {
      const c = String.fromCharCode(code);
      if (/[A-Za-z0-9]/.test(c)) continue;
      // `-` has its own clause in the sentence, so it is not among the listed characters.
      const said = c === '-' ? SENTENCE.includes('- stands only between two letters or digits') : named.has(c);
      expect(isShopifyFilterValue(`A${c}B`), `${c} named: ${String(said)}`).toBe(said);
    }
  });

  it('lists nothing the rule refuses, and names exactly the words it refuses', () => {
    for (const c of listed()) expect(isShopifyFilterValue(`A${c}B`), c).toBe(true);
    // The rule refuses a word the sentence names, and none it does not.
    for (const w of ['OR', 'AND', 'NOT']) {
      expect(SENTENCE).toContain(w);
      expect(isShopifyFilterValue(`A ${w} B`), w).toBe(false);
    }
    for (const w of ['XOR', 'NOR', 'NAND', 'ANDOR', 'TO', 'IN']) expect(isShopifyFilterValue(`A ${w} B`), w).toBe(true);
  });

  it('is what the planner is told, for each key, without the value', () => {
    for (const key of SHOPIFY_LIST_FILTER_KEYS) {
      expect(() => parseListSource(HOST, { form: 'shopify', filters: { [key]: 'Secret"Value' }, after: { title: 'x' } }, 'PATCH', () => null))
        .toThrow(shopifyFilterRefusal(key));
      try {
        parseListSource(HOST, { form: 'shopify', filters: { [key]: 'Secret"Value' }, after: { title: 'x' } }, 'PATCH', () => null);
      } catch (e) {
        expect((e as Error).message).not.toContain('Secret');
      }
    }
  });
});

describe('a Shopify list source with filters, as the planner gives it', () => {
  const parse = (filters: unknown, scan: (t: string) => string | null = () => null): BulkListSource =>
    parseListSource(HOST, { form: 'shopify', filters, after: { title: 'x' } }, 'PATCH', scan);

  it('refuses empty filters and an empty value instead of reading every product', () => {
    for (const f of [{}, [], 'Tee', null, 5]) expect(() => parse(f), JSON.stringify(f)).toThrow('source_list.filters for form shopify must name product_type, vendor or both.');
    expect(() => parse({ product_type: '' })).toThrow(shopifyFilterRefusal('product_type'));
    expect(() => parse({ vendor: ' ' })).toThrow(shopifyFilterRefusal('vendor'));
  });

  it('refuses a key it does not know, and a value that looks like a credential', () => {
    expect(() => parse({ product_type: 'Tee', tag: 'x' })).toThrow('source_list.filters for form shopify may only use: product_type, vendor.');
    expect(() => parse({ vendor: 'Acme' }, (t) => (t === 'Acme' ? 'token' : null))).toThrow('source_list.filters.vendor holds something that looks like a credential.');
  });

  it('keeps an absent filter apart from an empty one', () => {
    expect(parseListSource(HOST, { form: 'shopify', after: { title: 'x' } }, 'PATCH', () => null)).toMatchObject({ form: 'shopify', filters: {} });
    expect(parse({ vendor: 'Acme' })).toMatchObject({ form: 'shopify_filtered', filters: { vendor: 'Acme' } });
  });
});

describe('the body of a filtered list page', () => {
  const q = (body: string | null): unknown => (body === null ? null : (JSON.parse(body) as { variables: { q: string } }).variables.q);

  it('puts each filter in $q as a quoted value, product_type first', () => {
    expect(q(shopifyListBody(0, {}))).toBe('id:>0');
    expect(q(shopifyListBody(7, { vendor: 'Acme' }))).toBe('id:>7 AND vendor:"Acme"');
    expect(q(shopifyListBody(7, { product_type: 'Gemüse' }))).toBe('id:>7 AND product_type:"Gemüse"');
    expect(q(shopifyListBody(7, { vendor: 'Acme', product_type: "Men's T-Shirt" }))).toBe('id:>7 AND product_type:"Men\'s T-Shirt" AND vendor:"Acme"');
  });

  it('builds nothing for filters the rule refuses, so no grant and no request can carry them', () => {
    for (const f of [{ vendor: 'a" OR vendor:"b' }, { vendor: '' }, { tag: 'x' } as never, { vendor: 'a\\' }, { product_type: 'x*' }]) {
      expect(shopifyListBody(0, f), JSON.stringify(f)).toBeNull();
    }
  });

  it('records the search it sends in the read trail', () => {
    expect(shopifyReadRequest({ form: 'shopify_products_list', afterId: 7, filters: { product_type: 'Tee' } })?.detail).toBe('shopify_products_list id:>7 AND product_type:"Tee"');
    expect(shopifyReadRequest({ form: 'shopify_products_list', afterId: 7, filters: {} })?.detail).toBe('shopify_products_list id:>7');
    expect(shopifyReadRequest({ form: 'shopify_products_list', afterId: 7, filters: { vendor: 'a OR b' } })).toBeNull();
  });

  it('records a list search as sent where it fits, and otherwise the sent text cut at a value\'s end, saying how many it leaves out', () => {
    const detail = (filters: Parameters<typeof shopifyListBody>[1], room?: number): string =>
      shopifyReadRequest({ form: 'shopify_products_list', afterId: 7, filters }, room)!.detail.slice('shopify_products_list '.length);
    expect(detail({ product_type: ['Tee', 'Kaffee'], vendor: 'Acme' })).toBe('id:>7 AND (product_type:"Tee" OR product_type:"Kaffee") AND vendor:"Acme"');
    // One value of the longest the rule takes: whole where the row has room, else said to be left out.
    const longest = `A${'b'.repeat(254)}`;
    expect(detail({ product_type: longest }, 300)).toBe(`id:>7 AND product_type:"${longest}"`);
    expect(detail({ product_type: longest })).toBe('id:>7 … [cut here: 1 of 1 values left out]');
    expect(SHOPIFY_READ_DETAIL_MAX).toBe(400 - 59 - (63 + '.myshopify.com'.length));
    const values = Array.from({ length: 50 }, (_, i) => `Obergruppe Nummer ${String(i + 1).padStart(2, '0')}`);
    const filters = { product_type: values, vendor: 'Acme' };
    const sent = `id:>7 AND (${values.map((v) => `product_type:"${v}"`).join(' OR ')}) AND vendor:"Acme"`;
    const shown = detail(filters);
    expect(shown.length).toBeLessThanOrEqual(SHOPIFY_READ_DETAIL_MAX);
    const m = /^(.*) … \[cut here: (\d+) of 51 values left out\]$/.exec(shown)!;
    // The sent text itself, operators and all, cut right after a value.
    expect(sent.startsWith(m[1]!)).toBe(true);
    expect(m[1]!.endsWith('"')).toBe(true);
    const kept = [...m[1]!.matchAll(/product_type:"[^"]*"/g)].length;
    expect(kept).toBeGreaterThan(0);
    expect(m[1]).toBe(`id:>7 AND (${values.slice(0, kept).map((v) => `product_type:"${v}"`).join(' OR ')}`);
    expect(Number(m[2])).toBe(51 - kept);
    // As full as the row allows: the next value would not fit.
    expect(`id:>7 AND (${values.slice(0, kept + 1).map((v) => `product_type:"${v}"`).join(' OR ')} … [cut here: ${String(50 - kept)} of 51 values left out]`.length)
      .toBeGreaterThan(SHOPIFY_READ_DETAIL_MAX);
  });

  it('never says it cut nothing: a search just over the row leaves out at least one value', () => {
    // Seven values of length L: the sent search is 141 + 7·L, from under the budget to just over it.
    let cuts = 0;
    for (let L = 17; L <= 25; L++) {
      const values = Array.from({ length: 7 }, (_, i) => `W${String(i)}${'x'.repeat(L - 2)}`);
      const d = shopifyReadRequest({ form: 'shopify_products_list', afterId: 7, filters: { product_type: values } })!.detail;
      const m = / \[cut here: (\d+) of 7 values left out\]$/.exec(d);
      if (m === null) continue;
      cuts++;
      expect(Number(m[1]), d).toBeGreaterThan(0);
    }
    expect(cuts).toBeGreaterThan(0);
  });
});

describe('the grant of a filtered list page', () => {
  const base: CapabilityContract = {
    version: 1, origin: 'reviewed', grantedTools: ['http_request'], httpMethods: [],
    hostPatterns: [HOST], pathPatterns: [], paramConstraints: {},
  };
  const post = (contract: CapabilityContract, body: unknown): boolean =>
    contractGrants('http_request', { method: 'POST', url: ENDPOINT, headers: { 'content-type': 'application/json' }, body }, contract);

  it('grants the body with its own filters and no other — not the whole store, not another group', () => {
    const tee = withShopifyRead(base, HOST, { phase: 'list', afterId: 0, filters: { product_type: 'Tee' } });
    expect(post(tee, shopifyListBody(0, { product_type: 'Tee' }))).toBe(true);
    expect(post(tee, shopifyListBody(0, {}))).toBe(false);
    expect(post(tee, shopifyListBody(0, { product_type: 'Mug' }))).toBe(false);
    expect(post(tee, shopifyListBody(0, { product_type: 'Tee', vendor: 'Acme' }))).toBe(false);
    const all = withShopifyRead(base, HOST, { phase: 'list', afterId: 0, filters: {} });
    expect(post(all, shopifyListBody(0, { product_type: 'Tee' }))).toBe(false);
  });

  it('refuses a body whose $q differs in any part — order, an extra term, a prefix', () => {
    const tee = withShopifyRead(base, HOST, { phase: 'list', afterId: 0, filters: { product_type: 'Tee', vendor: 'Acme' } });
    const body = (q: string): string => JSON.stringify({ query: SHOPIFY_READ_DOCUMENTS.shopify_products_list, variables: { n: SHOPIFY_LIST_PAGE_SIZE, q } });
    expect(post(tee, body('id:>0 AND product_type:"Tee" AND vendor:"Acme"'))).toBe(true);
    for (const q of ['id:>0 AND vendor:"Acme" AND product_type:"Tee"', 'id:>0 AND product_type:"Tee" AND vendor:"Acme" OR id:>0', 'id:>0 AND product_type:"Tee"', 'id:>0 AND product_type:"Tee" AND vendor:"Acme2"']) {
      expect(post(tee, body(q)), q).toBe(false);
    }
  });

  it('is not minted for filters the rule refuses', () => {
    expect(() => withShopifyRead(base, HOST, { phase: 'list', afterId: 0, filters: { vendor: 'a OR b' } })).toThrow(/filters the value rule takes/);
  });
});

describe('a filter with a list of values', () => {
  const parse = (filters: unknown, scan: (t: string) => string | null = () => null): BulkListSource =>
    parseListSource(HOST, { form: 'shopify', filters, after: { title: 'x' } }, 'PATCH', scan);
  const q = (body: string | null): unknown => (body === null ? null : (JSON.parse(body) as { variables: { q: string } }).variables.q);
  const many = (n: number): string[] => Array.from({ length: n }, (_, i) => `Gruppe ${String(i)}`);

  it('takes 2 to the maximum of values the rule takes, none two the same up to ASCII letter case', () => {
    expect(isShopifyFilterValues(['Tee', 'Kaffee'])).toBe(true);
    expect(isShopifyFilterValues(many(SHOPIFY_LIST_FILTER_MAX_VALUES))).toBe(true);
    expect(isShopifyFilterValues('Tee')).toBe(true);
    for (const v of [[], ['Tee'], many(SHOPIFY_LIST_FILTER_MAX_VALUES + 1), ['Tee', 'tee'], ['Tee', 'Tee'], ['Tee', ''], ['Tee', 'a" OR vendor:"b'], ['Tee', 'x)'], ['Tee', 5], ['Tee', ['Mug']]]) {
      expect(isShopifyFilterValues(v), JSON.stringify(v)).toBe(false);
    }
    // Diacritics are not folded: Gemüse and Gemuse are two values, as the check after the read sees them.
    expect(isShopifyFilterValues(['Gemüse', 'Gemuse'])).toBe(true);
  });

  it('is parsed as written, in the planner\'s order, and refused whole otherwise', () => {
    expect(parse({ product_type: ['Kaffee', 'Tee'], vendor: 'Acme' })).toMatchObject({ form: 'shopify_filtered', filters: { product_type: ['Kaffee', 'Tee'], vendor: 'Acme' } });
    for (const v of [[], ['Tee'], many(SHOPIFY_LIST_FILTER_MAX_VALUES + 1), ['Tee', 'TEE']]) {
      expect(() => parse({ product_type: v }), JSON.stringify(v)).toThrow(shopifyFilterListRefusal('product_type'));
    }
    expect(() => parse({ vendor: ['Acme', 'a OR b'] })).toThrow(shopifyFilterRefusal('vendor'));
    expect(() => parse({ vendor: ['Acme', 'Beta'] }, (t) => (t === 'Beta' ? 'token' : null))).toThrow('source_list.filters.vendor holds something that looks like a credential.');
    expect(shopifyFilterListRefusal('vendor')).toBe(`source_list.filters.vendor as a list holds 2 to ${String(SHOPIFY_LIST_FILTER_MAX_VALUES)} values, no two the same up to letter case; for one value give it as text.`);
  });

  it('puts a list in $q as its values joined by OR in parentheses, one value as before', () => {
    expect(q(shopifyListBody(7, { product_type: ['Tee', 'Kaffee'] }))).toBe('id:>7 AND (product_type:"Tee" OR product_type:"Kaffee")');
    expect(q(shopifyListBody(7, { vendor: ['A', 'B'], product_type: ['Tee', 'Mug'] }))).toBe('id:>7 AND (product_type:"Tee" OR product_type:"Mug") AND (vendor:"A" OR vendor:"B")');
    expect(q(shopifyListBody(7, { product_type: ['Tee', 'Mug'], vendor: 'Acme' }))).toBe('id:>7 AND (product_type:"Tee" OR product_type:"Mug") AND vendor:"Acme"');
    // One value builds byte for byte as before lists existed.
    expect(shopifyListBody(7, { product_type: 'Tee' })).toBe(JSON.stringify({ query: SHOPIFY_READ_DOCUMENTS.shopify_products_list, variables: { n: SHOPIFY_LIST_PAGE_SIZE, q: 'id:>7 AND product_type:"Tee"' } }));
    for (const f of [{ product_type: ['Tee'] }, { product_type: [] }, { product_type: ['Tee', 'tee'] }, { product_type: ['Tee', 'a" OR x:"b'] }, { product_type: many(SHOPIFY_LIST_FILTER_MAX_VALUES + 1) }]) {
      expect(shopifyListBody(0, f), JSON.stringify(f).slice(0, 80)).toBeNull();
    }
  });

  it('is granted with its own list only — not another order, not a subset, not one value of it', () => {
    const base: CapabilityContract = { version: 1, origin: 'reviewed', grantedTools: ['http_request'], httpMethods: [], hostPatterns: [HOST], pathPatterns: [], paramConstraints: {} };
    const post = (contract: CapabilityContract, body: unknown): boolean =>
      contractGrants('http_request', { method: 'POST', url: ENDPOINT, headers: { 'content-type': 'application/json' }, body }, contract);
    const g = withShopifyRead(base, HOST, { phase: 'list', afterId: 0, filters: { product_type: ['Tee', 'Kaffee'] } });
    expect(post(g, shopifyListBody(0, { product_type: ['Tee', 'Kaffee'] }))).toBe(true);
    for (const f of [{ product_type: ['Kaffee', 'Tee'] }, { product_type: 'Tee' }, { product_type: ['Tee', 'Kaffee', 'Mug'] }, {}]) {
      expect(post(g, shopifyListBody(0, f)), JSON.stringify(f)).toBe(false);
    }
    expect(() => withShopifyRead(base, HOST, { phase: 'list', afterId: 0, filters: { product_type: ['Tee'] } })).toThrow(/filters the value rule takes/);
  });

  it('holds a product whose field equals any one value, by the same rule as one value, and none of an empty list', () => {
    const product = (productType: unknown, vendor: unknown = 'Acme'): unknown => ({ product: { productType, vendor } });
    expect(shopifyInFilter(product('Kaffee'), { product_type: ['Tee', 'Kaffee'] })).toBe(true);
    expect(shopifyInFilter(product('KAFFEE'), { product_type: ['Tee', 'Kaffee'] })).toBe(true);
    expect(shopifyInFilter(product('Mug'), { product_type: ['Tee', 'Kaffee'] })).toBe(false);
    expect(shopifyInFilter(product('Gemuse'), { product_type: ['Tee', 'Gemüse'] })).toBe(false);
    expect(shopifyInFilter(product('KAFFEÉ'), { product_type: ['Kaffeé'] as never })).toBe(false);
    expect(shopifyInFilter(product(null), { product_type: ['Tee', 'Kaffee'] })).toBe(false);
    expect(shopifyInFilter(product('Tee'), { product_type: [] as never })).toBe(false);
    expect(shopifyInFilter(product('Tee', 'Beta'), { product_type: ['Tee', 'Mug'], vendor: ['Acme', 'Beta'] })).toBe(true);
    expect(shopifyInFilter(product('Tee', 'Gamma'), { product_type: ['Tee', 'Mug'], vendor: ['Acme', 'Beta'] })).toBe(false);
  });

  it('holds no product for a stored list no parse built, and does not throw', () => {
    const product = { product: { productType: 'Tee', vendor: 'Acme' } };
    for (const tampered of [[5, 'Tee'], ['Tee', null], { 0: 'Tee' }, 7]) {
      const filters = { product_type: tampered } as never;
      expect(() => shopifyInFilter(product, filters), JSON.stringify(tampered)).not.toThrow();
    }
    expect(shopifyInFilter(product, { product_type: [5, 'Tee'] } as never)).toBe(false);
    expect(shopifyInFilter(product, { product_type: { 0: 'Tee' } } as never)).toBe(false);
    // Nor a list the rule refuses, though its values are text and one of them matches.
    expect(shopifyInFilter(product, { product_type: ['Tee'] } as never)).toBe(false);
    expect(shopifyInFilter(product, { product_type: ['Tee', 'tee'] } as never)).toBe(false);
    expect(shopifyInFilter(product, { product_type: ['Tee', 'a OR b'] } as never)).toBe(false);
    expect(shopifyInFilter(product, { product_type: 'Tee OR Mug' } as never)).toBe(false);
    // The same list, as the rule takes it, holds it.
    expect(shopifyInFilter(product, { product_type: ['Tee', 'Kaffee'] })).toBe(true);
  });

  it('never reaches the address or the query grant of a list form other than Shopify\'s', () => {
    const woo: BulkListSource = { form: 'woocommerce', path: '/wp-json/wc/v3/products', filters: { category: ['1', '2'] }, idField: 'id', method: 'PATCH', after: { absent: false, value: {} } } as never;
    expect(() => listPageUrl('shop.example.com', woo, 1)).toThrow('only a Shopify list takes a list of filter values');
    expect(() => listQueryParams(woo)).toThrow('only a Shopify list takes a list of filter values');
  });
});

describe('where the stored Shopify list form is read', () => {
  // Every place in the engine that names a Shopify list form, sorted. READ takes the stored
  // form, so it must hold for `shopify_filtered` too; INPUT is what the planner may name, so it
  // takes `shopify` and `shopify_media`, never `shopify_filtered`. A new place fails here until
  // it is sorted into one of them.
  const READ = [
    'core/bulk-list.ts | : isShopifyListForm(form) ? SHOPIFY_LIST_PAGE_SIZE',
    'core/bulk-list.ts | export const SHOPIFY_FILTERED_LIST_FORM = \'shopify_filtered\'',
    'core/bulk-list.ts | export const SHOPIFY_LIST_FORM = \'shopify\';',
    'core/bulk-list.ts | export function isShopifyListForm(form: unknown): form is Sh',
    'core/bulk-list.ts | export function isShopifyListSource(source: BulkListSource):',
    'core/bulk-list.ts | export type ShopifyListSourceForm = typeof SHOPIFY_LIST_FORM',
    'core/bulk-list.ts | function isListForm(v: unknown): v is BulkListForm {',
    'core/bulk-list.ts | hostPatterns: [host], pathPatterns: isShopifyListForm(source',
    'core/bulk-list.ts | if (isShopifyListForm(source.form)) return undefined;',
    'core/bulk-list.ts | if (isShopifyListForm(source.form)) throw new RangeError(\'a ',
    'core/bulk-list.ts | if (source.form === SHOPIFY_FILTERED_LIST_FORM) return sourc',
    'core/bulk-list.ts | if (source.form === SHOPIFY_LIST_FORM) return source.path ==',
    'core/bulk-list.ts | return form === SHOPIFY_LIST_FORM || form === SHOPIFY_FILTER',
    'core/bulk-list.ts | return isListForm(source.form) && BULK_LIST_FORMS[source.for',
    'core/bulk-list.ts | return isShopifyListForm(source.form);',
    'core/bulk-list.ts | return list !== null && list.source.form === SHOPIFY_FILTERE',
    'core/bulk-preview.ts | BULK_LIST_FORMS, SHOPIFY_FILTERED_LIST_FORM, SHOPIFY_MEDIA_L',
    'core/bulk-preview.ts | const shopify = list !== null && isShopifyListSource(list.so',
    // A filtered list is written with the product form.
    'core/bulk-preview.ts | const shopifyForm = list !== null && isShopifyListForm(list.',
    'core/bulk-preview.ts | const withdrawn = list.source.form === SHOPIFY_FILTERED_LIST',
    'core/bulk-preview.ts | if (isShopifyListForm(source.form)) throw new Error(\'a Shopi',
    // The product writer and the HTML fields of a product run: a filtered list writes products too.
    'core/bulk-external-writer.ts | const fields = htmlFieldsOfListForm(\'shopify\').filter((f) =>',
    // The context a judge may read: a filtered list reads its products as every product list does.
    'core/bulk-judge-rule.ts | if (form === \'shopify\' || form === \'shopify_filtered\') retur',
    'core/bulk-judge-rule.ts | if (form === \'shopify_media\') return [];',
    'core/bulk-ledger.ts | if (this.shopifyFormOfRun(run) === \'shopify_product\') for (c',
    'server/http-api.ts | import { BULK_LIST_NOTE, isShopifyListSource, listPageUrl, s',
    'server/http-api.ts | listFirstPage: listRun ? (isShopifyListSource(listRun.source',
    // The image list: every other stored form, filtered or not, is read and written as products.
    'core/bulk-ledger.ts | import { SHOPIFY_MEDIA_LIST_FORM, type BulkListSource, type ',
    'core/bulk-ledger.ts | return this.listFormOfFamily(run) === SHOPIFY_MEDIA_LIST_FOR',
    'core/bulk-list.ts | const perPage = form === SHOPIFY_MEDIA_LIST_FORM ? SHOPIFY_M',
    'core/bulk-list.ts | export const SHOPIFY_MEDIA_LIST_FORM = \'shopify_media\';',
    'core/bulk-list.ts | if (source.form === SHOPIFY_MEDIA_LIST_FORM) return source.p',
    'core/bulk-list.ts | return form === SHOPIFY_MEDIA_LIST_FORM ? \'shopify_media_alt',
    'core/bulk-preview.ts | const media = source.form === SHOPIFY_MEDIA_LIST_FORM;',
  ];
  const INPUT = [
    // parseListSource and parseShopifyListSource: the planner's form, then the stored one it becomes.
    'core/bulk-list.ts | const form = Object.keys(filters).length > 0 ? SHOPIFY_FILTE',
    'core/bulk-list.ts | if (!isListForm(form)) throw new BulkSourceError(`source_lis',
    'core/bulk-list.ts | if (form === SHOPIFY_LIST_FORM) return parseShopifyListSourc',
    'tools/builtin/bulk.ts | form: { type: \'string\', enum: [\'woocommerce\', \'shopify\', \'sh',
    // The forms a planner may name, checked before parsing; the stored form is not one of them.
    'tools/builtin/bulk.ts | function isPlannerShopifyForm(form: unknown): form is typeof',
    'tools/builtin/bulk.ts | return form === SHOPIFY_LIST_FORM || form === SHOPIFY_MEDIA_',
    // A judge on the planner's form: only the product form takes one.
    'tools/builtin/bulk.ts | if (judgeInput !== undefined && form !== \'shopify\') throw ne',
    // The image form on the planner's input: refused where the store connection may not write
    // files, and named after a refused product plan only where it may.
    'tools/builtin/bulk.ts | if (form === \'shopify_media\' && isShopifyStoreHostName(host)',
    'tools/builtin/bulk.ts | const images = form !== \'shopify\' ? \'\' : mediaWritableFor(in',
    'tools/builtin/bulk.ts | import { SHOPIFY_LIST_FORM, SHOPIFY_MEDIA_LIST_FORM, listRea',
    // parseShopifyMediaListSource: the planner's image form and the form it is stored under.
    'core/bulk-list.ts | if (form === SHOPIFY_MEDIA_LIST_FORM) return parseShopifyMed',
    'core/bulk-list.ts | return { form: SHOPIFY_MEDIA_LIST_FORM, path: \'\', filters: {',
  ];
  // Lines that name the provider `shopify` (its OAuth preset), not a list form.
  const NOT_A_LIST_FORM = [
    'core/oauth-presets.ts | id: \'shopify\',',
    'core/shopify-graphql.ts | const version = OAUTH_PRESETS.get(\'shopify\')?.adminApiVersio',
    'server/webhook-receiver.ts | const secret = this.deps.secret(presetClientKeys(\'shopify\').',
    'core/webhook-verifiers.ts | return profile.auth?.type === \'oauth2\' && profile.auth.oauth',
    // The instance setting that lets bulk runs read a store: a switch, not a list form.
    'web-ui/lib/components/bulk-runs-setting.ts | && typeof r[\'shopify\'] === \'boolean\';',
    'web-ui/lib/stores/contained-way-out.ts | const shopify = bulk[\'shopify\'] === true;',
  ];
  const PATTERN = /SHOPIFY_(FILTERED_|MEDIA_)?LIST_FORM|isShopifyList(Source|Form)|'shopify(_filtered|_media)?'|isListForm\(/;

  function places(): string[] {
    const out: string[] = [];
    const walk = (root: string, dir: string, prefix: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(root, p, prefix); }
        else if (/\.(ts|svelte)$/.test(e.name) && !e.name.endsWith('.test.ts') && !e.name.endsWith('.d.ts')) {
          const rel = prefix + p.slice(root.length + 1);
          for (const line of readFileSync(p, 'utf8').split('\n')) {
            const t = line.trim();
            if (t.startsWith('*') || t.startsWith('/*') || t.startsWith('//')) continue;
            if (PATTERN.test(t)) out.push(`${rel} | ${t.slice(0, 60)}`);
          }
        }
      }
    };
    walk(join(__dirname, '..'), join(__dirname, '..'), '');
    // The web UI compares no list form today (its two lines above name a setting); a place there would be sorted here too.
    const ui = join(__dirname, '..', '..', 'packages', 'web-ui', 'src');
    walk(ui, ui, 'web-ui/');
    return out.filter((p) => !NOT_A_LIST_FORM.includes(p)).sort();
  }

  it('is sorted, each place into one list', () => {
    expect(READ.filter((p) => INPUT.includes(p))).toEqual([]);
    expect(places()).toEqual([...READ, ...INPUT].sort());
  });

  it('has a pattern that sees each way a place is written', () => {
    expect(PATTERN.test("if (source.form === 'shopify_filtered')")).toBe(true);
    expect(PATTERN.test('isShopifyListForm(x)')).toBe(true);
    expect(PATTERN.test("OAUTH_PRESETS.get('shopifyx')")).toBe(false);
    expect(places().length).toBe(READ.length + INPUT.length);
    // The provider lines it leaves out are there, so leaving them out is not what keeps the list short.
    const all = NOT_A_LIST_FORM.map((p) => p.split(' | ')[0]!);
    for (const [i, f] of all.entries()) {
      const text = readFileSync(f.startsWith('web-ui/') ? join(__dirname, '..', '..', 'packages', 'web-ui', 'src', f.slice('web-ui/'.length)) : join(__dirname, '..', f), 'utf8');
      expect(text.split('\n').some((l) => `${f} | ${l.trim().slice(0, 60)}` === NOT_A_LIST_FORM[i]), NOT_A_LIST_FORM[i]).toBe(true);
    }
  });
});
