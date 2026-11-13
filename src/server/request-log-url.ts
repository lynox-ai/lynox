// === The request URL as the request log may write it ===
//
// The log line keeps the path and the names of the query parameters, and replaces every query
// value. A value can carry something a reader of the container log should not hold, and a list
// of parameters to redact misses the next one without a sound, so all values go. Should a value
// ever be needed in the log, it is let through here by name, with the reason.
//
// The path is read as sent and never decoded. This runs on every request, before anyone is
// known, so it does only linear work on a bounded string: a path longer than `MAX_LOGGED_PATH`
// is replaced whole; a segment that holds an address (`@`, or `%40` under any number of `%25`)
// is replaced whole, because some routes name a contact by address in the path; a path the
// router reads as a CRM contact route (`/api/crm/contacts/:name/…`) is written as that route
// with the contact replaced, because the segment holds a person's name and no general rule can
// tell a name from an id; a known secret
// shape is masked; everything after an encoded `?` is replaced; the webhook route token is taken
// out; an absolute-form target loses its scheme and authority. Because nothing is decoded, the
// path keeps the shape the HTTP parser admitted, with no space in it, so it cannot pose as the
// status and time fields of the line.

import { maskSecretPatterns } from '../core/secret-store.js';
import { redactWebhookPath } from './webhook-receiver.js';

const REDACTED = '<redacted>';
const ADDRESS = '<address>';

/** Longest path the log line writes; a longer one is written as `LONG_PATH`. */
export const MAX_LOGGED_PATH = 2048;
const LONG_PATH = '<long path>';

/** A parameter name the log keeps as written; anything else in that place is redacted too. */
const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_.\-[\]]{0,63}$/;

/** A path segment that holds an address as sent: a plain or percent-encoded `@`, also the
 *  full-width one, under any number of `%25`. */
const HOLDS_ADDRESS = /@|%(?:25)*40|%(?:25)*EF%(?:25)*BC%(?:25)*A0/i;

const CONTACT = '<contact>';
/** A CRM route with a contact in the path, matched on the path as the router reads it. */
const CRM_CONTACT_ROUTE = /^\/api\/(v1\/)?crm\/contacts\/([^/]+)(\/.*)?$/;
/** A contact segment that names no one: the row id of `DELETE /api/crm/contacts/:id`, which
 *  ends there. Followed by more path, digits are a contact's name like any other. */
const ROW_ID = /^\d+$/;

/**
 * The CRM route `rawPath` reaches, with the contact replaced, or null when it reaches none.
 * The match runs on the path as the router derives it (`_handleRequest` in `http-api.ts`):
 * through `URL`, which resolves dot segments, reads `\` as `/` and a leading `//` as an
 * authority, and with `/api/v1/` read as `/api/`. Percent escapes stay as sent, as they do
 * for the router, so nothing is decoded here either.
 */
function crmContactPath(rawPath: string): string | null {
  let pathname: string;
  try {
    pathname = new URL(rawPath, 'http://localhost').pathname;
  } catch {
    return null;
  }
  const match = CRM_CONTACT_ROUTE.exec(pathname);
  const rest = match?.[3] ?? '';
  if (match === null || (ROW_ID.test(match[2]!) && (rest === '' || rest === '/'))) return null;
  return `/api/${match[1] ?? ''}crm/contacts/${CONTACT}${rest}`;
}

/**
 * `rawUrl` fit for the request log: the path as `logPath` writes it, every query value
 * replaced, the fragment dropped. An entry without `=` is a value on its own and is replaced
 * whole.
 */
export function requestLogUrl(rawUrl: string): string {
  const withoutFragment = (rawUrl.split('#', 1)[0] ?? '').replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?]*/, '');
  const q = withoutFragment.indexOf('?');
  const path = logPath(q === -1 ? withoutFragment : withoutFragment.slice(0, q));
  if (q === -1) return path;
  const entries = withoutFragment.slice(q + 1).split('&').filter((entry) => entry !== '');
  const kept = entries.map((entry) => {
    const eq = entry.indexOf('=');
    if (eq === -1) return REDACTED;
    const name = entry.slice(0, eq);
    return `${PARAM_NAME.test(name) ? name : REDACTED}=${REDACTED}`;
  });
  return kept.length === 0 ? path : `${path}?${kept.join('&')}`;
}

/** The path part of the log line, read as sent (see the head of this file). */
function logPath(rawPath: string): string {
  if (rawPath.length > MAX_LOGGED_PATH) return LONG_PATH;
  // `URL` escapes what it reads, so the route written can be longer than the path sent.
  const source = crmContactPath(rawPath) ?? rawPath;
  if (source.length > MAX_LOGGED_PATH) return LONG_PATH;
  const encodedQuery = source.search(/%3F/i);
  const path = encodedQuery === -1 ? source : source.slice(0, encodedQuery);
  const segments = redactWebhookPath(path).split('/').map((segment) => (HOLDS_ADDRESS.test(segment) ? ADDRESS : segment));
  const written = maskSecretPatterns(segments.join('/'), { includeGeneric: true }) || '/';
  return encodedQuery === -1 ? written : `${written}%3F${REDACTED}`;
}
