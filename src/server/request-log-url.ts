// === The request URL as the request log may write it ===
//
// The log line keeps the path and the names of the query parameters, and replaces every query
// value. A value can carry something a reader of the container log should not hold, and a list
// of parameters to redact misses the next one without a sound, so all values go. Should a value
// ever be needed in the log, it is let through here by name, with the reason.
//
// The path goes through the audit log's own reading of it (`requestPathTarget`): a segment that
// holds an address is replaced whole and a known secret shape is masked, because some routes
// name a contact by address in the path. Everything after an encoded `?` in the path is
// replaced, and an absolute-form target loses its scheme and authority.
//
// That reading decodes, so it runs on every request only within a bound: a path longer than
// `MAX_LOGGED_PATH` is replaced whole (decoding a long run of broken escapes costs real time on
// the event loop, and anyone can send one). The route token is taken out after decoding,
// and decoded whitespace is escaped again, so a path cannot pose as the status and time fields.

import { requestPathTarget } from '../core/audit-log.js';
import { redactWebhookPath } from './webhook-receiver.js';

const REDACTED = '<redacted>';

/** Longest path the log line decodes; a longer one is written as `LONG_PATH`. */
export const MAX_LOGGED_PATH = 2048;
const LONG_PATH = '<long path>';

/** A parameter name the log keeps as written; anything else in that place is redacted too. */
const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_.\-[\]]{0,63}$/;

/**
 * `rawUrl` fit for the request log: the webhook route token taken out of the path
 * (`redactWebhookPath`), every query value replaced, the fragment dropped. An entry without `=`
 * is a value on its own and is replaced whole.
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

/** The path part of the log line: an encoded `?` and all after it replaced, addresses and secret
 *  shapes as the audit log treats them, the route token taken out of the decoded text. */
function logPath(rawPath: string): string {
  if (rawPath.length > MAX_LOGGED_PATH) return LONG_PATH;
  const encodedQuery = rawPath.search(/%3F/i);
  const path = encodedQuery === -1 ? rawPath : rawPath.slice(0, encodedQuery);
  const target = redactWebhookPath(requestPathTarget(path))
    .replace(/[\s\p{Z}]/gu, (c) => encodeURIComponent(c)) || '/';
  return encodedQuery === -1 ? target : `${target}%3F${REDACTED}`;
}
