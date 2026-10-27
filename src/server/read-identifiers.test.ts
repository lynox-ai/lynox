import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reloadConfig } from '../core/config.js';
import { LynoxHTTPApi, READ_IDENTIFIERS } from './http-api.js';

/**
 * The query parameters a mandate's read row may carry (D15, `READ_IDENTIFIERS`), held to the
 * handlers that read them. Read from the source: which names a handler reads is a property of
 * its code, not of a request. Every name the file reads is either an identifier (declared at
 * its route) or named here as not one, so a new name fails until it is placed.
 *
 * What a text scan cannot see is made to fail rather than pass:
 * - a read of the query in any form other than `searchParams.get('<name>')`, and any use of
 *   `req.url` other than `new URL(req.url ?? …)`, must be listed;
 * - a literal read of an identifying name must sit in a `user` GET route that declares it, or
 *   be listed. A read in a helper or a handler held in a `const` is credited to the
 *   registration above it: caught when that is anything but a GET route declaring the same
 *   name. Only this file is scanned; the routes are all registered here;
 * - the scan must find exactly the `user` GET routes of the real table.
 */
const NOT_IDENTIFYING = new Set([
  // Paging, ordering and windows.
  'limit', 'offset', 'since', 'fromSeq', 'days', 'dateFrom', 'dateTo', 'tzOffsetMin', 'window',
  // Filters over a list: what kind, not which one.
  'status', 'type', 'stage', 'bucket', 'model', 'includeArchived', 'snoozedOnly', 'hidden', 'reveal', 'view',
  // Free text: content, never logged.
  'q',
  // An OAuth provider's answer: a code and a state are credentials.
  'code', 'state', 'error',
  // Read outside a mandate's GET routes, or not naming an object: usage period (a helper of
  // the usage routes), a memory delete's pattern, an admin cleanup's preview, an admin window,
  // the scopes a connect confirmation was shown (read on the POST only).
  'period', 'pattern', 'dryRun', 'hours', 'shown_scopes',
]);
const IDENTIFYING = new Set([...READ_IDENTIFIERS.values()].flat());
/** Routes that read the query through a helper taking a variable name; each says which names. */
const THROUGH_HELPER = new Map([['GET /api/bulk/runs/:id/targets', ['offset', 'limit']]]);
/** Identifying names read outside a `user` GET route, by the registration they sit under. */
const OUTSIDE_READS = [
  // A delete names its file in the query; it is a change, recorded as one.
  "addStatic('user', 'DELETE /api/files' path",
];
/** Registration keys written as a template, by what the template names. */
const TEMPLATE_KEYS = new Map([['GET ${LynoxHTTPApi.PROFILE_OAUTH_CALLBACK_PATH}', 'GET /api/oauth/callback']]);
const SOURCE = readFileSync(new URL('./http-api.ts', import.meta.url), 'utf8');

function userGetRoutesWithQueryReads(): Map<string, { names: Set<string>; dynamic: boolean }> {
  const src = SOURCE;
  const any = /addStatic\(|parseDynamicRoute\(/g;
  const starts: number[] = [];
  for (let m = any.exec(src); m !== null; m = any.exec(src)) starts.push(m.index);
  const get = /addStatic\('user', [`']GET ([^`']+)[`']|parseDynamicRoute\('user', 'GET', '([^']+)'/g;
  const out = new Map<string, { names: Set<string>; dynamic: boolean }>();
  for (let m = get.exec(src); m !== null; m = get.exec(src)) {
    const end = starts.find((s) => s > m!.index) ?? src.length;
    const body = src.slice(m.index, end);
    const names = new Set([...body.matchAll(/searchParams\.get\('([^']+)'\)/g)].map((x) => x[1]!));
    const key = `GET ${m[1] ?? m[2]!}`;
    out.set(TEMPLATE_KEYS.get(key) ?? key, { names, dynamic: /searchParams\.(get|has)\((?!')/.test(body) });
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

  it('places a name on one side only', () => {
    // A name on both sides would pass every check below whichever way it is meant.
    expect([...IDENTIFYING].filter((n) => NOT_IDENTIFYING.has(n))).toEqual([]);
  });

  it('places every query name the file reads', () => {
    const names = new Set([...SOURCE.matchAll(/searchParams\.get\('([^']+)'\)/g)].map((x) => x[1]!));
    expect(names.size).toBeGreaterThan(20);
    expect([...names].filter((n) => !IDENTIFYING.has(n) && !NOT_IDENTIFYING.has(n))).toEqual([]);
  });

  it('reads the query in no form it cannot check', () => {
    // Every use of `searchParams` is a literal `get`/`has`, the dispatcher handing it to the read
    // trail, or a listed helper. An alias, `getAll`, iteration or `Object.fromEntries` fails here.
    const other = SOURCE.split('\n')
      .filter((l) => /searchParams|new URLSearchParams\(|\burl\.search\b/.test(l))
      .filter((l) => !/^\s*(\/\/|\*)/.test(l))
      .map((l) => l.replace(/searchParams\.(get|has)\('[^']+'\)/g, ''))
      .filter((l) => /searchParams|new URLSearchParams\(|\burl\.search\b/.test(l))
      .map((l) => l.trim());
    expect(other).toEqual([
      'if (!this._recordedMandateRead(req, res, method, routePath, pathname, url.searchParams)) return;',
      'if (!this._recordedMandateRead(req, res, method, route.path, pathname, url.searchParams)) return;',
      'const v = Number(url.searchParams.get(name));',
      'return url.searchParams.has(name) && Number.isInteger(v) && v >= 0 ? v : undefined;',
    ]);
  });

  it('declares every identifier a route reads', () => {
    const undeclared = [...routes].flatMap(([k, r]) => [...r.names].filter((n) => IDENTIFYING.has(n) && !(READ_IDENTIFIERS.get(k) ?? []).includes(n)).map((n) => `${k} ${n}`));
    expect(undeclared).toEqual([]);
  });

  it('declares nothing a route does not read', () => {
    const unread = [...READ_IDENTIFIERS].flatMap(([k, names]) => names.filter((n) => routes.get(k)?.names.has(n) !== true).map((n) => `${k} ${n}`));
    expect(unread).toEqual([]);
  });

  it('knows every route that reads the query through a variable name, and which names', () => {
    const dynamic = [...routes].filter(([, r]) => r.dynamic).map(([k]) => k);
    expect(dynamic).toEqual([...THROUGH_HELPER.keys()]);
    for (const [key, names] of THROUGH_HELPER) {
      for (const n of names) expect(NOT_IDENTIFYING.has(n)).toBe(true);
      // The names the route hands its helper, read from its body: nothing beyond the listed ones.
      const at = SOURCE.indexOf(`'${key.slice(4)}'`);
      const body = SOURCE.slice(at, SOURCE.indexOf('parseDynamicRoute(', at + 1));
      expect([...new Set([...body.matchAll(/num\('([^']+)'\)/g)].map((x) => x[1]!))].sort()).toEqual([...names].sort());
    }
  });

  it('reads an identifying name only in a user GET route, or where it is listed', () => {
    const regs = [...SOURCE.matchAll(/addStatic\('(?:user|admin)', [`'][A-Z]+ [^`']+[`']|parseDynamicRoute\('(?:user|admin)', '[A-Z]+', '[^']+'/g)];
    const outside = [...SOURCE.matchAll(/searchParams\.get\('([^']+)'\)/g)]
      .filter((m) => IDENTIFYING.has(m[1]!))
      .map((m) => ({ name: m[1]!, under: regs.filter((r) => r.index! < m.index!).at(-1)?.[0] ?? '(before any route)' }))
      .filter((x) => !/^addStatic\('user', [`']GET |^parseDynamicRoute\('user', 'GET'/.test(x.under))
      .map((x) => `${x.under} ${x.name}`);
    expect(outside).toEqual(OUTSIDE_READS);
  });

  it('takes the request URL apart in one form only', () => {
    // `new URL(req.url ?? …)` leaves the query to `searchParams`, which the tests above read. A
    // split on `?`, a regex over `req.url`, `.search` or `querystring` would read it unseen.
    const other = SOURCE.split('\n')
      .filter((l) => !/^\s*(\/\/|\*)/.test(l))
      .filter((l) => /req\.url|req\[['"]url|\{[^}]*\burl\b[^}]*\}\s*=\s*req\b|\.search\b(?!\()|\.href\b|querystring/.test(l))
      .filter((l) => !/new URL\(req\.url \?\? /.test(l))
      .map((l) => l.trim());
    expect(other).toEqual([
      // A plugin's file URL, not a request's.
      'const mod = await import(pathToFileURL(abs).href) as { handler?: unknown };',
      // The request log line, with a webhook route token taken out.
      "const url = redactWebhookPath(req.url ?? '/');",
      // The webhook route admits a raw path only when it equals the parsed one; the comparison
      // reads the path up to `?`, never the query.
      "if (token !== null && isCanonicalRequestPath(req.url ?? '/', url.pathname)) {",
      // The OAuth callback hands a provider's signature check (Shopify's HMAC) the query string
      // itself. Parsed only by that check, which hands back the code to spend from the signed
      // values; the route reads its other names through `searchParams` as everywhere else.
      "const rawQuery = (req.url ?? '').split('#')[0]!.split('?').slice(1).join('?');",
    ]);
  });
});

describe('the scan against the real route table', () => {
  let api: LynoxHTTPApi;
  let dir: string;
  const saved: Record<string, string | undefined> = {};
  const ENV = ['LYNOX_DATA_DIR', 'LYNOX_HTTP_SECRET', 'LYNOX_ALLOW_PLAIN_HTTP', 'LYNOX_VAULT_KEY', 'LYNOX_BILLING_TIER', 'LYNOX_MANAGED_MODE'];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-read-ids-'));
    for (const k of ENV) saved[k] = process.env[k];
    process.env['LYNOX_DATA_DIR'] = dir;
    // Built at RUNTIME: this repo is public, and the commit-time scan looks for key shapes.
    process.env['LYNOX_HTTP_SECRET'] = `t-${randomBytes(12).toString('hex')}`;
    process.env['LYNOX_ALLOW_PLAIN_HTTP'] = 'true';
    process.env['LYNOX_VAULT_KEY'] = `v-${randomBytes(12).toString('hex')}`;
    delete process.env['LYNOX_BILLING_TIER'];
    delete process.env['LYNOX_MANAGED_MODE'];
    reloadConfig();
    api = new LynoxHTTPApi();
    await api.init();
  }, 120_000);

  afterAll(async () => {
    try {
      await api?.shutdown();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
      reloadConfig();
    }
  });

  it('scans exactly the user GET routes the server registers', () => {
    const routes = userGetRoutesWithQueryReads();
    const table = api.routeStancesForTesting().filter((r) => r.method === 'GET' && r.scope === 'user').map((r) => `GET ${r.path}`);
    expect(table.length).toBeGreaterThan(80);
    expect(table.filter((k) => !routes.has(k))).toEqual([]);
    expect([...routes.keys()].filter((k) => !table.includes(k))).toEqual([]);
  });
});
