import { describe, it, expect } from 'vitest';
import {
  BULK_LIST_PAGE_BYTES, isSameListItem, isUnderList, listItemId, listItemKey, listPageCap, listPageElements,
  listPageUrl, listQueryParams, maxListPages, parseListSource, type BulkListSource,
} from './bulk-list.js';
import { BULK_MAX_SOURCE_BYTES } from './bulk-plan.js';

const HOST = 'shop.example.com';
const noSecret = (): null => null;
const base = { path: '/wp-json/wc/v3/products', after: { status: 'draft' } };

function parse(input: unknown, scan: (t: string) => string | null = noSecret): BulkListSource {
  return parseListSource(HOST, input, 'PUT', scan);
}

describe('parseListSource', () => {
  it('accepts a plain list with filters from the form and fills the defaults', () => {
    const s = parse({ ...base, filters: { category: '12', status: 'publish' } });
    expect(s).toEqual({
      form: 'woocommerce', path: '/wp-json/wc/v3/products', filters: { category: '12', status: 'publish' },
      idField: 'id', method: 'PUT', after: { status: 'draft' },
    });
  });

  it('takes a whole-number filter value as its text', () => {
    expect(parse({ ...base, filters: { category: 12 } }).filters).toEqual({ category: '12' });
  });

  it.each([
    ['/wp-json/wc/v3/products/'],
    ['/wp-json/wc/v3/products?status=any'],
    ['/wp-json/%2E%2E/products'],
    ['/wp-json/../products'],
    ['/wp-json/./products'],
    ['/wp-json/wc/v3/pro*ducts'],
    ['wp-json/wc/v3/products'],
    ['//evil.example.org/x'],
    ['/a b'],
    [''],
  ])('refuses the path %j', (path) => {
    expect(() => parse({ ...base, path })).toThrow(/source_list\.path/);
  });

  it.each([['_method'], ['rest_route'], ['.method'], ['page'], ['per_page'], ['orderby'], ['Category']])(
    'refuses the filter name %j — names come from the form, never from the planner',
    (name) => {
      expect(() => parse({ ...base, filters: { [name]: 'x' } })).toThrow(/may only use/);
    },
  );

  it.each([['a;b'], ['a&b'], ['a=b'], ['a%26'], ['a.b'], ['a b'], ['a+b'], ['a[0]'], [''], ['x'.repeat(65)], [1.5], [-0.5], [true], [null]])(
    'refuses the filter value %j',
    (value) => {
      expect(() => parse({ ...base, filters: { category: value } })).toThrow(/filter value/);
    },
  );

  it.each([['a.b'], ['a[0]'], ['1id'], [''], [7]])('refuses the id field %j', (idField) => {
    expect(() => parse({ ...base, id_field: idField })).toThrow(/id_field/);
  });

  it('refuses an after-state that sets the id field', () => {
    expect(() => parse({ ...base, after: { id: 5, status: 'draft' } })).toThrow(/must not set the id field/);
    expect(() => parse({ ...base, id_field: 'sku', after: { sku: 'x' } })).toThrow(/must not set the id field/);
  });

  it.each([[{}], [[]], ['x'], [{ a: { b: 1 } }], [{ a: [1] }]])('refuses the after-state %j', (after) => {
    expect(() => parse({ ...base, after })).toThrow(/source_list\.after/);
  });

  it('refuses an after-state the secret scan flags, and an address it flags', () => {
    expect(() => parse(base, (t) => (t.includes('draft') ? 'key' : null))).toThrow(/credential/);
    expect(() => parse({ ...base, filters: { sku: 'SECRETSKU' } }, (t) => (t.includes('SECRETSKU') ? 'key' : null))).toThrow(/list address/);
  });

  it('refuses a mail provider\'s API as a list', () => {
    expect(() => parseListSource('gmail.googleapis.com', { ...base, path: '/gmail/v1/users/me/messages' }, 'PATCH', noSecret))
      .toThrow(/mail provider/);
  });

  it.each([['/wp-json/wp/v2/users'], ['/wp-json/wc/v3/products/7/variations'], ['/wp-json/wc/v2/products'], ['/api/products']])(
    'refuses %j, a path outside the form — a form\'s filter names mean what they mean only on its own paths',
    (path) => {
      expect(() => parse({ ...base, path })).toThrow(/not a list of the form woocommerce/);
    },
  );

  it('refuses an unknown form and a write method outside the three', () => {
    expect(() => parse({ ...base, form: 'shopify' })).toThrow(/form must be one of/);
    expect(() => parseListSource(HOST, base, 'DELETE' as 'PUT', noSecret)).toThrow(/write_method/);
  });
});

describe('listPageUrl', () => {
  const s = parse({ ...base, filters: { status: 'publish', category: '12' } });

  it('builds the address in a fixed order: filters by name, order, page size, page', () => {
    expect(listPageUrl(HOST, s, 3)).toBe(
      'https://shop.example.com/wp-json/wc/v3/products?category=12&status=publish&orderby=id&order=asc&per_page=50&page=3',
    );
  });

  it('holds nothing a server could split differently from what was checked', () => {
    for (let page = 1; page <= maxListPages('woocommerce'); page++) {
      const query = listPageUrl(HOST, s, page).split('?')[1]!;
      expect(query).toMatch(/^[a-z_]+=[A-Za-z0-9_-]+(?:&[a-z_]+=[A-Za-z0-9_-]+)*$/);
    }
  });

  it.each([[0], [-1], [1.5], [maxListPages('woocommerce') + 1]])('refuses page %j', (page) => {
    expect(() => listPageUrl(HOST, s, page)).toThrow(RangeError);
  });
});

describe('listQueryParams', () => {
  it('pins every filter, the order and the page size to one value, and the page to a number', () => {
    const s = parse({ ...base, filters: { category: '12' } });
    const q = listQueryParams(s);
    expect(q).toEqual({
      category: { enum: ['12'] }, orderby: { enum: ['id'] }, order: { enum: ['asc'] },
      per_page: { enum: ['50'] }, page: { regex: '[1-9][0-9]{0,2}' },
    });
    // Every name the page address carries is one the grant names.
    const names = new URL(listPageUrl(HOST, s, 1)).searchParams;
    for (const n of names.keys()) expect(Object.hasOwn(q, n)).toBe(true);
  });
});

describe('limits', () => {
  it('lets a list take enough pages for the target cap and one more', () => {
    expect(maxListPages('woocommerce')).toBe(101);
  });

  it('caps a page at 4 MB or what is left of the source budget', () => {
    expect(listPageCap(0)).toBe(BULK_LIST_PAGE_BYTES);
    expect(listPageCap(BULK_MAX_SOURCE_BYTES - 10)).toBe(10);
    expect(listPageCap(BULK_MAX_SOURCE_BYTES + 10)).toBe(0);
  });
});

describe('listPageElements', () => {
  it('takes a top-level array only', () => {
    expect(listPageElements([{ id: 1 }])).toEqual([{ id: 1 }]);
    expect(listPageElements({ products: [{ id: 1 }] })).toBeNull();
    expect(listPageElements('[]')).toBeNull();
  });
});

describe('listItemId', () => {
  it.each([[{ id: 0 }, '0'], [{ id: 42 }, '42'], [{ id: 'abc-1_X' }, 'abc-1_X'], [{ id: Number.MAX_SAFE_INTEGER }, String(Number.MAX_SAFE_INTEGER)]])(
    'takes %j as %j',
    (element, id) => {
      expect(listItemId(element, 'id')).toEqual({ id });
    },
  );

  it.each([
    [1e21], [2 ** 53 + 2], [-1], [1.5], [Number.NaN], [Infinity],
    ['1/2'], ['..'], ['.'], ['%2F'], ['a b'], ['a?b'], ['a#b'], [''], ['x'.repeat(129)],
    [true], [null], [{}], [Array.of(1)],
  ])('refuses the id %j', (id) => {
    expect(listItemId({ id }, 'id')).toEqual({ invalid: 'list_item_bad_id' });
  });

  it('refuses an element that is not an object, and one without the field', () => {
    expect(listItemId([1], 'id')).toEqual({ invalid: 'list_item_not_object' });
    expect(listItemId('1', 'id')).toEqual({ invalid: 'list_item_not_object' });
    expect(listItemId({ ID: 1 }, 'id')).toEqual({ invalid: 'list_item_no_id' });
  });

  it('reads the id field of the element itself, never one it inherits', () => {
    const inherited: unknown = JSON.parse('{"__proto__": {"id": 1}}');
    expect(listItemId(inherited, 'id')).toEqual({ invalid: 'list_item_no_id' });
    // A polluted prototype is the case an `in` check would read: every plain object has it.
    Object.defineProperty(Object.prototype, 'sku_ref', { value: 7, configurable: true, enumerable: false });
    try {
      expect(listItemId({ name: 'x' }, 'sku_ref')).toEqual({ invalid: 'list_item_no_id' });
    } finally {
      delete (Object.prototype as Record<string, unknown>)['sku_ref'];
    }
  });
});

describe('listItemKey', () => {
  const s = parse(base);

  it('addresses an element as <list path>/<id> on the host', () => {
    expect(listItemKey(HOST, s, { id: 7, name: 'x' })).toEqual({ key: 'https://shop.example.com/wp-json/wc/v3/products/7', id: '7' });
  });

  it('passes on the reason an element has no usable id', () => {
    expect(listItemKey(HOST, s, { id: '../orders' })).toEqual({ invalid: 'list_item_bad_id' });
  });

  // Two rules stand between an element and a key outside the list: the id alphabet, and the
  // check that the built key lies one segment below the list. This asserts what both together
  // guarantee, so it fails only once both are gone — the second is defence in depth.
  it.each([['1/2'], ['a/../../orders']])('never builds a key outside the list for the id %j', (id) => {
    const got = listItemKey(HOST, s, { id });
    expect('invalid' in got).toBe(true);
  });
});

describe('isUnderList', () => {
  const s = parse(base);

  it.each([
    ['https://shop.example.com/wp-json/wc/v3/products/7', true],
    ['https://shop.example.com/wp-json/wc/v3/products/7/variations', false],
    ['https://shop.example.com/wp-json/wc/v3/products', false],
    ['https://shop.example.com/wp-json/wc/v3/products/', false],
    ['https://shop.example.com/wp-json/wc/v3/productsX/7', false],
    ['https://shop.example.com/wp-json/wc/v3/orders/7', false],
    ['https://other.example.com/wp-json/wc/v3/products/7', false],
    ['https://shop.example.com/wp-json/wc/v3/products/7?x=1', false],
    ['not a url', false],
  ])('%s → %s', (key, under) => {
    expect(isUnderList(HOST, s, key)).toBe(under);
  });
});

describe('isSameListItem', () => {
  it('holds when the target read back carries the listed id', () => {
    expect(isSameListItem({ id: 7, name: 'x' }, 'id', '7')).toBe(true);
    expect(isSameListItem({ id: '7' }, 'id', '7')).toBe(true);
  });

  it('fails for another id, a padded alias, a missing one', () => {
    expect(isSameListItem({ id: 8 }, 'id', '7')).toBe(false);
    expect(isSameListItem({ id: '07' }, 'id', '7')).toBe(false);
    expect(isSameListItem({ name: 'x' }, 'id', '7')).toBe(false);
    expect(isSameListItem([], 'id', '7')).toBe(false);
  });
});
