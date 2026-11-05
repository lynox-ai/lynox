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
// is replaced whole, because some routes name a contact by address in the path; a known secret
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
  const encodedQuery = rawPath.search(/%3F/i);
  const path = encodedQuery === -1 ? rawPath : rawPath.slice(0, encodedQuery);
  const segments = redactWebhookPath(path).split('/').map((segment) => (HOLDS_ADDRESS.test(segment) ? ADDRESS : segment));
  const written = maskSecretPatterns(segments.join('/'), { includeGeneric: true }) || '/';
  return encodedQuery === -1 ? written : `${written}%3F${REDACTED}`;
}
