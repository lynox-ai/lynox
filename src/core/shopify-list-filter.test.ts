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
  SHOPIFY_LIST_FILTER_KEYS, SHOPIFY_LIST_PAGE_SIZE, SHOPIFY_READ_DOCUMENTS, isShopifyFilterValue, isShopifyListFilters, shopifyFilterRefusal, shopifyListBody, shopifyReadRequest,
} from './shopify-graphql.js';
import { parseListSource, type BulkListSource } from './bulk-list.js';
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
    expect(SENTENCE).toBe("source_list.filters.vendor may hold letters, digits, single spaces and _ . & ' / + ; every word starts with a letter or digit, - stands only between two letters or digits, and OR, AND, NOT are not allowed as words.");
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
    'tools/builtin/bulk.ts | if (listForm === SHOPIFY_LIST_FORM || listForm === SHOPIFY_M',
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
    'server/webhook-receiver.ts | shopHost = profile.auth?.type === \'oauth2\' && profile.auth.o',
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
    // The web UI never compares a list form today; a place there would be sorted here too.
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
      const text = readFileSync(join(__dirname, '..', f), 'utf8');
      expect(text.split('\n').some((l) => `${f} | ${l.trim().slice(0, 60)}` === NOT_A_LIST_FORM[i]), NOT_A_LIST_FORM[i]).toBe(true);
    }
  });
});
