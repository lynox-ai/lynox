import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { READ_IDENTIFIERS } from './http-api.js';

/**
 * The query parameters a mandate's read row may carry (D15, `READ_IDENTIFIERS`), held to the
 * handlers that read them. Read from the source: which names a handler reads is a property of
 * its code, not of a request. Every name a `user` GET route reads is either an identifier
 * (declared at that route) or named here as not one, so a new name fails until it is placed.
 */
const NOT_IDENTIFYING = new Set([
  // Paging, ordering and windows.
  'limit', 'offset', 'since', 'fromSeq', 'days', 'dateFrom', 'dateTo', 'tzOffsetMin', 'window',
  // Filters over a list: what kind, not which one.
  'status', 'type', 'stage', 'bucket', 'model', 'name', 'includeArchived', 'snoozedOnly', 'hidden', 'reveal',
  // Free text: content, never logged.
  'q',
  // An OAuth provider's answer: a code and a state are credentials.
  'code', 'state', 'error',
]);
const IDENTIFYING = new Set([...READ_IDENTIFIERS.values()].flat());
/** Routes that read the query through a helper taking a variable name; each says which names. */
const THROUGH_HELPER = new Map([['GET /api/bulk/runs/:id/targets', ['offset', 'limit']]]);

function userGetRoutesWithQueryReads(): Map<string, { names: Set<string>; dynamic: boolean }> {
  const src = readFileSync(new URL('./http-api.ts', import.meta.url), 'utf8');
  const any = /addStatic\(|parseDynamicRoute\(/g;
  const starts: number[] = [];
  for (let m = any.exec(src); m !== null; m = any.exec(src)) starts.push(m.index);
  const get = /addStatic\('user', [`']GET ([^`']+)[`']|parseDynamicRoute\('user', 'GET', '([^']+)'/g;
  const out = new Map<string, { names: Set<string>; dynamic: boolean }>();
  for (let m = get.exec(src); m !== null; m = get.exec(src)) {
    const end = starts.find((s) => s > m!.index) ?? src.length;
    const body = src.slice(m.index, end);
    const names = new Set([...body.matchAll(/searchParams\.get\('([^']+)'\)/g)].map((x) => x[1]!));
    out.set(`GET ${m[1] ?? m[2]!}`, { names, dynamic: /searchParams\.(get|has)\((?!')/.test(body) });
  }
  return out;
}

describe('the query identifiers of a read row, held to the handlers', () => {
  const routes = userGetRoutesWithQueryReads();

  it('finds the routes it checks', () => {
    // The control: a scan that matched nothing would pass every assertion below.
    expect(routes.size).toBeGreaterThan(80);
    expect(routes.get('GET /api/files/download')?.names.has('path')).toBe(true);
  });

  it('places every query name a GET route reads', () => {
    const unplaced = [...routes].flatMap(([k, r]) => [...r.names].filter((n) => !IDENTIFYING.has(n) && !NOT_IDENTIFYING.has(n)).map((n) => `${k} ${n}`));
    expect(unplaced).toEqual([]);
  });

  it('declares every identifier a route reads', () => {
    const undeclared = [...routes].flatMap(([k, r]) => [...r.names].filter((n) => IDENTIFYING.has(n) && !(READ_IDENTIFIERS.get(k) ?? []).includes(n)).map((n) => `${k} ${n}`));
    expect(undeclared).toEqual([]);
  });

  it('declares nothing a route does not read', () => {
    const unread = [...READ_IDENTIFIERS].flatMap(([k, names]) => names.filter((n) => routes.get(k)?.names.has(n) !== true).map((n) => `${k} ${n}`));
    expect(unread).toEqual([]);
  });

  it('knows every route that reads the query through a variable name', () => {
    const dynamic = [...routes].filter(([, r]) => r.dynamic).map(([k]) => k);
    expect(dynamic).toEqual([...THROUGH_HELPER.keys()]);
    for (const names of THROUGH_HELPER.values()) for (const n of names) expect(NOT_IDENTIFYING.has(n)).toBe(true);
  });
});
