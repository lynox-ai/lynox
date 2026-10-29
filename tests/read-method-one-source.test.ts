/**
 * Which HTTP methods only read is answered in one place: `isReadMethod` in
 * `src/core/outbound-write.ts`. Every outbound gate that asks "does this request only read?"
 * calls it, so the gates cannot drift apart when the set changes.
 *
 * This test reads every source file and finds each line that compares a method with `GET` or
 * `HEAD`. A line it finds must be listed below, with the question it asks and how often that
 * exact line occurs. The listed lines ask a different question, and none of them may answer the
 * read question by hand. A new hand-written read check fails here, and so does an edit to a
 * listed line or a listed line that is gone: the list states the tree as it is.
 *
 * What it cannot see: a method named through an alias (`const R = 'GET'; m === R`), a set
 * spread over several lines, or a lookup object (`{ GET: 1 }[m]`). Those are left to review.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isReadMethod } from '../src/core/outbound-write.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const LIT = `['"\`](?:GET|HEAD|get|head)['"\`]`;
const COMPARES = new RegExp(
  `(?:===|!==|==|!=)\\s*${LIT}|${LIT}\\s*(?:===|!==|==|!=)|case\\s+${LIT}|(?:has|includes|indexOf|startsWith)\\(\\s*${LIT}|GET\\|HEAD|HEAD\\|GET`,
);
// A line holding both names is a set of them, whatever builds it (`['GET', 'HEAD'].includes`, `new Set`).
const BOTH = /['"`](?:GET|get)['"`].*['"`](?:HEAD|head)['"`]|['"`](?:HEAD|head)['"`].*['"`](?:GET|get)['"`]/;

/** Source with its comments removed and string contents kept, line numbers unchanged. */
function withoutComments(src: string): string {
  let out = '';
  let quote: string | null = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    const next = src[i + 1];
    if (quote !== null) {
      out += c;
      if (c === '\\') { out += next ?? ''; i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      i--;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') out += '\n'; i++; }
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    out += c;
  }
  return out;
}

/** The lines of `src` that compare a method with GET or HEAD, trimmed and with runs of space collapsed. */
export function methodComparisons(src: string): string[] {
  return withoutComments(src).split('\n')
    .filter((line) => COMPARES.test(line) || BOTH.test(line))
    .map((line) => line.trim().replace(/\s+/g, ' '));
}

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sourceFiles(path, found);
    else if (path.endsWith('.ts') && !path.endsWith('.test.ts') && !path.endsWith('.d.ts')) found.push(path);
  }
  return found;
}

// The questions a listed line asks instead.
const SOURCE = 'the one answer itself';
const OVERRIDE_NAMES = 'the method names an override may carry, not which of them read';
const REPEATABLE = 'whether a stopped or timed-out call may simply be repeated; the same set today, but a different question';
const FETCH_BODY = 'whether a body may go out: fetch refuses one on GET and HEAD, whatever the gates decided';
const REDIRECT = 'how a redirect rewrites the method (RFC 9110); HEAD keeps its method where GET is rewritten';
const BULK_WIRE = 'what a bulk run puts on the wire for the method it sends; the gates read the acted method through isReadMethod';
const CONTRACT_SHAPE = 'the shape of a bulk contract: one GET and one write method';
const LIST_READ = 'whether a request is a list read, which is a GET only; anything else is refused that grant';
const CURL = 'what curl sends from a shell line, where OPTIONS reads too';
const ABORT_ON_STOP = 'whether a mail call may be cut off when the run stops: only a GET';
const VOCABULARY = 'the methods a schema or type offers';
const INBOUND = 'a request a browser sends to this server, not one the engine sends out';

/** [file, question, exact count, line as `methodComparisons` gives it] */
const LISTED: ReadonlyArray<readonly [string, string, number, string]> = [
  ["src/core/bulk-external.ts", CONTRACT_SHAPE, 1, "const writes = contract.httpMethods.filter((m) => m !== 'GET');"],
  ["src/core/bulk-external.ts", BULK_WIRE, 1, "const payload = graphql !== undefined ? graphql.body : method !== 'GET' ? JSON.stringify(body) : undefined;"],
  ["src/core/bulk-external.ts", BULK_WIRE, 1, "if (method !== 'GET') headers['content-type'] = 'application/json';"],
  ["src/core/bulk-external.ts", BULK_WIRE, 1, "const read = await readResponse(res, now(), method === 'GET' || graphql !== undefined, maxBytes);"],
  ["src/core/bulk-ledger.ts", CONTRACT_SHAPE, 1, "const writes = methods.filter((m) => m !== 'GET');"],
  ["src/core/network-guard.ts", REDIRECT, 1, "if (response.status === 303 && method !== 'GET' && method !== 'HEAD') {"],
  ["src/core/network-guard.ts", REDIRECT, 1, "} else if ((response.status === 301 || response.status === 302) && method !== 'GET' && method !== 'HEAD') {"],
  ["src/core/outbound-write.ts", SOURCE, 1, "export function isReadMethod(method: string | null | undefined): method is 'GET' | 'HEAD' {"],
  ["src/core/outbound-write.ts", SOURCE, 1, "return method === 'GET' || method === 'HEAD';"],
  ["src/core/outbound-write.ts", OVERRIDE_NAMES, 1, "'GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE', 'CONNECT',"],
  ["src/core/workflow-portable.ts", VOCABULARY, 1, "const HTTP_METHOD_VALUES = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] as const;"],
  ["src/egress-proxy/server.ts", INBOUND, 1, "if (req.method !== 'GET') { send(res, 405); return; }"],
  ["src/integrations/mail/providers/oauth-graph.ts", ABORT_ON_STOP, 1, "signal: init.method === 'GET' ? joinCallSignal(own) : own,"],
  ["src/orchestrator/contract-validation.ts", CONTRACT_SHAPE, 1, "const writes = methods.filter((m) => m !== 'GET');"],
  ["src/orchestrator/contract-validation.ts", CONTRACT_SHAPE, 1, "if (methods.length !== 2 || !methods.includes('GET') || writes.length !== 1 || !MINTABLE_WRITE_METHODS.has(writes[0]!)) {"],
  ["src/server/cross-site-write.ts", INBOUND, 1, "const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);"],
  ["src/server/http-api.ts", INBOUND, 1, "const safe = method === 'GET' || method === 'HEAD';"],
  ["src/server/http-api.ts", INBOUND, 1, "const dispatchMethods = method === 'HEAD' ? ['HEAD', 'GET'] : [method];"],
  ["src/server/http-api.ts", INBOUND, 1, "?? (method === 'HEAD' ? this.staticRouteScopes.get(`GET ${candidate}`) : undefined);"],
  ["src/server/http-api.ts", INBOUND, 1, "if (method === 'GET' || method === 'HEAD') return true;"],
  ["src/server/http-api.ts", INBOUND, 1, "if (method !== 'GET' && method !== 'HEAD') return true;"],
  ["src/server/http-api.ts", INBOUND, 1, "if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'].includes(method)) {"],
  ["src/server/http-api.ts", INBOUND, 1, "if (method === 'GET' && (pathname === '/health' || pathname === '/api/health')) {"],
  ["src/server/http-api.ts", INBOUND, 1, "if (method === 'GET' && pathname === '/api/google/callback') {"],
  ["src/server/http-api.ts", INBOUND, 1, "if (method === 'GET' && pathname === LynoxHTTPApi.PROFILE_OAUTH_CALLBACK_PATH) {"],
  ["src/server/http-api.ts", INBOUND, 1, "?? (method === 'HEAD' ? this.staticRoutes.get(`GET ${pathname}`) : undefined);"],
  ["src/server/http-api.ts", INBOUND, 1, "const dispatchMethod = method === 'HEAD' ? ['HEAD', 'GET'] : [method];"],
  ["src/tools/builtin/http.ts", REDIRECT, 1, "if (status === 303) return method !== 'GET' && method !== 'HEAD';"],
  ["src/tools/builtin/http.ts", REDIRECT, 1, "return (status === 301 || status === 302) && method !== 'GET' && method !== 'HEAD';"],
  ["src/tools/builtin/http.ts", REDIRECT, 1, "...(method === 'GET' ? { carried: true as const } : {}),"],
  ["src/tools/builtin/http.ts", REPEATABLE, 2, "if ((verb === 'GET' || verb === 'HEAD') && carried !== undefined) return `${base}${read}. ${carriedWriteWarning(carried)}`;"],
  ["src/tools/builtin/http.ts", REPEATABLE, 1, "if (verb === 'GET' || verb === 'HEAD') return `${base}${read}`;"],
  ["src/tools/builtin/http.ts", REPEATABLE, 1, "if (verb === 'GET' || verb === 'HEAD') return `${base}${read}. It only reads, so it can simply be repeated.`;"],
  ["src/tools/builtin/http.ts", VOCABULARY, 1, "method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD'], description: 'HTTP method (default: GET)' },"],
  ["src/tools/builtin/http.ts", FETCH_BODY, 1, "typeof input.body === 'string' && method !== 'GET' && method !== 'HEAD'"],
  ["src/tools/builtin/http.ts", FETCH_BODY, 1, "const bodyGoesOut = typeof sentBody === 'string' && sentBody !== '' && method.toUpperCase() !== 'GET' && method.toUpperCase() !== 'HEAD';"],
  ["src/tools/builtin/http.ts", FETCH_BODY, 1, "if (outboundBody && method !== 'GET' && method !== 'HEAD') {"],
  ["src/tools/permission-guard.ts", CURL, 1, "{ pattern: /^(?:(?!\\b[cC][uU][rR][lL]\\b).)*\\b[cC][uU][rR][lL]\\b.*(?:\\s-[a-zA-Z]*X\\s*|\\s--request(?:\\s+|=))(?!(?:GET|HEAD|OPTIONS)\\b)\\S/m, label: 'HTTP mutation via curl' },"],
  ["src/tools/permission-guard.ts", LIST_READ, 1, "if (effectiveWriteMethod(method, headers, url) !== 'GET') return false;"],
  ["src/tools/permission-guard.ts", CURL, 1, "const SAFE_METHOD = /^(?:GET|HEAD|OPTIONS)$/;"],
  ["src/types/capability-contract.ts", VOCABULARY, 1, "export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';"],
];

describe('isReadMethod', () => {
  it('reads GET and HEAD, and nothing else', () => {
    expect(isReadMethod('GET')).toBe(true);
    expect(isReadMethod('HEAD')).toBe(true);
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE', 'CONNECT', 'PROPFIND', '']) {
      expect(isReadMethod(m), m).toBe(false);
    }
  });

  // Callers normalise for their own question; a fold in here would change what they decide.
  it('matches exactly: no case fold, no trim, and no method is not a read', () => {
    expect(isReadMethod('get')).toBe(false);
    expect(isReadMethod('Head')).toBe(false);
    expect(isReadMethod(' GET')).toBe(false);
    expect(isReadMethod(null)).toBe(false);
    expect(isReadMethod(undefined)).toBe(false);
  });
});

describe('the read set is written once', () => {
  it('finds each way of writing a read check', () => {
    for (const line of [
      "if (m === 'GET' || m === 'HEAD') return null;",
      "if ('HEAD' !== method) {",
      "if (!['GET', 'HEAD'].includes(method)) {",
      "const READS = new Set(['GET', 'HEAD']);",
      "if (READS.has('GET')) {}",
      "switch (m) { case 'GET': break; }",
      "const READ = /^(?:GET|HEAD)$/;",
      "if (method.toLowerCase() === 'get') {}",
    ]) {
      expect(methodComparisons(line), line).toHaveLength(1);
    }
  });

  it('does not count a comment, or a method that is only sent', () => {
    expect(methodComparisons("// if (m === 'GET' || m === 'HEAD')\n/* method !== 'GET' */")).toEqual([]);
    expect(methodComparisons("await fetch(url, { method: 'GET' });\nconst url = 'http://x/?a=//b'; const m = 'GET';")).toEqual([]);
  });

  it('every comparison in the source is a listed one, as often as listed', () => {
    const found = new Map<string, number>();
    for (const path of sourceFiles(join(ROOT, 'src'))) {
      const file = relative(ROOT, path);
      for (const line of methodComparisons(readFileSync(path, 'utf8'))) {
        const key = `${file}\n${line}`;
        found.set(key, (found.get(key) ?? 0) + 1);
      }
    }
    const listed = new Map(LISTED.map(([file, , count, line]) => [`${file}\n${line}`, count]));
    const unlisted = [...found].filter(([key]) => !listed.has(key)).map(([key]) => key.replace('\n', ': '));
    expect(unlisted, 'a method compared with GET or HEAD by hand: call isReadMethod for "does this only read?", or list the line with the question it asks instead').toEqual([]);
    const off = [...listed].filter(([key, count]) => found.get(key) !== count)
      .map(([key, count]) => `${key.replace('\n', ': ')} (listed ${count}, found ${found.get(key) ?? 0})`);
    expect(off, 'a listed line changed, moved or is gone: list it as it is now').toEqual([]);
  });
});
