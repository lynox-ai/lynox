import { describe, it, expect } from 'vitest';
import { contractGrants, reviewableQuery, withListQuery, type ListQueryConstraints } from './permission-guard.js';
import type { CapabilityContract } from '../types/capability-contract.js';

const LIST = 'https://shop.example.com/wp-json/wc/v3/products';
const base: CapabilityContract = {
  version: 1, origin: 'reviewed', grantedTools: ['http_request'], httpMethods: ['GET'],
  hostPatterns: ['shop.example.com'], pathPatterns: ['/wp-json/wc/v3/products'], paramConstraints: {},
};
const constraints: ListQueryConstraints = {
  category: { enum: ['12'] }, orderby: { enum: ['id'] }, order: { enum: ['asc'] },
  per_page: { enum: ['50'] }, page: { regex: '[1-9][0-9]{0,2}' },
};
const PAGE = `${LIST}?category=12&orderby=id&order=asc&per_page=50&page=3`;
const grants = (url: string, extra: Record<string, unknown> = {}, contract = withListQuery(base, constraints)): boolean =>
  contractGrants('http_request', { method: 'GET', url, ...extra }, contract);

describe('a reviewed contract without a list query — unchanged', () => {
  it('grants the plain address and refuses any query, a bare one included', () => {
    expect(contractGrants('http_request', { method: 'GET', url: LIST }, base)).toBe(true);
    expect(contractGrants('http_request', { method: 'GET', url: PAGE }, base)).toBe(false);
    expect(contractGrants('http_request', { method: 'GET', url: `${LIST}?` }, base)).toBe(false);
  });

  it('a stored or parsed copy of a list-read contract is such a contract: the query grant does not survive serialisation', () => {
    const live = withListQuery(base, constraints);
    expect(grants(PAGE, {}, live)).toBe(true);
    const roundTripped = JSON.parse(JSON.stringify(live)) as CapabilityContract;
    expect(grants(PAGE, {}, roundTripped)).toBe(false);
    expect(grants(PAGE, {}, { ...live })).toBe(false);
  });
});

describe('withListQuery', () => {
  it('grants the page address the engine builds', () => {
    expect(grants(PAGE)).toBe(true);
    expect(grants(`${LIST}?page=1`)).toBe(true);
  });

  it('is only made from a reviewed GET-only contract', () => {
    expect(() => withListQuery({ ...base, origin: 'authorship' }, constraints)).toThrow(/reviewed/);
    expect(() => withListQuery({ ...base, httpMethods: ['GET', 'PATCH'] }, constraints)).toThrow(/GET/);
  });

  it('refuses a list read without a query, and one with a body', () => {
    expect(grants(LIST)).toBe(false);
    expect(grants(PAGE, { body: '_method=DELETE' })).toBe(false);
    expect(grants(PAGE, { body: '' })).toBe(false);
  });

  it('refuses a method-override header, as every reviewed grant does', () => {
    expect(grants(PAGE, { headers: { 'X-HTTP-Method-Override': 'DELETE' } })).toBe(false);
  });

  it('keeps the pinned path and host', () => {
    expect(grants('https://shop.example.com/wp-json/wc/v3/orders?page=1')).toBe(false);
    expect(grants('https://other.example.com/wp-json/wc/v3/products?page=1')).toBe(false);
    expect(grants('http://shop.example.com/wp-json/wc/v3/products?page=1')).toBe(false);
    expect(grants('https://shop.example.com:8443/wp-json/wc/v3/products?page=1')).toBe(false);
    expect(grants(`${LIST}?page=1#x`)).toBe(false);
    expect(grants(`${LIST}#x?page=1`)).toBe(false);
  });
});

describe('reviewableQuery', () => {
  it('admits names among the constraints with values they allow', () => {
    expect(reviewableQuery('category=12&page=101', constraints)).toBe(true);
  });

  it.each([
    ['', 'empty'],
    ['page=0', 'regex miss'],
    ['page=1000', 'regex miss (too long)'],
    ['category=13', 'enum miss'],
    ['tag=1', 'name not among the constraints'],
    ['page=1&page=2', 'a name twice'],
    ['page=1&&order=asc', 'an empty segment'],
    ['page=1&', 'a trailing empty segment'],
    ['page', 'no value'],
    ['page=1=2', 'two equals'],
    ['=1', 'no name'],
    ['page=%31', 'percent-encoding'],
    ['page=1+1', 'a plus'],
    ['page=1;order=asc', 'a semicolon'],
    ['category=1.2', 'a dot in a value'],
    ['page[]=1', 'array syntax'],
    ['pa.ge=1', 'a dot in a name'],
    ['Page=1', 'an upper-case name'],
    ['_method=GET', 'a leading underscore'],
    [`page=1&${'x'.repeat(520)}=1`, 'too long'],
  ])('refuses %j (%s)', (raw) => {
    expect(reviewableQuery(raw, constraints)).toBe(false);
  });

  it('refuses a constraint that allows nothing explicit', () => {
    expect(reviewableQuery('page=1', { page: {} })).toBe(false);
  });

  // ⛔ The one refusal no other rule here makes: the name is allowed by the constraints and
  // passes the name and value alphabet, so only the method-name rule stands between it and
  // a server that reads it as the request's method.
  it.each([['method'], ['x_http_method_override'], ['http_method'], ['methodology']])(
    'never admits %j, a name that could select a method — even when the constraints list it',
    (name) => {
      expect(reviewableQuery(`${name}=DELETE`, { [name]: { enum: ['DELETE'] } })).toBe(false);
      expect(grants(`${LIST}?${name}=DELETE`, {}, withListQuery(base, { [name]: { enum: ['DELETE'] } }))).toBe(false);
    },
  );
});
